# Walnut for Windows

One file a person downloads and double-clicks: `Walnut-Setup-x64.exe`. It installs itself (one
click, per user, no administrator), puts Walnut in the Start menu and on the desktop, and opens
the Walnut window. Like the Mac app (`desktop/`), the window is thin and all the product lives
in Walnut itself.

Walnut runs on Windows inside WSL (Linux beside Windows), in a Linux of its own called
`OpenWalnut`, so the person's own WSL Linuxes are never touched. The first open sets it up
with the same PowerShell steps as the invite line in Settings > Remote Hosts > Add a machine
(`src/core/net/net-join-ps1.ts` `appScriptWindows`, carried here as
`resources/walnut-setup.ps1`), run hidden and shown as four steps:

1. WSL, new enough for systemd. A PC without it asks once for an administrator to turn it on,
   then for a restart; the next open carries on.
2. The OpenWalnut Linux, from Ubuntu's WSL image (checked against its pinned checksum).
3. A sign-in item that keeps that Linux running (`%LOCALAPPDATA%\OpenWalnut\start.ps1`).
4. Then one of two:
   - **Use Walnut on this PC**: Walnut installed in the Linux (`install.sh`), its server a
     systemd user service there (`open-walnut-web.service`, port 3456), and its console in the
     window at `http://localhost:3456` (WSL forwards Windows' localhost into the Linux). It
     keeps serving while the window is closed.
   - **Add this PC to my Walnut**: the same join a Linux machine runs, with the link (or the
     ticket) the Mac shows. The window then shows the This PC page.

What the app remembers is `%LOCALAPPDATA%\OpenWalnut\app.json`; its log is `app.log` beside
it. A PC that joined with the PowerShell line before the app is recognized from its Linux.

## Not signed (yet)

The installer is not code signed, so Windows asks before the first run: Edge may say the file
"isn't commonly downloaded" (Keep, then Keep anyway), and SmartScreen says "Windows protected
your PC" (More info, then Run anyway). Windows 11 with Smart App Control on blocks an unsigned
file outright; the PowerShell line in Settings works there. Free ways to sign are a Microsoft
Store listing (MSIX, signed by the Store) or the SignPath Foundation; paid ones are Azure
Artifact Signing or a code signing certificate.

## Build

```bash
cd desktop-windows
npm ci
npm run dist        # Windows only (NSIS needs Windows, or wine): dist/Walnut-Setup-x64.exe
npm run typecheck
```

`.github/workflows/windows-app.yml` builds it on a Windows runner and runs
`test/double-click.ps1`: the download, a double-click in Explorer, SmartScreen, setup and the
console in the window, recorded. For a stable release it attaches the installer and
`latest.yml` (what the app's updater reads) to the release, so
`releases/latest/download/Walnut-Setup-x64.exe` is always the newest. A build with version
0.0.0 (a test build) never updates itself.

## Take it off a PC

Apps > Installed apps > Walnut > Uninstall removes the app. Walnut's Linux and its data stay;
to remove them too, in PowerShell: `wsl --unregister OpenWalnut`, then
`Remove-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run OpenWalnut` and
`Remove-Item -Recurse "$env:LOCALAPPDATA\OpenWalnut"`.
