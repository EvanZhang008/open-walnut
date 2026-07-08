#!/usr/bin/env bash
# Open Walnut cloud companion — one-shot bootstrap for Amazon Linux 2023 (arm64).
#
# Invoked by the EC2 user-data (see infra/lib/walnut-cloud-stack.ts):
#   bash /opt/walnut/scripts/cloud/setup.sh <domain>
#
# Run as root. Idempotent — safe to re-run (e.g. via SSM after a repo update):
#   sudo bash /opt/walnut/scripts/cloud/setup.sh wn.example.com
#
# What it sets up:
#   Caddy (443/80, auto Let's Encrypt) → Walnut server (localhost:3456)
#   Data: /var/lib/walnut/.open-walnut  = git working tree (OPEN_WALNUT_HOME)
#         /var/lib/walnut/git/walnut-data.git = bare hub repo (Mac pushes here
#         over git smart HTTP through Caddy; post-receive materializes into
#         the working tree)
set -euo pipefail

# cloud-init runs user-data with no HOME; npm/git need one.
export HOME="${HOME:-/root}"

DOMAIN="${1:?usage: setup.sh <domain>}"

REPO_DIR=/opt/walnut
WALNUT_USER=walnut
WALNUT_LIB=/var/lib/walnut
DATA_HOME="$WALNUT_LIB/.open-walnut"
HUB_REPO="$WALNUT_LIB/git/walnut-data.git"
CADDY_BIN=/usr/local/bin/caddy

# Run a command as the walnut user. HOME is set explicitly — runuser's
# env-reset behavior varies across util-linux versions and a git command
# writing to the wrong ~/.gitconfig is a miserable first-boot failure.
as_walnut() {
  runuser -u "$WALNUT_USER" -- env HOME="$WALNUT_LIB" "$@"
}

echo "==> [1/9] System packages"
# gcc-c++/make/python3: insurance for native npm modules if a prebuild is missing.
dnf install -y git tar nodejs22 gcc-c++ make python3
# npm ships separately for versioned node packages on AL2023.
dnf install -y nodejs22-npm || true

# AL2023 ships node/npm/npx as versioned binaries (node-22 etc). Make sure the
# unversioned names resolve — symlink into /usr/local/bin if alternatives
# didn't wire them up.
for tool in node npm npx; do
  if ! command -v "$tool" >/dev/null 2>&1 && [ -x "/usr/bin/${tool}-22" ]; then
    ln -sf "/usr/bin/${tool}-22" "/usr/local/bin/${tool}"
  fi
done
command -v npm >/dev/null 2>&1 || { echo "FATAL: npm not found after install"; exit 1; }
NODE_BIN="$(command -v node)"
echo "node: $NODE_BIN ($(node --version)), npm $(npm --version)"

echo "==> [2/9] Swap (t4g.small has 2GB RAM; vite/tsup builds need headroom)"
if [ ! -f /swapfile ]; then
  # dd, not fallocate — swapon rejects fallocate'd files on some filesystems.
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show | grep -q /swapfile || swapon /swapfile
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

echo "==> [3/9] Bun (required by scripts/build-daemon.sh during npm run build)"
if ! command -v bun >/dev/null 2>&1; then
  export BUN_INSTALL=/opt/bun
  curl -fsSL https://bun.sh/install | bash
  ln -sf /opt/bun/bin/bun /usr/local/bin/bun
fi

echo "==> [4/9] Caddy (static binary — AL2023 dnf does not ship caddy)"
if ! id -u caddy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/caddy --create-home \
    --shell /usr/sbin/nologin caddy
fi
if [ ! -x "$CADDY_BIN" ]; then
  tmp="$(mktemp -d)"
  url="$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest \
    | grep -o 'https://[^"]*linux_arm64\.tar\.gz' | head -1)"
  [ -n "$url" ] || { echo "FATAL: could not resolve latest Caddy linux_arm64 release"; exit 1; }
  echo "downloading $url"
  curl -fsSL "$url" -o "$tmp/caddy.tar.gz"
  tar -xzf "$tmp/caddy.tar.gz" -C "$tmp" caddy
  install -m 755 "$tmp/caddy" "$CADDY_BIN"
  rm -rf "$tmp"
fi
"$CADDY_BIN" version

mkdir -p /etc/caddy
# Domain is injected via environment so the Caddyfile itself stays generic.
cat > /etc/caddy/env <<EOF
WALNUT_DOMAIN=$DOMAIN
EOF
# reverse_proxy tuned for SSE/WebSocket long-lived streams:
#   flush_interval -1              → flush immediately, never buffer responses
#   transport read/write_timeout 0 → no idle timeout on the upstream conn
# (read_timeout/write_timeout are valid Caddy v2.6+ http transport options.)
cat > /etc/caddy/Caddyfile <<'EOF'
{$WALNUT_DOMAIN} {
	reverse_proxy 127.0.0.1:3456 {
		flush_interval -1
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
}
EOF

# Official Caddy systemd unit (caddy/dist), plus our EnvironmentFile.
cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
EnvironmentFile=/etc/caddy/env
ExecStart=$CADDY_BIN run --environ --config /etc/caddy/Caddyfile
ExecReload=$CADDY_BIN reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

echo "==> [5/9] walnut service user"
if ! id -u "$WALNUT_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$WALNUT_LIB" --create-home \
    --shell /usr/sbin/nologin "$WALNUT_USER"
fi
as_walnut git config --global user.name "walnut"
as_walnut git config --global user.email "walnut@localhost"
as_walnut git config --global init.defaultBranch main

echo "==> [6/9] Data layout: bare hub repo + working tree"
install -d -o "$WALNUT_USER" -g "$WALNUT_USER" "$WALNUT_LIB/git"
if [ ! -d "$HUB_REPO" ]; then
  as_walnut git init --bare --initial-branch=main "$HUB_REPO"
fi

# post-receive: a push from the Mac materializes into the working tree
# near-realtime. flock serializes overlapping pushes.
cat > "$HUB_REPO/hooks/post-receive" <<EOF
#!/usr/bin/env bash
# Auto-generated by scripts/cloud/setup.sh — pull pushed refs into the
# working tree so the running server sees new data immediately.
set -euo pipefail
# git exports GIT_DIR while running hooks; it would hijack the pull below
# (making it operate on the bare repo instead of the working tree).
unset GIT_DIR GIT_WORK_TREE
exec 9>"$WALNUT_LIB/git/.post-receive.lock"
flock 9
if [ "\$(id -un)" = "$WALNUT_USER" ]; then
  git -C "$DATA_HOME" pull --ff-only origin main
else
  runuser -u "$WALNUT_USER" -- env HOME="$WALNUT_LIB" git -C "$DATA_HOME" pull --ff-only origin main
fi
EOF
chmod 755 "$HUB_REPO/hooks/post-receive"
chown "$WALNUT_USER:$WALNUT_USER" "$HUB_REPO/hooks/post-receive"

if [ ! -d "$DATA_HOME/.git" ]; then
  as_walnut git clone "$HUB_REPO" "$DATA_HOME"
fi
# Seed the hub with an empty initial commit if it has no history yet, so
# `pull --ff-only origin main` always has a ref to work with. (Run as the
# walnut user — root would trip git's safe.directory ownership guard.)
if ! as_walnut git -C "$HUB_REPO" rev-parse --verify main >/dev/null 2>&1; then
  as_walnut git -C "$DATA_HOME" checkout -B main
  as_walnut git -C "$DATA_HOME" commit --allow-empty -m "walnut data hub init"
  as_walnut git -C "$DATA_HOME" push -u origin main
fi

echo "==> [7/9] Build Walnut ($REPO_DIR)"
export PATH="/usr/local/bin:$PATH"
# The chown below hands the repo to the walnut user; let root git commands
# (this script's re-runs, `git pull` via SSM) keep working afterwards.
git config --global --add safe.directory "$REPO_DIR"
cd "$REPO_DIR"
npm ci
npm run build
(cd web && npx vite build)
# Service user must be able to read everything (incl. node_modules).
chown -R "$WALNUT_USER:$WALNUT_USER" "$REPO_DIR"

echo "==> [8/9] walnut.service"
# Port note: the server takes its port from the --port CLI flag (default 3456
# in src/web/server.ts DEFAULT_PORT) — there is no PORT env var.
cat > /etc/systemd/system/walnut.service <<EOF
[Unit]
Description=Open Walnut server (cloud companion)
After=network-online.target
Wants=network-online.target

[Service]
User=$WALNUT_USER
Group=$WALNUT_USER
WorkingDirectory=$REPO_DIR
Environment=WALNUT_CLOUD_MODE=1
Environment=OPEN_WALNUT_HOME=$DATA_HOME
Environment=HOME=$WALNUT_LIB
ExecStart=$NODE_BIN $REPO_DIR/dist/cli.js web --port 3456
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

echo "==> [9/9] Enable services + unattended security updates"
dnf install -y dnf-automatic
sed -i 's/^upgrade_type.*/upgrade_type = security/' /etc/dnf/automatic.conf
sed -i 's/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf

systemctl daemon-reload
systemctl enable --now dnf-automatic.timer
systemctl enable caddy.service walnut.service
systemctl restart caddy.service walnut.service

echo "==> Done. https://$DOMAIN → localhost:3456"
echo "    Check: systemctl status caddy walnut; journalctl -u walnut -f"
