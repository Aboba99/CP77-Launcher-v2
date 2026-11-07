// Minecraft LAN helper: finds a world opened with "Open to LAN", shows its address,
// re-broadcasts the beacon on every subnet (Wi-Fi often drops multicast) and checks reachability.
// Build: build.bat (uses csc from .NET Framework 4.x shipped with Windows). C# 5 only.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

sealed class McLan : Form
{
    const int LanPort = 4445; // Minecraft Java LAN discovery: 224.0.2.60:4445, "[MOTD]name[/MOTD][AD]port[/AD]"
    static readonly IPAddress Group = IPAddress.Parse("224.0.2.60");
    static readonly Regex Beacon = new Regex(@"\[MOTD\](.*?)\[/MOTD\]\[AD\](\d{1,5})\[/AD\]", RegexOptions.Singleline);
    static readonly TimeSpan Stale = TimeSpan.FromSeconds(5); // Minecraft announces every 1.5 s

    readonly Label status = new Label(), hint = new Label();
    readonly TextBox addr = new TextBox();
    readonly Button copy = new Button(), check = new Button(), fw = new Button();
    readonly UdpClient listen = new UdpClient(), relay = new UdpClient(0) { EnableBroadcast = true };
    readonly int relayPort;

    List<IPAddress> locals = new List<IPAddress>(), bcasts = new List<IPAddress>();
    IPAddress myIp, hostIp;
    int hostPort;
    bool isHost;
    string motd;
    byte[] beacon;
    DateTime seen;

    McLan()
    {
        float k;
        using (var g = CreateGraphics()) k = g.DpiX / 96f;
        Func<int, int> S = v => (int)(v * k);
        Text = "Minecraft LAN";
        Font = new Font("Segoe UI", 10f);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        StartPosition = FormStartPosition.CenterScreen;

        var t = new TableLayoutPanel { AutoSize = true, ColumnCount = 3, Padding = new Padding(S(10)) };
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, S(270)));
        t.ColumnStyles.Add(new ColumnStyle());
        t.ColumnStyles.Add(new ColumnStyle());
        status.Font = new Font(Font.FontFamily, 12f, FontStyle.Bold);
        hint.ForeColor = SystemColors.GrayText;
        foreach (var l in new[] { status, hint })
        {
            l.AutoSize = true;
            l.MaximumSize = new Size(S(470), 0);
            l.Margin = new Padding(3, 3, 3, S(8));
        }
        addr.Font = new Font("Consolas", 14f);
        addr.Dock = DockStyle.Fill;
        copy.Text = "Копировать";
        check.Text = "Проверить";
        fw.Text = "Настроить брандмауэр";
        foreach (var b in new[] { copy, check, fw }) b.AutoSize = true;
        t.Controls.Add(status, 0, 0); t.SetColumnSpan(status, 3);
        t.Controls.Add(addr, 0, 1);
        t.Controls.Add(copy, 1, 1);
        t.Controls.Add(check, 2, 1);
        t.Controls.Add(hint, 0, 2); t.SetColumnSpan(hint, 3);
        t.Controls.Add(fw, 0, 3);
        Controls.Add(t);

        copy.Click += (s, e) => { if (addr.Text.Length > 0) Clipboard.SetText(addr.Text); };
        check.Click += (s, e) => Check();
        fw.Click += (s, e) => Firewall();
        addr.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; Check(); } };

        relayPort = ((IPEndPoint)relay.Client.LocalEndPoint).Port;
        listen.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        try { listen.Client.Bind(new IPEndPoint(IPAddress.Any, LanPort)); }
        catch (SocketException ex) { status.Text = "Порт " + LanPort + " занят: " + ex.Message; return; }
        LoadNets();
        NetworkChange.NetworkAddressChanged += (s, e) => BeginInvoke((Action)LoadNets);
        var timer = new System.Windows.Forms.Timer { Interval = 1500 };
        timer.Tick += (s, e) => Tick();
        timer.Start();
        Render();
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (listen.Client.IsBound) new Thread(Receive) { IsBackground = true }.Start();
    }

    // Local IPv4 addresses, their directed broadcasts, and the main IP (interface with a gateway).
    void LoadNets()
    {
        var ips = new List<IPAddress>();
        var bc = new List<IPAddress> { IPAddress.Broadcast };
        IPAddress main = null;
        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            var p = ni.GetIPProperties();
            bool gw = p.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any));
            foreach (var u in p.UnicastAddresses)
            {
                if (u.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                ips.Add(u.Address);
                if (gw && main == null) main = u.Address;
                if (u.IPv4Mask != null && !u.IPv4Mask.Equals(IPAddress.Any))
                {
                    byte[] a = u.Address.GetAddressBytes(), m = u.IPv4Mask.GetAddressBytes();
                    for (int i = 0; i < 4; i++) a[i] |= (byte)~m[i];
                    bc.Add(new IPAddress(a));
                }
                try { listen.Client.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.AddMembership, new MulticastOption(Group, u.Address)); }
                catch (SocketException) { } // already joined or no multicast on this interface
            }
        }
        locals = ips;
        bcasts = bc.Distinct().ToList();
        myIp = main ?? ips.FirstOrDefault(a => !a.ToString().StartsWith("169.254.")) ?? ips.FirstOrDefault();
        Render();
    }

    void Receive()
    {
        var ep = new IPEndPoint(IPAddress.Any, 0);
        while (true)
        {
            byte[] d;
            try { d = listen.Receive(ref ep); }
            catch (SocketException) { continue; }
            catch (ObjectDisposedException) { return; }
            var m = Beacon.Match(Encoding.UTF8.GetString(d));
            int port;
            if (!m.Success || !int.TryParse(m.Groups[2].Value, out port) || port < 1 || port > 65535) continue;
            var from = ep;
            string name = m.Groups[1].Value;
            try { BeginInvoke((Action)(() => OnBeacon(from, name, port, d))); }
            catch (InvalidOperationException) { return; } // form closed
        }
    }

    void OnBeacon(IPEndPoint from, string name, int port, byte[] data)
    {
        bool local = locals.Contains(from.Address);
        if (local && from.Port == relayPort) return; // our own relay echo
        bool changed = !from.Address.Equals(hostIp) || port != hostPort || name != motd;
        hostIp = from.Address; hostPort = port; motd = name; isHost = local; beacon = data;
        seen = DateTime.UtcNow;
        if (!changed) return;
        Render();
        if (!isHost) Check();
    }

    void Tick()
    {
        if (hostIp == null) return;
        if (DateTime.UtcNow - seen > Stale) { hostIp = null; Render(); return; }
        if (!isHost) return;
        foreach (var b in bcasts)
            try { relay.Send(beacon, beacon.Length, new IPEndPoint(b, LanPort)); }
            catch (SocketException) { }
    }

    void Render()
    {
        string me = myIp == null ? "нет сети" : myIp.ToString();
        status.ForeColor = hostIp == null ? SystemColors.ControlText : Color.ForestGreen;
        check.Visible = !isHost || hostIp == null;
        if (hostIp == null)
        {
            status.Text = "Ищу открытый мир…";
            hint.Text = "Хост: в Minecraft Esc → «Открыть для сети».\nЗапусти это приложение на обоих ПК — дальше всё само.\n" +
                        "Можно ввести адрес вручную и нажать «Проверить».\nМой IP: " + me;
        }
        else if (isHost)
        {
            status.Text = "✓ Мир «" + motd + "» открыт на этом ПК";
            addr.Text = me + ":" + hostPort;
            hint.Text = "Мир сам появится у подруги в «Сетевой игре» (приложение дублирует сигнал для Wi-Fi). " +
                        "Если нет — «Прямое подключение» → адрес выше.\nНе пускает? Нажми «Настроить брандмауэр» (после каждого открытия мира).";
        }
        else
        {
            status.Text = "✓ Найден мир «" + motd + "»";
            addr.Text = hostIp + ":" + hostPort;
        }
    }

    async void Check()
    {
        var parts = addr.Text.Trim().Split(':');
        IPAddress ip;
        int port = 25565;
        if (parts.Length > 2 || !IPAddress.TryParse(parts[0], out ip) || parts.Length == 2 && !int.TryParse(parts[1], out port))
        {
            hint.Text = "Введи адрес вида 192.168.1.5:54321";
            return;
        }
        check.Enabled = false;
        hint.Text = "Проверяю связь с " + ip + ":" + port + "…";
        bool ok = await Task.Run(() =>
        {
            using (var c = new TcpClient())
                try { return c.ConnectAsync(ip, port).Wait(2000) && c.Connected; }
                catch (Exception) { return false; }
        });
        check.Enabled = true;
        hint.Text = ok
            ? "✓ Связь есть. Мир появится в «Сетевой игре»; если нет — «Прямое подключение» → этот адрес."
            : "✗ Нет связи. На ПК хоста нажми «Настроить брандмауэр» в этом приложении.\n" +
              "Не помогло — проверь, что оба в одной сети, и выключи в роутере «изоляцию клиентов» (AP isolation).";
    }

    // Removes inbound Java block rules (left after "Cancel" in the Windows prompt) and allows LAN discovery + the world port.
    async void Firewall()
    {
        string ps = "Get-NetFirewallApplicationFilter|?{$_.Program -like '*java*'}|Get-NetFirewallRule|" +
                    "?{$_.Direction -eq 'Inbound' -and $_.Action -eq 'Block'}|Remove-NetFirewallRule;" +
                    "Remove-NetFirewallRule -DisplayName 'Minecraft LAN' -EA 0;" +
                    "New-NetFirewallRule -DisplayName 'Minecraft LAN' -Direction Inbound -Protocol UDP -LocalPort " + LanPort + " -Action Allow -EA Stop|Out-Null;" +
                    (isHost && hostIp != null
                        ? "New-NetFirewallRule -DisplayName 'Minecraft LAN' -Direction Inbound -Protocol TCP -LocalPort " + hostPort + " -Action Allow -EA Stop|Out-Null;"
                        : "");
        fw.Enabled = false;
        try
        {
            using (var p = Process.Start(new ProcessStartInfo("powershell", "-NoProfile -ExecutionPolicy Bypass -Command \"try{" + ps + "exit 0}catch{exit 1}\"")
                   { Verb = "runas", UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden }))
            {
                await Task.Run(() => p.WaitForExit());
                hint.Text = p.ExitCode == 0 ? "✓ Брандмауэр настроен." : "✗ Не удалось настроить брандмауэр.";
            }
        }
        catch (Win32Exception) { hint.Text = "Нужны права администратора — подтверди запрос Windows."; }
        fw.Enabled = true;
    }

    [DllImport("user32")] static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main()
    {
        try { SetProcessDPIAware(); } catch (Exception) { } // not available outside Windows
        Application.EnableVisualStyles();
        Application.Run(new McLan());
    }
}
