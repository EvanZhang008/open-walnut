# shellcheck shell=bash
# Target: a brand-new macOS virtual machine on this Apple Silicon Mac, via Tart
# (https://tart.run). The "vanilla" image is a stock macOS install: no Homebrew, no
# Xcode Command Line Tools, no git, no node — the closest thing to a new laptop.
# Zero cloud cost; a run leaves nothing behind (`tart delete` on exit).
#
# Requires: brew install cirruslabs/cli/tart sshpass ; tart pull <image> (~24GB once).

TART_IMAGE_DEFAULT="ghcr.io/cirruslabs/macos-sequoia-vanilla:latest"
TART_USER="admin"      # cirruslabs images: admin/admin with passwordless sudo
TART_PASS="admin"
TART_SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5"

# Tart prunes its image cache when disk is low; on a Mac with ~44 GB free it deleted
# a finished 30 GB pull before the clone could use it. The run needs the image, so no.
export TART_NO_AUTO_PRUNE=1

tart_require() {
  need_cmd tart "brew install cirruslabs/cli/tart"
  need_cmd sshpass "brew install sshpass"
  local image="$1"
  # plain table output: the JSON form escapes the slashes in the name
  tart list 2>/dev/null | awk 'NR > 1 { print $2 }' | grep -qxF "$image" \
    || die "image not pulled yet: tart pull $image"
}

# tart_up <vm-name> <image>  → sets TART_IP; registers stop+delete on exit
tart_up() {
  local vm="$1" image="$2"
  log "tart: clone $image → $vm"
  tart clone "$image" "$vm" || die "tart clone failed"
  # --keep leaves the VM running for a look around; `tart delete <vm>` when done.
  on_exit_push "[ \"\${KEEP:-0}\" = 1 ] || tart delete '$vm' >/dev/null 2>&1 || true"
  tart set "$vm" --cpu "${WALNUT_ONB_TART_CPU:-4}" --memory "${WALNUT_ONB_TART_MEM:-8192}" >/dev/null 2>&1 || true
  log "tart: booting (headless)"
  tart run "$vm" --no-graphics --no-audio > "$RUN_DIR/tart-run.log" 2>&1 &
  TART_RUN_PID=$!
  on_exit_push "[ \"\${KEEP:-0}\" = 1 ] || tart stop '$vm' >/dev/null 2>&1 || kill $TART_RUN_PID 2>/dev/null || true"
  wait_for "tart ip '$vm' --wait 5" 180 3 || die "tart: VM got no IP in 180s (see $RUN_DIR/tart-run.log)"
  TART_IP=$(tart ip "$vm")
  wait_for "tart_ssh true" 240 5 || die "tart: ssh not reachable on $TART_IP in 240s"
  ok "tart: $vm up at $TART_IP"
}

# tart_ssh <cmd...>  — runs in the VM as admin, streams output
tart_ssh() {
  # shellcheck disable=SC2086
  sshpass -p "$TART_PASS" ssh $TART_SSH_OPTS "$TART_USER@$TART_IP" "$@"
}
# shellcheck disable=SC2086
tart_scp_to()   { sshpass -p "$TART_PASS" scp $TART_SSH_OPTS "$1" "$TART_USER@$TART_IP:$2"; }
# shellcheck disable=SC2086
tart_scp_from() { sshpass -p "$TART_PASS" scp $TART_SSH_OPTS -r "$TART_USER@$TART_IP:$1" "$2"; }

# Forward VM port $1 to local port $2 in the background; registers teardown.
tart_forward() {
  # shellcheck disable=SC2086
  sshpass -p "$TART_PASS" ssh $TART_SSH_OPTS -N -L "127.0.0.1:$2:127.0.0.1:$1" "$TART_USER@$TART_IP" &
  FWD_PID=$!
  on_exit_push "kill $FWD_PID 2>/dev/null || true"
  wait_for "curl -s -o /dev/null http://127.0.0.1:$2/api/system/health" 30 1 || warn "tart: port-forward $1→$2 not answering"
}
