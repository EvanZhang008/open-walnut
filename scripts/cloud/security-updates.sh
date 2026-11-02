#!/usr/bin/env bash
# Daily security updates for the companion (and any Linux box Walnut sets up), applied
# for real and followed by a reboot only when an update needs one.
#
# Why not just dnf-automatic: Amazon Linux 2023 pins its package repositories to the
# release the AMI shipped with, so `dnf upgrade` there (dnf-automatic included) sees no
# newer packages at all; updates arrive only with `--releasever=latest`. A companion with
# dnf-automatic on for months still had every advisory open (2026-11-02), and nothing
# rebooted it into the kernels it did have. So on dnf this installs its own unit:
#
#   walnut-security-update.timer    daily at UPDATE_AT (UTC), a few minutes of spread
#   walnut-security-update.service  dnf upgrade --security --releasever=latest, then a
#                                   reboot only when `needs-restarting -r` says one is due
#
# and turns dnf-automatic.timer off so the two never race. On apt (Ubuntu) the stock
# unattended-upgrades does see new packages; it gets the reboot it lacks, at UPDATE_AT.
# Every Walnut service is enabled, so it comes back by itself after the reboot.
#
# Usage (root): security-updates.sh [dnf|apt]     safe to re-run
# Knobs: UPDATE_AT (HH:MM, UTC, default 10:30), ROOT (a prefix, for tests: files are
# written under it and nothing is enabled), SYSTEMCTL (default systemctl).
set -euo pipefail

PKG="${1:-}"
if [ -z "$PKG" ]; then
  if command -v dnf >/dev/null 2>&1; then PKG=dnf; else PKG=apt; fi
fi
UPDATE_AT="${UPDATE_AT:-10:30}"
ROOT="${ROOT:-}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
if ! [[ "$UPDATE_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
  echo "security-updates: UPDATE_AT must be HH:MM (UTC), got '$UPDATE_AT'" >&2
  exit 2
fi

UNIT_DIR="$ROOT/etc/systemd/system"
BIN="$ROOT/usr/local/sbin/walnut-security-update"
mkdir -p "$UNIT_DIR" "$(dirname "$BIN")"

if [ "$PKG" = dnf ]; then
  cat > "$BIN" <<'EOF'
#!/usr/bin/env bash
# Installed by Walnut's scripts/cloud/security-updates.sh. Applies security updates from
# the latest release, then reboots only when an update needs it.
set -uo pipefail
DNF="${DNF:-dnf}"
NEEDS_RESTARTING="${NEEDS_RESTARTING:-needs-restarting}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
echo "walnut-security-update: applying security updates (releasever latest)"
if ! "$DNF" -y upgrade --security --releasever=latest; then
  echo "walnut-security-update: dnf upgrade failed" >&2
  exit 1
fi
# needs-restarting -r: exit 0 = no reboot needed, 1 = a reboot is needed.
if "$NEEDS_RESTARTING" -r >/dev/null 2>&1; then
  echo "walnut-security-update: no reboot needed"
  exit 0
fi
echo "walnut-security-update: an update needs a reboot; rebooting"
"$SYSTEMCTL" reboot
EOF
  chmod 0755 "$BIN"

  cat > "$UNIT_DIR/walnut-security-update.service" <<'EOF'
[Unit]
Description=Walnut daily security updates (reboots only when an update needs it)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/walnut-security-update
EOF

  cat > "$UNIT_DIR/walnut-security-update.timer" <<EOF
[Unit]
Description=Walnut daily security updates at $UPDATE_AT UTC

[Timer]
OnCalendar=*-*-* $UPDATE_AT:00 UTC
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF

  if [ -z "$ROOT" ]; then
    command -v needs-restarting >/dev/null 2>&1 || dnf -y install dnf-utils
    "$SYSTEMCTL" daemon-reload
    # The old way: never both, or two updates race for the rpm lock.
    "$SYSTEMCTL" disable --now dnf-automatic.timer >/dev/null 2>&1 || true
    "$SYSTEMCTL" enable --now walnut-security-update.timer
  fi
  echo "security-updates: walnut-security-update.timer daily at $UPDATE_AT UTC"
else
  APT_DIR="$ROOT/etc/apt/apt.conf.d"
  mkdir -p "$APT_DIR"
  cat > "$APT_DIR/20auto-upgrades" <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  cat > "$APT_DIR/52walnut-reboot" <<EOF
// Written by Walnut's scripts/cloud/security-updates.sh: reboot when an update needs it.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "$UPDATE_AT";
EOF
  if [ -z "$ROOT" ]; then
    "$SYSTEMCTL" enable --now apt-daily-upgrade.timer
  fi
  echo "security-updates: unattended-upgrades with a reboot at $UPDATE_AT when needed"
fi
