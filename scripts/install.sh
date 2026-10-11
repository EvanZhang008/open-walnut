#!/bin/sh
# Install Open Walnut: one command, no Node, no npm, no build tools.
#
#   curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh
#
# Downloads the self-contained archive for this machine (its own Node plus the
# open-walnut package, scripts/runtime-bundle/build.mjs) from the GitHub
# Release, checks it against the release's SHA256SUMS, puts it in
# ~/.local/share/open-walnut/app and links `walnut` into ~/.local/bin. Running
# it again installs the newest release over the old one. Walnut updates itself
# after that (`walnut update`, and on every start).
#
# Knobs: OPEN_WALNUT_VERSION (a release, default the newest), OPEN_WALNUT_INSTALL_DIR,
# OPEN_WALNUT_BIN_DIR, OPEN_WALNUT_RELEASE_BASE_URL and OPEN_WALNUT_RELEASES_API (mirrors, tests;
# a file:// base is a directory laid out like the releases, by path, not percent-encoded: the
# release Walnut.app carries), OPEN_WALNUT_PROGRESS=1 (the download's progress bar without a terminal).
set -eu

repo="EvanZhang008/open-walnut"
base_url="${OPEN_WALNUT_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
releases_api="${OPEN_WALNUT_RELEASES_API:-https://api.github.com/repos/${repo}/releases?per_page=20}"
install_dir="${OPEN_WALNUT_INSTALL_DIR:-$HOME/.local/share/open-walnut}"
bin_dir="${OPEN_WALNUT_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf '\nopen-walnut install: %s\n' "$1" >&2
  exit 1
}
say() { printf '  %s\n' "$1" >&2; }

# fetch URL FILE [progress]: 0 on success, 44 on a 404, 1 otherwise.
fetch() {
  # A release on this disk (the one inside Walnut.app): no network at all.
  case "$1" in
    file://*)
      [ -f "${1#file://}" ] || return 44
      cp "${1#file://}" "$2" || return 1
      return 0
      ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    # A progress bar for the one big download, when someone is watching: a
    # terminal, or the Mac app, which reads the percentage off it
    # (OPEN_WALNUT_PROGRESS=1, desktop/BundledRuntime.swift).
    quiet="-sS"
    if [ "${3:-}" = progress ] && { [ -t 2 ] || [ "${OPEN_WALNUT_PROGRESS:-}" = 1 ]; }; then quiet="--progress-bar"; fi
    status="$(curl "$quiet" -L --retry 3 -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s answered HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    if wget -q "$1" -O "$2"; then return 0; fi
    return 1
  else
    fail "curl or wget is required"
  fi
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "Open Walnut runs on macOS and Linux; on $(uname -s) use npm: npm install -g open-walnut" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "no build for $(uname -m); use npm: npm install -g open-walnut" ;;
esac
# An Apple silicon Mac running this shell under Rosetta still wants the arm64 build.
if [ "$platform" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch="arm64"
fi

command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

mkdir -p "$install_dir"
staging="$(mktemp -d "${install_dir}/.staging-XXXXXX")"
cleanup() {
  # A swap that stopped half way puts the old copy back before anything is removed.
  if [ ! -e "$install_dir/app" ] && [ -e "$staging/previous" ]; then mv "$staging/previous" "$install_dir/app"; fi
  rm -rf "$staging"
  # A first install that failed leaves no empty directory behind.
  rmdir "$install_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

target="${platform}-${arch}"
version="${OPEN_WALNUT_VERSION:-}"
version="${version#v}"
if [ -z "$version" ]; then
  say "Finding the newest release..."
  # The newest release's checksums name its archives, and so its version.
  if fetch "${base_url%/download}/latest/download/SHA256SUMS" "$staging/SHA256SUMS"; then
    version="$(sed -n "s/.*open-walnut-\([0-9][0-9A-Za-z.-]*\)-${target}\.tar\.gz\$/\1/p" "$staging/SHA256SUMS" | head -n 1)"
  fi
  # A release's archives are built in the minutes after it is out: until then
  # (or when one platform's build failed) the newest release that has this one.
  if [ -z "$version" ] && fetch "$releases_api" "$staging/releases.json"; then
    version="$(tr ',' '\n' < "$staging/releases.json" | sed -n \
      -e 's/^[[:space:]{]*"tag_name":[[:space:]]*"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/T \1/p' \
      -e 's/^[[:space:]{]*"name":[[:space:]]*"\(open-walnut-[^"]*\)".*/A \1/p' |
      awk -v target="$target" '$1 == "T" { t = $2; next } $1 == "A" && t != "" && $2 == ("open-walnut-" t "-" target ".tar.gz") { print t; exit }')"
  fi
  [ -n "$version" ] || fail "found no release with a self-contained build for ${target}; install with npm instead: npm install -g open-walnut"
fi

stem="open-walnut-${version}-${target}"
archive="${stem}.tar.gz"
say "Installing Open Walnut ${version} (${target})..."
code=0
fetch "${base_url}/v${version}/SHA256SUMS" "$staging/SHA256SUMS" || code=$?
if [ "$code" -eq 44 ]; then
  fail "release ${version} has no self-contained build; install it with npm: npm install -g open-walnut@${version}"
elif [ "$code" -ne 0 ]; then
  fail "could not download the release checksums"
fi
expected="$(grep " \*\{0,1\}${archive}\$" "$staging/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "release ${version} has no build for ${target}; install it with npm: npm install -g open-walnut@${version}"
case "$base_url" in
  file://*) say "Unpacking the ${archive} it came with..." ;;
  *) say "Downloading ${archive}..." ;;
esac
fetch "${base_url}/v${version}/${archive}" "$staging/${archive}" progress || fail "could not download ${archive}"
actual="$(checksum "$staging/${archive}")"
[ "$actual" = "$expected" ] || fail "${archive} does not match its SHA256SUMS entry (a broken or tampered download); nothing was changed"

say "Unpacking..."
tar -xzf "$staging/${archive}" -C "$staging"
rm -f "$staging/${archive}"
[ -x "$staging/${stem}/bin/walnut" ] || fail "${archive} holds no bin/walnut"
printed="$("$staging/${stem}/bin/walnut" --version 2>/dev/null || true)"
case "$printed" in
  "$version"*) ;;
  *) fail "the downloaded Walnut does not run here (it printed: ${printed:-nothing}); nothing was changed" ;;
esac

# Swap in the new copy: the old one moves aside first, so a failure leaves one in place.
if [ -e "$install_dir/app" ]; then
  mv "$install_dir/app" "$staging/previous"
fi
mv "$staging/${stem}" "$install_dir/app"
mkdir -p "$bin_dir"
ln -sfn "$install_dir/app/bin/walnut" "$bin_dir/walnut"
ln -sfn "$install_dir/app/bin/open-walnut" "$bin_dir/open-walnut"

printf '\n  Installed Open Walnut %s\n\n' "$version" >&2
case ":${PATH}:" in
  *":${bin_dir}:"*) printf '  Start it with:  walnut web\n' >&2 ;;
  *) printf '  Add %s to your PATH, then start it with:  walnut web\n' "$bin_dir" >&2 ;;
esac
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  printf '  Walnut runs its sessions with Claude Code: https://claude.com/product/claude-code\n' >&2
fi
printf '\n' >&2
