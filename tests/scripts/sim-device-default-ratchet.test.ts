/**
 * Ratchet: no tool in the repo picks an iOS simulator for the person running it.
 *
 * A test run installs its own build on the simulator it drives. Scripts used to
 * default to a device by model name (`SIM_NAME="iPhone 16 Pro"`, then the first
 * simctl row of that name) or to "whichever one is booted", and on a machine where
 * that simulator was the one its owner uses every day, an agent's run replaced the
 * owner's build. Every script now resolves its simulator through
 * scripts/lib/sim-device.sh: an explicit UDID (an argument, the script's own
 * variable, or WALNUT_SIM_UDID), else a lease from WALNUT_SIM_QUEUE_SCRIPT on a test
 * lane, else it refuses.
 *
 * This test reads every tool under scripts/ and ios-native/ (shell, JS/TS, Python,
 * YAML such as Maestro flows, and the `scripts` of each package.json, the repo
 * root's included), enumerated from the tree so a NEW file is covered without being
 * listed, and fails on any member of the class:
 *   udid              a simulator UDID written into a file (a personal device id in a
 *                     public repo, and a device nobody else has);
 *   device-name       a fixed device model ("iPhone 16 Pro") in code;
 *   destination-name  a destination that selects by `name=`, written into the
 *                     destination or into a variable assembled for one;
 *   name-match        a lookup that matches a device by its name (grep, jq, python);
 *   name-device       a simctl / Maestro device argument taken from a *NAME* variable;
 *   booted            "booted" as the device (a value or a parameter default), or used
 *                     to select a device from simctl output;
 *   first-device      the tool chooses a device for its user: the first UDID of a
 *                     device list (grep -oE, jq, awk, python) that no explicit UDID or
 *                     NAME narrows, or a pick by family (/iPhone/, startswith("iPhone")).
 * A lookup may span lines, so the list it reads counts within a few lines of it.
 * Comment lines are skipped, except for the udid rule: a device id in a comment is
 * still published. `simctl create` lines may name a device type, since they make a
 * new simulator rather than pick an existing one.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const ROOTS = ['scripts', 'ios-native']
const SKIP_DIRS = new Set(['node_modules', '.git', 'DerivedData', 'build', '.build', 'Pods', 'dist', 'runs'])
const SKIP_DIR_SUFFIXES = ['.xcodeproj', '.xcworkspace', '.app', '.xcresult']

type Kind = 'shell' | 'js' | 'py' | 'yaml'
type SimRule = 'udid' | 'device-name' | 'destination-name' | 'name-match' | 'name-device' | 'booted' | 'first-device'
interface SimViolation { rule: SimRule; line: number; text: string }

/**
 * Each entry needs a reason a reviewer can check. A file listed here may break
 * only the named rule; the stale-entry test fails once it no longer does.
 */
const ALLOWLIST: Array<{ file: string; rule: SimRule; reason: string }> = [
  {
    file: 'ios-native/tests/fleet/remote-run.sh',
    rule: 'first-device',
    reason: 'ranks iPhone device TYPES of the newest runtime for the `simctl create` of its own "Walnut Fleet Test" simulator; it never picks an existing device (it drives the UDID it wrote down when it made one, or --udid)',
  },
]

/** How far (in lines) a lookup may sit from the device list it reads. */
const WINDOW = 6

const UDID_RE = /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/i
const DEVICE_NAME_RE = /\b(?:iPhone|iPad)(?:\s+(?:\d+[a-z]*|SE|Air|Pro|Plus|Max|mini|e))+\b/
const DESTINATION_NAME_RES = [
  /platform=[^\n]*?\bname=/,                         // "platform=iOS Simulator,name=..."
  /-destination\b[^\n]*\bname=/,                      // -destination "name=$X"
  /\b\w+\s*=\s*["'`](?:[^"'`\n]*,)?name=/,           // DEST="name=$DEV", later fed to -destination
]
/** A shell variable that holds a device NAME (SIM_NAME, DEVICE_NAME, DEV_NAME, ...). */
const NAME_VAR = String.raw`\$\{?[A-Za-z_]*NAME[A-Za-z_]*\}?`
/** Words that put a line about simulators (UUIDs outside shell and YAML need one on their line). */
const DEVICE_CONTEXT = /\b(?:devs?|devices?|sims?|simulators?|udid|isAvailable|simctl|xcrun|runtimes?|destination|maestro)\b/i
/** A simulator device LIST nearby: what a lookup over "a device's name" reads from. */
const LIST_CONTEXT = /\bsimctl\b|\bxcrun\b|\bsimulators?\b|\budid\b|\bisAvailable\b|\bdevices\b|\[\s*['"]devices['"]\s*\]|\bmaestro\b/i
const NAME_MATCH_NEAR_LIST_RES = [
  /\[\s*['"]name['"]\s*\]\s*(?:\.\w+\(\)\s*)?[!=]==?/,  // python / js: d['name'] == ..., d['name'].lower() == ...
  /\.get\(\s*['"]name['"]\s*\)\s*[!=]==?/,              // python: d.get('name') == ...
  /\.name\s*(?:\.\w+\(\)\s*)?[!=]==?/,                  // jq / js: .name == ...
]
const NAME_MATCH_RES = [
  /grep\b[^|\n]*\$\{?\w*(?:SIM|DEVICE|DEV|PHONE)\w*NAME\w*\}?/i, // grep "$SIM_NAME", fixed or not
]
const SIMCTL_WITH_NAME_GREP = new RegExp(String.raw`simctl[^\n]*\|[^\n]*grep\b[^|\n]*` + NAME_VAR)
const NAME_DEVICE_RES = [
  new RegExp(String.raw`simctl\s+[\w-]+(?:\s+-{1,2}[\w-]+)*\s+["']?` + NAME_VAR), // simctl install "$SIM_NAME"
  new RegExp(String.raw`--udid[=\s]+["']?` + NAME_VAR),                              // maestro --udid "$DEVICE_NAME"
  new RegExp(String.raw`\bid=` + NAME_VAR),                                          // -destination "...,id=$SIM_NAME"
]
/** "booted" as the device itself: the value of an assignment or a parameter default. */
const BOOTED_VALUE_RES = [
  /(?:^|[\s;&|(])(?:export\s+|local\s+|readonly\s+)?\w+=["']?booted\b/i,  // UDID=booted, DEVICE="booted"
  /\$\{[#!]?\w+(?:\[[^\]]*\])?:?[-=+?]\s*["']?booted\b/i,              // ${1-booted} ${UDID:=booted} ${X:+booted}
  /(["'`])booted\1/,                                                     // 'booted' as a literal (a device, never a state)
]
/** A line that uses "booted" (any case) is a selector when it also does one of these. */
const BOOTED_WORD = /\bbooted\b/i
const BOOTED_SELECTOR_RES = [
  /\bsimctl\b/,                                        // simctl list devices booted / simctl spawn booted
  /\b(?:grep|egrep|fgrep|awk|sed|rg|perl)\b/,          // grep -m1 Booted, awk '/Booted/', sed ... (Booted)
  /\bselect\s*\(/,                                     // jq select(.state=="Booted")
  /\.state\s*[!=]==?/,                                 // d.state === 'Booted' over a device list
  /\[\s*['"]state['"]\s*\]\s*[!=]==?/,                 // d['state'] == 'Booted'
  /\.filter\s*\(|\.find\s*\(/,                         // devices.find(d => ... 'Booted')
  /\(Booted\)/,                                        // simctl's text listing, "(Booted)"
]
/** In JS and Python any comparison of a state with Booted reads a device list: d.get('state') == 'Booted'. */
const BOOTED_STATE_COMPARE = /\bstate\b[^\n]*(?:[!=]==?|\bis\b|\bin\b)[^\n]*\bbooted\b|\bbooted\b[^\n]*(?:[!=]==?|\bin\b)[^\n]*\bstate\b/i
/** Choosing a device by its family: /iPhone/, startswith("iPhone"), grep iPhone. */
const FAMILY_SELECTOR_RES = [
  /\/[^/\n]*\b(?:iPhone|iPad)\b[^/\n]*\//,                                               // awk '/iPhone/', a regex literal
  /\b(?:startswith|startsWith|endswith|endsWith|includes|contains|test|match|search|fnmatch)\s*\(\s*\S*\s*["'`](?:iPhone|iPad)/,
  /\bgrep\b[^|\n]*\b(?:iPhone|iPad)\b/,
  /["'](?:iPhone|iPad)[^"'\n]*["']\s+in\b/,                                              // python: "iPhone" in d["name"]
  /\bselect\s*\([^\n]*\b(?:iPhone|iPad)\b/,
]
/** A line that takes a device's UDID out of a listing. */
const UDID_TAKE_RES = [
  /\bgrep\s+-[A-Za-z]*o[A-Za-z]*\s+[^|\n]*(?:\{36\}|\{8\}-)/,   // grep -oE '[0-9A-F-]{36}'
  /\.udid\b/,                                                     // jq / js
  /\[\s*['"]udid['"]\s*\]/,                                       // python / js
  /\bprint\s+\$\d/,                                               // awk '{print $2}'
]
/** It takes the first one: head -1, [0], exit or break after the first hit. */
const FIRST_PICK = /\bhead\s+-(?:n\s*)?1\b|\[0\]|\bexit\b|SystemExit|\bbreak\b|sys\.exit|\bfirst\b|limit\(1|\bnext\s*\(|\.find\s*\(/
/** ...unless an explicit device narrows it: a UDID or NAME variable, a jq --arg, a comparison on the udid. */
const NARROWED = /\$\{?\w*(?:UDID|DEVICE|NAME|udid|device)\w*\}?|--arg\b|\budid\b[^\n]*[!=]==?|[!=]==?[^\n]*\budid\b/

function isComment(raw: string, kind: Kind): boolean {
  if (kind === 'js') return /^\s*(?:\/\/|\/\*|\*)/.test(raw)
  return /^\s*#/.test(raw)
}

/** The check, over one file's text, so it can be tested on strings. */
function findSimDefaultViolations(content: string, kind: Kind = 'shell'): SimViolation[] {
  const out: SimViolation[] = []
  const lines = content.split('\n')
  const code = lines.map((raw) => (isComment(raw, kind) ? '' : raw))
  const near = (i: number, before: number, after: number) => code.slice(Math.max(0, i - before), i + after + 1)
  lines.forEach((raw, i) => {
    const line = i + 1
    const text = raw.trim()
    const push = (rule: SimRule) => out.push({ rule, line, text })
    const id = raw.match(UDID_RE)?.[0]
    // A shell or YAML file names no UUID but a device's. Elsewhere UUIDs are task and
    // session ids; there a device's is the upper-case simctl form or sits by a device word.
    if (id && (kind === 'shell' || kind === 'yaml' || !/[a-f]/.test(id) || DEVICE_CONTEXT.test(raw))) push('udid')
    if (!code[i]) return
    if (/simctl\s+create\b/.test(raw)) return
    if (DEVICE_NAME_RE.test(raw)) push('device-name')
    if (DESTINATION_NAME_RES.some((re) => re.test(raw))) push('destination-name')
    const nearList = near(i, WINDOW, WINDOW).some((l) => LIST_CONTEXT.test(l))
    if (NAME_MATCH_RES.some((re) => re.test(raw)) || SIMCTL_WITH_NAME_GREP.test(raw)
      || (nearList && NAME_MATCH_NEAR_LIST_RES.some((re) => re.test(raw)))) push('name-match')
    if (NAME_DEVICE_RES.some((re) => re.test(raw))) push('name-device')
    if (BOOTED_VALUE_RES.some((re) => re.test(raw))
      || (BOOTED_WORD.test(raw) && BOOTED_SELECTOR_RES.some((re) => re.test(raw)))
      || ((kind === 'js' || kind === 'py') && BOOTED_STATE_COMPARE.test(raw))) push('booted')
    if (FAMILY_SELECTOR_RES.some((re) => re.test(raw))) push('first-device')
    else if (UDID_TAKE_RES.some((re) => re.test(raw))) {
      const around = near(i, WINDOW, 3)
      if (around.some((l) => LIST_CONTEXT.test(l)) && near(i, 0, 3).some((l) => FIRST_PICK.test(l))
        && !near(i, WINDOW, 3).some((l) => NARROWED.test(l))) push('first-device')
    }
  })
  return out
}

/** A package.json's `scripts` are shell lines; checked one by one, at their line in the file. */
function findPackageJsonViolations(content: string): SimViolation[] {
  const out: SimViolation[] = []
  const pkg = JSON.parse(content) as { scripts?: Record<string, string> }
  const lines = content.split('\n')
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    const at = lines.findIndex((l) => l.includes(JSON.stringify(name).slice(0, -1) + '"'))
    for (const v of findSimDefaultViolations(cmd, 'shell')) out.push({ ...v, line: at + 1 })
  }
  // A device id anywhere in the file, not only in scripts.
  for (const v of findSimDefaultViolations(content, 'js')) if (v.rule === 'udid') out.push(v)
  return out
}

function kindOf(full: string, name: string): Kind | null {
  if (/\.(?:sh|bash|zsh)$/.test(name)) return 'shell'
  if (/\.(?:m?[jt]s|cjs|cts|mts)$/.test(name)) return 'js'
  if (/\.py$/.test(name)) return 'py'
  if (/\.ya?ml$/.test(name)) return 'yaml'
  if (path.extname(name) !== '') return null
  const fd = fs.openSync(full, 'r')
  try {
    const buf = Buffer.alloc(80)
    const first = buf.subarray(0, fs.readSync(fd, buf, 0, 80, 0)).toString('utf8').split('\n')[0] ?? ''
    if (/^#!.*\b(?:sh|bash|zsh)\b/.test(first)) return 'shell'
    if (/^#!.*\bpython/.test(first)) return 'py'
    if (/^#!.*\b(?:node|bun)\b/.test(first)) return 'js'
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** Every tool under the roots, repo-relative, symlinks not followed. */
function toolFiles(): Array<{ file: string; kind: Kind | 'package-json' }> {
  const found: Array<{ file: string; kind: Kind | 'package-json' }> = [{ file: 'package.json', kind: 'package-json' }]
  const walk = (rel: string) => {
    for (const ent of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || SKIP_DIR_SUFFIXES.some((s) => ent.name.endsWith(s))) continue
        walk(child)
      } else if (ent.isFile()) {
        if (ent.name === 'package.json') { found.push({ file: child, kind: 'package-json' }); continue }
        const kind = kindOf(path.join(REPO, child), ent.name)
        if (kind) found.push({ file: child, kind })
      }
    }
  }
  for (const root of ROOTS) if (fs.existsSync(path.join(REPO, root))) walk(root)
  return found.sort((a, b) => a.file.localeCompare(b.file))
}

function violationsOf(file: string, kind: Kind | 'package-json'): SimViolation[] {
  const content = fs.readFileSync(path.join(REPO, file), 'utf8')
  return kind === 'package-json' ? findPackageJsonViolations(content) : findSimDefaultViolations(content, kind)
}

function allowed(file: string, rule: SimRule): boolean {
  return ALLOWLIST.some((a) => a.file === file && a.rule === rule)
}

describe('findSimDefaultViolations', () => {
  const FAKE = '00000000-1111-2222-3333-444444444444'
  // Samples that spawn a macOS-only tool are built from pieces: written whole, they read as
  // a real unguarded spawn to tests/scripts/cross-platform-ratchet.test.ts.
  const SPAWN_FN = ['spawn', 'Sync'].join('')

  it.each<[string, string, SimRule, Kind?]>([
    ['a fixed model name as the default', 'SIM_NAME="iPhone 16 Pro"', 'device-name'],
    ['a model name as a parameter default', 'DEVICE_NAME="${DEVICE_NAME:-iPhone 16 Pro}"', 'device-name'],
    ['an iPad model', "DEV='iPad Air 13'", 'device-name'],
    ['a model name in JS code', "const DEVICE = process.env.DEVICE || 'iPhone 16 Pro'", 'device-name', 'js'],
    ['a model name in a Maestro flow', '# flow\ndevice: iPhone 15 Pro', 'device-name', 'yaml'],
    ['a destination by a literal name', "  -destination 'platform=iOS Simulator,name=iPhone 15' \\", 'destination-name'],
    ['a destination by a variable name', '  -destination "platform=iOS Simulator,name=$SIM_NAME" \\', 'destination-name'],
    ['a destination assembled in a variable', 'DEST="name=$DEV"', 'destination-name'],
    ['a destination assembled after the platform', 'DEST="platform=iOS Simulator,OS=18.0,name=$DEV"', 'destination-name'],
    ['a destination by name in JS', "const args = ['-destination', `platform=iOS Simulator,name=${dev}`]", 'destination-name', 'js'],
    ['a simctl lookup by name (grep -F, fixed)', `UDID="$(xcrun simctl list devices available | grep -F "$SIM_NAME (" | head -1)"`, 'name-match'],
    ['a simctl lookup by name (grep, unfixed)', 'UDID=$(xcrun simctl list devices | grep "$SIM_NAME" | head -1)', 'name-match'],
    ['a grep for a device name variable', 'line=$(grep "$DEVICE_NAME" "$LIST")', 'name-match'],
    ['a simctl lookup by name (python)', "        if dev['name']=='$DEVICE_NAME' and dev['isAvailable']:", 'name-match'],
    ['a simctl lookup by name (jq)', `jq -r '.devices[][] | select(.name == "x") | .udid'`, 'name-match'],
    ['a lookup by name in JS', "const d = devices.find((x) => x.name === wanted)", 'name-match', 'js'],
    ['a lookup by name in python', "udid = next(d['udid'] for d in devs if d['name'] == want)", 'name-match', 'py'],
    ['simctl install on a name variable', 'xcrun simctl install "$SIM_NAME" "$APP"', 'name-device'],
    ['simctl boot on a name variable', 'xcrun simctl boot $DEVICE_NAME', 'name-device'],
    ['maestro on a name variable', 'maestro --udid "$SIM_NAME" test flow.yaml', 'name-device'],
    ['the booted listing', 'UDID=$(xcrun simctl list devices booted 2>/dev/null | head -1)', 'booted'],
    ['booted as the default argument', 'UDID="${1:-booted}"', 'booted'],
    ['a simctl verb on booted', 'xcrun simctl spawn booted launchctl list', 'booted'],
    ['parsing the booted row', "sed -n 's/.*(\\([0-9A-F-]\\{36\\}\\)) (Booted).*/\\1/p'", 'booted'],
    ['grep -m1 Booted', "UDID=$(xcrun simctl list devices | grep -m1 Booted | grep -oE '[0-9A-F-]{36}')", 'booted'],
    ['grep Booted on a saved listing', 'line=$(grep -m1 "Booted" "$LIST")', 'booted'],
    ['awk on Booted', "UDID=$(awk '/Booted/ {print $NF; exit}' devices.txt)", 'booted'],
    ['jq select on Booted', `UDID=$(jq -r '[.devices[][] | select(.state=="Booted")][0].udid' devices.json)`, 'booted'],
    ['a JS filter on Booted', "const dev = list.find((d) => d.state === 'Booted')", 'booted', 'js'],
    ['a python filter on Booted', "booted = [d for d in devs if d['state'] == 'Booted']", 'booted', 'py'],
    ['booted as a plain value', 'UDID=booted', 'booted'],
    ['booted as a quoted value', 'DEVICE="booted"', 'booted'],
    ['booted exported', 'export SIM_UDID=booted', 'booted'],
    ['booted as a := default', 'UDID="${UDID:=booted}"', 'booted'],
    ['booted as a = default', 'UDID="${UDID=booted}"', 'booted'],
    ['booted as a - default', 'UDID="${1-booted}"', 'booted'],
    ['booted as a :+ alternative', 'X="${SIM:+booted}"', 'booted'],
    ['booted as a JS fallback', "const udid = process.env.UDID || 'booted'", 'booted', 'js'],
    ['a python get of the state', "        if d.get('state') == 'Booted':", 'booted', 'py'],
    ['a python lower-cased state', "        if dev['state'].lower() == 'booted':", 'booted', 'py'],
    ['the first UDID of the list (grep -oE)', "UDID=$(xcrun simctl list devices available | grep -oE '[0-9A-F-]{36}' | head -1)", 'first-device'],
    ['the first UDID of the list (jq)', "UDID=$(xcrun simctl list devices -j | jq -r '[.devices[][]][0].udid')", 'first-device'],
    ['the first iPhone (awk)', "UDID=$(xcrun simctl list devices | awk -F'[()]' '/iPhone/ {print $2; exit}')", 'first-device'],
    ['the first iPhone (python)', '        if d["name"].startswith("iPhone") and d["isAvailable"]:', 'first-device'],
    ['the first iPhone (grep)', "UDID=$(xcrun simctl list devices | grep iPhone | head -1)", 'first-device'],
    ['the first available device (python, over lines)', [
      'UDID="$(xcrun simctl list devices -j | python3 -c "',
      'import json,sys',
      "for rt in json.load(sys.stdin)['devices'].values():",
      '    for d in rt:',
      "        if d['isAvailable']: print(d['udid']); raise SystemExit",
      '")"',
    ].join('\n'), 'first-device'],
    ['the first device in JS', "const udid = JSON.parse(out).devices[runtime][0].udid", 'first-device', 'js'],
    ['a name lookup split over lines (python)', [
      "devs = json.load(sys.stdin)['devices']",
      'for rt in devs.values():',
      '    for d in rt:',
      "        if d['name'] == want:",
      "            print(d['udid'])",
    ].join('\n'), 'name-match', 'py'],
    ['a name lookup split over lines (JS)', [
      `const list = JSON.parse(${SPAWN_FN}('xcrun', ['simctl', 'list', 'devices', '-j']).stdout)`,
      'const all = Object.values(list.devices).flat()',
      'const d = all.find((d) => d.name === want)',
    ].join('\n'), 'name-match', 'js'],
    ['a hardcoded udid', `UDID="${FAKE}"`, 'udid'],
    ['a udid in a comment', `# my phone sim is ${FAKE.toLowerCase()}`, 'udid'],
    ['a udid in a JS comment', `// the lane sim: ${FAKE}`, 'udid', 'js'],
    ['an upper-case udid in JS', "const LANE = 'B0B0B0B0-0000-4000-8000-00000000000B'", 'udid', 'js'],
    ['a lower-case udid by a device word in python', "UDID = 'b0b0b0b0-0000-4000-8000-00000000000b'", 'udid', 'py'],
  ])('flags %s', (_label, line, rule, kind = 'shell') => {
    const head = kind === 'js' ? "import fs from 'node:fs'\n\n" : '#!/usr/bin/env bash\nset -uo pipefail\n'
    const v = findSimDefaultViolations(`${head}${line}\n`, kind)
    expect(v.map((x) => x.rule)).toContain(rule)
  })

  it('flags the old freeze-probe shape as a whole script', () => {
    const old = [
      '#!/usr/bin/env bash',
      'SIM_NAME="iPhone 16 Pro"',
      `UDID="$(xcrun simctl list devices available | grep -F "$SIM_NAME (" | head -1 | grep -oE '[0-9A-F-]{36}')"`,
      'xcrun simctl install "$UDID" "$APP"',
    ].join('\n')
    expect(findSimDefaultViolations(old).map((v) => `${v.rule}@${v.line}`)).toEqual(['device-name@2', 'name-match@3'])
  })

  it('reads package.json scripts as shell', () => {
    const pkg = JSON.stringify({ name: 'x', scripts: { build: 'tsc', 'ios:test': "xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 16 Pro'" } }, null, 2)
    expect(findPackageJsonViolations(pkg).map((v) => v.rule).sort()).toEqual(['destination-name', 'device-name'])
    expect(findPackageJsonViolations(pkg)[0]!.line).toBe(5)
    expect(findPackageJsonViolations(JSON.stringify({ scripts: { test: 'vitest run' } }))).toEqual([])
  })

  it.each<[string, string, Kind?]>([
    ['the helper', '. "$REPO/scripts/lib/sim-device.sh"\nwalnut_sim_resolve "${1:-}" || exit 2\nUDID="$WALNUT_SIM_DEVICE"'],
    ['a destination by id', '  -destination "platform=iOS Simulator,id=$UDID" \\'],
    ['a generic destination', "  -destination 'generic/platform=iOS Simulator' \\"],
    ['an explicit udid variable', 'UDID="${WALNUT_SIM_UDID:?set WALNUT_SIM_UDID}"'],
    ['a model name in a comment', '# L2: end-to-end smoke (formerly on the iPhone 16 Pro sim)'],
    ['a model name in a JS doc comment', ' * e.g. "iPhone 16 Pro Stress2" -> "iPhone-16-Pro-Stress2"', 'js'],
    ['making a dedicated simulator', 'xcrun simctl create walnut-test "iPhone 16 Pro"'],
    ['reading the name of a device found by udid', "        if dev['udid'].upper()=='$UDID'.upper():\n            print(dev['name'])"],
    ['waiting for a named device to boot', '[ "$st" = "Booted" ] && break'],
    ['checking a known device state', 'if [ "$DEVICE_STATE" != "Booted" ]; then'],
    ['waiting with simctl bootstatus', 'xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1'],
    ['generic prose', 'echo "boot an iPhone simulator first"'],
    ['a local name variable', 'local name="$1"'],
    ['a flag ending in name=', 'npx wrangler pages deploy site --project-name=open-walnut'],
    ['an awk variable', "awk -v name=\"$2\" '{ print name }'"],
    ['a display name printed for a udid', 'step "installing + launching on $DEVICE_NAME ($UDID)"'],
    ['a first pick narrowed by an explicit udid', `UDID=$(xcrun simctl list devices | grep -F "($WANT_UDID)" | grep -oE '[0-9A-F-]{36}' | head -1)`],
    ['a jq lookup narrowed by --arg', `st="$(xcrun simctl list devices -j | jq -r --arg u "$DEVICE" '[.devices[][] | select(.udid==$u)] | .[0].state // ""')"`],
    ['booted in a message', 'die "simulator $DEVICE did not reach Booted state"'],
    ['booted in prose', 'echo "it never takes the one that is booted."'],
    ['a name match that is not about devices', "const gate = jobs.find((j) => j.name === GATE_JOB)", 'js'],
    ['a session id in a JS tool', "const SESSION = '7b370f7c-c1bd-4961-b7cf-2a69d34d5854'", 'js'],
  ])('passes %s', (_label, body, kind = 'shell') => {
    expect(findSimDefaultViolations(`#!/usr/bin/env bash\n${body}\n`, kind)).toEqual([])
  })
})

describe('no tool picks a simulator for its user', () => {
  const files = toolFiles()

  it('finds the files it guards', () => {
    // A walk that silently found nothing would pass everything.
    const names = files.map((f) => f.file)
    expect(files.filter((f) => f.kind === 'shell').length).toBeGreaterThan(20)
    expect(files.filter((f) => f.kind === 'js').length).toBeGreaterThan(20)
    expect(names).toContain('scripts/lib/sim-device.sh')
    expect(names).toContain('ios-native/tests/ui/run-ui-tests.sh')
    expect(names).toContain('scripts/robot-user/episode.mjs')
    expect(names).toContain('ios-native/tests/monkey/stress-composer.yaml')
    expect(names).toContain('package.json')
  })

  it('every tool resolves its simulator through scripts/lib/sim-device.sh or an explicit UDID', () => {
    const offenders: string[] = []
    for (const { file, kind } of files) {
      for (const v of violationsOf(file, kind)) {
        if (!allowed(file, v.rule)) offenders.push(`${file}:${v.line} [${v.rule}] ${v.text}`)
      }
    }
    expect(offenders, [
      'These files pick an iOS simulator by model name, by "booted", or by a written-in UDID.',
      'Resolve it with scripts/lib/sim-device.sh (walnut_sim_resolve) instead, or allowlist the',
      'file in this test with a reason.',
    ].join(' ')).toEqual([])
  })

  it('the allowlist gives a reason for every entry and has no stale ones', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length, `${entry.file} needs a reason`).toBeGreaterThanOrEqual(15)
      const found = files.find((f) => f.file === entry.file)
      expect(found, `${entry.file} is allowlisted but not a guarded file any more`).toBeTruthy()
      const hits = violationsOf(entry.file, found!.kind).filter((v) => v.rule === entry.rule)
      expect(hits.length, `${entry.file} is allowlisted for ${entry.rule} but no longer breaks it`).toBeGreaterThan(0)
    }
  })

  it('the scripts that drive a simulator source the helper', () => {
    for (const file of [
      'scripts/ios-perf-check.sh',
      'scripts/ios-perf/freeze-probe.sh',
      'scripts/ios-perf/kb-loop-probe.sh',
      'scripts/ios-client-log-e2e.sh',
      'ios-native/tests/inbox/inbox-e2e.sh',
      'ios-native/tests/monkey/monkey.sh',
      'ios-native/tests/ui/run-ui-tests.sh',
    ]) {
      const content = fs.readFileSync(path.join(REPO, file), 'utf8')
      expect(content, file).toMatch(/^\s*\.\s+"[^\n]*scripts\/lib\/sim-device\.sh"$/m)
      expect(content, file).toMatch(/walnut_sim_resolve/)
    }
  })
})
