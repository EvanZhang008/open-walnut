#!/usr/bin/env node
// Runs as `prestart`, right after the Node-version check. Also usable by hand:
// `node scripts/check-native-toolchain.mjs` after a failed `npm install`.
//
// Walnut has one native module it cannot do without: better-sqlite3. On Linux its
// prebuilt binary needs glibc 2.29+. Any distro from the last few years has that and
// never compiles anything. On an older C library (glibc 2.26 boxes are still around)
// node-gyp compiles it, and needs two things such a box usually lacks: Python 3.8+
// (node-gyp's own scripts) and a C++20 compiler, GCC 10+ (the Node 22 headers). The
// stock toolchain fails minutes in with a Python SyntaxError or template errors that
// mention neither requirement.
//
// npm offers no hook that runs BEFORE a dependency's install script (the root
// `preinstall` runs after them; measured), so this cannot stop the doomed compile.
// What it can do is make the very next command a person types explain itself: if
// better-sqlite3 does not load, say exactly why and print the commands that fix it.
// When it loads, exit 0 silently. Keep this file to syntax every Node since 12 parses.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.env.WALNUT_SKIP_TOOLCHAIN_CHECK === '1' || process.platform !== 'linux') process.exit(0);

const MIN_GLIBC_FOR_PREBUILT = [2, 29]; // better-sqlite3's prebuilt binary
const MIN_GCC = 10; // C++20, required by the Node 22 headers
const MIN_PYTHON = [3, 8]; // node-gyp

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '') + (r.stderr || '') : null;
}
function have(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}
function atLeast(v, [maj, min]) {
  const [a, b] = String(v).split('.').map(Number);
  return a > maj || (a === maj && b >= min);
}

// 1. Does the module load? Then nothing here matters.
let loadError = null;
try {
  createRequire(import.meta.url)('better-sqlite3');
} catch (err) {
  loadError = err;
}
if (!loadError) {
  if (process.env.npm_config_build_from_source) {
    console.warn(
      'walnut: npm_config_build_from_source is set, so every native module compiles from source '
      + 'even where a prebuilt binary exists (sharp needs libvips for that). Unset it unless you mean it.',
    );
  }
  process.exit(0);
}

// 2. It does not. Work out which of the three usual reasons apply here.
function glibcVersion() {
  try {
    const v = process.report && process.report.getReport().header.glibcVersionRuntime;
    if (v) return v;
  } catch { /* fall through */ }
  const out = sh('getconf', ['GNU_LIBC_VERSION']);
  const m = out && out.match(/(\d+\.\d+)/);
  return m ? m[1] : null;
}
function pythonVersion() {
  const py = process.env.PYTHON || process.env.npm_config_python || 'python3';
  const out = sh(py, ['--version']);
  const m = out && out.match(/(\d+\.\d+)/);
  return { cmd: py, version: m ? m[1] : null };
}
function compilerInfo() {
  const cxx = process.env.CXX || 'c++';
  const out = sh(cxx, ['--version']);
  if (!out) return { cmd: cxx, kind: 'missing', major: 0 };
  if (/clang/i.test(out)) {
    const m = out.match(/clang version (\d+)/i);
    return { cmd: cxx, kind: 'clang', major: m ? Number(m[1]) : 0 };
  }
  const dump = sh(cxx, ['-dumpfullversion', '-dumpversion']) || '';
  const m = dump.match(/^(\d+)/m);
  return { cmd: cxx, kind: 'gcc', major: m ? Number(m[1]) : 0 };
}

const glibc = glibcVersion();
const py = pythonVersion();
const cxx = compilerInfo();
const oldGlibc = glibc && !atLeast(glibc, MIN_GLIBC_FOR_PREBUILT);
const pyOk = py.version && atLeast(py.version, MIN_PYTHON);
const cxxOk = cxx.kind === 'clang' || (cxx.kind === 'gcc' && cxx.major >= MIN_GCC);

const lines = [`walnut: better-sqlite3 is not built, so Walnut cannot start.`, ``];
if (!oldGlibc) {
  // A modern box where the prebuilt should have worked: the install itself is off.
  lines.push(
    `  ${loadError && loadError.message ? loadError.message.split('\n')[0] : 'module not found'}`,
    ``,
    `  This machine (glibc ${glibc || 'unknown'}) can use the prebuilt binary, so no compiler is needed.`,
    `  Run \`npm install\` again and read its output; a network block on github.com (where the`,
    `  prebuilt is downloaded from) is the usual cause.`,
    ``,
  );
} else {
  lines.push(
    `  Its C library is glibc ${glibc}. Prebuilt native binaries need 2.29+, so better-sqlite3 has to`,
    `  compile here, and compiling against Node ${process.versions.node} needs:`,
    `    Python ${MIN_PYTHON.join('.')}+ for node-gyp   ${pyOk ? `(ok: ${py.cmd} is ${py.version})` : `(NOT met: ${py.cmd} is ${py.version || 'missing'})`}`,
    `    a C++20 compiler, GCC ${MIN_GCC}+     ${cxxOk ? `(ok: ${cxx.cmd} is ${cxx.kind} ${cxx.major})` : `(NOT met: ${cxx.cmd} is ${cxx.kind === 'missing' ? 'missing' : `${cxx.kind} ${cxx.major}`})`}`,
    ``,
  );
  // Name the exact commands for this box. Each line below is one paste.
  const installs = [];
  const env = [];
  if (!cxxOk) {
    const newer = ['gcc10-g++', 'g++-14', 'g++-13', 'g++-12', 'g++-11', 'g++-10'].find(have);
    if (newer) env.push(`CC=${newer.replace('g++', 'gcc')}`, `CXX=${newer}`);
    else if (have('yum') || have('dnf')) { installs.push(`sudo ${have('dnf') ? 'dnf' : 'yum'} install -y gcc10-c++ make`); env.push('CC=gcc10-gcc', 'CXX=gcc10-g++'); }
    else if (have('apt-get')) { installs.push('sudo apt-get install -y g++-10 make'); env.push('CC=gcc-10', 'CXX=g++-10'); }
    else installs.push(`# install GCC ${MIN_GCC}+ with your package manager, then set CC= and CXX= below`);
  }
  if (!pyOk) {
    const newer = ['python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3.8'].find(have);
    if (newer) {
      env.push(`PYTHON=${newer}`);
    } else {
      // No distro package is assumed: on a glibc 2.26 box the distro's newest Python is
      // often 3.7 and the extras channel that used to carry 3.8 is not always there
      // (verified on one such machine). uv's managed Python is a static build that
      // runs on glibc 2.17+, installs in seconds, and needs no sudo.
      const uv = have('uv') ? 'uv' : '~/.local/bin/uv';
      if (!have('uv')) installs.push('curl -LsSf https://astral.sh/uv/install.sh | sh');
      installs.push(`${uv} python install 3.12`);
      env.push(`PYTHON="$(${uv} python find 3.12)"`);
    }
  }
  lines.push(`  Fix, then install again:`, ``);
  for (const i of installs) lines.push(`    ${i}`);
  lines.push(`    ${env.length ? env.join(' ') + ' ' : ''}npm install`, ``);
  lines.push(
    `  Distros with glibc 2.29+ (AL2023, Ubuntu 22.04+, Debian 12+) install with no compiler at all.`,
    `  sharp (image compression) is optional and is skipped on this machine either way.`,
    ``,
  );
}
lines.push(`  WALNUT_SKIP_TOOLCHAIN_CHECK=1 bypasses this check.`, ``);
process.stderr.write(lines.join('\n'), () => process.exit(1));
