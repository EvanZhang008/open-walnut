#!/usr/bin/env bash
# Deploy a COMMIT of this checkout to production, never its working tree.
#
#   bash scripts/deploy-committed.sh             # deploy HEAD
#   bash scripts/deploy-committed.sh <commit>    # deploy another commit
#   WALNUT_DEVPROD_DRY_RUN=1 bash scripts/deploy-committed.sh
#   WALNUT_DEPLOY_NO_WAIT=1 bash scripts/deploy-committed.sh   # queue it, do not wait
#
# Deploys queue (scripts/lib/deploy-queue.sh): production restarts at most once per
# 10 minutes, each time with the newest commit, and every caller hears whether
# the deploy that carried its commit went out.
#
# Several agents share one checkout, and `bun run dev:prod` builds whatever is on
# disk, so a peer's half-written files ship with your commit (2026-09-26: a peer's
# JS went out without its CSS and no long session could scroll). This script
# clones the commit into a temp directory (a separate clone that borrows this
# repo's objects: no worktree, no stash, nothing in this checkout changes), links
# this checkout's dependencies into it, and runs the CLONE's dev-prod.sh with
# WALNUT_DEVPROD_SERVE_ROOT pointing back here, so the server still runs as this
# checkout. Every guard of dev-prod.sh applies unchanged (type-check, smoke boot
# before the kill, rollback, cooldown), and WALNUT_DEVPROD_* knobs pass through:
# the clone builds and serves the compiled walnut file for this machine (plus
# the Linux files host servers take, from the same build). The compiled files
# are staged outside the clone, so removing it never touches the running server.
# The clone is removed afterwards (WALNUT_DEPLOY_KEEP_BUILD=1 keeps it).
set -euo pipefail

SERVE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# An inherited GIT_DIR outranks -C (git exports one while it runs hooks).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX

REF="${1:-HEAD}"
if ! SHA="$(git -C "$SERVE_ROOT" rev-parse --verify --quiet "$REF^{commit}")"; then
  echo "Not a commit in $SERVE_ROOT: $REF" >&2
  exit 1
fi
BRANCH="$(git -C "$SERVE_ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "HEAD" ]]; then BRANCH=deploy; fi

# Runs the dependency-linking snippet below from stdin with bun (what the build
# uses) as `bun run -`. A bare `bun -` is NOT stdin: bun reads it as `bun add`
# and installs the arguments as packages. dev-prod.sh then checks the version.
JS_RUN=()
for cand in "${WALNUT_BUN:-}" "$(command -v bun || true)" "$HOME/.bun/bin/bun"; do
  if [[ -n "$cand" && -x "$cand" ]]; then JS_RUN=("$cand" run -); break; fi
done
if (( ${#JS_RUN[@]} == 0 )); then
  echo "No bun found (WALNUT_BUN, PATH, ~/.bun/bin): install it with curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# The deploy queue (scripts/lib/deploy-queue.sh): at most one restart per gap, each
# shipping the newest commit of then. Its runner is this script, detached.
DQ_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
DQ_LIB="$(dirname "$DQ_SCRIPT")/lib/deploy-queue.sh"
# The queue's own deploy of a target: never passed on to dev-prod.sh, whose server
# and sessions would inherit it and skip the queue.
DQ_IS_RUNNER="${WALNUT_DEPLOY_RUNNER:-0}"
unset WALNUT_DEPLOY_RUNNER
if [[ "${WALNUT_DEPLOY_RUNNER_LOOP:-0}" == "1" ]]; then
  # Its own deploys are plain runs of this script.
  unset WALNUT_DEPLOY_RUNNER_LOOP
  # shellcheck source=lib/deploy-queue.sh
  source "$DQ_LIB"
  dq_runner || true
  exit 0
fi

# Nothing new to serve: production already runs this commit, or a later one that
# contains it (a peer deployed after it landed), from a clean build. Each deploy
# restarts the server, which costs every open window a few seconds of timeouts,
# and on 2026-10-28 prod restarted up to 76 times a day. WALNUT_DEVPROD_FORCE=1
# deploys anyway; a dry run, a rehearsal or a server that does not answer always
# goes on. WALNUT_DEPLOY_CONFIG_URL: the config to read (tests).
if [[ "${WALNUT_DEVPROD_FORCE:-0}" != "1" && "${WALNUT_DEVPROD_DRY_RUN:-0}" != "1" && "${WALNUT_DEVPROD_REHEARSAL:-0}" != "1" ]]; then
  served_json="$(curl -s -m 3 "${WALNUT_DEPLOY_CONFIG_URL:-http://127.0.0.1:3456/api/config}" 2>/dev/null || true)"
  served="$("${JS_RUN[@]}" "$served_json" <<'JS' 2>/dev/null || true
try {
  const b = JSON.parse(process.argv[2] || '{}').build || {}
  if (b.dirty === false && /^[0-9a-f]{7,40}$/.test(b.commit || '')) console.log(b.commit)
} catch {}
JS
)"
  if [[ -n "$served" ]] && served_sha="$(git -C "$SERVE_ROOT" rev-parse --verify --quiet "$served^{commit}")" \
    && git -C "$SERVE_ROOT" merge-base --is-ancestor "$SHA" "$served_sha"; then
    echo "Deploy skipped: production already serves ${served_sha:0:12}, which contains ${SHA:0:12} (WALNUT_DEVPROD_FORCE=1 deploys anyway)."
    exit 0
  fi
fi

# Every other caller waits its turn in the queue; the runner's own deploy, a forced
# one and a dry run go straight on. WALNUT_DEPLOY_QUEUE=0 turns the queue off.
if [[ "$DQ_IS_RUNNER" != "1" && "${WALNUT_DEVPROD_FORCE:-0}" != "1" && "${WALNUT_DEVPROD_DRY_RUN:-0}" != "1" \
  && "${WALNUT_DEPLOY_QUEUE:-1}" != "0" ]]; then
  if [[ -f "$DQ_LIB" ]]; then
    # shellcheck source=lib/deploy-queue.sh
    source "$DQ_LIB"
    dq_code=0
    dq_request "$SHA" || dq_code=$?
    exit "$dq_code"
  fi
  echo "No deploy queue at $DQ_LIB; deploying at once." >&2
fi

BUILD="${TMPDIR:-/tmp}"
# A rehearsal (scripts/dev-prod.sh) writes everything into the dir it is given,
# its clone included. A dir it would refuse is left to it to refuse.
rehearsal_dir="${WALNUT_DEVPROD_REHEARSAL_DIR:-}"
if [[ "${WALNUT_DEVPROD_REHEARSAL:-0}" == "1" && "$rehearsal_dir" == /* && -d "$rehearsal_dir" ]]; then
  BUILD="$rehearsal_dir"
fi
BUILD="${BUILD%/}/open-walnut-build.${SHA:0:12}.$$"
cleanup() {
  if [[ "${WALNUT_DEPLOY_KEEP_BUILD:-0}" == "1" ]]; then
    echo "Build clone kept: $BUILD"
  elif [[ "$BUILD" == */open-walnut-build.* && -d "$BUILD" ]]; then
    rm -rf "$BUILD"
  fi
}
trap cleanup EXIT

echo "Deploying commit ${SHA:0:12} ($BRANCH) from a clean clone: $BUILD"
git clone --quiet --shared --no-checkout "$SERVE_ROOT" "$BUILD"
git -C "$BUILD" checkout --quiet -B "$BRANCH" "$SHA"

# A commit from before the serve-root knob would run the server inside the clone,
# which is deleted on exit.
if ! grep -q 'WALNUT_DEVPROD_SERVE_ROOT' "$BUILD/scripts/dev-prod.sh"; then
  echo "Commit ${SHA:0:12} predates WALNUT_DEVPROD_SERVE_ROOT; deploy it with bun run dev:prod from a clean tree." >&2
  exit 1
fi

# Dependencies come from the deploy's own copy-on-write mirror of this checkout's
# node_modules, never from links into the checkout: bun and esbuild resolve a linked
# package to its real path and read every package.json above it, so the checkout's own
# package.json joined every build, and one left mid-merge (conflict markers) failed every
# deploy (2026-11-10). The mirror is copied again only when the checkout's install changed,
# and older ones go once unused for two hours. Where the volume cannot clone files, or
# WALNUT_DEPLOY_DEPS_MIRROR=0, the build links the checkout's node_modules as before.
deps_src="$SERVE_ROOT"
deps_root="${WALNUT_DEPLOY_DEPS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/open-walnut-deploy-deps}"
if [[ "$BUILD" == "${rehearsal_dir%/}"/open-walnut-build.* ]]; then deps_root="${rehearsal_dir%/}/deploy-deps"; fi
deps_key() { # what this checkout has installed, as a short hash
  (cd "$BUILD" && "${JS_RUN[@]}" "$SERVE_ROOT" <<'JS'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const [root] = process.argv.slice(2)
const h = crypto.createHash('sha256')
const list = (d) => { try { return fs.readdirSync(d).sort() } catch { return [] } }
const at = (p) => { try { return String(fs.statSync(p).mtimeMs) } catch { return '' } }
for (const nm of ['node_modules', 'web/node_modules']) {
  const dir = path.join(root, nm)
  // Dot entries are tool caches and temp files (vite writes .vite-temp on every run), not
  // the install, except .bin.
  for (const n of list(dir).filter((n) => !n.startsWith('.') || n === '.bin')) {
    for (const e of n.startsWith('@') ? list(path.join(dir, n)).map((c) => `${n}/${c}`) : [n]) {
      // The package's directory too: an install that replaces or adds files moves it.
      h.update(`${nm}/${e} ${at(path.join(dir, e))} ${at(path.join(dir, e, 'package.json'))}\n`)
    }
  }
}
for (const f of ['bun.lock', 'web/bun.lock']) { try { h.update(fs.readFileSync(path.join(root, f))) } catch {} }
// Patched dependencies change files inside a package, not its package.json.
for (const f of list(path.join(root, 'patches'))) { try { h.update(fs.readFileSync(path.join(root, 'patches', f))) } catch {} }
process.stdout.write(h.digest('hex').slice(0, 16))
JS
  )
}
dev_of() { if [[ "$(uname -s)" == Darwin ]]; then stat -f %d "$1"; else stat -c %d "$1"; fi; }
clone_one() { if [[ "$(uname -s)" == Darwin ]]; then cp -c -R "$1" "$2"; else cp -a --reflink=always "$1" "$2"; fi; }
clone_tree() { # copy-on-write copy of a node_modules dir without its dot caches (.bin kept), or fail
  local e
  mkdir "$2" || return 1
  for e in "$1"/* "$1"/.bin; do
    [[ -e "$e" || -L "$e" ]] || continue
    clone_one "$e" "$2/${e##*/}" || return 1
  done
}
mirror_deps() {
  local key dir tmp old pid probe
  [[ -d "$SERVE_ROOT/node_modules" ]] || return 1
  mkdir -p "$deps_root" || return 1
  # Only a clone on the same volume costs no disk: macOS cp -c copies in full across volumes,
  # and a volume that cannot clone would copy 2 GB. One small file proves it can.
  [[ "$(dev_of "$deps_root")" == "$(dev_of "$SERVE_ROOT/node_modules")" ]] || return 1
  probe="$deps_root/.probe.$$"
  if [[ "$(uname -s)" != Darwin ]]; then
    cp --reflink=always "$SERVE_ROOT/package.json" "$probe" 2>/dev/null || { rm -f "$probe"; return 1; }
    rm -f "$probe"
  fi
  key="$(deps_key)" && [[ "$key" =~ ^[0-9a-f]{16}$ ]] || return 1
  dir="$deps_root/$key"
  for old in "$deps_root"/.copy.*; do   # a copy a killed deploy left
    pid="${old##*.copy.}"
    [[ -d "$old" && "$pid" =~ ^[0-9]+$ ]] && ! kill -0 "$pid" 2>/dev/null && rm -rf "$old"
  done
  if [[ ! -d "$dir/node_modules" ]]; then
    tmp="$deps_root/.copy.$$"; rm -rf "$tmp"; mkdir -p "$tmp/web"
    echo "Copying this checkout's node_modules into the deploy's own mirror (copy-on-write, once per install): $dir"
    if ! clone_tree "$SERVE_ROOT/node_modules" "$tmp/node_modules" 2>/dev/null \
      || { [[ -d "$SERVE_ROOT/web/node_modules" ]] && ! clone_tree "$SERVE_ROOT/web/node_modules" "$tmp/web/node_modules" 2>/dev/null; } \
      || [[ "$(deps_key)" != "$key" ]]; then   # it failed, or an install ran during the copy
      rm -rf "$tmp"; return 1
    fi
    printf '{"private":true}\n' > "$tmp/package.json" && printf '{"private":true}\n' > "$tmp/web/package.json" \
      && [[ -s "$tmp/package.json" && -s "$tmp/web/package.json" ]] || { rm -rf "$tmp"; return 1; }
    if [[ -e "$dir" ]]; then rm -rf "$tmp"; else mv "$tmp" "$dir" || { rm -rf "$tmp"; return 1; }; fi
    rm -rf "$dir/.copy.$$"   # another deploy made the same mirror first: mv put ours inside it
  fi
  touch "$dir"
  # Older mirrors go once nothing has used them for two hours: a deploy that bypasses the
  # queue (a dry run, WALNUT_DEVPROD_FORCE) may still be building from one.
  for old in "$deps_root"/*; do
    [[ "$old" != "$dir" && -d "$old" && "${old##*/}" =~ ^[0-9a-f]{16}$ ]] || continue
    [[ -n "$(find "$old" -maxdepth 0 -mmin +120 2>/dev/null)" ]] && rm -rf "$old"
  done
  deps_src="$dir"
}
if [[ "${WALNUT_DEPLOY_DEPS_MIRROR:-1}" != 0 ]] && ! mirror_deps; then
  echo "No copy-on-write mirror of node_modules here; linking the checkout's node_modules (a package.json there that does not parse fails the build)."
fi

# Dependencies: every top-level entry of this checkout's node_modules is linked,
# except the workspace packages, which must be the COMMITTED ones in the
# clone (this checkout's links point at its own, possibly edited, packages/).
# It prints each dependency the commit declares that the checkout has not
# installed (a commit that adds one lands before anyone runs bun install here;
# 2026-11-03: the web type-check then failed on a missing module).
missing="$(cd "$BUILD" && "${JS_RUN[@]}" "$deps_src/node_modules" "$BUILD/node_modules" "$BUILD" "$SERVE_ROOT" <<'JS'
const fs = require('fs')
const path = require('path')
const [src, dst, build, checkout] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(path.join(build, 'package.json'), 'utf8'))
const workspaces = new Map()
for (const dir of pkg.workspaces ?? []) {
  const name = JSON.parse(fs.readFileSync(path.join(build, dir, 'package.json'), 'utf8')).name
  workspaces.set(name, path.join(build, dir))
}
const scopes = new Set([...workspaces.keys()].filter((n) => n.startsWith('@')).map((n) => n.split('/')[0]))
fs.mkdirSync(dst, { recursive: true })
for (const entry of fs.readdirSync(src)) {
  if (scopes.has(entry)) {
    fs.mkdirSync(path.join(dst, entry), { recursive: true })
    for (const child of fs.readdirSync(path.join(src, entry))) {
      const name = `${entry}/${child}`
      if (!workspaces.has(name)) fs.symlinkSync(path.join(src, entry, child), path.join(dst, entry, child))
    }
  } else if (!workspaces.has(entry)) {
    fs.symlinkSync(path.join(src, entry), path.join(dst, entry))
  }
}
for (const [name, dir] of workspaces) {
  fs.mkdirSync(path.dirname(path.join(dst, name)), { recursive: true })
  fs.symlinkSync(dir, path.join(dst, name))
}
const declared = (p) => Object.keys({ ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) })
const lacks = (pkgDir, nm) => declared(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')))
  .filter((n) => !workspaces.has(n) && !fs.existsSync(path.join(nm, n, 'package.json')))
const webDir = path.join(build, 'web')
const webNm = path.join(path.dirname(src), 'web', 'node_modules')
const out = [...lacks(build, src).map((n) => `root ${n}`)]
if (fs.existsSync(path.join(webDir, 'package.json'))) out.push(...lacks(webDir, webNm).map((n) => `web ${n}`))
// A dependency the commit patches, installed here with an older patch or none: the install
// copies the patched files once, so a commit that only changes patches/ deployed the old
// files (2026-11-10: the Codex catalog fix reached production unpatched). Each hunk of the
// patch, as it reads once applied (its context and added lines in order), must appear whole
// in the installed file, and a package the checkout patched must still be patched here.
// No apostrophes in this block: bash 3.2 pairs quotes inside a heredoc within $(...).
const hunksOf = (text) => {
  const files = []
  let file = null
  let hunk = null
  for (const line of text.split('\n')) {
    const head = /^\+\+\+ b\/(.+)$/.exec(line)
    if (head) { file = { name: head[1], hunks: [] }; files.push(file); hunk = null; continue }
    if (!file) continue
    if (line.startsWith('@@')) { hunk = []; file.hunks.push(hunk); continue }
    if (!hunk) continue
    if (line.startsWith('+') || line.startsWith(' ')) hunk.push(line.slice(1))
    else if (line === '') hunk.push('')
  }
  return files
}
const stalePatch = (dir, text) => {
  for (const file of hunksOf(text)) {
    let have
    try { have = fs.readFileSync(path.join(dir, file.name), 'utf8') } catch { return true }
    for (const hunk of file.hunks) {
      while (hunk.length && hunk[hunk.length - 1] === '') hunk.pop()
      if (hunk.length && !have.includes(hunk.join('\n'))) return true
    }
  }
  return false
}
const nameOf = (spec) => spec.replace(/@[^@/]+$/, '')
const patched = pkg.patchedDependencies ?? {}
for (const [spec, rel] of Object.entries(patched)) {
  const dir = path.join(src, nameOf(spec))
  let text
  try { text = fs.readFileSync(path.join(build, rel), 'utf8') } catch { continue }
  if (fs.existsSync(path.join(dir, 'package.json')) && stalePatch(dir, text)) out.push(`root patched ${nameOf(spec)}`)
}
let before = {}
try { before = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')).patchedDependencies ?? {} } catch {}
for (const spec of Object.keys(before)) if (!(spec in patched)) out.push(`root unpatched ${nameOf(spec)}`)
process.stdout.write(out.join('\n'))
JS
)"
if [[ -d "$deps_src/web/node_modules" ]]; then
  ln -s "$deps_src/web/node_modules" "$BUILD/web/node_modules"
fi
# A dependency the commit needs and the checkout lacks, or one it patches that the checkout
# installed with an older patch: install the commit's own lockfile into the clone instead of
# linking, never into the shared checkout.
if [[ -n "$missing" ]]; then
  echo "The checkout's node_modules lacks what this commit declares ($(echo "$missing" | tr '\n' ' ')); installing the commit's lockfile in the clone."
  bun_bin="${JS_RUN[0]}"
  rm -f "$BUILD/web/node_modules"
  if grep -q '^root ' <<<"$missing"; then
    # The root install's postinstall installs web/ too (scripts/postinstall.mjs).
    rm -rf "$BUILD/node_modules"
    (cd "$BUILD" && "$bun_bin" install --frozen-lockfile)
  elif [[ -f "$BUILD/web/package.json" ]]; then
    (cd "$BUILD/web" && "$bun_bin" install --frozen-lockfile)
  fi
fi

# Built inputs the checkout keeps out of git: copied, so a deploy never fetches them again
# (2026-11-03: a deploy failed when the SQLite site's name did not resolve). The macOS build
# links a pinned SQLite; scripts/build-sqlite-dylib.mjs uses the copy only when its stamp
# matches the pins and rebuilds otherwise. A real copy, never a link (the build writes there),
# and one that differs from the checkout after copying (a rebuild there mid-copy can pair an
# old library with a new stamp) is dropped, so the build makes its own as before.
VENDOR_BUILT=(vendor/sqlite)
for dir in "${VENDOR_BUILT[@]}"; do
  if [[ -d "$SERVE_ROOT/$dir" && ! -e "$BUILD/$dir" ]]; then
    mkdir -p "$(dirname "$BUILD/$dir")"
    if ! cp -RL "$SERVE_ROOT/$dir" "$BUILD/$dir" || ! diff -rq "$SERVE_ROOT/$dir" "$BUILD/$dir" >/dev/null 2>&1; then
      echo "Could not copy $dir from the checkout; the build makes its own." >&2
      rm -rf "$BUILD/$dir"
    fi
  fi
done

cd "$BUILD"
WALNUT_DEVPROD_SERVE_ROOT="$SERVE_ROOT" bash "$BUILD/scripts/dev-prod.sh"
