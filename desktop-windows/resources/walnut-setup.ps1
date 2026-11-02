# Walnut for Windows: what the Walnut app runs, hidden, to set Walnut up on this PC.
# WALNUT_APP_MODE=own: Walnut of its own, its console in the app's window. WALNUT_APP_MODE=join:
# this PC joins a Walnut, with WALNUT_JOIN_LINK (an invite link) or WALNUT_JOIN_TICKET.
# Walnut runs inside WSL (Linux beside Windows), in its own Linux called OpenWalnut; your
# other WSL Linuxes are not touched. No administrator is needed, except to turn WSL on.
& {
# A profile's strict mode would stop at $IsWindows, unset in Windows PowerShell 5.1.
Set-StrictMode -Off
# Not 'Stop': Windows PowerShell 5.1 turns a native command's stderr into a terminating
# error under it. Every step checks its own result instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$env:WSL_UTF8 = '1'
$Distro = 'OpenWalnut'

function Step([string]$label, [string]$text) { Write-Host ('  ' + ($label + ' ').PadRight(19, '.') + ' ' + $text) }
function Say-Stop([string]$text) { Write-Host ''; Write-Host $text -ForegroundColor Red }
function Lines($out) { @($out | ForEach-Object { ([string]$_ -replace [char]0, '').Trim() } | Where-Object { $_ }) }
# A Linux command in OpenWalnut: sh -c with the script as base64, so nothing is quoted twice.
function In-Linux([string]$user, [string]$script) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($script -replace "`r", '')))
  # Out-Host: its lines are shown, never taken as this function's result.
  & wsl.exe -d $Distro -u $user --cd '~' --exec sh -c "echo $b64 | base64 -d | sh" | Out-Host
  return $LASTEXITCODE
}

function Join-Walnut {
  if ($env:WALNUT_APP_MODE -eq 'own') { Write-Host 'Walnut: setting Walnut up on this PC' } else { Write-Host 'Walnut: adding this PC to your Walnut machines' }
  $mode = [string]$env:WALNUT_APP_MODE
  $link = [string]$env:WALNUT_JOIN_LINK
  $t = [string]$env:WALNUT_JOIN_TICKET
  if ($mode -eq 'join') {
    if ($link) { if ($link -notmatch '^https://[A-Za-z0-9.-]+(:[0-9]+)?/join/[A-Za-z0-9-]+$') { Say-Stop 'That is not a Walnut invite link. Paste the link your Mac shows under Settings > Remote Hosts > Add a machine.'; return 1 } }
    elseif ($t -notmatch '^wn1-[A-Za-z0-9_-]+$') { Say-Stop 'Paste the link your Mac shows under Settings > Remote Hosts > Add a machine.'; return 1 }
  } elseif ($mode -ne 'own') { Say-Stop 'WALNUT_APP_MODE is own or join.'; return 1 }
  # $IsWindows is unset in Windows PowerShell 5.1 and false only in PowerShell on Linux or
  # macOS, where the tests run this script against a stand-in wsl.exe.
  $onWindows = $IsWindows -ne $false
  if ($onWindows -and [Environment]::OSVersion.Version.Build -lt 19041) { Say-Stop 'Walnut needs Windows 10 version 2004 or newer (it runs in WSL 2).'; return 1 }
  $arch = 'amd64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }

  # 1. WSL itself, new enough to run systemd (the Linux service that keeps Walnut running).
  $ver = Lines (& wsl.exe --version 2>$null) | Select-Object -First 1
  if ($LASTEXITCODE -ne 0 -or -not $ver) {
    & wsl.exe --status *> $null
    if ($LASTEXITCODE -eq 0) {
      Step 'WSL' 'too old for Walnut: Windows asks you next to let it update (an administrator prompt)'
      $p = $null
      try { $p = Start-Process wsl.exe -ArgumentList '--update' -Verb RunAs -Wait -PassThru } catch { Say-Stop 'WSL was not updated (the prompt was declined). Run "wsl --update" yourself, then try again.'; return 1 }
      $ver = Lines (& wsl.exe --version 2>$null) | Select-Object -First 1
      if ($LASTEXITCODE -ne 0 -or -not $ver) { Say-Stop 'WSL is still too old. Run "wsl --update" in PowerShell, then try again.'; return 1 }
    } else {
      Step 'WSL' 'not on this PC: Windows asks you next to turn it on (an administrator prompt)'
      $p = $null
      try { $p = Start-Process wsl.exe -ArgumentList '--install', '--no-distribution' -Verb RunAs -Wait -PassThru } catch { Say-Stop 'WSL was not turned on (the prompt was declined). Try again when you want to.'; return 1 }
      # 3010: done, after a restart.
      if ($p -and $p.ExitCode -notin 0, 3010) { Say-Stop ('Windows could not turn WSL on (wsl --install exited ' + $p.ExitCode + '). Turn on virtualization in the PC''s firmware settings if it is off, or run "wsl --install" yourself, then try again.'); return 1 }
      Say-Stop 'WSL is on. Restart Windows, then open Walnut again.'
      return 3
    }
  }
  Step 'WSL' ('ready (' + ($ver -replace '^[^0-9]*', '') + ')')

  # 2. Its own Linux, from Ubuntu's WSL image (checked against its pinned checksum).
  $have = (Lines (& wsl.exe --list --quiet 2>$null)) -contains $Distro
  if (-not $have) {
    $rootfs = $env:WALNUT_WSL_ROOTFS
    $dl = $null
    if (-not $rootfs) {
      $img = @{ amd64 = @{ url = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/20240423/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'; sha = '8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea' }; arm64 = @{ url = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/20240423/ubuntu-noble-wsl-arm64-wsl.rootfs.tar.gz'; sha = 'fecec1d9b7b750c12c109edb49c13c1006f4a2efabb9b8bf341f11c4c9f2ef11' } }[$arch]
      Step 'Linux' 'downloading Ubuntu 24.04 for WSL (about 350 MB)'
      $dl = Join-Path $env:TEMP ('openwalnut-rootfs-' + $arch + '.tar.gz')
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
      try { Invoke-WebRequest -UseBasicParsing -Uri $img.url -OutFile $dl -ErrorAction Stop } catch { Say-Stop ('The Ubuntu download failed: ' + $_.Exception.Message + '. Try again.'); return 1 }
      # .NET, not Get-FileHash: that one is a script function of a module a Windows PowerShell
      # started from PowerShell 7 cannot load, and then it is missing (2026-11-02, CI).
      $sha = [Security.Cryptography.SHA256]::Create(); $fs = [IO.File]::OpenRead($dl)
      try { $got = -join ($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) } finally { $fs.Dispose(); $sha.Dispose() }
      if ($got -ne $img.sha) { Remove-Item $dl -Force; Say-Stop 'The Ubuntu download did not match its checksum (a broken or tampered copy); nothing was changed. Try again.'; return 1 }
      $rootfs = $dl
    }
    $dir = Join-Path $env:LOCALAPPDATA ('OpenWalnut\wsl\' + $Distro)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    & wsl.exe --import $Distro $dir $rootfs --version 2 | Out-Null
    $code = $LASTEXITCODE
    if ($dl) { Remove-Item $dl -Force -ErrorAction SilentlyContinue }
    if ($code -ne 0) { Say-Stop ('WSL could not make the ' + $Distro + ' Linux (wsl --import exited ' + $code + ').'); return 1 }
  }
  $user = (([string]$env:USERNAME).ToLower() -replace '[^a-z0-9_-]', '')
  if ($user -notmatch '^[a-z_][a-z0-9_-]{0,30}$' -or $user -eq 'root') { $user = 'walnut' }
  # Its user: named after the Windows one unless that is a system account's name, with a uid
  # from 1500 up, so its daemon's instance lock (a loopback port from uid and directory, and
  # every WSL Linux shares one loopback) never meets a Walnut's in the user's own WSL Linux.
  $setup = "u='" + $user + "'" + "`n" + @'
set -e
if id -u "$u" >/dev/null 2>&1; then [ "$(id -u "$u")" -ge 1000 ] || u=walnut; fi
id -u "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash -K UID_MIN=1500 "$u"
printf '[boot]\nsystemd=true\n[user]\ndefault=%s\n[interop]\nappendWindowsPath=false\n' "$u" > /etc/wsl.conf.new
echo "user=$u"
if ! cmp -s /etc/wsl.conf.new /etc/wsl.conf; then mv /etc/wsl.conf.new /etc/wsl.conf; echo restart; else rm -f /etc/wsl.conf.new; fi
'@
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($setup -replace "`r", '')))
  $said = Lines (& wsl.exe -d $Distro -u root --exec sh -c "echo $b64 | base64 -d | sh")
  if ($LASTEXITCODE -ne 0) { Say-Stop ('Setting up the ' + $Distro + ' Linux failed.'); return 1 }
  $named = @($said | Where-Object { $_ -like 'user=*' }) | Select-Object -First 1
  if ($named) { $user = $named.Substring(5) }
  # systemd starts with the Linux, so a changed wsl.conf needs one restart of it.
  if ($said -contains 'restart') { & wsl.exe --terminate $Distro | Out-Null }
  $boot = "timeout 120 systemctl is-system-running --wait >/dev/null 2>&1; loginctl enable-linger $user; test -d /run/systemd/system"
  if ((In-Linux 'root' $boot) -ne 0) { Say-Stop ('systemd did not start in the ' + $Distro + ' Linux; Walnut needs it to keep running.'); return 1 }
  Step 'Linux' ($Distro + ' ready (Ubuntu 24.04, user ' + $user + ')')

  # 3. Start it with Windows: WSL stops a Linux nobody holds open, so start.ps1 holds it, run
  # by a sign-in item (and, from the invite, by "Open Walnut" in the Start menu; per user, no administrator).
  $lnk = ''
  if ($onWindows) {
    $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Open Walnut.lnk'
    $owDir = Join-Path $env:LOCALAPPDATA 'OpenWalnut'
    New-Item -ItemType Directory -Force -Path $owDir | Out-Null
    $start = Join-Path $owDir 'start.ps1'
    Set-Content -Path $start -Encoding UTF8 -Value @'
param([switch]$Show, [switch]$Hold)
# Walnut on this PC runs in WSL, in the OpenWalnut Linux. Made by Walnut's join; run at sign-in.
$Distro = 'OpenWalnut'
$env:WSL_UTF8 = '1'
function Test-Hold { try { ([Threading.Mutex]::OpenExisting('Local\OpenWalnutHold')).Dispose(); $true } catch { $false } }
if ($Hold) {
  $m = New-Object Threading.Mutex($false, 'Local\OpenWalnutHold')
  $mine = $false
  try { $mine = $m.WaitOne(0) } catch [Threading.AbandonedMutexException] { $mine = $true }
  if (-not $mine) { return }
  # Until the Linux is taken off this PC (wsl --unregister). Read from the registry, not from
  # wsl.exe, which says nothing while WSL updates.
  $registered = { @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue | ForEach-Object { (Get-ItemProperty $_.PSPath).DistributionName }) -contains $Distro }
  while (& $registered) {
    & wsl.exe -d $Distro --exec sleep infinity
    Start-Sleep -Seconds 30
  }
  return
}
if (-not (Test-Hold)) {
  $holdArgs = '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $PSCommandPath + '"'), '-Hold'
  if ($env:SSH_CONNECTION) {
    # Over SSH, Windows ends every process of the session when it closes, and the hold with it.
    # A process WMI starts is not the session's, so it outlives it (2026-11-02, a PC joined over SSH).
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $ps + '" ' + ($holdArgs -join ' ')); CurrentDirectory = $env:SystemRoot } | Out-Null
  } else {
    Start-Process powershell.exe -WindowStyle Hidden -WorkingDirectory $env:SystemRoot -ArgumentList $holdArgs
  }
}
if ($Show) {
  Write-Host ('Walnut runs on this PC (in WSL, the ' + $Distro + ' Linux) and starts by itself when you sign in to Windows.')
  Write-Host ''
  & wsl.exe -d $Distro --cd '~' --exec sh -c 'echo IiRIT01FLy5sb2NhbC9zaGFyZS9vcGVuLXdhbG51dC9iaW4vd2FsbnV0IiBuZXQgc3RhdHVzCg== | base64 -d | sh'
  Write-Host ''
  Read-Host 'Press Enter to close' | Out-Null
}
'@
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $run = '"' + $ps + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $start + '"'
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'OpenWalnut' -Value $run -PropertyType String -Force | Out-Null
    Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
    $lnk = ''
    & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $start
    $held = $false
    for ($i = 0; $i -lt 30 -and -not $held; $i++) {
      try { ([Threading.Mutex]::OpenExisting('Local\OpenWalnutHold')).Dispose(); $held = $true } catch { Start-Sleep -Milliseconds 500 }
    }
    if ($held) { Step 'Start with Windows' 'on (a sign-in item)' }
    else { Step 'Start with Windows' 'not started: a script policy on this PC kept start.ps1 from running, so WSL soon stops Walnut and it does not start with Windows.' }
  }
  Write-Host ''

  # 4. The same join a Linux machine runs.
  if ($mode -eq 'own') {
    $inner = @'
W="${OPEN_WALNUT_INSTALL_DIR:-$HOME/.local/share/open-walnut}/bin/walnut"
if [ ! -x "$W" ]; then
  printf '  Walnut ............ installing\n'
  # Fetched first: `curl | sh` reads a failed download as an empty script and succeeds.
  f=$(mktemp)
  if ! curl -fsSL "${WALNUT_JOIN_INSTALL_URL:-https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh}" -o "$f"; then rm -f "$f"; echo "Could not download Walnut's installer (above). Check this PC is online, then try again."; exit 1; fi
  if ! OPEN_WALNUT_MODIFY_PATH=0 sh "$f" > "$f.log" 2>&1 < /dev/null; then cat "$f.log"; rm -f "$f" "$f.log"; echo 'Walnut did not install (above).'; exit 1; fi
  rm -f "$f" "$f.log"
  [ -x "$W" ] || { echo "Walnut installed, but not in $W."; exit 1; }
fi
printf '  Walnut ............ installed (%s)\n' "$("$W" --version 2>/dev/null | head -n 1)"
unit="$HOME/.config/systemd/user/open-walnut-web.service"
mkdir -p "$(dirname "$unit")"
printf '[Unit]\nDescription=Walnut (its console shows in the Walnut app on Windows)\n\n[Service]\nExecStart=%s web --port 3456\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n' "$W" > "$unit.new"
changed=0
if cmp -s "$unit.new" "$unit"; then rm -f "$unit.new"; else mv "$unit.new" "$unit"; changed=1; fi
# Right after the Linux started, its user manager may not answer yet.
i=0; while [ ! -S "$XDG_RUNTIME_DIR/bus" ] && [ "$i" -lt 30 ]; do i=$((i + 1)); sleep 1; done
[ "$changed" = 0 ] || systemctl --user daemon-reload
systemctl --user enable open-walnut-web.service > /dev/null 2>&1 || { echo 'Walnut could not be made a service (systemctl --user enable).'; exit 1; }
# A changed unit (a new place for Walnut) restarts a server that runs; otherwise start one that does not.
if [ "$changed" = 1 ]; then act=restart; else act=start; fi
systemctl --user "$act" open-walnut-web.service || { echo 'Walnut could not start as a service (above).'; exit 1; }
# Counted and timed: a server that takes connections and never answers costs 5 minutes, not 30.
# Quiet while it waits (each refused try is the wait, not a fault); the service's own log says why at the end.
i=0; end=$(($(date +%s) + 300))
until curl -fs -o /dev/null --max-time 5 http://127.0.0.1:3456/api/config; do
  i=$((i + 1))
  if [ "$i" -ge 300 ] || [ "$(date +%s)" -ge "$end" ]; then journalctl --user -u open-walnut-web.service -n 30 --no-pager; echo 'Walnut did not start (above).'; exit 1; fi
  sleep 1
done
# Every WSL Linux shares one network: the answer may be another Walnut on the port (one in
# the PC's own Linux). It is this one only when the listener is in this unit; a process of
# another Linux shows no pid here.
if command -v ss > /dev/null 2>&1; then
  lp=$(ss -ltnpH "sport = :3456" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\),.*/\1/p' | head -n 1)
  if [ -z "$lp" ] || ! grep -qs open-walnut-web.service "${WALNUT_PROC_DIR:-/proc}/$lp/cgroup"; then
    systemctl --user disable --now open-walnut-web.service > /dev/null 2>&1
    echo 'Port 3456 is taken by another program on this PC (another Walnut, in a WSL Linux or on Windows). Stop it, then try again.'
    exit 1
  fi
fi
printf '  Walnut ............ running\n'
'@
  } elseif ($link) {
    $inner = 'f=$(mktemp) && curl -fsSL ''' + $link + ''' -o "$f" && sh "$f"; c=$?; rm -f "$f"; exit $c'
  } else {
    $sh = $env:WALNUT_JOIN_SCRIPT_URL
    if (-not $sh) { $sh = 'https://github.com/EvanZhang008/open-walnut/releases/latest/download/join.sh' }
    $inner = 'f=$(mktemp) && curl -fsSL ''' + $sh + ''' -o "$f" && sh "$f" ' + $t + '; c=$?; rm -f "$f"; exit $c'
  }
  $pass = @()
  foreach ($k in 'WALNUT_JOIN_INSTALL_URL', 'OPEN_WALNUT_RELEASE_BASE_URL', 'OPEN_WALNUT_VERSION') { if ((Get-Item "env:$k" -ErrorAction SilentlyContinue)) { $pass += "$k/u" } }
  if ($pass.Count) { $env:WSLENV = (@($pass) + @($env:WSLENV | Where-Object { $_ })) -join ':' }
  $code = In-Linux $user ('export XDG_RUNTIME_DIR=/run/user/$(id -u)' + "`n" + $inner + "`n")
  if ($code -ne 0) { if ($mode -eq 'own') { Say-Stop ('Walnut did not start in the ' + $Distro + ' Linux (above). Try again.') } else { Say-Stop ('The join in the ' + $Distro + ' Linux stopped (above). Try again, or make a new link on your Mac if it says the link is used or old.') }; if ($code -eq 3) { $code = 1 }; return $code }
  Write-Host ''
  if ($mode -eq 'own') { Write-Host ('Walnut runs on this PC, in WSL (the ' + $Distro + ' Linux).') } else { Write-Host ('This PC is one of your Walnut machines now. It runs Walnut in WSL, in the ' + $Distro + ' Linux.') }
  return 0
}

$code = 1
try { $code = [int](@(Join-Walnut)[-1]) } catch { Say-Stop ('Walnut could not join this PC: ' + $_.Exception.Message) }
$global:LASTEXITCODE = $code
if ($PSCommandPath) { exit $code }
}
