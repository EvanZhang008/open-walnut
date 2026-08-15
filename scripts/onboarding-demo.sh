#!/usr/bin/env bash
# Build the pristine onboarding image, run it, and drive/verify (optionally record) the
# first-run onboarding from the host. Fully isolated from the production server on :3456.
#
#   scripts/onboarding-demo.sh build                 # build the image
#   scripts/onboarding-demo.sh clean                 # path 1/3: no creds → onboarding shows
#   scripts/onboarding-demo.sh happy                 # path 2: inject a real key → Personal AI ready
#   scripts/onboarding-demo.sh record out.mp4        # record the clean-room onboarding walkthrough
#
# For `happy`, provide a credential via the host env (NEVER committed, NEVER baked in):
#   AWS_BEARER_TOKEN_BEDROCK=... AWS_REGION=us-west-2 scripts/onboarding-demo.sh happy
#   (or AWS_PROFILE=... — but a profile needs ~/.aws mounted; bearer token is simplest in a container)
set -euo pipefail

IMAGE=walnut-onboarding
PORT=3457
URL="http://localhost:${PORT}"
NAME=walnut-onboarding-run
HERE="$(cd "$(dirname "$0")/.." && pwd)"

cmd="${1:-help}"

build() {
  echo "==> building $IMAGE (fresh Linux build inside the image) …"
  docker build -f "$HERE/Dockerfile.onboarding" -t "$IMAGE" "$HERE"
}

stop_run() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }

run_container() {
  # $1... extra `docker run` args (e.g. -e AWS_BEARER_TOKEN_BEDROCK=...)
  stop_run
  echo "==> starting container on :$PORT (clean home, no host mounts) …"
  docker run -d --name "$NAME" -p "${PORT}:${PORT}" "$@" "$IMAGE" >/dev/null
}

case "$cmd" in
  build) build ;;

  clean)
    docker image inspect "$IMAGE" >/dev/null 2>&1 || build
    run_container
    echo "==> verifying clean-room onboarding (expect banner, no provider) …"
    node "$HERE/scripts/onboarding-demo.mjs" --url "$URL"
    rc=$?
    stop_run
    exit $rc
    ;;

  happy)
    docker image inspect "$IMAGE" >/dev/null 2>&1 || build
    # Pass whatever credential the host has — bearer token is the container-friendly path.
    declare -a CREDS=()
    [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ] && CREDS+=(-e "AWS_BEARER_TOKEN_BEDROCK=${AWS_BEARER_TOKEN_BEDROCK}")
    [ -n "${AWS_REGION:-}" ] && CREDS+=(-e "AWS_REGION=${AWS_REGION}")
    [ -n "${AWS_ACCESS_KEY_ID:-}" ] && CREDS+=(-e "AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}")
    [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && CREDS+=(-e "AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}")
    if [ ${#CREDS[@]} -eq 0 ]; then
      echo "ERROR: 'happy' needs a credential in the host env (AWS_BEARER_TOKEN_BEDROCK + AWS_REGION)." >&2
      exit 2
    fi
    run_container "${CREDS[@]}"
    echo "==> verifying happy path (expect provider ready + Personal AI reply) …"
    node "$HERE/scripts/onboarding-demo.mjs" --url "$URL" --expect-ready --chat "hello, are you there?"
    rc=$?
    stop_run
    exit $rc
    ;;

  record)
    out="${2:-onboarding.mp4}"
    docker image inspect "$IMAGE" >/dev/null 2>&1 || build
    run_container
    echo "==> recording clean-room onboarding → $out …"
    node "$HERE/scripts/onboarding-demo.mjs" --url "$URL" --record "$out"
    rc=$?
    stop_run
    exit $rc
    ;;

  stop) stop_run; echo "stopped." ;;

  *)
    echo "usage: scripts/onboarding-demo.sh {build|clean|happy|record <file>|stop}" >&2
    echo "  clean  — path 1/3: no creds, assert onboarding banner shows" >&2
    echo "  happy  — path 2: inject host cred, assert Personal AI ready + replies" >&2
    echo "  record — record the clean-room onboarding walkthrough to <file>" >&2
    exit 1
    ;;
esac
