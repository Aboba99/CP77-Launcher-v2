// Command rngaudit is a Windows desktop wrapper around the ROB RUN RNG audit page.
//
// The page is embedded in the binary, written to %LOCALAPPDATA%\ROBRUN-RNG-Audit
// on start, and shown in a native WebView2 window. Loading it from a stable
// file:// path keeps localStorage (the spin history) across launches. If the
// WebView2 runtime is missing, the page opens in the default browser instead.
package main

import (
	_ "embed"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"github.com/jchv/go-webview2"
)

//go:embed index.html
var page []byte

const appName = "ROBRUN-RNG-Audit"

func main() {
	base, err := os.UserCacheDir() // %LOCALAPPDATA% on Windows
	if err != nil {
		base = os.TempDir()
	}
	dir := filepath.Join(base, appName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fatal("Не удалось создать папку приложения:\n" + err.Error())
	}
	htmlPath := filepath.Join(dir, "index.html")
	if err := os.WriteFile(htmlPath, page, 0o644); err != nil {
		fatal("Не удалось записать страницу:\n" + err.Error())
	}
	pageURL := (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(htmlPath)}).String()

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(dir, "webview"),
		WindowOptions: webview2.WindowOptions{
			Title:  "Аудит рулетки ROB RUN",
			Width:  1280,
			Height: 860,
			Center: true,
		},
	})
	if w == nil {
		// No WebView2 runtime (rare on Windows 10/11): fall back to the default browser.
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", htmlPath).Start()
		return
	}
	defer w.Destroy()
	w.Navigate(pageURL)
	w.Run()
}

func fatal(msg string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	title, _ := syscall.UTF16PtrFromString("Аудит рулетки ROB RUN")
	text, _ := syscall.UTF16PtrFromString(msg)
	const mbIconError = 0x10
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), mbIconError)
	os.Exit(1)
}
