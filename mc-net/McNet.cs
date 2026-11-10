// McNet: play a Minecraft Java "Open to LAN" world over the Internet without a VPN or a server.
// Both players run it and exchange addresses. A direct UDP tunnel (NAT hole punching + reliable
// ordered delivery) carries Minecraft's TCP; the friend's world shows up in the LAN list.
// Build: build.bat (uses csc from .NET Framework 4.x shipped with Windows). C# 5 only.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

sealed class McNet : Form
{
    const int LanPort = 4445, UdpPort = 47474, TcpPort = 25577, Mss = 1150, Window = 256, Stale = 5000;
    const byte Punch = 0x81, Pong = 0x82, Data = 0x83, Ack = 0x84; // packet: type, sender id, receiver id, body (STUN starts with 0x00/0x01)
    const byte Open = 0, Bytes = 1, Fin = 2;                       // frame: stream id, kind (|0x80 when sent by the stream's opener), payload
    static readonly IPAddress Group = IPAddress.Parse("224.0.2.60");
    static readonly Regex Beacon = new Regex(@"\[MOTD\](.*?)\[/MOTD\]\[AD\](\d{1,5})\[/AD\]", RegexOptions.Singleline);
    static readonly string[] StunHosts = { "stun.l.google.com:19302", "stun.cloudflare.com:3478", "stun.sipnet.ru:3478" };

    sealed class Pkt { public byte[] Buf; public long Sent; public int Tx = 1, Skip; }
    sealed class Conn // one tunnelled TCP connection; Key > 0xFFFF when opened by this side
    {
        public int Key; public uint Link; public Socket Sock; public bool Closed;
        public readonly BlockingCollection<byte[]> Out = new BlockingCollection<byte[]>();
    }

    readonly Label status = new Label(), hint = new Label();
    readonly TextBox mine = new TextBox { ReadOnly = true }, friend = new TextBox();
    readonly Button copy = new Button { Text = "Копировать" }, connect = new Button { Text = "Соединить" };
    readonly string cfg = Path.ChangeExtension(Application.ExecutablePath, ".txt");

    readonly object L = new object(); // guards all state below
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Random rnd = new Random();
    readonly Socket udp = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
    readonly Socket lan = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
    readonly TcpListener tcp;
    readonly int tcpPort;
    readonly Dictionary<uint, Pkt> flight = new Dictionary<uint, Pkt>();        // sent, not yet acknowledged
    readonly Dictionary<uint, byte[]> ooo = new Dictionary<uint, byte[]>();     // received out of order
    readonly Dictionary<int, Conn> conns = new Dictionary<int, Conn>();
    readonly Dictionary<IPEndPoint, IPEndPoint> mapped = new Dictionary<IPEndPoint, IPEndPoint>(); // STUN server -> my public address
    List<IPAddress> locals = new List<IPAddress>();
    System.Threading.Timer ticker;
    IPEndPoint peer, me;
    uint myId, peerId, sndNext, sndUna, rcvNext;
    bool est, symmetric, bad;
    long seen, since, lastPunch, lastBeacon, localSeen = -Stale;
    double srtt = -1, rttvar;
    int localPort, nextConn;
    string localMotd = "", peerMotd = "";

    long Now { get { return clock.ElapsedMilliseconds; } }
    bool Linked { get { return est && Now - seen < 3000; } }
    double Rto { get { return srtt < 0 ? 300 : Math.Max(40, srtt + 4 * rttvar); } }

    McNet()
    {
        float k;
        using (var g = CreateGraphics()) k = g.DpiX / 96f;
        Func<int, int> S = v => (int)(v * k);
        Text = "McNet";
        Font = new Font("Segoe UI", 10f);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        StartPosition = FormStartPosition.CenterScreen;

        var t = new TableLayoutPanel { AutoSize = true, ColumnCount = 3, Padding = new Padding(S(10)) };
        t.ColumnStyles.Add(new ColumnStyle());
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, S(250)));
        t.ColumnStyles.Add(new ColumnStyle());
        status.Font = new Font(Font.FontFamily, 12f, FontStyle.Bold);
        hint.ForeColor = SystemColors.GrayText;
        foreach (var l in new[] { status, hint })
        {
            l.AutoSize = true;
            l.MaximumSize = new Size(S(470), 0);
            l.Margin = new Padding(3, 3, 3, S(8));
        }
        Func<string, Label> caption = s => new Label { Text = s, AutoSize = true, Anchor = AnchorStyles.Left };
        foreach (var b in new[] { mine, friend }) { b.Font = new Font("Consolas", 12f); b.Dock = DockStyle.Fill; }
        foreach (var b in new[] { copy, connect }) { b.AutoSize = true; b.Dock = DockStyle.Fill; }
        t.Controls.Add(status, 0, 0); t.SetColumnSpan(status, 3);
        t.Controls.Add(caption("Мой адрес"), 0, 1); t.Controls.Add(mine, 1, 1); t.Controls.Add(copy, 2, 1);
        t.Controls.Add(caption("Адрес друга"), 0, 2); t.Controls.Add(friend, 1, 2); t.Controls.Add(connect, 2, 2);
        t.Controls.Add(hint, 0, 3); t.SetColumnSpan(hint, 3);
        Controls.Add(t);

        copy.Click += (s, e) => { try { if (mine.Text.Length > 0) Clipboard.SetText(mine.Text); } catch (ExternalException) { } };
        connect.Click += (s, e) => Connect();
        friend.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; Connect(); } };

        udp.ReceiveBufferSize = udp.SendBufferSize = 1 << 20;
        try { udp.Bind(new IPEndPoint(IPAddress.Any, UdpPort)); } // fixed port keeps the public address stable between runs
        catch (SocketException) { udp.Bind(new IPEndPoint(IPAddress.Any, 0)); }
        lan.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        try { lan.Bind(new IPEndPoint(IPAddress.Any, LanPort)); }
        catch (SocketException) { lan.Bind(new IPEndPoint(IPAddress.Any, 0)); } // can still announce, cannot detect a local world
        tcp = new TcpListener(IPAddress.Any, TcpPort);
        try { tcp.Start(); }
        catch (SocketException) { tcp = new TcpListener(IPAddress.Any, 0); tcp.Start(); }
        tcpPort = ((IPEndPoint)tcp.LocalEndpoint).Port;
        lock (L) Reset();
        LoadNets();
        NetworkChange.NetworkAddressChanged += (s, e) => LoadNets();
        try { friend.Text = File.ReadAllText(cfg).Trim(); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        if (friend.Text.Length > 0) Connect();
        Render();
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        foreach (var a in new ThreadStart[] { Receive, Beacons, Accept, Stun }) Start(a);
        ticker = new System.Threading.Timer(o => Tick(), null, 20, 20);
        var ui = new System.Windows.Forms.Timer { Interval = 500 };
        ui.Tick += (s, a) => Render();
        ui.Start();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (ticker != null) ticker.Dispose();
        base.OnFormClosed(e);
    }

    static void Start(ThreadStart a) { new Thread(a) { IsBackground = true }.Start(); }
    static void Put(byte[] b, int o, uint v) { b[o] = (byte)(v >> 24); b[o + 1] = (byte)(v >> 16); b[o + 2] = (byte)(v >> 8); b[o + 3] = (byte)v; }
    static uint Get(byte[] b, int o) { return (uint)(b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]); }
    static string Cut(string s) { return s.Length > 40 ? s.Substring(0, 40) + "…" : s; }

    // ---------- UI ----------

    void Connect()
    {
        var p = friend.Text.Trim().Split(':');
        IPAddress ip = null;
        int port = 0;
        bad = p.Length != 2 || !IPAddress.TryParse(p[0], out ip) || ip.AddressFamily != AddressFamily.InterNetwork ||
              !int.TryParse(p[1], out port) || port < 1 || port > 65535;
        lock (L)
        {
            peer = bad ? null : new IPEndPoint(ip, port);
            since = Now;
            Reset();
        }
        if (!bad)
            try { File.WriteAllText(cfg, friend.Text.Trim()); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        Render();
    }

    void Render()
    {
        string st, h;
        lock (L)
        {
            long now = Now;
            bool linked = Linked, hosting = now - localSeen < Stale;
            if (me != null && mine.Text != me.ToString()) mine.Text = me.ToString();
            st = me == null ? (now < 6000 ? "Узнаю свой адрес…" : "✗ Нет интернета или UDP заблокирован")
               : peer == null ? "Обменяйтесь адресами"
               : !linked ? "Соединяюсь с другом…"
               : "✓ Соединено напрямую · " + (srtt < 1 ? "<1" : srtt.ToString("0")) + " мс";
            if (bad) h = "Адрес друга выглядит так: 93.184.216.34:47474";
            else if (peer == null)
                h = "1. Скопируй «Мой адрес» и отправь другу.\n2. Вставь адрес друга и нажми «Соединить».\n" +
                    "Это делают оба. Адрес запоминается — в следующий раз просто запустите приложение.";
            else if (!linked)
                h = now - since < 8000 ? "Пробиваю прямое соединение…"
                  : "Друг должен запустить McNet и ввести твой адрес.\nАдреса меняются вместе с IP — сверьте их заново.";
            else if (hosting) h = "Твой мир «" + localMotd + "» виден другу в «Сетевой игре».";
            else if (peerMotd.Length > 0)
                h = "Мир друга «" + peerMotd + "» уже в Minecraft: «Сетевая игра».\nНе появился — «Прямое подключение» → localhost:" + tcpPort;
            else h = "Хост: в Minecraft Esc → «Открыть для сети» — мир сам появится у друга.";
            if (symmetric && !linked)
                h += "\n⚠ Твой роутер или провайдер выдаёт разные порты (симметричный NAT) — напрямую может не соединиться.";
            status.ForeColor = linked ? Color.ForestGreen : SystemColors.ControlText;
        }
        status.Text = st;
        hint.Text = h;
    }

    // ---------- discovery: local addresses, own LAN world, public address ----------

    void LoadNets()
    {
        var ips = new List<IPAddress>();
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (var u in ni.GetIPProperties().UnicastAddresses)
                {
                    if (u.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    ips.Add(u.Address);
                    try { lan.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.AddMembership, new MulticastOption(Group, u.Address)); }
                    catch (SocketException) { } // already joined or no multicast on this interface
                }
            }
        }
        catch (NetworkInformationException) { return; }
        lock (L) locals = ips;
    }

    // Minecraft announces an opened world on 224.0.2.60:4445 as "[MOTD]name[/MOTD][AD]port[/AD]" every 1.5 s.
    void Beacons()
    {
        var buf = new byte[1500];
        EndPoint ep = new IPEndPoint(IPAddress.Any, 0);
        while (true)
        {
            int n;
            try { n = lan.ReceiveFrom(buf, ref ep); }
            catch (SocketException) { continue; }
            catch (ObjectDisposedException) { return; }
            var m = Beacon.Match(Encoding.UTF8.GetString(buf, 0, n));
            int port;
            if (!m.Success || !int.TryParse(m.Groups[2].Value, out port) || port < 1 || port > 65535 || port == tcpPort) continue; // tcpPort: our own announcement
            lock (L)
                if (locals.Contains(((IPEndPoint)ep).Address)) { localPort = port; localMotd = Cut(m.Groups[1].Value); localSeen = Now; }
        }
    }

    // Asks public STUN servers how this socket looks from the Internet; different answers mean a symmetric NAT.
    void Stun()
    {
        var servers = new List<IPEndPoint>();
        var req = new byte[20];
        rnd.NextBytes(req);
        req[0] = 0; req[1] = 1; req[2] = 0; req[3] = 0; req[4] = 0x21; req[5] = 0x12; req[6] = 0xA4; req[7] = 0x42;
        while (true)
        {
            if (servers.Count == 0)
                foreach (var h in StunHosts)
                    try
                    {
                        var p = h.Split(':');
                        servers.Add(new IPEndPoint(Dns.GetHostAddresses(p[0]).First(a => a.AddressFamily == AddressFamily.InterNetwork), int.Parse(p[1])));
                    }
                    catch (SocketException) { }
                    catch (InvalidOperationException) { }
            foreach (var s in servers)
                try { udp.SendTo(req, s); } catch (SocketException) { }
            Thread.Sleep(me == null ? 1000 : 20000);
            lock (L)
            {
                if (mapped.Count > 0) { me = mapped.Values.First(); symmetric = mapped.Values.Distinct().Count() > 1; }
                mapped.Clear();
            }
        }
    }

    void OnStun(IPEndPoint from, byte[] b, int n)
    {
        if (n < 20 || b[0] != 1 || b[1] != 1) return; // binding success response
        for (int i = 20; i + 12 <= n; i += 4 + ((b[i + 2] << 8 | b[i + 3]) + 3 & ~3))
        {
            int type = b[i] << 8 | b[i + 1], port = b[i + 6] << 8 | b[i + 7];
            if (type != 0x20 && type != 1 || b[i + 5] != 1) continue; // (XOR-)MAPPED-ADDRESS, IPv4
            var a = new byte[4];
            Buffer.BlockCopy(b, i + 8, a, 0, 4);
            if (type == 0x20) { port ^= 0x2112; for (int j = 0; j < 4; j++) a[j] ^= b[4 + j]; }
            mapped[from] = new IPEndPoint(new IPAddress(a), port);
            return;
        }
    }

    // ---------- link: handshake, keep-alive, reliable ordered frames over UDP ----------

    // New link incarnation: fresh ids and sequence numbers, every tunnelled connection dropped.
    void Reset()
    {
        foreach (var c in conns.Values)
        {
            c.Closed = true;
            c.Out.CompleteAdding();
            if (c.Sock != null) c.Sock.Close();
        }
        conns.Clear(); flight.Clear(); ooo.Clear();
        sndNext = sndUna = rcvNext = peerId = 0;
        est = false;
        peerMotd = "";
        do myId = (uint)rnd.Next(); while (myId == 0);
        Monitor.PulseAll(L);
    }

    byte[] Make(byte type, int body)
    {
        var p = new byte[9 + body];
        p[0] = type; Put(p, 1, myId); Put(p, 5, peerId);
        return p;
    }

    void Tx(byte[] p) { try { if (peer != null) udp.SendTo(p, peer); } catch (SocketException) { } }
    void Resend(Pkt p) { p.Sent = Now; p.Tx++; p.Skip = 0; Tx(p.Buf); }

    void Rtt(double ms)
    {
        if (srtt < 0) { srtt = ms; rttvar = ms / 2; }
        else { rttvar = .75 * rttvar + .25 * Math.Abs(srtt - ms); srtt = .875 * srtt + .125 * ms; }
    }

    void Tick()
    {
        lock (L)
        {
            long now = Now;
            if (peer == null) return;
            double rto = Rto;
            foreach (var p in flight.Values)
                if (now - p.Sent > Math.Min(2000, rto * (1 << Math.Min(p.Tx - 1, 5)))) Resend(p);
            if (est && now - seen > 10000) Reset(); // peer vanished: start over
            if (now - lastPunch >= 500) // keeps the NAT hole open, measures ping, tells the peer about our world
            {
                lastPunch = now;
                var m = Encoding.UTF8.GetBytes(now - localSeen < Stale ? localMotd : "");
                var p = Make(Punch, 4 + m.Length);
                Put(p, 9, (uint)now);
                Buffer.BlockCopy(m, 0, p, 13, m.Length);
                Tx(p);
            }
            if (now - lastBeacon >= 1500 && Linked && peerMotd.Length > 0) // show the peer's world in this PC's LAN list
            {
                lastBeacon = now;
                var b = Encoding.UTF8.GetBytes("[MOTD]" + peerMotd + "[/MOTD][AD]" + tcpPort + "[/AD]");
                foreach (var ip in locals)
                    try
                    {
                        lan.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, ip.GetAddressBytes());
                        lan.SendTo(b, new IPEndPoint(Group, LanPort));
                    }
                    catch (SocketException) { }
            }
        }
    }

    void Receive()
    {
        var b = new byte[2048];
        EndPoint ep = new IPEndPoint(IPAddress.Any, 0);
        while (true)
        {
            int n;
            try { n = udp.ReceiveFrom(b, ref ep); }
            catch (SocketException) { continue; } // e.g. ICMP "port unreachable" while punching
            catch (ObjectDisposedException) { return; }
            var from = (IPEndPoint)ep;
            lock (L)
            {
                if (n > 0 && b[0] < 0x80) { OnStun(from, b, n); continue; }
                if (n < 13 || peer == null || !from.Address.Equals(peer.Address)) continue;
                uint src = Get(b, 1), dst = Get(b, 5);
                if (src == 0 || dst != 0 && dst != myId) continue;      // addressed to an older incarnation of this link
                if (src != peerId) { if (est) Reset(); peerId = src; lastPunch = 0; } // new or restarted peer: answer at once
                if (dst != myId) continue;                              // peer does not know our id yet: nothing but its id is usable
                if (!from.Equals(peer)) peer = from;                    // NAT gave the peer another port
                est = true;
                seen = Now;
                if (b[0] == Punch)
                {
                    peerMotd = Encoding.UTF8.GetString(b, 13, Math.Min(n - 13, 200));
                    var q = Make(Pong, 4);
                    Buffer.BlockCopy(b, 9, q, 9, 4);
                    Tx(q);
                }
                else if (b[0] == Pong) { uint ms = (uint)Now - Get(b, 9); if (ms < 10000) Rtt(ms); }
                else if (b[0] == Data && n >= 16) OnData(b, n);
                else if (b[0] == Ack && n >= 25) OnAck(b);
            }
        }
    }

    void OnData(byte[] b, int n)
    {
        uint seq = Get(b, 9);
        int d = (int)(seq - rcvNext);
        if (d >= 4096) return;
        if (d >= 0 && !ooo.ContainsKey(seq))
        {
            var f = new byte[n - 13];
            Buffer.BlockCopy(b, 13, f, 0, f.Length);
            ooo[seq] = f;
            while (ooo.TryGetValue(rcvNext, out f)) { ooo.Remove(rcvNext++); Deliver(f); }
        }
        var a = Make(Ack, 16); // next expected, the packet that triggered this ack, bitmap of the 64 packets after the gap
        ulong bits = 0;
        if (ooo.Count > 0)
            for (int i = 0; i < 64; i++)
                if (ooo.ContainsKey(rcvNext + 1 + (uint)i)) bits |= 1UL << i;
        Put(a, 9, rcvNext); Put(a, 13, seq); Put(a, 17, (uint)(bits >> 32)); Put(a, 21, (uint)bits);
        Tx(a);
    }

    void OnAck(byte[] b)
    {
        uint cum = Get(b, 9), trig = Get(b, 13), top = cum;
        ulong bits = (ulong)Get(b, 17) << 32 | Get(b, 21);
        if ((int)(sndNext - cum) < 0 || (int)(sndNext - trig) <= 0) return;
        Pkt p;
        if (flight.TryGetValue(trig, out p))
        {
            if (p.Tx == 1) Rtt(Now - p.Sent);
            flight.Remove(trig);
        }
        if ((int)(trig - top) > 0) top = trig;
        for (; (int)(cum - sndUna) > 0; sndUna++) flight.Remove(sndUna);
        for (int i = 0; i < 64; i++)
            if ((bits >> i & 1) != 0)
            {
                uint s = cum + 1 + (uint)i;
                flight.Remove(s);
                if ((int)(s - top) > 0) top = s;
            }
        // packets the receiver skipped over twice are lost: resend without waiting for the timeout
        for (uint s = sndUna; (int)(top - s) > 0; s++)
            if (flight.TryGetValue(s, out p) && ++p.Skip >= 2 && Now - p.Sent > Math.Max(10, srtt)) Resend(p);
        Monitor.PulseAll(L);
    }

    void Frame(int key, byte kind, byte[] d, int n)
    {
        var p = Make(Data, 7 + n);
        Put(p, 9, sndNext);
        p[13] = (byte)(key >> 8); p[14] = (byte)key; p[15] = (byte)(kind | (key > 0xFFFF ? 0x80 : 0));
        if (n > 0) Buffer.BlockCopy(d, 0, p, 16, n);
        flight[sndNext++] = new Pkt { Buf = p, Sent = Now };
        Tx(p);
    }

    // ---------- tunnelled TCP connections ----------

    void Deliver(byte[] f)
    {
        int key = f[0] << 8 | f[1] | ((f[2] & 0x80) != 0 ? 0 : 0x10000), kind = f[2] & 0x7F;
        Conn c;
        conns.TryGetValue(key, out c);
        if (kind == Open)
        {
            if (c != null || key > 0xFFFF) return;
            if (Now - localSeen >= Stale) { Frame(key, Fin, null, 0); return; } // no world is open here
            var s = conns[key] = new Conn { Key = key, Link = myId };
            int port = localPort;
            Start(() => Run(s, port));
        }
        else if (c == null) return;
        else if (kind == Fin) c.Out.CompleteAdding();
        else if (!c.Out.IsAddingCompleted)
        {
            var d = new byte[f.Length - 3];
            Buffer.BlockCopy(f, 3, d, 0, d.Length);
            c.Out.Add(d);
        }
    }

    // The friend's Minecraft connects here; the other side connects to its LAN world.
    void Accept()
    {
        while (true)
        {
            Socket sock;
            try { sock = tcp.AcceptSocket(); }
            catch (SocketException) { continue; }
            catch (ObjectDisposedException) { return; }
            Conn c;
            lock (L)
            {
                if (!Linked) { sock.Close(); continue; }
                c = new Conn { Key = 0x10000 | nextConn++ & 0xFFFF, Link = myId, Sock = sock };
                conns[c.Key] = c;
                Frame(c.Key, Open, null, 0);
            }
            Start(() => Run(c, 0));
        }
    }

    // Tunnel -> TCP. With a port, first connects to the local world.
    void Run(Conn c, int port)
    {
        try
        {
            if (port != 0)
            {
                var s = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                lock (L) c.Sock = s; // lets End()/Reset() abort the connect
                s.Connect(IPAddress.Loopback, port);
            }
            c.Sock.NoDelay = true;
            Start(() => Read(c));
            foreach (var d in c.Out.GetConsumingEnumerable()) c.Sock.Send(d);
        }
        catch (SocketException) { }
        catch (ObjectDisposedException) { }
        End(c);
    }

    // TCP -> tunnel. Blocks while the send window is full, which throttles the TCP side.
    void Read(Conn c)
    {
        var buf = new byte[Mss];
        try
        {
            int n;
            while ((n = c.Sock.Receive(buf)) > 0)
                lock (L)
                {
                    while (!c.Closed && flight.Count >= Window) Monitor.Wait(L, 1000);
                    if (c.Closed) break;
                    Frame(c.Key, Bytes, buf, n);
                }
        }
        catch (SocketException) { }
        catch (ObjectDisposedException) { }
        End(c);
    }

    void End(Conn c)
    {
        lock (L)
        {
            if (!c.Closed)
            {
                c.Closed = true;
                conns.Remove(c.Key);
                if (c.Link == myId && !c.Out.IsAddingCompleted) Frame(c.Key, Fin, null, 0); // the peer has not closed it yet
                c.Out.CompleteAdding();
                Monitor.PulseAll(L);
            }
            if (c.Sock != null) c.Sock.Close();
        }
    }

    [DllImport("user32")] static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main()
    {
        try { SetProcessDPIAware(); } catch (Exception) { } // not available outside Windows
        Application.EnableVisualStyles();
        Application.Run(new McNet());
    }
}
