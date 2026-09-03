#!/bin/bash
# Fresh-machine onboarding test for Open Walnut.
#
# Provisions a machine that has never seen Walnut, does exactly what the README tells a
# new user to do (git clone → npm install → npm start, and npm install -g open-walnut),
# times every step, screenshots the first-run page, and tears the machine down. What
# comes back is a table of steps and a list of "findings": each place a brand-new user
# would have had to stop and figure something out.
#
#   scripts/onboarding-test/run.sh mac-vm  [--image ghcr.io/cirruslabs/macos-sequoia-vanilla:latest]
#   scripts/onboarding-test/run.sh linux   [--os al2023|al2|al2023-arm|ubuntu] [--type t3.large]
#   scripts/onboarding-test/run.sh mac-ec2 [--os sequoia|tahoe] [--type mac2.metal] --yes-mac-host
#
#   common flags: --path readme,npm  --ref <git ref>  --pkg open-walnut@latest
#                 --keep (leave the machine up)  --record (asciinema + browser video → mp4)
#                 --ttl-hours 3 (sweep may kill the instance after this)
#
#   scripts/onboarding-test/run.sh status              # what is up right now
#   scripts/onboarding-test/run.sh sweep [--all] [--release-hosts]
#   scripts/onboarding-test/run.sh release-host        # give the Mac host back (24h min billed)
#
# Targets:
#   mac-vm   a stock macOS VM on this Apple Silicon Mac via Tart: no Homebrew, no Xcode
#            CLT, no git, no node. Free, ~2 min to boot, nothing left behind.
#   linux    EC2 (Amazon Linux 2023 / Ubuntu 24.04), reached only through SSM.
#   mac-ec2  EC2 mac2.metal; needs Mac-host eligibility on the account and bills 24h min.
#
# Artifacts: /tmp/walnut-onboarding-test/<run-id>/{report.md,steps.jsonl,logs/,first-run-*.png,onboarding-*.mp4}

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; }
TARGET="${1:-}"; [ $# -gt 0 ] && shift
case "$TARGET" in -h|--help|'') usage; exit 0 ;; esac
PATHS="readme,npm"; REF="main"; PKG="open-walnut@latest"; KEEP=0; RECORD=0; TTL_HOURS=3
OS=""; ITYPE=""; IMAGE=""; YES_MAC_HOST=0; SWEEP_ALL=0; RELEASE_HOSTS=0; READY_TIMEOUT=900
ORIG_ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --path) PATHS="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --pkg) PKG="$2"; shift 2 ;;
    --os) OS="$2"; shift 2 ;;
    --type) ITYPE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --ttl-hours) TTL_HOURS="$2"; shift 2 ;;
    --ready-timeout) READY_TIMEOUT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --record) RECORD=1; shift ;;
    --yes-mac-host) YES_MAC_HOST=1; shift ;;
    --all) SWEEP_ALL=1; shift ;;
    --release-hosts) RELEASE_HOSTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag $1 (see --help)" ;;
  esac
done
export KEEP YES_MAC_HOST

case "$TARGET" in
  mac-vm|linux|mac-ec2) ;;
  status)       . "$HERE/lib/aws.sh"; aws_require; aws_status; exit 0 ;;
  sweep)        . "$HERE/lib/aws.sh"; aws_require; SWEEP_ALL=$SWEEP_ALL RELEASE_HOSTS=$RELEASE_HOSTS aws_sweep; exit 0 ;;
  release-host) . "$HERE/lib/aws.sh"; aws_require; aws_release_hosts; exit 0 ;;
  *) die "unknown target '$TARGET': mac-vm | linux | mac-ec2 | status | sweep | release-host  (--help for details)" ;;
esac

# Under --record the outer process already picked the run dir; the inner one inherits it.
if [ -n "${ONB_RUN_DIR:-}" ]; then
  RUN_DIR="$ONB_RUN_DIR"; RUN_ID="$(basename "$RUN_DIR")"
else
  RUN_ID="$(new_run_id "$TARGET")"; RUN_DIR="$ONB_OUT_ROOT/$RUN_ID"
fi
mkdir -p "$RUN_DIR"

# --record: re-run this exact invocation under asciinema so the whole terminal story
# (provisioning narration + the probe's live output) lands in one .cast, then render.
if [ "$RECORD" = 1 ] && [ -z "${ONB_INSIDE_REC:-}" ]; then
  need_cmd asciinema "brew install asciinema"
  export ONB_INSIDE_REC=1 ONB_RUN_DIR="$RUN_DIR"
  asciinema rec --overwrite --cols 120 --rows 36 --title "Open Walnut onboarding · $TARGET" \
    -c "$0 $TARGET ${ORIG_ARGS[*]}" "$RUN_DIR/terminal.cast"
  bash "$HERE/render-video.sh" "$RUN_DIR" "$TARGET"
  exit 0
fi

log "run $RUN_ID → $RUN_DIR"
PROBE_ARGS="--path $PATHS --ref $REF --pkg $PKG --ready-timeout $READY_TIMEOUT --out \$HOME/walnut-onb"

# ── provision ─────────────────────────────────────────────────────────────────
case "$TARGET" in
  mac-vm)
    . "$HERE/lib/tart.sh"
    IMAGE="${IMAGE:-$TART_IMAGE_DEFAULT}"
    tart_require "$IMAGE"
    tart_up "onb-$(utc_stamp | tr -d 'TZ')" "$IMAGE"
    exec_stream() { tart_ssh "$@"; }
    put_probe()   { tart_scp_to "$HERE/probe.sh" "probe.sh"; }
    fetch_out()   { tart_scp_from "walnut-onb/steps.jsonl" "$RUN_DIR/"; tart_scp_from "walnut-onb/logs" "$RUN_DIR/"; }
    forward()     { tart_forward "$1" "$2"; }
    PROBE_CMD="bash ~/probe.sh $PROBE_ARGS"
    ;;
  linux|mac-ec2)
    . "$HERE/lib/aws.sh"
    aws_require
    SWEEP_ALL=0 RELEASE_HOSTS=0 aws_sweep   # expired leftovers only; --all belongs to `sweep`
    TTL=$(( $(now_s) + TTL_HOURS * 3600 ))
    if [ "$TARGET" = linux ]; then
      OS="${OS:-al2023}"
      # The default type follows the AMI's architecture; an arm64 image on t3 is refused.
      case "$OS" in *-arm) ITYPE="${ITYPE:-c7g.large}" ;; *) ITYPE="${ITYPE:-t3.large}" ;; esac
      case "$OS" in ubuntu) LOGIN=ubuntu ;; *) LOGIN=ec2-user ;; esac
      SSM_WAIT=600
    else
      OS="${OS:-sequoia}"; ITYPE="${ITYPE:-mac2.metal}"; LOGIN=ec2-user
      SSM_WAIT=1500
    fi
    if [ -n "${WALNUT_ONB_REUSE_INSTANCE:-}" ]; then
      # Harness development only: point at an instance a previous --keep run left up.
      INSTANCE_ID="$WALNUT_ONB_REUSE_INSTANCE"; warn "reusing $INSTANCE_ID (not a fresh machine!)"
    else
      HOST_ID=""; [ "$TARGET" = mac-ec2 ] && aws_mac_host "$ITYPE"   # sets HOST_ID or dies
      AMI="$(aws_ami "$OS")"; [ -n "$AMI" ] || die "aws: no AMI for --os $OS"
      WALNUT_ONB_DISK_GB="${WALNUT_ONB_DISK_GB:-$([ "$TARGET" = mac-ec2 ] && echo 150 || echo 60)}" \
        aws_launch "$AMI" "$ITYPE" "$RUN_ID" "$TTL" "$LOGIN" $HOST_ID
      aws_wait_ssm "$INSTANCE_ID" "$SSM_WAIT"
    fi
    [ "$TARGET" = mac-ec2 ] && REMOTE_HOME="/Users/$LOGIN" || REMOTE_HOME="/home/$LOGIN"
    # The follow file lives in /tmp (written by root's detached shell); the probe's own
    # output dir is created by the login user so ownership never gets in its way.
    exec_stream() { aws_ssm_follow "$INSTANCE_ID" "$1" "/tmp/walnut-onb-probe.out"; }
    exec_quiet()  { aws_ssm_exec "$INSTANCE_ID" "$1" 120; }
    put_probe()   { aws_ssm_put_file "$INSTANCE_ID" "$HERE/probe.sh" "/tmp/probe.sh"; }
    fetch_out()   {
      aws_ssm_cat "$INSTANCE_ID" "$REMOTE_HOME/walnut-onb/steps.jsonl" | sed '/^None$/d' > "$RUN_DIR/steps.jsonl"
      # All logs in ONE round trip (SSM caps a reply near 24KB): the tail of each file
      # behind a marker line, split back into files here.
      mkdir -p "$RUN_DIR/logs"
      aws_ssm_exec "$INSTANCE_ID" "for f in $REMOTE_HOME/walnut-onb/logs/*.log; do echo \"@@FILE \$(basename \$f)\"; tail -c 2400 \"\$f\"; echo; done" 60 \
        | awk -v dir="$RUN_DIR/logs" '/^@@FILE /{ out = dir "/" $2; printf "" > out; next } out { print >> out }'
    }
    forward()     { aws_port_forward "$INSTANCE_ID" "$1" "$2"; }
    # SSM runs as ssm-user; the probe must run as the login user so nvm/npm -g land in a
    # real home directory like they would for a person.
    PROBE_CMD="sudo -iu $LOGIN bash -lc 'bash /tmp/probe.sh $PROBE_ARGS'"
    ;;
esac

# ── run the probe, streaming its narration into this terminal ─────────────────
put_probe
log "probe: starting on the fresh machine"
exec_stream "$PROBE_CMD" | tee "$RUN_DIR/probe.out" || true
log "probe: collecting results"
fetch_out || warn "could not fetch all probe output"
summarize_steps "$RUN_DIR/steps.jsonl" | tee "$RUN_DIR/summary.txt"

# ── first-run capture (screenshot + optional browser video) per path that came up ──
step_ok() { grep -q "\"name\":\"$1\",\"status\":\"ok\"" "$RUN_DIR/steps.jsonl" 2>/dev/null; }
CAPTURE_FLAGS=""; [ "$RECORD" = 1 ] && CAPTURE_FLAGS="--video"
LP=$((40000 + RANDOM % 20000))   # per-run local ports so two runs can capture at once
if step_ok "readme:first-run"; then
  forward 3456 "$LP"
  (cd "$REPO_ROOT" && node "$HERE/capture.mjs" --url "http://127.0.0.1:$LP" --out "$RUN_DIR" --name readme $CAPTURE_FLAGS) || warn "capture (readme) failed"
fi
if step_ok "npm:first-run"; then
  forward 3458 "$((LP + 1))"
  (cd "$REPO_ROOT" && node "$HERE/capture.mjs" --url "http://127.0.0.1:$((LP + 1))" --out "$RUN_DIR" --name npm $CAPTURE_FLAGS) || warn "capture (npm) failed"
fi

# ── stop the servers the probe started (its own PIDs only), then teardown via trap ──
case "$TARGET" in
  mac-vm) tart_ssh "bash ~/probe.sh --stop" || true ;;
  *) exec_quiet "sudo -iu $LOGIN bash -lc 'bash /tmp/probe.sh --stop'" || true ;;
esac

# ── report ─────────────────────────────────────────────────────────────────────
{
  echo "# Onboarding test · $RUN_ID"
  echo
  echo "Target: $TARGET${OS:+ ($OS)}${ITYPE:+ · $ITYPE}${IMAGE:+ · $IMAGE} · paths: $PATHS · ref: $REF · pkg: $PKG"
  echo
  echo '```'; cat "$RUN_DIR/summary.txt"; echo '```'
  echo
  echo "## Artifacts"
  for f in "$RUN_DIR"/first-run-*.png "$RUN_DIR"/onboarding-*.mp4 "$RUN_DIR"/browser-*.mp4 "$RUN_DIR"/terminal.cast; do [ -e "$f" ] && echo "- $f"; done
  echo "- $RUN_DIR/logs/ (full output of every step)"
} > "$RUN_DIR/report.md"
ok "report: $RUN_DIR/report.md"
[ "$KEEP" = 1 ] && warn "--keep: machine left running; clean up with: run.sh sweep --all (aws) or tart delete (mac-vm)"
exit 0
