#!/bin/bash
# tests/e2e/old-box/run.sh [--release <v0.6.17 linux archive>] [--work <dir>] [--files <dir>]
#
# Proves that a cloud companion box set up before the compiled walnut file moves
# to it with no step on the box (docs/plan/walnut-single-binary.md, "The cloud
# companion"): builds two walnut files for the box's Linux (this checkout's HEAD,
# then the same tree one empty commit later, in a scratch clone, so each has its
# own build id), then runs tests/e2e/companion-old-box-e2e.test.ts, which lays a
# container out like a v0.6.17 box and moves it with this checkout's Mac driver.
#
#   --release  the v0.6.17 Linux archive for the Docker host's arch (default:
#              downloaded from the GitHub release into the work dir)
#   --work     scratch dir (default ${TMPDIR:-/tmp}/walnut-old-box)
#   --files    reuse two built files: <dir>/{a,b}/{walnut,build-info.json}
#
# Needs docker, git and bun (scripts/lib/find-bun.sh). Builds take a few minutes each.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$REPO/scripts/lib/find-bun.sh"
WORK="${TMPDIR:-/tmp}/walnut-old-box"
RELEASE=""
FILES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --files) FILES="$2"; shift 2 ;;
    *) echo "old-box: unknown argument $1" >&2; exit 2 ;;
  esac
done
walnut_find_bun "$REPO" || { echo "old-box: $(walnut_bun_missing)" >&2; exit 1; }
command -v docker >/dev/null || { echo "old-box: needs docker" >&2; exit 1; }

case "$(docker version --format '{{.Server.Arch}}')" in
  arm64|aarch64) ARCH=arm64; BUN_ARCH=aarch64 ;;
  amd64|x86_64) ARCH=x64; BUN_ARCH=x64 ;;
  *) echo "old-box: unsupported docker arch" >&2; exit 1 ;;
esac
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"

if [ -z "$RELEASE" ]; then
  URL=https://github.com/EvanZhang008/open-walnut/releases/download/v0.6.17
  NAME="open-walnut-0.6.17-linux-$ARCH.tar.gz"
  RELEASE="$WORK/$NAME"
  [ -s "$RELEASE" ] || curl -fsSL --retry 3 -o "$RELEASE" "$URL/$NAME"
  curl -fsSL --retry 3 -o "$WORK/SHA256SUMS" "$URL/SHA256SUMS"
  (cd "$WORK" && grep " $NAME\$" SHA256SUMS | shasum -a 256 -c -) || { echo "old-box: $NAME does not match the release's SHA256SUMS" >&2; exit 1; }
fi
# Before the builds, which take minutes.
[ -s "$RELEASE" ] || { echo "old-box: the release archive $RELEASE is missing" >&2; exit 1; }

if [ -z "$FILES" ]; then
  FILES="$WORK/files"
  SRC="$WORK/src"
  rm -rf "$SRC" "$FILES"
  git clone -q "$REPO" "$SRC"
  # The scratch clone builds with this checkout's installed dependencies.
  ln -s "$(cd "$REPO/node_modules" && pwd -P)" "$SRC/node_modules"
  ln -s "$(cd "$REPO/web/node_modules" && pwd -P)" "$SRC/web/node_modules"
  build() { # <name> [build-binary flags]
    local name="$1"; shift
    (cd "$SRC" && "$BUN_BIN" scripts/build-binary.mjs --target "linux-$ARCH" "$@")
    mkdir -p "$FILES/$name"
    cp "$SRC/dist-bin/walnut-linux-$ARCH" "$FILES/$name/walnut"
    cp "$SRC/dist/binary-stage/root/dist/build-info.json" "$FILES/$name/build-info.json"
  }
  build a
  git -C "$SRC" -c user.name=old-box -c user.email=old-box@localhost commit -q --allow-empty -m "old-box e2e: a second build"
  build b --reuse-web
fi

# The last step runs the new launcher on bun, as a later setup.sh does: bun's own
# Linux file, from the cache `bun build --compile` keeps for cross targets.
LINUX_BUN="${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}/bun-linux-$BUN_ARCH-v$BUN_VERSION"
[ -x "$LINUX_BUN" ] || LINUX_BUN=""

cd "$REPO"
WALNUT_OLD_BOX_E2E=1 WALNUT_OLD_BOX_RELEASE="$RELEASE" WALNUT_OLD_BOX_FILES="$FILES" \
WALNUT_OLD_BOX_BUN="$LINUX_BUN" WALNUT_OLD_BOX_EVIDENCE="$WORK/evidence" \
  "$BUN_BIN" --bun ./node_modules/.bin/vitest run --config vitest.e2e.config.ts tests/e2e/companion-old-box-e2e.test.ts
