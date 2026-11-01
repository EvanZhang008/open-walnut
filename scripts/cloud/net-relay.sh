#!/usr/bin/env bash
# The host network's relay on the cloud companion (docs/reference/host-network.md).
# Run by setup.sh as root, after walnut's service user and /etc/walnut exist; safe to re-run.
#
#   walnut-iroh-relay.service  the relay, 127.0.0.1:3340 behind Caddy (/relay, /ping on 443).
#                              It lets in only machines on the user's list: for each one
#                              that connects it asks Walnut (POST /api/v1/net/relay-access,
#                              loopback, with the token below), so a stranger is refused.
#   walnut-iroh-qad.service    address discovery on UDP 7842: tells a member its public
#                              address so two machines can connect directly. It carries no
#                              data and accepts no stream. Its certificate is its own,
#                              made here (the key never leaves this box); Walnut hands the
#                              public half to each machine, which trusts it alone.
#
# Both run as a throwaway user (DynamicUser) with no capabilities and a tight sandbox.
# Usage: net-relay.sh <domain>
set -euo pipefail

DOMAIN="${1:?usage: net-relay.sh <domain>}"
IROH_VERSION=1.4.1
# The official iroh-relay release tarballs (github.com/n0-computer/iroh), pinned.
declare -A IROH_SHA256=(
  [aarch64-unknown-linux-musl]=3fc0c2d67c1cd66250bf82f3e2f17a985b7081a3d272186bad9d63e3f2347b38
  [x86_64-unknown-linux-musl]=75254641e3fad7fcbac6dee4d485556fbe06ef708340a9d8810469270ba626b8
)
RELAY_BIN=/usr/local/bin/walnut-iroh-relay
RELAY_DIR=/etc/walnut-iroh-relay
QAD_DIR=/etc/walnut-iroh-qad
ETC_WALNUT=/etc/walnut
WALNUT_GROUP=walnut
TOKEN_FILE="$ETC_WALNUT/net-relay-token"
ROOT_FILE="$ETC_WALNUT/net-relay-root.crt"
DROPIN_DIR=/etc/systemd/system/walnut.service.d

case "$(uname -m)" in
  aarch64|arm64) TARGET=aarch64-unknown-linux-musl ;;
  x86_64|amd64) TARGET=x86_64-unknown-linux-musl ;;
  *) echo "net-relay: no relay build for $(uname -m)" >&2; exit 1 ;;
esac

# 1. The binary (kept when it is already this version).
if [ ! -x "$RELAY_BIN" ] || [ "$("$RELAY_BIN" --version 2>/dev/null | awk '{print $2}')" != "$IROH_VERSION" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  url="https://github.com/n0-computer/iroh/releases/download/v$IROH_VERSION/iroh-relay-v$IROH_VERSION-$TARGET.tar.gz"
  curl -fsSL --retry 3 --max-time 300 -o "$tmp/relay.tar.gz" "$url"
  echo "${IROH_SHA256[$TARGET]}  $tmp/relay.tar.gz" | sha256sum -c --quiet -
  tar -xzf "$tmp/relay.tar.gz" -C "$tmp" ./iroh-relay
  install -o root -g root -m 755 "$tmp/iroh-relay" "$RELAY_BIN"
fi
"$RELAY_BIN" --version

# 2. The token the relay shows Walnut (made once). Walnut reads it from the file; the relay
#    gets it from an env file systemd reads as root.
install -o root -g root -m 755 -d "$RELAY_DIR" "$QAD_DIR"
if [ ! -s "$TOKEN_FILE" ] || [ -L "$TOKEN_FILE" ]; then
  rm -f "$TOKEN_FILE"
  ( umask 077; openssl rand -hex 32 > "$TOKEN_FILE.tmp" )
  mv -fT "$TOKEN_FILE.tmp" "$TOKEN_FILE"
fi
chown root:"$WALNUT_GROUP" "$TOKEN_FILE"; chmod 640 "$TOKEN_FILE"
( umask 077; printf 'IROH_RELAY_HTTP_BEARER_TOKEN=%s\n' "$(cat "$TOKEN_FILE")" > "$RELAY_DIR/env" )
chmod 600 "$RELAY_DIR/env"

cat > "$RELAY_DIR/relay.toml" <<'EOF'
# Walnut's relay: loopback only, behind Caddy. Address discovery is its own unit
# (walnut-iroh-qad); no metrics port.
enable_relay = true
http_bind_addr = "127.0.0.1:3340"
enable_quic_addr_discovery = false
enable_metrics = false
# Only the user's machines: Walnut on this box answers "true" for a member.
[access.http]
url = "http://127.0.0.1:3456/api/v1/net/relay-access"
# A bound on what reaches this box: new connections, and what each machine may send.
[limits]
accept_conn_limit = 20.0
accept_conn_burst = 100
[limits.client.rx]
bytes_per_second = 8388608
max_burst_bytes = 33554432
EOF
chmod 644 "$RELAY_DIR/relay.toml"

# 3. Address discovery's own certificate (made once; ten years).
if [ ! -s "$QAD_DIR/qad.key" ]; then
  ( umask 077
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -keyout "$QAD_DIR/qad.key" -out "$QAD_DIR/qad.crt" -days 3650 \
      -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" \
      -addext "basicConstraints=critical,CA:FALSE" -addext "extendedKeyUsage=serverAuth" \
      -addext "keyUsage=critical,digitalSignature" 2>/dev/null )
fi
chmod 600 "$QAD_DIR/qad.key"; chmod 644 "$QAD_DIR/qad.crt"
install -o root -g "$WALNUT_GROUP" -m 644 "$QAD_DIR/qad.crt" "$ROOT_FILE"

cat > "$QAD_DIR/qad.toml" <<'EOF'
# Address discovery only: no relaying (that stays on 443 behind Caddy), no HTTP, no metrics.
# Answers a QUIC handshake on UDP 7842 with the caller's own public address; streams are refused.
enable_relay = false
http_bind_addr = "127.0.0.1:3342"
enable_quic_addr_discovery = true
enable_metrics = false
[tls]
cert_mode = "Manual"
manual_cert_path = "/run/credentials/walnut-iroh-qad.service/qad.crt"
manual_key_path = "/run/credentials/walnut-iroh-qad.service/qad.key"
quic_bind_addr = "0.0.0.0:7842"
dangerous_http_only = true
EOF
chmod 644 "$QAD_DIR/qad.toml"

# 4. The units: a throwaway user, no capabilities, nothing writable.
sandbox() {
  cat <<'EOF'
Restart=always
RestartSec=2
DynamicUser=yes
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateUsers=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
TasksMax=64

[Install]
WantedBy=multi-user.target
EOF
}
{
  cat <<EOF
[Unit]
Description=Walnut host network relay (127.0.0.1:3340 behind Caddy; only the user's machines)
After=network-online.target walnut.service

[Service]
EnvironmentFile=$RELAY_DIR/env
ExecStart=$RELAY_BIN -c $RELAY_DIR/relay.toml
MemoryMax=256M
EOF
  sandbox
} > /etc/systemd/system/walnut-iroh-relay.service
{
  cat <<EOF
[Unit]
Description=Walnut host network address discovery (UDP 7842; tells the user's machines their public address, carries no data)
After=network-online.target

[Service]
# Its own certificate, never Caddy's key: handed over by systemd, readable by this unit alone.
LoadCredential=qad.crt:$QAD_DIR/qad.crt
LoadCredential=qad.key:$QAD_DIR/qad.key
ExecStart=$RELAY_BIN -c $QAD_DIR/qad.toml
MemoryMax=64M
EOF
  sandbox
} > /etc/systemd/system/walnut-iroh-qad.service
chmod 644 /etc/systemd/system/walnut-iroh-relay.service /etc/systemd/system/walnut-iroh-qad.service

# 5. What Walnut needs to hand each machine: the relay, its token, the discovery pin.
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/net.conf" <<EOF
[Service]
Environment=WALNUT_NET_RELAYS=https://$DOMAIN
Environment=WALNUT_NET_RELAY_TOKEN_FILE=$TOKEN_FILE
Environment=WALNUT_NET_RELAY_ROOT_FILE=$ROOT_FILE
EOF
chmod 644 "$DROPIN_DIR/net.conf"

systemctl daemon-reload
systemctl enable walnut-iroh-relay.service walnut-iroh-qad.service
systemctl restart walnut-iroh-relay.service walnut-iroh-qad.service
echo "    host network relay: $(systemctl is-active walnut-iroh-relay) / address discovery: $(systemctl is-active walnut-iroh-qad)"
