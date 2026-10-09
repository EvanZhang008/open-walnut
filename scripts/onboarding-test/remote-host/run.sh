#!/usr/bin/env bash
# Remote-host onboarding test for Open Walnut: the SECOND machine.
#
# The fresh-machine harness one level up proves the Walnut server installs and
# answers. This one proves Walnut can take a brand-new Linux dev box it has
# never seen and provision it over real ssh: install the daemon runtime (Bun),
# upload and start the daemon, tunnel to it, list folders, probe the terminal,
# and report a precise reason when `claude` cannot run there.
#
# The dev box is a local container (Dockerfile next to this file) with no C
# compiler, no node, an npm-built `claude`, and ~/workplace -> /workplace.
#
# What this script does, in order:
#   1. refuses to start without a working Docker (clear message, exit 1)
#   2. builds the fixture image
#   3. generates a throwaway ed25519 key pair in a private temp dir
#   4. starts the container with sshd on a random loopback port
#   5. writes an ssh config with the alias walnut-onboarding-devbox
#   6. runs tests/live/remote-host-onboarding.live.test.ts against it
#   7. on EXIT (success, failure or Ctrl-C) removes the container it started
#      and the temp dir, and nothing else
#
# Usage:
#   scripts/onboarding-test/remote-host/run.sh          # build, run, tear down
#   scripts/onboarding-test/remote-host/run.sh --keep   # leave the container up
#   scripts/onboarding-test/remote-host/run.sh --help
#
# Needs: docker (daemon running), ssh, ssh-keygen, and `npm install` done in
# the repo. `npm run build:daemon` first gives the daemon its optional sidecars.
# Bash 3.2 safe: this also runs from a stock macOS shell.

KEEP=0
case "${1:-}" in
  -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  --keep) KEEP=1 ;;
  "") ;;
  *) echo "remote-host: unknown argument '$1' (see --help)" >&2; exit 1 ;;
esac

# The Docker check comes before anything else runs and uses only shell
# builtins, so it answers even on a PATH that has nothing else on it.
if ! command -v docker >/dev/null 2>&1; then
  echo "remote-host: docker is not installed or not on PATH." >&2
  echo "remote-host: this test runs the remote host as a local container. Install Docker, or let CI run it (job 'remote-host')." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "remote-host: docker is installed but its daemon is not running (docker info failed)." >&2
  echo "remote-host: start Docker and retry, or let CI run it (job 'remote-host')." >&2
  exit 1
fi

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
IMAGE="walnut-onboarding-remote-host:local"
SSH_ALIAS="walnut-onboarding-devbox"

die() { echo "remote-host: $*" >&2; exit 1; }
# Registry and mirror failures as docker, apt and curl print them.
NETWORK_PATTERN='Could not resolve|Temporary failure (in name )?resolv|no such host|dial tcp|i/o timeout|TLS handshake timeout|connection (refused|reset)|toomanyrequests|429 Too Many Requests|Failed to fetch|unexpected EOF|net/http'

for tool in ssh ssh-keygen; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed; the test drives Walnut's real ssh path"
done
VITEST="$REPO/node_modules/.bin/vitest"
[ -x "$VITEST" ] || die "vitest is missing; run 'npm install' in $REPO first"
if [ ! -f "$REPO/dist/daemon-binaries/changes-core.cjs" ]; then
  echo "remote-host: warning: dist/daemon-binaries has no sidecars; run 'npm run build:daemon' for full daemon parity" >&2
fi

# Short path on purpose: ssh ControlMaster sockets live under here and a unix
# socket path is capped near 104 bytes.
WORK="$(mktemp -d /tmp/walnut-rh.XXXXXX)"
CONTAINER_ID=""

cleanup() {
  status=$?
  if [ -n "$CONTAINER_ID" ]; then
    if [ "$KEEP" = 1 ]; then
      echo "remote-host: --keep: container $CONTAINER_ID left running; remove it with: docker rm -f $CONTAINER_ID" >&2
    else
      docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
    fi
  fi
  # Only ever the dir this run created.
  case "$WORK" in
    /tmp/walnut-rh.*) [ "$KEEP" = 1 ] || rm -rf "$WORK" ;;
  esac
  exit "$status"
}
trap cleanup EXIT

t0=$(date +%s)
echo "remote-host: building $IMAGE"
# The base image is pinned by digest (see the Dockerfile), so every registry
# below hands out the same bytes. Docker Hub limits anonymous pulls per address
# and a hosted runner shares its address with other jobs: 2026-10-09 both
# attempts got 429 Too Many Requests. A base image a registry would not hand out
# moves to the next one; any other build failure is reported as it is.
BASE_REGISTRIES="docker.io/library mirror.gcr.io/library public.ecr.aws/docker/library"
BASE_REFUSED_PATTERN='failed to resolve source metadata|toomanyrequests|429 Too Many Requests'
built=0
for registry in $BASE_REGISTRIES; do
  if docker build --build-arg "BASE_REGISTRY=$registry" -t "$IMAGE" "$HERE" > "$WORK/docker-build.log" 2>&1; then
    built=1
    break
  fi
  grep -Eiq "$BASE_REFUSED_PATTERN" "$WORK/docker-build.log" || break
  echo "remote-host: $registry did not hand out the base image: $(grep -Eim1 "$BASE_REFUSED_PATTERN" "$WORK/docker-build.log" | cut -c1-200)" >&2
done
if [ "$built" != 1 ]; then
  tail -n 40 "$WORK/docker-build.log" >&2
  # A failed pull or apt fetch is the network, not the fixture; say which, so
  # CI's summary tells a registry hiccup from a broken Dockerfile.
  if grep -Eiq "$NETWORK_PATTERN" "$WORK/docker-build.log"; then
    die "NETWORK: docker build could not fetch the base image or apt packages: $(grep -Eim1 "$NETWORK_PATTERN" "$WORK/docker-build.log")"
  fi
  die "docker build failed (see the log above)"
fi
echo "remote-host: image built in $(( $(date +%s) - t0 ))s"

ssh-keygen -q -t ed25519 -N '' -C walnut-onboarding-throwaway -f "$WORK/id_ed25519"

# 127.0.0.1::22 lets Docker pick a free high port on loopback only.
CONTAINER_ID="$(docker run -d --rm \
  --label walnut-onboarding-test=remote-host \
  -p 127.0.0.1::22 \
  -e WALNUT_ONBOARDING_AUTHORIZED_KEY="$(cat "$WORK/id_ed25519.pub")" \
  "$IMAGE")"
PORT="$(docker port "$CONTAINER_ID" 22/tcp | head -n 1 | sed 's/.*://')"
case "$PORT" in ''|*[!0-9]*) die "could not read the container's ssh port (got '$PORT')" ;; esac
echo "remote-host: container ${CONTAINER_ID:0:12} serves ssh on 127.0.0.1:$PORT"

SSH_CONFIG="$WORK/ssh_config"
cat > "$SSH_CONFIG" <<CFG
Host $SSH_ALIAS
  HostName 127.0.0.1
  Port $PORT
  User alice
  IdentityFile $WORK/id_ed25519
  IdentitiesOnly yes
  IdentityAgent none
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  GlobalKnownHostsFile /dev/null
  LogLevel ERROR
CFG

ready=0
for _ in $(seq 1 60); do
  if ssh -F "$SSH_CONFIG" -o BatchMode=yes -o ConnectTimeout=2 "$SSH_ALIAS" true >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  docker logs "$CONTAINER_ID" >&2 || true
  die "sshd in the container never accepted the throwaway key within 60s"
fi
echo "remote-host: ssh $SSH_ALIAS works; running the live test"

export WALNUT_REMOTE_ONBOARDING_SSH_CONFIG="$SSH_CONFIG"
export WALNUT_REMOTE_ONBOARDING_HOST="$SSH_ALIAS"
# Belt and braces: the test mocks its own data dir, but nothing it spawns may
# fall back to the real data dir or the default daemon runtime dir either.
export OPEN_WALNUT_HOME="$WORK/walnut-home"
export WALNUT_DAEMON_DIR="$WORK/walnut-runtime"
mkdir -p "$OPEN_WALNUT_HOME" "$WALNUT_DAEMON_DIR"

cd "$REPO"
set +e
"$VITEST" run --config vitest.live.config.ts tests/live/remote-host-onboarding.live.test.ts
test_status=$?
set -e

if [ "$test_status" != 0 ]; then
  echo "remote-host: live test failed; daemon-side logs from the container follow" >&2
  docker exec "$CONTAINER_ID" sh -c 'ls -la /tmp/open-walnut 2>&1; for f in /tmp/open-walnut/daemon-start.log /tmp/open-walnut/daemon-d-*.log; do [ -f "$f" ] && { echo "== $f"; tail -n 60 "$f"; }; done' >&2 || true
fi
exit "$test_status"
