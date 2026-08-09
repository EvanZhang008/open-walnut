#!/usr/bin/env bash
# Open Walnut cloud companion — one-shot bootstrap.
#
# Supported images (both arm64 and x86_64):
#   Amazon Linux 2023  (dnf)  — what the AWS CDK stack boots
#   Ubuntu 24.04 LTS   (apt)  — what the Hetzner driver boots
# The package manager is autodetected, so any dnf- or apt-based image with
# systemd should work; only these two are exercised.
#
# Invoked by the VM's user-data (see src/core/cloud-setup/user-data.ts and
# infra/lib/walnut-cloud-stack.ts):
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

# ── Platform detection (done once; every step below branches on $PKG) ────────
if command -v dnf >/dev/null 2>&1; then
  PKG=dnf
elif command -v apt-get >/dev/null 2>&1; then
  PKG=apt
else
  echo "FATAL: no supported package manager (need dnf or apt-get)" >&2
  exit 1
fi

# nologin lives in different places: /usr/sbin on Debian/Ubuntu, /sbin on
# AL2023 (which also symlinks /sbin → /usr/sbin, but don't rely on that).
NOLOGIN=/usr/sbin/nologin
[ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
[ -x "$NOLOGIN" ] || NOLOGIN=/bin/false

case "$(uname -m)" in
  aarch64|arm64) CADDY_ARCH=arm64 ;;
  x86_64|amd64)  CADDY_ARCH=amd64 ;;
  *) echo "FATAL: unsupported architecture $(uname -m) — no Caddy build to fetch" >&2; exit 1 ;;
esac

# runuser is util-linux, but it lives in /usr/sbin on Debian/Ubuntu and is only
# on PATH for root — and the post-receive hook below runs with git's own thin
# environment, so resolve it to an absolute path once and use that everywhere.
RUNUSER="$(command -v runuser || true)"
[ -n "$RUNUSER" ] || for c in /usr/sbin/runuser /sbin/runuser; do
  [ -x "$c" ] && RUNUSER="$c" && break
done
[ -n "$RUNUSER" ] || { echo "FATAL: runuser not found (install util-linux)" >&2; exit 1; }

echo "==> platform: $PKG, $(uname -m) (caddy linux_$CADDY_ARCH), nologin $NOLOGIN"

# apt needs an index refresh before the first install, and exactly once.
APT_UPDATED=0
pkg_install() {
  if [ "$PKG" = dnf ]; then
    dnf install -y "$@"
  else
    if [ "$APT_UPDATED" = 0 ]; then
      DEBIAN_FRONTEND=noninteractive apt-get update -y
      APT_UPDATED=1
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  fi
}

# Run a command as the walnut user. HOME is set explicitly — runuser's
# env-reset behavior varies across util-linux versions and a git command
# writing to the wrong ~/.gitconfig is a miserable first-boot failure.
as_walnut() {
  "$RUNUSER" -u "$WALNUT_USER" -- env HOME="$WALNUT_LIB" "$@"
}

echo "==> [1/9] System packages"
if [ "$PKG" = dnf ]; then
  # gcc-c++/make/python3: insurance for native npm modules if a prebuild is missing.
  pkg_install git tar nodejs22 gcc-c++ make python3
  # npm ships separately for versioned node packages on AL2023.
  dnf install -y nodejs22-npm || true

  # AL2023 ships node/npm/npx as versioned binaries (node-22 etc). Make sure the
  # unversioned names resolve — symlink into /usr/local/bin if alternatives
  # didn't wire them up. (dnf-only: apt's nodejs package installs plain names.)
  for tool in node npm npx; do
    if ! command -v "$tool" >/dev/null 2>&1 && [ -x "/usr/bin/${tool}-22" ]; then
      ln -sf "/usr/bin/${tool}-22" "/usr/local/bin/${tool}"
    fi
  done
else
  # build-essential is the apt equivalent of gcc-c++/make; ca-certificates so
  # the NodeSource fetch below can verify TLS on a minimal image.
  pkg_install git tar build-essential python3 curl ca-certificates gnupg
  # Ubuntu 24.04's own nodejs is 18.x — too old (package.json wants >=20), so
  # take Node 22 from NodeSource. Skipped when a good enough node is present,
  # which is what makes a re-run cheap.
  NODE_MAJOR="$(node --version 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p' || true)"
  if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
    echo "    (installing Node 22 from NodeSource; found '${NODE_MAJOR:-none}')"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    # The setup script already refreshed the index for its own repo.
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
fi
command -v npm >/dev/null 2>&1 || { echo "FATAL: npm not found after install"; exit 1; }
NODE_BIN="$(command -v node)"
# systemd units take absolute paths, and git is /usr/bin/git on both images —
# resolve it rather than assume, since a NodeSource-style repo can shadow it.
GIT_BIN="$(command -v git)"
echo "node: $NODE_BIN ($(node --version)), npm $(npm --version), git $GIT_BIN"

echo "==> [2/9] Swap (a 2GB box — t4g.small, CX22 — needs headroom for vite/tsup)"
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

echo "==> [4/9] Caddy (static binary — neither AL2023 nor Ubuntu ships a current caddy)"
if ! id -u caddy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/caddy --create-home \
    --shell "$NOLOGIN" caddy
fi
if [ ! -x "$CADDY_BIN" ]; then
  tmp="$(mktemp -d)"
  url="$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest \
    | grep -o "https://[^\"]*linux_${CADDY_ARCH}\\.tar\\.gz" | head -1)"
  [ -n "$url" ] || { echo "FATAL: could not resolve latest Caddy linux_$CADDY_ARCH release"; exit 1; }
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
# ── Global options: issuer failover for sslip.io hostnames ──────────────────
# Only emitted for *.sslip.io names; an operator's own domain keeps the exact
# Caddyfile it had before (no global block at all).
#
# Why sslip.io needs this: it is a wildcard-DNS service (<dashed-ip>.sslip.io
# resolves to that IP with no registrar involved) and it is NOT on the Public
# Suffix List. Let's Encrypt therefore treats `sslip.io` itself as the
# registered domain, so every sslip.io user on the internet shares ONE
# "50 certificates per registered domain per 7 days" bucket — which strangers
# can exhaust, and a domain-less operator cannot do anything about.
#
# The fix is a contact email, which is what actually buys the failover.
# Verified in Caddy's source, not guessed: modules/caddytls/automation.go
# `DefaultIssuers(userEmail)` appends the ZeroSSL ACME issuer ONLY when an
# email is non-empty, and caddyconfig/httpcaddyfile/tlsapp.go feeds the global
# `email` option into it. With no email Caddy runs a single (Let's Encrypt)
# issuer and has nothing to fail over to. With one, Caddy auto-negotiates
# ZeroSSL's EAB credentials (acmeissuer.go generateZeroSSLEABCredentials), so
# no account signup or stored key is needed.
#
# Deliberately NOT used: a `cert_issuer zerossl { … }` block. In Caddy 2.x that
# names the ZeroSSL *API* issuer (module tls.issuance.zerossl), which REQUIRES a
# paid `api_key` and is explicitly distinct from ZeroSSL's ACME endpoint — it
# would fail here. `email` is the supported way to get the dual ACME chain, so
# that is all we write; issuer ordering stays Caddy's default (LE, then ZeroSSL).
#
# The address must be syntactically deliverable even though nothing is sent to
# it: Let's Encrypt's Boulder validates contacts (policy.ValidEmail → the domain
# must be a valid hostname ending in an ICANN TLD, and must not be example.com/
# .net/.org). So `walnut@localhost` or an example.com address would be REJECTED
# at account creation. `invalid` is the RFC 2606 reserved TLD, which parses as a
# hostname and is not on Boulder's forbidden list.
# LIVE SMOKE MUST VERIFY (not checkable at lint/synth time):
#   1. `caddy validate --config /etc/caddy/Caddyfile` accepts the global block.
#   2. A cert is really issued for <dashed-ip>.sslip.io (curl the https origin).
#   3. `journalctl -u caddy | grep -i certificate` names the issuer, and LE
#      accepted the placeholder contact (watch for an InvalidEmail problem
#      document — if it appears, switch to a real operator address).
#   4. If LE is rate-limited, confirm the retry actually reaches ZeroSSL rather
#      than only backing off against LE.
CADDY_GLOBAL_BLOCK=""
case "$DOMAIN" in
  *.sslip.io)
    echo "    (sslip.io hostname — enabling Caddy's Let's Encrypt → ZeroSSL issuer failover)"
    CADDY_GLOBAL_BLOCK=$'{\n\t# Turns on Caddy\'s redundant LE→ZeroSSL issuer chain (see setup.sh).\n\temail walnut@walnut.invalid\n}\n\n'
    ;;
esac

# reverse_proxy tuned for SSE/WebSocket long-lived streams:
#   flush_interval -1              → flush immediately, never buffer responses
#   transport read/write_timeout 0 → no idle timeout on the upstream conn
# (read_timeout/write_timeout are valid Caddy v2.6+ http transport options.)
# printf '%s' for the global block so no backslash/escape in it is reinterpreted;
# the site block stays a quoted heredoc so {$WALNUT_DOMAIN} reaches Caddy intact.
printf '%s' "$CADDY_GLOBAL_BLOCK" > /etc/caddy/Caddyfile
cat >> /etc/caddy/Caddyfile <<'EOF'
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
    --shell "$NOLOGIN" "$WALNUT_USER"
fi
as_walnut git config --global user.name "walnut"
as_walnut git config --global user.email "walnut@localhost"
as_walnut git config --global init.defaultBranch main

echo "==> [6/9] Data layout: bare hub repo + working tree"
install -d -o "$WALNUT_USER" -g "$WALNUT_USER" "$WALNUT_LIB/git"
if [ ! -d "$HUB_REPO" ]; then
  as_walnut git init --bare --initial-branch=main "$HUB_REPO"
fi
# Allow pushes over git smart HTTP (`git http-backend` refuses receive-pack
# without this, even for authenticated users on some git versions). The
# endpoint itself (/git/data, src/web/routes/git-http.ts) enforces device-token
# auth before any pack ever reaches the repo.
as_walnut git -C "$HUB_REPO" config http.receivepack true

# ── Hub self-maintenance (2026-08-06 incident hardening) ────────────────────
# A bare repo receives one new pack per push and NOTHING ever consolidates
# them by default (`gc --auto` only fires after porcelain commands, which a
# bare hub never runs). With the Mac pushing every 30–60s the incident hub
# reached 32 packs / 9.9GB; every fetch's object walk then ran slower than
# the Mac's 15s client timeout, and the abort→retry loop stacked orphaned
# git processes until this 2-vCPU box sat at 99.85% CPU for a week (phone
# showed "offline" — TLS handshakes starved; even SSM couldn't run).
#
# Two layers, both must exist:
#   1. git-http.ts spawns `gc --auto` after each successful receive-pack
#      (in-band, catches growth as it happens).
#   2. This systemd timer (out-of-band backstop): catches the case where the
#      server-side gc is never reached — old server build, crash loops, or
#      pushes arriving through some future non-walnut path.
# gc.auto=0 on purpose: the timer/hook own gc; git's own heuristics must not
# compete with them (same policy as the Mac-side data repo).
as_walnut git -C "$HUB_REPO" config gc.auto 0
as_walnut git -C "$HUB_REPO" config maintenance.auto false
cat > /etc/systemd/system/walnut-hub-gc.service <<UNIT
[Unit]
Description=GC the walnut data hub bare repo (defense against pack accumulation)
[Service]
Type=oneshot
User=$WALNUT_USER
ExecStart=$GIT_BIN -C $HUB_REPO -c gc.auto=6700 -c gc.autoPackLimit=8 -c repack.writeBitmaps=true gc --auto --quiet
Nice=10
UNIT
cat > /etc/systemd/system/walnut-hub-gc.timer <<UNIT
[Unit]
Description=Periodic walnut data hub gc
[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
RandomizedDelaySec=15min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now walnut-hub-gc.timer

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
  $GIT_BIN -C "$DATA_HOME" pull --ff-only origin main
else
  # Absolute paths: a git hook inherits git's own thin PATH, which on Ubuntu
  # does not include /usr/sbin (where runuser lives).
  $RUNUSER -u "$WALNUT_USER" -- env HOME="$WALNUT_LIB" $GIT_BIN -C "$DATA_HOME" pull --ff-only origin main
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
# npm ci normally installs the right prebuilt native binding, but a deploy can
# leave a stale/foreign-platform binding behind (observed 2026-07-10: linux-arm64
# binding missing → every SQLite consumer degraded to "null.prepare" errors).
# Verify the binding actually loads on THIS platform; rebuild if it doesn't.
node -e "require('better-sqlite3')" 2>/dev/null || npm rebuild better-sqlite3
npm run build
(cd web && npx vite build)
# Service user must be able to read everything (incl. node_modules).
chown -R "$WALNUT_USER:$WALNUT_USER" "$REPO_DIR"

echo "==> [8/9] walnut.service"
# Secrets the companion needs at runtime (e.g. OPENAI_API_KEY for the voice
# STT fallback) live in SSM Parameter Store under /walnut/* and materialize
# into /etc/walnut/walnut.env here. Config.yaml is the wrong home for them:
# it git-syncs through the data hub, and cloud-held secrets must never ride
# a repo. Idempotent + best-effort — a missing parameter just means that
# feature stays off.
mkdir -p /etc/walnut
touch /etc/walnut/walnut.env
# Non-AWS providers (and a hand-run of this script off-instance) have no aws CLI;
# every SSM lookup below is optional, so skip the whole block rather than eating
# a `command not found` per parameter.
if command -v aws >/dev/null 2>&1; then
  if OPENAI_KEY=$(aws ssm get-parameter --name /walnut/openai-api-key \
      --with-decryption --query Parameter.Value --output text 2>/dev/null); then
    grep -q '^OPENAI_API_KEY=' /etc/walnut/walnut.env \
      && sed -i "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$OPENAI_KEY|" /etc/walnut/walnut.env \
      || echo "OPENAI_API_KEY=$OPENAI_KEY" >> /etc/walnut/walnut.env
  else
    echo "    (no /walnut/openai-api-key in SSM — voice STT cloud fallback disabled)"
  fi
  # web_search (Tavily) — same pattern: config.yaml is machine-local and never
  # carries secrets, so the key rides SSM → env. web-search-tool falls back to
  # TAVILY_API_KEY when tools.web_search.api_key is absent from config.
  if TAVILY_KEY=$(aws ssm get-parameter --name /walnut/tavily-api-key \
      --with-decryption --query Parameter.Value --output text 2>/dev/null); then
    grep -q '^TAVILY_API_KEY=' /etc/walnut/walnut.env \
      && sed -i "s|^TAVILY_API_KEY=.*|TAVILY_API_KEY=$TAVILY_KEY|" /etc/walnut/walnut.env \
      || echo "TAVILY_API_KEY=$TAVILY_KEY" >> /etc/walnut/walnut.env
  else
    echo "    (no /walnut/tavily-api-key in SSM — web_search disabled on the companion)"
  fi
else
  echo "    (no aws CLI — skipping SSM secrets)"
fi
chown "$WALNUT_USER:$WALNUT_USER" /etc/walnut/walnut.env
chmod 600 /etc/walnut/walnut.env

# Pairing code (a pre-generated setup token) if provisioning burned one in via
# cloud-init. cloud-init writes it as root before this script runs, so the
# service user cannot read it yet. The value itself never enters the unit file —
# only the path — so `systemctl show walnut` cannot leak it.
if [ -s /etc/walnut/setup-token ]; then
  chown "$WALNUT_USER:$WALNUT_USER" /etc/walnut/setup-token
  chmod 600 /etc/walnut/setup-token
  echo "    (provisioned setup token present — claim from your Walnut app)"
fi

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
Environment=NODE_ENV=production
Environment=OPEN_WALNUT_HOME=$DATA_HOME
Environment=WALNUT_GIT_HUB_DIR=$WALNUT_LIB/git
Environment=HOME=$WALNUT_LIB
# Path, not value — the pairing code stays out of 'systemctl show'. Absent file
# = no provisioned token, and the server mints+prints a random one as before.
Environment=WALNUT_SETUP_TOKEN_FILE=/etc/walnut/setup-token
# Optional secrets (SSM-materialized above); '-' = absent file is fine.
EnvironmentFile=-/etc/walnut/walnut.env
ExecStart=$NODE_BIN $REPO_DIR/dist/cli.js web --port 3456
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

echo "==> [9/9] Enable services + unattended security updates"
if [ "$PKG" = dnf ]; then
  pkg_install dnf-automatic
  sed -i 's/^upgrade_type.*/upgrade_type = security/' /etc/dnf/automatic.conf
  sed -i 's/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf
  AUTO_UPDATE_TIMER=dnf-automatic.timer
else
  pkg_install unattended-upgrades
  # Ubuntu's cloud images ship unattended-upgrades but not always the periodic
  # config that actually fires it, so write it rather than assuming. The
  # security-only origin list is the package's own default (50unattended-upgrades).
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  AUTO_UPDATE_TIMER=apt-daily-upgrade.timer
fi

systemctl daemon-reload
systemctl enable --now "$AUTO_UPDATE_TIMER"
systemctl enable caddy.service walnut.service
systemctl restart caddy.service walnut.service

echo "==> Done. https://$DOMAIN → localhost:3456"
echo "    Check: systemctl status caddy walnut; journalctl -u walnut -f"
