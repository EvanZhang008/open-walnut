#!/bin/sh
# Install Open Walnut: one command, nothing installed first (no Node, no npm, no build tools).
#
#   curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh
#
# Downloads the compiled Walnut for this machine (walnut-<version>-<target>.gz, one
# file, scripts/build-binary.mjs) from the GitHub Release, checks it against the
# release's SHA256SUMS, and installs it the way Claude Code's installer does:
#
#   ~/.local/share/open-walnut/versions/<version>/walnut   one directory per version
#   ~/.local/share/open-walnut/bin/walnut                  link to the one in use
#   ~/.local/bin/walnut, ~/.local/bin/open-walnut          links to that link
#
# The new version goes in beside the old one and becomes the one in use with one
# rename, so a failure at any step leaves the old one running. The version it
# replaced stays for a rollback; older ones go. Walnut updates itself after that
# (`walnut update`, and on every start) in the same layout
# (src/core/self-update/binary-install.ts). On Linux, a musl system (Alpine) gets
# the musl build.
#
# A release from before the compiled file (an OPEN_WALNUT_VERSION that has only the
# self-contained Node archive, open-walnut-<version>-<platform>-<arch>.tar.gz) still
# installs, into ~/.local/share/open-walnut/app, the way it always did.
#
# Knobs: OPEN_WALNUT_VERSION (a release, default the newest), OPEN_WALNUT_INSTALL_DIR,
# OPEN_WALNUT_BIN_DIR, OPEN_WALNUT_TARGET (darwin-arm64, linux-x64-musl, ...: the
# file to install, default this machine's), OPEN_WALNUT_RELEASE_BASE_URL and
# OPEN_WALNUT_RELEASES_API (mirrors, tests; a file:// base is a directory laid out
# like the releases, by path, not percent-encoded: the release Walnut.app carries),
# OPEN_WALNUT_PROGRESS=1 (the download's progress bar without a terminal).
#
# Nothing runs until the last line calls main: a download cut short is a script
# that does nothing, never half of one.
set -eu

fail() {
  printf '\nopen-walnut install: %s\n' "$1" >&2
  exit 1
}
say() { printf '  %s\n' "$1" >&2; }

# A release's version, as the updater accepts one (binary-install.ts): it names paths here.
valid_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}

# fetch URL FILE [progress]: 0 on success, 44 on a 404, 43 on a refusal (403, 429), 1 otherwise.
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
      403 | 429) printf 'GET %s answered HTTP %s\n' "$1" "$status" >&2; return 43 ;;
      *) printf 'GET %s answered HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    if wget -q "$1" -O "$2"; then return 0; fi
    return 1
  else
    fail "curl or wget is required"
  fi
}

# Which C library this Linux runs on: musl (Alpine) or glibc. ldd names its own;
# a glibc system may also carry musl's loader, so the loader decides only without an answer.
libc_of() {
  out="$(ldd --version 2>&1 || true)"
  case "$out" in
    *musl*) echo musl; return 0 ;;
    *GNU* | *GLIBC* | *glibc*) echo glibc; return 0 ;;
  esac
  for loader in /lib/ld-musl-*; do
    if [ -e "$loader" ]; then echo musl; return 0; fi
  done
  echo glibc
}

# This machine's target, and the word an older release's Node archive uses for it
# (none for musl, which had no archive).
pick_target() {
  case "$(uname -s)" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *) fail "Open Walnut runs on macOS and Linux; on $(uname -s) there is no build" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch="arm64" ;;
    x86_64 | amd64) arch="x64" ;;
    *) fail "no build for $(uname -m) (Open Walnut runs on arm64 and x64)" ;;
  esac
  # An Apple silicon Mac running this shell under Rosetta still wants the arm64 build.
  if [ "$platform" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch="arm64"
  fi
  legacy_target="${platform}-${arch}"
  target="$legacy_target"
  if [ "$platform" = linux ] && [ "$(libc_of)" = musl ]; then target="${target}-musl"; fi
  if [ -n "${OPEN_WALNUT_TARGET:-}" ]; then
    case "$OPEN_WALNUT_TARGET" in
      darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64 | linux-arm64-musl | linux-x64-musl) target="$OPEN_WALNUT_TARGET" ;;
      *) fail "OPEN_WALNUT_TARGET=$OPEN_WALNUT_TARGET is not a target (darwin-arm64, darwin-x64, linux-arm64, linux-x64, linux-arm64-musl, linux-x64-musl)" ;;
    esac
    legacy_target="${target%-musl}"
  fi
  case "$target" in *-musl) legacy_target="" ;; esac
}

pick_checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    checksum() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else
    fail "sha256sum or shasum is required"
  fi
}
# The sha256 SHA256SUMS ($1) gives for the file named $2, or nothing.
sum_of() { awk -v name="$2" '{ f = $2; sub(/^\*/, "", f); if (f == name) { print $1; exit } }' "$1"; }

cleanup() {
  # An archive swap that stopped half way puts the old copy back before anything is removed.
  if [ ! -e "$install_dir/app" ] && [ -e "$staging/previous-app" ]; then mv "$staging/previous-app" "$install_dir/app"; fi
  rm -rf "$staging"
  if [ -n "$locked" ] && [ "$(cat "$install_dir/.update.lock/owner" 2>/dev/null || true)" = "$lock_owner" ]; then
    rm -rf "$install_dir/.update.lock"
  fi
  # A first install that failed leaves no empty directory behind.
  rmdir "$install_dir/versions" 2>/dev/null || true
  rmdir "$install_dir" 2>/dev/null || true
}

# The release to install: OPEN_WALNUT_VERSION, else the newest with a build for this target.
pick_version() {
  version="${OPEN_WALNUT_VERSION:-}"
  version="${version#v}"
  if [ -n "$version" ]; then
    valid_version "$version" || fail "OPEN_WALNUT_VERSION=${OPEN_WALNUT_VERSION} is not a version (like 0.9.3)"
    return 0
  fi
  say "Finding the newest release..."
  # The newest release's checksums name its files, and so its version.
  if fetch "${base_url%/download}/latest/download/SHA256SUMS" "$staging/SHA256SUMS"; then
    version="$(sed -n "s/^[0-9a-f]\{64\}[ *]\{1,2\}walnut-\([0-9][0-9A-Za-z.-]*\)-${target}\.gz\$/\1/p" "$staging/SHA256SUMS" | head -n 1)"
    # The newest release is from before the compiled file: its Node archive for this machine.
    if [ -z "$version" ] && [ -n "$legacy_target" ]; then
      version="$(sed -n "s/^[0-9a-f]\{64\}[ *]\{1,2\}open-walnut-\([0-9][0-9A-Za-z.-]*\)-${legacy_target}\.tar\.gz\$/\1/p" "$staging/SHA256SUMS" | head -n 1)"
    fi
  fi
  # A release's files go up as it is published, SHA256SUMS last: until then (or when
  # this target's build is missing) the newest release that has both, or an older
  # release's archive.
  if [ -z "$version" ]; then
    code=0
    fetch "$releases_api" "$staging/releases.json" || code=$?
    if [ "$code" -eq 43 ]; then
      fail "GitHub refused the list of releases (its API allows 60 requests an hour from one address without a login). Try again later, or name the release: OPEN_WALNUT_VERSION=<version> (https://github.com/${repo}/releases)"
    fi
    if [ "$code" -eq 0 ]; then
      version="$(tr ',' '\n' < "$staging/releases.json" | sed -n \
        -e 's/^[[:space:]{]*"tag_name":[[:space:]]*"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/T \1/p' \
        -e 's/^[[:space:]{]*"name":[[:space:]]*"\(\(open-\)\{0,1\}walnut-[^"]*\)".*/A \1/p' \
        -e 's/^[[:space:]{]*"name":[[:space:]]*"SHA256SUMS".*/S/p' |
        awk -v target="$target" -v legacy="$legacy_target" '
          function settle() { if (t == "" || !sums) return; if (gz) { print t; found = 1; exit } if (arc && old == "") old = t }
          $1 == "T" { settle(); t = $2; gz = 0; arc = 0; sums = 0; next }
          $1 == "S" && t != "" { sums = 1; next }
          $1 == "A" && t != "" && $2 == ("walnut-" t "-" target ".gz") { gz = 1; next }
          $1 == "A" && t != "" && legacy != "" && $2 == ("open-walnut-" t "-" legacy ".tar.gz") { arc = 1 }
          END { if (!found) settle(); if (!found && old != "") print old }')"
    fi
  fi
  [ -n "$version" ] || fail "found no release with a build for ${target}"
  valid_version "$version" || fail "the newest release names no version this installs (${version})"
}

# A link at $2 to $1, made beside it and renamed over it: a reader sees the old link or the new one.
swap_link() {
  ln -s "$1" "$2.new.$$"
  mv -f "$2.new.$$" "$2"
}

# What $install_dir/bin/walnut points at now: a version, "app" (the Node archive), or nothing.
in_use() {
  link="$(readlink "$install_dir/bin/walnut" 2>/dev/null || true)"
  case "$link" in
    ../versions/*/walnut) link="${link#../versions/}"; echo "${link%/walnut}" ;;
    # A link made by hand (a rollback) may name its version by its full path.
    "$install_dir"/versions/*/walnut) link="${link#"$install_dir"/versions/}"; echo "${link%/walnut}" ;;
    ../app/bin/walnut | "$install_dir"/app/bin/walnut) echo app ;;
    *)
      # An install by the install.sh before the versions layout linked straight to the archive.
      case "$(readlink "$bin_dir/walnut" 2>/dev/null || true)" in
        "$install_dir/app/bin/walnut") echo app ;;
      esac
      ;;
  esac
}

# The PATH links, and the marker the updater recognizes this install by.
finish() {
  mkdir -p "$bin_dir"
  ln -sfn "$install_dir/bin/walnut" "$bin_dir/walnut"
  ln -sfn "$install_dir/bin/walnut" "$bin_dir/open-walnut"
  printf '{"layout":"versions","target":"%s"}\n' "$target" > "$staging/marker"
  mv -f "$staging/marker" "$install_dir/open-walnut-install.json"
  printf '\n  Installed Open Walnut %s\n\n' "$version" >&2
  case ":${PATH}:" in
    *":${bin_dir}:"*) printf '  Start it with:  walnut web\n' >&2 ;;
    *) printf '  Add %s to your PATH, then start it with:  walnut web\n' "$bin_dir" >&2 ;;
  esac
  if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
    printf '  Walnut runs its sessions with Claude Code: https://claude.com/product/claude-code\n' >&2
  fi
  printf '\n' >&2
}

# Does a process with this pid exist? kill -0 alone says no for another user's.
pid_alive() {
  case "$1" in '' | *[!0-9]* | 0 | 1) return 1 ;; esac
  kill -0 "$1" 2>/dev/null || [ -d "/proc/$1" ] || ps -p "$1" >/dev/null 2>&1
}

# When a process started, as the updater records it (install-lock.ts processStart), or nothing.
start_of() { ps -o lstart= -p "$1" 2>/dev/null | awk '{ $1 = $1; print }' || true; }

# The versions a running Walnut sits in, one per line: each server marks its own
# (running/<pid> holds the version, src/core/self-update/binary-install.ts). The
# marker of a process that is gone is removed.
running_versions() {
  for marker in "$install_dir"/running/*; do
    [ -f "$marker" ] || continue
    pid="${marker##*/}"
    case "$pid" in '' | *[!0-9]*) continue ;; esac
    if pid_alive "$pid"; then sed -n 1p "$marker"; else rm -f "$marker"; fi
  done
}
is_running() {
  case "
$running
" in *"
$1
"*) return 0 ;; esac
  return 1
}

# Does a process run from the Node archive? It marks nothing, so its command line
# says; when ps cannot answer, the answer is yes.
app_in_use() {
  commands="$(ps -axo command= 2>/dev/null)" || return 0
  case "$commands" in *"$install_dir/app/"*) return 0 ;; esac
  return 1
}

# Remove every version but the two named (the new one and the one it replaced) and
# the ones a server still runs, and the Node archive once it is neither and nothing
# runs from it. Only in a root this installer made (its marker was there before this
# run), and only what this layout puts there: a version directory holding a walnut.
prune() {
  [ -n "$had_marker" ] || return 0
  for dir in "$install_dir"/versions/*; do
    [ -f "$dir/walnut" ] || continue
    name="${dir##*/}"
    if [ "$name" != "$1" ] && [ "$name" != "$2" ] && ! is_running "$name"; then rm -rf "$dir"; fi
  done
  if [ "$1" != app ] && [ "$2" != app ] && [ -f "$install_dir/app/bin/walnut" ] && ! app_in_use; then
    rm -rf "$install_dir/app"
  fi
}

# Whether the lock's owner line ($1) names a holder that is gone: its process is not
# running, or its pid now belongs to a process that started at another time. A lock
# whose owner line was never written is a lock being made, for at most a minute.
owner_gone() {
  pid="$(printf '%s\n' "$1" | awk 'NR == 1 { print $1 }')"
  case "$pid" in
    '' | *[!0-9]* | 0 | 1) [ -n "$(find "$lock" -prune -mmin +1 2>/dev/null)" ]; return ;;
  esac
  pid_alive "$pid" || return 0
  started="$(printf '%s\n' "$1" | awk 'NR == 1 { $1 = ""; $2 = ""; sub(/^ +/, ""); print }')"
  [ -n "$started" ] || return 1
  now="$(start_of "$pid")"
  [ -n "$now" ] && [ "$now" != "$started" ]
}

# The inode of a directory (ls -i is POSIX), to know a moved lock is the one judged.
# shellcheck disable=SC2012 # one known path; only the first field is read
inode_of() { ls -di "$1" 2>/dev/null | awk '{ print $1 }'; }

# Remove a stale lock, inside the takeover directory: one taker at a time, the owner
# judged again there, and the lock moved aside gone only if it is the directory judged.
# 0 when the lock is gone (mkdir then decides who holds it next).
take_over() {
  gate="$lock.takeover"
  if ! mkdir "$gate" 2>/dev/null; then
    # A taker that died inside it: its takeover directory goes after a minute.
    [ -n "$(find "$gate" -prune -mmin +1 2>/dev/null)" ] || return 1
    rm -rf "$gate"
    mkdir "$gate" 2>/dev/null || return 1
  fi
  gone=1
  judged_inode="$(inode_of "$lock")"
  if [ -n "$judged_inode" ]; then
    if owner_gone "$(cat "$lock/owner" 2>/dev/null || true)"; then
      aside="$lock.stale-$$"
      if mv "$lock" "$aside" 2>/dev/null && [ "$(inode_of "$aside")" != "$judged_inode" ]; then
        # A new lock replaced the stale one after the judging: it goes back.
        if [ ! -e "$lock" ]; then mv "$aside" "$lock" 2>/dev/null || true; fi
        gone=""
      fi
      rm -rf "$aside"
    else
      gone=""
    fi
  fi
  rm -rf "$gate"
  [ -n "$gone" ]
}

# One change to $install_dir at a time: the lock Walnut's own updater takes too, with
# the same owner line and the same takeover (src/core/self-update/install-lock.ts). An
# update still running is waited for, for a minute.
take_lock() {
  lock="$install_dir/.update.lock"
  lock_owner="$(printf '%s install.sh %s' "$$" "$(start_of "$$")" | awk '{ $1 = $1; print }')"
  waited=0
  while ! mkdir "$lock" 2>/dev/null; do
    if owner_gone "$(cat "$lock/owner" 2>/dev/null || true)" && take_over; then continue; fi
    [ "$waited" -lt 60 ] || fail "another update of ${install_dir} is running; run this again once it is done"
    if [ "$waited" -eq 0 ]; then say "Waiting for another update of ${install_dir} to finish..."; fi
    waited=$((waited + 1))
    sleep 1
  done
  locked=1
  printf '%s\n' "$lock_owner" > "$lock/owner"
}

# The C++ runtime the musl build links, where musl's loader looks: Alpine's libstdc++
# and libgcc packages, which a minimal image does not have.
has_cxx_runtime() {
  for lib in libstdc++.so.6 libgcc_s.so.1; do
    found=""
    for dir in /lib /usr/lib /usr/local/lib; do
      if [ -e "$dir/$lib" ]; then found=1; fi
    done
    [ -n "$found" ] || return 1
  done
}

# The version's printed first word must be the version: a file that does not run here
# (wrong system, broken download) changes nothing.
check_runs() {
  # A file told to be bun (BUN_BE_BUN) would answer as bun.
  printed="$(unset BUN_BE_BUN; "$1" --version 2>"$staging/version-error" || true)"
  case "$printed" in
    "$version" | "$version "*) return 0 ;;
  esac
  said="${printed:-$(head -c 300 "$staging/version-error" 2>/dev/null || true)}"
  case "$target" in
    *-musl)
      if ! has_cxx_runtime || grep -q 'Error relocating' "$staging/version-error" 2>/dev/null; then
        fail "Walnut's musl build needs the C++ runtime, which this system lacks. Install it (Alpine: apk add libstdc++ libgcc), then run this again; nothing was changed"
      fi
      ;;
  esac
  fail "the downloaded Walnut does not run here (it printed: ${said:-nothing}); nothing was changed"
}

# The compiled file: into versions/<version>, then the link.
install_file() {
  # A release carried on this disk may hold the file unpacked (the Mac app's, signed
  # for it, lists only that one).
  if [ -n "$carried_plain" ]; then
    say "Installing the ${file} it came with..."
    fetch "${base_url}/v${version}/${file}" "$staging/walnut" || fail "could not read ${file}"
    [ "$(checksum "$staging/walnut")" = "$expected_file" ] || fail "${file} does not match its SHA256SUMS entry (a broken or tampered copy); nothing was changed"
  else
    case "$base_url" in
      file://*) say "Unpacking the ${asset} it came with..." ;;
      *) say "Downloading ${asset}..." ;;
    esac
    command -v gzip >/dev/null 2>&1 || fail "gzip is required"
    fetch "${base_url}/v${version}/${asset}" "$staging/${asset}" progress || fail "could not download ${asset}"
    [ "$(checksum "$staging/${asset}")" = "$expected_gz" ] || fail "${asset} does not match its SHA256SUMS entry (a broken or tampered download); nothing was changed"
    say "Unpacking..."
    gzip -dc "$staging/${asset}" > "$staging/walnut" || fail "could not unpack ${asset}"
    rm -f "$staging/${asset}"
    if [ -n "$expected_file" ] && [ "$(checksum "$staging/walnut")" != "$expected_file" ]; then
      fail "${asset} does not unpack to the ${file} its SHA256SUMS names; nothing was changed"
    fi
  fi
  chmod 755 "$staging/walnut"
  check_runs "$staging/walnut"

  take_lock
  previous="$(in_use)"
  running="$(running_versions)"
  mkdir -p "$install_dir/versions" "$install_dir/bin"
  target_dir="$install_dir/versions/$version"
  # A copy of this version nothing uses is a leftover; one a server runs from stays.
  if [ -d "$target_dir" ] && [ "$previous" != "$version" ] && ! { is_running "$version" && [ -f "$target_dir/walnut" ]; }; then
    rm -rf "$target_dir"
  fi
  if [ -d "$target_dir" ]; then
    # This version is in use: replace its file in place only when it differs.
    if [ "$(checksum "$target_dir/walnut" 2>/dev/null || true)" != "$(checksum "$staging/walnut")" ]; then
      mv -f "$staging/walnut" "$target_dir/walnut"
    fi
  else
    mkdir "$staging/version"
    mv "$staging/walnut" "$staging/version/walnut"
    mv "$staging/version" "$target_dir"
  fi
  swap_link "../versions/$version/walnut" "$install_dir/bin/walnut"
  # Installed on purpose: no longer held back (src/core/self-update/held-versions.ts).
  rm -f "$install_dir/bad/$version"
  # The same version again replaced nothing: whatever was kept before stays.
  if [ "$previous" != "$version" ]; then prune "$version" "$previous"; fi
  finish
}

# A release from before the compiled file: its self-contained Node archive, into app/.
install_archive() {
  [ -n "$legacy_target" ] || fail "release ${version} has no build for ${target}"
  stem="open-walnut-${version}-${legacy_target}"
  archive="${stem}.tar.gz"
  expected="$(sum_of "$staging/SHA256SUMS" "$archive")"
  [ -n "$expected" ] || fail "release ${version} has no build for ${target}"
  command -v tar >/dev/null 2>&1 || fail "tar is required"
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
  check_runs "$staging/${stem}/bin/walnut"

  take_lock
  previous="$(in_use)"
  running="$(running_versions)"
  # Swap in the new copy: the old one moves aside first, so a failure leaves one in place.
  if [ -e "$install_dir/app" ]; then
    mv "$install_dir/app" "$staging/previous-app"
  fi
  mv "$staging/${stem}" "$install_dir/app"
  mkdir -p "$install_dir/bin"
  swap_link "../app/bin/walnut" "$install_dir/bin/walnut"
  prune app "$previous"
  finish
}

main() {
  repo="EvanZhang008/open-walnut"
  base_url="${OPEN_WALNUT_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
  releases_api="${OPEN_WALNUT_RELEASES_API:-https://api.github.com/repos/${repo}/releases?per_page=20}"
  install_dir="${OPEN_WALNUT_INSTALL_DIR:-$HOME/.local/share/open-walnut}"
  bin_dir="${OPEN_WALNUT_BIN_DIR:-$HOME/.local/bin}"

  pick_target
  pick_checksum

  mkdir -p "$install_dir"
  had_marker=""
  if [ -f "$install_dir/open-walnut-install.json" ]; then had_marker=1; fi
  staging="$(mktemp -d "${install_dir}/.staging-XXXXXX")"
  locked=""
  lock_owner=""
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  pick_version
  say "Installing Open Walnut ${version} (${target})..."
  code=0
  fetch "${base_url}/v${version}/SHA256SUMS" "$staging/SHA256SUMS" || code=$?
  if [ "$code" -eq 44 ]; then
    fail "release ${version} has no build to install here (no SHA256SUMS)"
  elif [ "$code" -eq 43 ]; then
    fail "GitHub refused the release checksums (HTTP 403 or 429: a limit for this address). Try again later"
  elif [ "$code" -ne 0 ]; then
    fail "could not download the release checksums"
  fi

  file="walnut-${version}-${target}"
  asset="${file}.gz"
  expected_gz="$(sum_of "$staging/SHA256SUMS" "$asset")"
  expected_file="$(sum_of "$staging/SHA256SUMS" "$file")"
  carried_plain=""
  case "$base_url" in
    file://*) if [ -n "$expected_file" ] && [ -f "${base_url#file://}/v${version}/${file}" ]; then carried_plain=1; fi ;;
  esac
  if [ -n "$expected_gz" ] || [ -n "$carried_plain" ]; then
    install_file
  else
    install_archive
  fi
}

main "$@"
