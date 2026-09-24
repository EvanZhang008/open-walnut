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
#   bash /opt/walnut/scripts/cloud/setup.sh <domain> [--engine <id>] [--bedrock-region <region>]
#
# Run as root. Idempotent — safe to re-run (e.g. via SSM after a repo update):
#   sudo bash /opt/walnut/scripts/cloud/setup.sh wn.example.com
#
# --engine / --bedrock-region go to scripts/cloud/ensure-harness.sh (step 9),
# which installs Claude Code plus that engine's CLI and switches cloud exec on.
# Both are optional: without --engine the box keeps its own defaults.engine
# (claude on a fresh box); the Bedrock region defaults to us-west-2.
#
# What it sets up:
#   Caddy (443/80, auto Let's Encrypt) → Walnut server (localhost:3456)
#   Data: /var/lib/walnut/.open-walnut  = git working tree (OPEN_WALNUT_HOME)
#         /var/lib/walnut/git/walnut-data.git = bare hub repo (Mac pushes here
#         over git smart HTTP through Caddy; post-receive materializes into
#         the working tree)
#   Exec: Claude Code + the default engine's CLI for the walnut user, so the
#         box runs sessions itself through its loopback daemon (cloud exec)
set -euo pipefail

# cloud-init runs user-data with no HOME; npm/git need one.
export HOME="${HOME:-/root}"

DOMAIN="${1:?usage: setup.sh <domain> [--engine <id>] [--bedrock-region <region>]}"
shift

REPO_DIR=/opt/walnut
WALNUT_USER=walnut
WALNUT_LIB=/var/lib/walnut
DATA_HOME="$WALNUT_LIB/.open-walnut"
HUB_REPO="$WALNUT_LIB/git/walnut-data.git"
CADDY_BIN=/usr/local/bin/caddy
# Root's config for the service (step 8): root:walnut 0750, so the service user
# can read what it is given and create nothing. Its one runtime write (the
# spent pairing code) lives in a subdirectory of its own, CLAIM_DIR.
ETC_WALNUT=/etc/walnut
CLAIM_DIR="$ETC_WALNUT/claim"
# Root-only record that the code tree was once writable by someone other than
# root (see the check below). Only rebuilding the tree from a fresh clone
# clears it: the first-boot script re-clones, a deploy swaps in a sibling.
EXPOSED_MARKER=/root/.walnut-code-tree-exposed
ROOT_USER=root
WALNUT_GROUP=walnut

# >>> code-tree exposure (tests/scripts/cloud-ensure-harness.test.ts runs this block)
# The code tree is root's and read-only to the service user, which runs agents
# (cloud exec). Root runs code from it below (the harness script, npm lifecycle
# scripts, the build), and bash is reading this very file out of it, so a tree
# that user could change is a path to root. This runs before anything else and
# never repairs the tree: taking it back (chown) would erase the only evidence,
# after which nothing tells that a .npmrc, node_modules or .git in it is the
# service user's work. The finding goes into a root-only marker instead, and a
# tree with a marker is replaced from a fresh clone, never built on in place.
# A link in the tree is as safe as what it resolves to: one leaving the tree
# for the service home, for something the service user controls, or for a name
# that does not exist yet (anyone may create it) counts as a way in.
tree_link_exposure() {
  local tree_real home_real l t
  tree_real="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  home_real="$(cd "$WALNUT_LIB" 2>/dev/null && pwd -P || printf '%s' "$WALNUT_LIB")"
  while IFS= read -r l; do
    t="$(realpath "$l" 2>/dev/null || true)"
    case "$t" in "$tree_real"|"$tree_real"/*) continue ;; esac
    if [ -z "$t" ] || [ ! -e "$t" ]; then echo "$l (a link to $(readlink "$l"), which does not exist)"; return 0; fi
    case "$t" in "$home_real"|"$home_real"/*) echo "$l (a link into $WALNUT_LIB)"; return 0 ;; esac
    if [ -n "$(find "$t" "$(dirname "$t")" -maxdepth 0 -user "$WALNUT_USER" -print 2>/dev/null)" ]; then
      echo "$l (a link to $t, which $WALNUT_USER controls)"; return 0
    fi
  done < <(find "$1" -type l -print 2>/dev/null)
  return 0
}
tree_exposure() {
  local hit
  hit="$(find "$1" \( ! -user "$ROOT_USER" -o \( ! -type l \( -perm -020 -o -perm -002 \) \) \) -print -quit 2>/dev/null || true)"
  if [ -n "$hit" ]; then echo "$hit"; return 0; fi
  tree_link_exposure "$1"
}
# Appends one line to the marker (created 0600 in root's home when absent).
record_exposure() {
  (umask 077 && mkdir -p "$(dirname "$EXPOSED_MARKER")" && \
    printf '%s %s: %s was writable by a non-root user (first: %s)\n' \
      "$(date -u +%FT%TZ)" "$1" "$REPO_DIR" "$2" >> "$EXPOSED_MARKER")
}
exposed="$(tree_exposure "$REPO_DIR")"
if [ -n "$exposed" ] && ! record_exposure setup.sh "$exposed"; then
  echo "FATAL: $REPO_DIR can be changed by a non-root user (first: $exposed), and $EXPOSED_MARKER could not be written" >&2
  exit 3
fi
if [ -e "$EXPOSED_MARKER" ]; then
  echo "FATAL: root will not run code from $REPO_DIR: it was writable by a non-root user." >&2
  sed 's/^/       /' "$EXPOSED_MARKER" >&2
  echo "       Replace it from a fresh clone, then run this script from the new tree:" >&2
  echo "         mv $REPO_DIR $REPO_DIR.exposed-\$(date +%s) && chmod 700 $REPO_DIR.exposed-*" >&2
  echo "         git clone --branch main <repo url> $REPO_DIR && rm -f $EXPOSED_MARKER" >&2
  echo "       Treat the service user as compromised until you have looked at the old tree." >&2
  exit 3
fi
# <<< code-tree exposure

# >>> harness args (tests/scripts/cloud-ensure-harness.test.ts runs this block)
# The flags only tune step 9, so none of them may stop first boot: a value this
# checkout does not know (a Mac on a newer release naming a newer engine, a
# typo) is dropped with a warning and step 9 falls back to its default. Each
# flag is checked on its own, before the long build, so a bad region cannot
# take a good engine down with it.
HARNESS_SCRIPT="$REPO_DIR/scripts/cloud/ensure-harness.sh"
HARNESS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --engine=*|--bedrock-region=*) flag="${1%%=*}"; value="${1#*=}"; shift ;;
    --engine|--bedrock-region)
      if [ $# -lt 2 ]; then echo "WARNING: $1 has no value; ignored" >&2; shift; continue; fi
      flag="$1"; value="$2"; shift 2 ;;
    *) echo "WARNING: unknown argument '$1' ignored (usage: setup.sh <domain> [--engine <id>] [--bedrock-region <region>])" >&2; shift; continue ;;
  esac
  if bash "$HARNESS_SCRIPT" --validate-args "$flag" "$value" >/dev/null 2>&1; then
    HARNESS_ARGS+=("$flag" "$value")
  else
    echo "WARNING: $flag '$value' is not valid for this checkout; ignored (step 9 uses its default)" >&2
  fi
done
# <<< harness args

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
# Run from an interactive root shell (sudo -i), a child holding root's terminal
# could push keystrokes into it (TIOCSTI) or read what root types next. So it
# gets a session of its own (setsid: no controlling terminal) and no terminal
# fd at all: stdin is /dev/null, stdout and stderr go through pipes. as_walnut_in
# is the one variant that passes the caller's stdin, for data fed to it.
setsid --wait true </dev/null >/dev/null 2>&1 \
  || { echo "FATAL: setsid --wait not available (util-linux 2.24 or newer)" >&2; exit 1; }
# stdout and stderr each through a pipe, both drained before it returns (the
# exit status is the command's, under pipefail).
as_walnut_in() {
  { setsid --wait "$RUNUSER" -u "$WALNUT_USER" -- env HOME="$WALNUT_LIB" "$@" 2>&1 1>&3 3>&- | cat >&2; } 3>&1 | cat
}
as_walnut() { as_walnut_in "$@" </dev/null; }

echo "==> [1/10] System packages"
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

echo "==> [2/10] Swap (a 2GB box — t4g.small, CX22 — needs headroom for vite/tsup)"
if [ ! -f /swapfile ]; then
  # dd, not fallocate — swapon rejects fallocate'd files on some filesystems.
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show | grep -q /swapfile || swapon /swapfile
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

echo "==> [3/10] Bun (required by scripts/build-daemon.sh during npm run build)"
if ! command -v bun >/dev/null 2>&1; then
  export BUN_INSTALL=/opt/bun
  curl -fsSL https://bun.sh/install | bash
  ln -sf /opt/bun/bin/bun /usr/local/bin/bun
fi

echo "==> [4/10] Caddy (static binary — neither AL2023 nor Ubuntu ships a current caddy)"
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
# The address must end in a REAL ICANN TLD. Live-verified 2026-08-11 (this was
# the reasoned-but-wrong bit the first live run caught): an RFC 2606 `.invalid`
# address was rejected by BOTH issuers — Boulder with "contact email has invalid
# domain: Domain name does not end with a valid public suffix (TLD)" and ZeroSSL
# ACME with "A contact URL for an account was invalid" — so the box sat cert-less
# forever and the failover chain never helped (both ends failed the same way).
# Boulder also forbids example.com/.net/.org. Hence a real, deliverable,
# project-owned contact below; nothing is ever sent to it in practice.
# LIVE SMOKE VERIFIED 2026-08-11 (us-west-2, real deploy):
#   1. `caddy validate` accepts the global block.
#   2. LE issued for <dashed-ip>.sslip.io ~4s after account creation succeeded.
#   3. journalctl named the issuer (acme-v02.api.letsencrypt.org).
#   4. Still unverified live: the LE→ZeroSSL failover under a real LE rate-limit.
CADDY_GLOBAL_BLOCK=""
case "$DOMAIN" in
  *.sslip.io)
    echo "    (sslip.io hostname — enabling Caddy's Let's Encrypt → ZeroSSL issuer failover)"
    CADDY_GLOBAL_BLOCK=$'{\n\t# Turns on Caddy\'s redundant LE→ZeroSSL issuer chain (see setup.sh).\n\temail certs@openwalnut.dev\n}\n\n'
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

echo "==> [5/10] walnut service user"
# nologin on purpose (nobody logs in as it). The session daemon still needs a
# real $SHELL to spawn the agent CLI, which ensure-harness.sh (step 9) gives
# walnut.service through a drop-in instead of loosening the account.
if ! id -u "$WALNUT_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$WALNUT_LIB" --create-home \
    --shell "$NOLOGIN" "$WALNUT_USER"
fi
as_walnut git config --global user.name "walnut"
as_walnut git config --global user.email "walnut@localhost"
as_walnut git config --global init.defaultBranch main

echo "==> [6/10] Data layout: bare hub repo + working tree"
# Everything under the service home is that user's, so root never writes there
# by path (a link it planted would redirect the write): the service user does.
as_walnut mkdir -p "$WALNUT_LIB/git"
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
# >>> hub hook (tests/scripts/cloud-ensure-harness.test.ts runs this block)
# Written by the service user, which owns the hub repo: through a temp file
# renamed over the hook, so a link standing in its place is replaced, never
# followed, and nothing of root's is ever at stake.
# shellcheck disable=SC2016  # $1 and $tmp are the inner shell's
as_walnut_in bash -c 'set -e; umask 022; tmp="$(mktemp "$1.XXXXXX")"; cat > "$tmp"; chmod 755 "$tmp"
  if [ -d "$1" ] && [ ! -L "$1" ]; then rm -rf "$1"; fi; mv -fT "$tmp" "$1"' \
  write-hook "$HUB_REPO/hooks/post-receive" <<EOF
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
# <<< hub hook

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

echo "==> [7/10] Build Walnut ($REPO_DIR)"
export PATH="/usr/local/bin:$PATH"
# The code tree is ROOT's; the service user only reads it (the check at the top
# refused anything else before root ran a line from it). The server writes
# nothing here at runtime: on a package it cannot write it keeps plugin bundles
# and daemon caches under the data dir, and refuses (409) edits to shipped
# skills.
# Older versions let root run git in a service-owned tree; git's own ownership
# guard is the right default again.
git config --global --unset-all safe.directory "^$REPO_DIR\$" || true
cd "$REPO_DIR"
npm ci
# npm ci normally installs the right prebuilt native binding, but a deploy can
# leave a stale/foreign-platform binding behind (observed 2026-07-10: linux-arm64
# binding missing → every SQLite consumer degraded to "null.prepare" errors).
# Verify the binding actually loads on THIS platform; rebuild if it doesn't.
# Construct a database, not a bare require: the binding loads lazily, so only
# this proves it (src/core/native-abi-preflight.ts). This is the only repair:
# the server's own `npm rebuild` fallback fails on this box, because the
# service user cannot write node_modules.
node -e "new (require('better-sqlite3'))(':memory:').close()" 2>/dev/null || npm rebuild better-sqlite3
npm run build
(cd web && npx vite build)
# Readable and traversable by the service user (incl. node_modules), writable
# only by root. ensure-harness.sh (step 9) refuses to run from anything else.
chown -R -P root:root "$REPO_DIR"
chmod -R a+rX,go-w "$REPO_DIR"

echo "==> [8/10] walnut.service"
# >>> etc-walnut (tests/scripts/cloud-ensure-harness.test.ts runs this block)
# /etc/walnut is root's config for the service:
#   /etc/walnut              root:walnut 0750  readable, but the service user
#                                              can create nothing in it
#   /etc/walnut/walnut.env   root 0600         read by systemd, as root, only
#   /etc/walnut/setup-token  root 0600         the pairing code cloud-init
#                                              leaves here before this runs
#   /etc/walnut/claim/       walnut 0700       the service user's own: after a
#                                              claim the server unlinks the
#                                              spent code, which needs write
#                                              on its directory
# Root never writes by path in a directory the service user can write: files
# here are temp files renamed into place, and the code reaches claim/ through
# the service user itself (root only opens its own copy). Older versions gave
# the whole dir to the service user, so first take it back; from then on no
# name in it can be swapped under root. `mkdir -p` alone is not enough:
# cloud-init already made the dir, and mkdir -p leaves an existing dir as it is.
if [ -L "$ETC_WALNUT" ] || { [ -e "$ETC_WALNUT" ] && [ ! -d "$ETC_WALNUT" ]; }; then rm -f "$ETC_WALNUT"; fi
mkdir -p "$ETC_WALNUT"
chown -h "$ROOT_USER:$WALNUT_GROUP" "$ETC_WALNUT"
chmod 750 "$ETC_WALNUT"
# A name planted there before the take-back is kept only when it is a plain
# file with one link; anything else (a link, a dir, a hard link to someone
# else's file) is removed unread.
plain_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ -n "$(find "$1" -maxdepth 0 -links 1 -print 2>/dev/null)" ]; }
for name in walnut.env setup-token; do
  if { [ -e "$ETC_WALNUT/$name" ] || [ -L "$ETC_WALNUT/$name" ]; } && ! plain_file "$ETC_WALNUT/$name"; then
    echo "    removing $ETC_WALNUT/$name: not a plain file"
    rm -rf "${ETC_WALNUT:?}/$name"
  fi
done
# stdin -> <path in $ETC_WALNUT>, root-owned, mode <mode>: renamed over the name.
put_file() {
  local tmp
  tmp="$(mktemp "$ETC_WALNUT/.tmp.XXXXXX")"
  cat > "$tmp"
  chmod "$2" "$tmp"
  mv -fT "$tmp" "$1"
}
ENV_FILE="$ETC_WALNUT/walnut.env"
# KEY VALUE: walnut.env with KEY=VALUE in place of any earlier KEY line.
env_set() {
  { if [ -f "$ENV_FILE" ]; then grep -v "^$1=" "$ENV_FILE" || true; fi; printf '%s=%s\n' "$1" "$2"; } | put_file "$ENV_FILE" 600
}
# Secrets the companion needs at runtime (e.g. OPENAI_API_KEY for the voice
# STT fallback) live in SSM Parameter Store under /walnut/* and materialize
# into walnut.env here. Config.yaml is the wrong home for them: it git-syncs
# through the data hub, and cloud-held secrets must never ride a repo.
# Idempotent and best-effort: a missing parameter just means that feature stays
# off. Non-AWS providers (and a hand-run of this script off-instance) have no
# aws CLI; every lookup is optional, so skip the whole block rather than eating
# a `command not found` per parameter.
if command -v aws >/dev/null 2>&1; then
  if OPENAI_KEY=$(aws ssm get-parameter --name /walnut/openai-api-key \
      --with-decryption --query Parameter.Value --output text 2>/dev/null); then
    env_set OPENAI_API_KEY "$OPENAI_KEY"
  else
    echo "    (no /walnut/openai-api-key in SSM — voice STT cloud fallback disabled)"
  fi
  # web_search (Tavily) — same pattern: config.yaml is machine-local and never
  # carries secrets, so the key rides SSM → env. web-search-tool falls back to
  # TAVILY_API_KEY when tools.web_search.api_key is absent from config.
  if TAVILY_KEY=$(aws ssm get-parameter --name /walnut/tavily-api-key \
      --with-decryption --query Parameter.Value --output text 2>/dev/null); then
    env_set TAVILY_API_KEY "$TAVILY_KEY"
  else
    echo "    (no /walnut/tavily-api-key in SSM — web_search disabled on the companion)"
  fi
else
  echo "    (no aws CLI — skipping SSM secrets)"
fi
# Rewritten every run, so a file an older layout left to the service user is
# root's again (its content is kept: it only ever configures that service).
# Reading the name that is renamed over is the point: the old inode is read.
# shellcheck disable=SC2094
if [ -f "$ENV_FILE" ]; then put_file "$ENV_FILE" 600 < "$ENV_FILE"; else put_file "$ENV_FILE" 600 </dev/null; fi

# claim/: a real directory, the service user's (made here when missing).
if [ -L "$CLAIM_DIR" ] || { [ -e "$CLAIM_DIR" ] && [ ! -d "$CLAIM_DIR" ]; }; then rm -f "$CLAIM_DIR"; fi
if [ ! -d "$CLAIM_DIR" ]; then mkdir -m 700 "$CLAIM_DIR"; fi
chown -h "$WALNUT_USER:$WALNUT_GROUP" "$CLAIM_DIR"
chmod 700 "$CLAIM_DIR"
# Pairing code (a pre-generated setup token) if provisioning burned one in via
# cloud-init: handed to the service user, which writes its own copy, then
# root's copy goes. The value itself never enters the unit file (only the
# path), so `systemctl show walnut` cannot leak it.
TOKEN_STAGE="$ETC_WALNUT/setup-token"
if [ -s "$TOKEN_STAGE" ]; then
  # shellcheck disable=SC2016  # $1 and $tmp are the inner shell's
  as_walnut_in bash -c 'set -e; umask 077; tmp="$(mktemp "$1.XXXXXX")"; cat > "$tmp"; mv -fT "$tmp" "$1"' \
    put-token "$CLAIM_DIR/setup-token" < "$TOKEN_STAGE"
  rm -f "$TOKEN_STAGE"
  echo "    (provisioned setup token present — claim from your Walnut app)"
fi
# <<< etc-walnut

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
Environment=WALNUT_SETUP_TOKEN_FILE=$CLAIM_DIR/setup-token
# Optional secrets (SSM-materialized above); '-' = absent file is fine.
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN $REPO_DIR/dist/cli.js web --port 3456
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

echo "==> [9/10] Agent harness (Claude Code, default engine CLI, cloud exec)"
# Makes the box a real exec host: see the header of ensure-harness.sh. It never
# restarts walnut itself; the restart below picks up its drop-in and config.
# Never fatal: a box whose agent CLI failed to install still serves as a relay,
# and the next run of this script retries the install.
if ! bash "$HARNESS_SCRIPT" ${HARNESS_ARGS[@]+"${HARNESS_ARGS[@]}"}; then
  echo "WARNING: the agent harness is incomplete (see above); the companion starts as a relay only"
fi

echo "==> [10/10] Enable services + unattended security updates"
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
