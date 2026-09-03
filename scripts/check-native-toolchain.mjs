#!/usr/bin/env node
// Runs as `preinstall`, before npm fetches or builds a single dependency.
//
// Walnut has one native module it cannot do without: better-sqlite3. On Linux its
// prebuilt binary needs glibc 2.29+. Any distro from the last few years has that and
// never compiles anything. An older C library (Amazon Linux 2 is glibc 2.26) means
// node-gyp compiles it against the Node 22 headers, which need C++20, which GCC only
// has from version 10. The stock GCC 7 on such a box fails several minutes into the
// build with template errors that say nothing about any of this.
//
// So: if this machine WILL compile and its compiler CANNOT, stop here, in a second,
// with the two commands that make it work. Everything else exits 0 silently.
// Keep this file to syntax every Node since 12 can parse (it runs before check-node).
import { spawnSync } from 'node:child_process';

if (process.env.WALNUT_SKIP_TOOLCHAIN_CHECK === '1' || process.platform !== 'linux') process.exit(0);

const MIN_GLIBC_FOR_PREBUILT = [2, 29]; // better-sqlite3's prebuilt binary
const MIN_GCC_FOR_NODE22 = 10; // C++20

function glibcVersion() {
  try {
    const v = process.report && process.report.getReport().header.glibcVersionRuntime;
    if (v) return v;
  } catch { /* fall through */ }
  const r = spawnSync('getconf', ['GNU_LIBC_VERSION'], { encoding: 'utf8' });
  const m = r.stdout && r.stdout.match(/(\d+\.\d+)/);
  return m ? m[1] : null;
}

function versionAtLeast(v, [maj, min]) {
  const [a, b] = v.split('.').map(Number);
  return a > maj || (a === maj && b >= min);
}

function have(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}

/** { kind: 'gcc'|'clang'|'unknown', major } for the compiler node-gyp will use. */
function compilerInfo(cxx) {
  const r = spawnSync(cxx, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const out = r.stdout;
  if (/clang/i.test(out)) {
    const m = out.match(/clang version (\d+)/i);
    return { kind: 'clang', major: m ? Number(m[1]) : 0 };
  }
  const dump = spawnSync(cxx, ['-dumpfullversion', '-dumpversion'], { encoding: 'utf8' });
  const m = (dump.stdout || '').match(/^(\d+)/m);
  return { kind: /g\+\+|gcc/i.test(out) ? 'gcc' : 'unknown', major: m ? Number(m[1]) : 0 };
}

const glibc = glibcVersion();
// Unknown glibc: we cannot say the build will happen, so do not block anything.
if (!glibc || versionAtLeast(glibc, MIN_GLIBC_FOR_PREBUILT)) {
  if (process.env.npm_config_build_from_source) {
    console.warn(
      'walnut: npm_config_build_from_source is set, so every native module compiles from source '
      + 'even where a prebuilt binary exists (sharp needs libvips for that). Unset it unless you mean it.',
    );
  }
  process.exit(0);
}

// This machine will compile better-sqlite3. Can it?
const cxx = process.env.CXX || 'c++';
const info = compilerInfo(cxx);
const ok = info && (info.kind === 'clang' || (info.kind === 'gcc' && info.major >= MIN_GCC_FOR_NODE22) || info.kind === 'unknown');
if (ok) {
  console.warn(`walnut: glibc ${glibc} is older than the prebuilt native binaries need (2.29); better-sqlite3 compiles with ${cxx} (that is fine, allow a few minutes). sharp is optional and is skipped: pasted images are sent uncompressed.`);
  process.exit(0);
}

// Name a newer GCC if one is already on the box, else the package that provides it.
const candidates = ['gcc10-g++', 'g++-14', 'g++-13', 'g++-12', 'g++-11', 'g++-10', 'g++10'];
const found = candidates.find(have);
const cc = found ? found.replace('g++', 'gcc') : null;
const lines = [
  `walnut: this machine needs a newer C++ compiler before \`npm install\` can work.`,
  ``,
  `  Its C library is glibc ${glibc}. Prebuilt native binaries need 2.29+, so better-sqlite3`,
  `  compiles here, against Node ${process.versions.node} headers that need C++20 (GCC ${MIN_GCC_FOR_NODE22}+).`,
  `  The compiler npm would use is ${cxx}${info ? ` (${info.kind} ${info.major})` : ' (not found)'}, which cannot do that.`,
  ``,
];
if (found) {
  lines.push(`  A newer GCC is already installed. Point the build at it and run the install again:`, ``, `    CC=${cc} CXX=${found} npm install`);
} else if (have('yum') || have('dnf')) {
  const pm = have('dnf') ? 'dnf' : 'yum';
  lines.push(`  Install one and point the build at it:`, ``, `    sudo ${pm} install -y gcc10-c++ python3 make`, `    CC=gcc10-gcc CXX=gcc10-g++ npm install`);
} else if (have('apt-get')) {
  lines.push(`  Install one and point the build at it:`, ``, `    sudo apt-get install -y g++-10 python3 make`, `    CC=gcc-10 CXX=g++-10 npm install`);
} else {
  lines.push(`  Install GCC ${MIN_GCC_FOR_NODE22} or newer, then: CC=<gcc> CXX=<g++> npm install`);
}
lines.push(
  ``,
  `  Distros with glibc 2.29+ (AL2023, Ubuntu 22.04+, Debian 12+) install with no compiler at all.`,
  `  sharp (image compression) is optional and is skipped on this machine either way.`,
  `  WALNUT_SKIP_TOOLCHAIN_CHECK=1 bypasses this check.`,
  ``,
);
process.stderr.write(lines.join('\n'), () => process.exit(1));
