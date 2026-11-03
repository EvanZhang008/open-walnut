/**
 * ios-native/tests/ui-failure-evidence.py: what of a failed iOS UI test's result bundle CI
 * may upload. A public repo's artifacts are anyone's to download, so it keeps only images
 * and screened plain text of the failed tests, under a size cap, and never fails the job.
 * The pure parts are called through python3; the whole run goes through a fake xcresulttool
 * that answers like the real one (manifest.json, summary and activities JSON as Xcode 26 writes them).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'ios-native/tests/ui-failure-evidence.py')
const dirs: string[] = []
const tmp = (name: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `ui-evidence-${name}-`)); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** Call one function of the script with JSON arguments; bytes travel as base64. */
function call(fn: string, ...args: unknown[]): any {
  const code = `
import base64, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ev", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def dec(a):
    if isinstance(a, dict) and "b64" in a: return base64.b64decode(a["b64"])
    if isinstance(a, list): return [dec(x) for x in a]
    if isinstance(a, dict): return {k: dec(v) for k, v in a.items()}
    return a
def enc(v):
    if isinstance(v, bytes): return {"b64": base64.b64encode(v).decode()}
    if isinstance(v, (list, tuple)): return [enc(x) for x in v]
    if isinstance(v, dict): return {k: enc(x) for k, x in v.items()}
    return v
print(json.dumps(enc(getattr(m, sys.argv[2])(*dec(json.loads(sys.argv[3]))))))
`
  // -B: importing the script must leave no __pycache__ in the tree
  return JSON.parse(execFileSync('python3', ['-B', '-c', code, SCRIPT, fn, JSON.stringify(args)], { encoding: 'utf8' }))
}
const b64 = (b: Buffer) => ({ b64: b.toString('base64') })
const unb64 = (v: { b64: string } | null) => (v ? Buffer.from(v.b64, 'base64') : null)

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]) // CRC is not checked
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** A PNG with a text chunk and an EXIF chunk beside the ones it draws with. */
function png(extra = 0): Buffer {
  return Buffer.concat([PNG_SIG, chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Comment\0made on a private host')),
    chunk('eXIf', Buffer.from('exif')), chunk('IDAT', Buffer.alloc(16 + extra, 1)), chunk('IEND', Buffer.alloc(0))])
}
/** A JPEG with an EXIF (APP1) and a comment segment. */
function jpeg(): Buffer {
  const seg = (m: number, body: string) => { const b = Buffer.from(body); const h = Buffer.from([0xff, m, 0, 0]); h.writeUInt16BE(b.length + 2, 2); return Buffer.concat([h, b]) }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, 'JFIF\0'), seg(0xe1, 'Exif\0\0secret-camera'), seg(0xfe, 'a comment'),
    seg(0xdb, 'q'.repeat(10)), Buffer.from([0xff, 0xda, 0, 4, 1, 2]), Buffer.from('scan-data'), Buffer.from([0xff, 0xd9])])
}

describe('what the evidence may hold', () => {
  it('takes PNG and JPEG only when name and bytes agree, and text only as UTF-8 .txt', () => {
    expect(call('image_kind', 'a.png', b64(png()))).toBe('png')
    expect(call('image_kind', 'a.jpg', b64(jpeg()))).toBe('jpeg')
    expect(call('image_kind', 'a.png', b64(jpeg()))).toBeNull()
    expect(call('image_kind', 'a.mp4', b64(Buffer.from('\0\0\0\x14ftypmp42')))).toBeNull()
    expect(call('image_kind', 'UI Snapshot', b64(Buffer.from('bplist00....')))).toBeNull()
    expect(call('is_plain_text', 'tree.txt', b64(Buffer.from('Application, label: → Walnut')))).toBe(true)
    expect(call('is_plain_text', 'tree.txt', b64(Buffer.from([0x62, 0x00, 0x63])))).toBe(false)
    expect(call('is_plain_text', 'tree.txt', b64(Buffer.from([0xc3, 0x28])))).toBe(false)
    expect(call('is_plain_text', 'build.log', b64(Buffer.from('plain')))).toBe(false)
    expect(call('is_plain_text', 'Info.plist', b64(Buffer.from('<plist/>')))).toBe(false)
  })

  it('removes the metadata of an image and keeps what it draws', () => {
    const out = unb64(call('strip_png', b64(png())))!
    expect(out.subarray(0, 8)).toEqual(PNG_SIG)
    expect(out.includes(Buffer.from('IDAT'))).toBe(true)
    expect(out.includes(Buffer.from('private host'))).toBe(false)
    expect(out.includes(Buffer.from('eXIf'))).toBe(false)
    expect(call('strip_png', b64(png().subarray(0, 40)))).toBeNull()
    const j = unb64(call('strip_jpeg', b64(jpeg())))!
    expect(j.includes(Buffer.from('secret-camera'))).toBe(false)
    expect(j.includes(Buffer.from('a comment'))).toBe(false)
    expect(j.includes(Buffer.from('JFIF'))).toBe(true)
    expect(j.includes(Buffer.from('scan-data'))).toBe(true)
  })
})

describe('the text screen', () => {
  // Synthetic shapes only (no real credential), built so no scanner reads them as one.
  const secrets: Record<string, string> = {
    'private-key': '-----BEGIN RSA PRIVATE KEY-----\nMIIB',
    'aws-access-key': 'key AKIA' + 'ABCDEFGHIJKLMNOP' + ' here',
    'github-token': 'ghp_' + 'a1'.repeat(18),
    'slack-token': 'xoxb-' + '1234567890-abcdef',
    jwt: 'eyJ' + 'hbGciOiJI' + '.eyJ' + 'zdWIiOiIx' + '.' + 'c2lnbmF0dXJl',
    bearer: 'Authorization: Bearer ' + 'abcdefghijklmnopqrstu',
    'credential-assignment': 'api_key = "' + 'Zm9vYmFyYmF6cXV4' + '"',
    // fake values: the provider's prefix, then a filler no live key has
    'sk-key': 'OPENAI_KEY sk-' + 'proj-' + 'FAKE0fake0FAKE0fake0FAKE',
    'npm-token': '//registry/:_authToken ' + 'npm_' + 'FAKE0'.repeat(7),
    'aws-secret-key': 'aws_secret_access_key   ' + 'FAKE/fake+'.repeat(4),
    'url-credentials': 'git remote https://' + 'someone:hunter2' + '@git.example.org/r.git',
    'credential-field': "TextField, 0x1, {{0, 0}, {10, 10}}, identifier: 'settings.apiToken', label: 'API token', value: " + 'FAKE0fake'.repeat(3),
  }
  // the other shapes of the same rules, each named by the rule that drops it
  const more: [string, string][] = [
    ['sk-key', 'key sk-' + 'ant-' + 'api03-' + 'FAKE0fake0FAKE0fake0FAKE'],
    ['sk-key', 'key sk-' + 'FAKE0fake'.repeat(4)],
    ['aws-secret-key', 'SecretAccessKey ' + 'FAKE/fake+'.repeat(4)],
    ['credential-assignment', '{"token": "' + 'Zm9vYmFyYmF6cXV4' + '"}'],
    ['url-credentials', 'proxy socks5://u:' + 'p4ss' + '@10.0.0.9:1080'],
    ['credential-field', "SecureTextField, identifier: 'login.password', label: 'Sign in', value: " + 'FAKE0fake'.repeat(3)],
  ]
  for (const [rule, text] of more) {
    it(`drops a ${rule} written as ${JSON.stringify(text.slice(0, 18))}...`, () => {
      expect(call('screen_text', text)[2]).toBe(`secret-shaped text (${rule})`)
    })
  }

  it('keeps text that only looks near a secret', () => {
    for (const text of [
      'server http://127.0.0.1:59999/path?to=dev@example.org', // a port, no password
      "StaticText, label: 'Tokens used', value: 1,204", // a count, not a key
      "TextField, label: 'Password', value: ••••••••••••••••", // a secure field shows dots
      'sk-reader-onboarding-flow-view-model', // a word with a hyphen, no key kind
      'npm_config_cache is set', // short, no token
      // a credential word only as part of another word, or outside the label and identifier
      "  ↳StaticText, 0x7, label: 'tokenized search results for walnut', value: ABCDEFGHIJ0123456789",
      "  ↳Cell, 0x8, identifier: 'row.3', label: 'Row 3', value: ABCDEFGHIJ0123456789 (secret)",
    ]) expect(call('screen_text', text)[2], text).toBeNull()
  })
  for (const [rule, text] of Object.entries(secrets)) {
    it(`drops a file with a ${rule}, and never says what matched`, () => {
      const [out, counts, reason] = call('screen_text', `line one\n${text}\nline three`)
      expect(out).toBeNull()
      expect(counts).toEqual({})
      expect(reason).toBe(`secret-shaped text (${rule})`)
    })
  }

  it('redacts home directories, temp dirs, mail, private hosts, outside IPs and env lines', () => {
    const text = [
      'Path: /Users/someone/work/repo/ios-native/WalnutUITests/IslandStateUITests.swift:59',
      'cache /home/builder/.cache/x and /private/var/folders/ab/cd123/T/xyz',
      'from dev@example.org on build-7.corp and mac.local',
      'server http://127.0.0.1:59999 vs 10.1.2.3',
      'RUNNER_TEMP=/Users/runner/work/_temp',
      "StaticText, identifier: 'harness.islandSent', label: 'Sent 1'",
    ].join('\n')
    const [out, counts, reason] = call('screen_text', text)
    expect(reason).toBeNull()
    expect(out).toContain('/Users/<user>/work/repo/ios-native/WalnutUITests/IslandStateUITests.swift:59')
    expect(out).toContain('/home/<user>/.cache/x')
    expect(out).toContain('<temp path>')
    expect(out).toContain('from <email> on <host> and <host>')
    expect(out).toContain('http://127.0.0.1:59999 vs <ip>')
    expect(out).toContain('<environment line>')
    expect(out).not.toMatch(/someone|builder|example\.org|10\.1\.2\.3|RUNNER_TEMP/)
    expect(out).toContain("identifier: 'harness.islandSent', label: 'Sent 1'")
    expect(counts).toEqual({ 'home-path': 2, 'temp-path': 1, email: 1, 'private-host': 2, 'ip-address': 1, 'env-line': 1 })
  })

  it('redacts device and volume paths and IPv6, and keeps loopback, clocks and UDIDs', () => {
    const text = [
      'app /private/var/mobile/Containers/Data/Application/0F1E2D3C/Documents/a.json',
      'disk /Volumes/Backup Drive and /Volumes/work/repo/x.swift',
      'peer fe80::1c2b:3a4d:5e6f:7a8b%en0 and 2001:db8:85a3:0:0:8a2e:370:7334 and ::ffff:10.2.3.4',
      'loopback ::1 and http://[::1]:8080 at 12:30:45 on 2026-11-02T10:12:33Z',
      'simulator 5313C8E6-81C7-4B02-A388-026487FC5571',
    ].join('\n')
    const [out, counts, reason] = call('screen_text', text)
    expect(reason).toBeNull()
    expect(out).toContain('app <system path>')
    expect(out).toContain('disk /Volumes/<volume> Drive and /Volumes/<volume>/repo/x.swift')
    expect(out).toContain('peer <ip>%en0 and <ip> and ::ffff:<ip>')
    expect(out).toContain('loopback ::1 and http://[::1]:8080 at 12:30:45 on 2026-11-02T10:12:33Z')
    expect(out).toContain('simulator 5313C8E6-81C7-4B02-A388-026487FC5571')
    expect(out).not.toMatch(/mobile|Backup|work\/repo|fe80|2001:db8|10\.2\.3\.4/)
    expect(counts).toEqual({ 'var-path': 1, 'volume-path': 2, 'ipv6-address': 2, 'ip-address': 1 })
  })

  it('drops an environment dump whole', () => {
    const dump = ['HOME=/x', 'PATH=/bin', 'GITHUB_SHA=abc', 'RUNNER_OS=macOS', 'CI=true', 'XCODE_VERSION=26'].join('\n')
    expect(call('screen_text', dump)[2]).toBe('environment dump (6 environment lines)')
  })

  it('counts two-letter names, but never NAME=value inside a line, as environment lines', () => {
    // An element tree full of labels like 'OK=1' is evidence, not an environment dump.
    const tree = [
      "Attributes: Application, 0x1, pid: 1, label: 'Walnut'",
      "  ↳StaticText, 0x2, label: 'OK=1'",
      "  ↳StaticText, 0x3, label: 'CI=true'",
      "  ↳StaticText, 0x4, label: 'TZ=UTC'",
      "  ↳StaticText, 0x5, value: ID=42",
      "  ↳Button, 0x6, label: 'Run with DEBUG=1'",
      '+2.50s  Type "CI=true" into TextField',
      'Ok=fine, mixed case is prose',
      'X=1, one letter is not a name',
    ].join('\n')
    expect(call('screen_text', tree)).toEqual([tree, {}, null])
    // At a line's start they are environment lines: redacted, and five of them a dump.
    const [out, counts] = call('screen_text', 'CI=true\nlabel kept')
    expect(out).toBe('<environment line>\nlabel kept')
    expect(counts).toEqual({ 'env-line': 1 })
    expect(call('screen_text', 'CI=1\nTZ=UTC\nOS=x\nPWD=/\nexport GH=1')[2]).toBe('environment dump (5 environment lines)')
  })

  it('leaves an element tree as it is', () => {
    const tree = "Attributes: Application, 0x10361a660, pid: 77900, label: 'Walnut'\n  ↳Button, {{16.0, 331.0}, {171.0, 23.0}}, label: 'Answer 4'\n"
    expect(call('screen_text', tree)).toEqual([tree, {}, null])
  })
})

describe('the screen on hostile text', () => {
  /** CPU seconds screen_text takes on each input, built and timed inside python. */
  function timings(): Record<string, { cpu: number; reason: string | null; counts: Record<string, number>; head: string }> {
    const code = `
import importlib.util, json, sys, time
spec = importlib.util.spec_from_file_location("ev", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
tree = "Attributes: Application, 0x10361a660, pid: 77900, label: 'Walnut'\\n" + "".join(
    "  \u21b3Button, 0x%x, {{16.0, %d.0}, {171.0, 23.0}}, identifier: 'row.%d', label: 'Answer %d'\\n" % (i, i, i, i) for i in range(40))
hostile = "a-" * 450 + " " + "a." * 450 + " " + "secret" * 100 + " " + "ab:" * 300 + " user.name@" + "a-" * 30 + " mac.local\\n"
mixed = ((tree + hostile) * (2 * 1024 * 1024 // len(tree + hostile) + 1))[:2 * 1024 * 1024]
inputs = {
    "hyphenated line": "a-" * 100000,
    "dotted line": "a." * 100000,
    "hyphenated words": ("a-" * 450 + " ") * 223,
    "dotted words": ("a." * 450 + " ") * 223,
    "mixed 2 MB": mixed,
}
out = {}
for k, text in inputs.items():
    t0 = time.process_time(); r = m.screen_text(text); cpu = time.process_time() - t0
    out[k] = {"cpu": cpu, "reason": r[2], "counts": r[1], "head": (r[0] or "")[:40]}
print(json.dumps(out))
`
    return JSON.parse(execFileSync('python3', ['-B', '-c', code, SCRIPT], { encoding: 'utf8' }))
  }

  it('screens a 200,000-character line in well under a second and 2 MB in about one', () => {
    // Before every quantifier was bounded, a 20,000-character line of 'a-' took minutes:
    // the job's limit then cancelled the run, and a cancelled run keeps no evidence.
    // Measured 2026-11-02 (CPU seconds): 200,000 characters 0.001 to 0.065, the 2 MB text
    // 0.35 on an M-series Mac and 0.73 on a Linux dev host; the 2 MB bound leaves a slower
    // runner room, and a return of the old backtracking costs minutes, far past it.
    const t = timings()
    for (const [k, v] of Object.entries(t)) {
      expect(v.cpu, `${k}: ${v.cpu.toFixed(3)} s`).toBeLessThan(k === 'mixed 2 MB' ? 2 : 1)
      expect(v.reason, k).toBeNull()
    }
    // A run of more than 1000 non-space characters is one marker, never screened rule by rule.
    expect(t['hyphenated line']!.head).toBe('<long token, 200000 chars>')
    expect(t['hyphenated line']!.counts).toEqual({ 'long-token': 1 })
    expect(t['dotted line']!.head).toBe('<long token, 200000 chars>')
    // The 2 MB text was screened, not skipped: its hosts are redacted.
    expect(t['mixed 2 MB']!.counts['private-host']).toBeGreaterThan(100)
  })
})

describe('the size cap', () => {
  const items = [
    { name: 'a', size: 10, failure: false }, { name: 'b', size: 50, failure: false },
    { name: 'c', size: 60, failure: true }, { name: 'd', size: 5, failure: true },
  ]
  it('drops the largest first, a failure’s own attachment last', () => {
    const [kept, dropped] = call('apply_cap', items, 80)
    expect(dropped.map((i: { name: string }) => i.name)).toEqual(['b'])
    expect(kept.map((i: { name: string }) => i.name)).toEqual(['a', 'c', 'd'])
    const [kept2, dropped2] = call('apply_cap', items, 30)
    expect(dropped2.map((i: { name: string }) => i.name)).toEqual(['b', 'a', 'c'])
    expect(kept2.map((i: { name: string }) => i.name)).toEqual(['d'])
    expect(call('apply_cap', items, 1000)[1]).toEqual([])
  })

  it('drops one of two equal attachments, not both', () => {
    const twins = [{ name: 'shot', size: 10, failure: false }, { name: 'shot', size: 10, failure: false }]
    const [kept, dropped] = call('apply_cap', twins, 15)
    expect(dropped).toHaveLength(1)
    expect(kept).toHaveLength(1)
  })

  it('names files plainly, keeping the extension', () => {
    expect(call('file_slug', '4-review-sheet_0_5313C8E6-81C7-4B02-A388-026487FC5571.png')).toBe('4-review-sheet.png')
    expect(call('file_slug', 'Debug description for `"x" StaticText`_0_6615303A-A802-40BD-B78B-12F7B10D7211.txt')).toBe('Debug-description-for-x-StaticText.txt')
    expect(call('file_slug', 'a'.repeat(200) + '.txt')).toHaveLength(80)
  })
})

/** A fake xcresulttool: answers from files in $FAKE_DIR, fails as $FAKE_FAIL says. */
const FAKE_TOOL = `
import json, os, shutil, sys
a = sys.argv[1:]; d = os.environ["FAKE_DIR"]; fail = os.environ.get("FAKE_FAIL", "")
def arg(n): return a[a.index(n) + 1]
if a[:3] == ["get", "test-results", "summary"]:
    if fail == "summary": sys.exit("Error: the result bundle is corrupt")
    print(open(os.path.join(d, "summary.json")).read())
elif a[:2] == ["export", "attachments"]:
    if fail == "export": sys.exit(1)
    out = arg("--output-path"); src = os.path.join(d, "attachments")
    entries = []
    for i, name in enumerate(sorted(os.listdir(src))):
        exported = "F%02d%s" % (i, os.path.splitext(name)[1])
        shutil.copy(os.path.join(src, name), os.path.join(out, exported))
        entries.append({"exportedFileName": exported, "suggestedHumanReadableName": os.path.splitext(name)[0] + "_0_6615303A-A802-40BD-B78B-12F7B10D7211" + os.path.splitext(name)[1],
                        "isAssociatedWithFailure": False, "timestamp": 100 + i, "configurationName": "c", "deviceName": "d", "deviceId": "x"})
    json.dump([{"testIdentifier": arg("--test-id"), "attachments": entries}], open(os.path.join(out, "manifest.json"), "w"))
elif a[:3] == ["get", "test-results", "activities"]:
    print(json.dumps({"testRuns": [{"device": {"modelName": "iPhone 17", "platform": "iOS Simulator", "osVersion": "26.0"},
        "activities": [{"title": "Start Test", "startTime": 1000.0},
                       {"title": 'Tap "Send" Button', "startTime": 1002.5, "childActivities": [{"title": "Synthesize event", "startTime": 1002.6}]},
                       {"title": "XCTAssertTrue failed - Sent 0", "startTime": 1012.0, "isAssociatedWithFailure": True}]}]}))
else:
    sys.exit("unknown " + " ".join(a))
`

function fixture(failures: unknown[], attachments: Record<string, Buffer | string>) {
  const d = tmp('fake')
  fs.writeFileSync(path.join(d, 'tool.py'), FAKE_TOOL)
  fs.writeFileSync(path.join(d, 'summary.json'), JSON.stringify({ result: failures.length ? 'Failed' : 'Passed', testFailures: failures }))
  fs.mkdirSync(path.join(d, 'attachments'))
  for (const [name, data] of Object.entries(attachments)) fs.writeFileSync(path.join(d, 'attachments', name), data)
  const bundle = path.join(d, 'ios-ui.xcresult'); fs.mkdirSync(bundle)
  return { d, bundle }
}

function run(f: { d: string; bundle: string }, extra: string[] = [], env: Record<string, string> = {}) {
  const out = tmp('out'), gh = tmp('gh')
  const r = spawnSync('python3', [SCRIPT, '--bundle', f.bundle, '--out', out, '--tool', `python3 ${path.join(f.d, 'tool.py')}`, ...extra], {
    encoding: 'utf8', env: { ...process.env, FAKE_DIR: f.d, GITHUB_OUTPUT: path.join(gh, 'out'), GITHUB_STEP_SUMMARY: path.join(gh, 'summary'), ...env },
  })
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
  const files = fs.readdirSync(out, { recursive: true }).map(String).filter((p) => fs.statSync(path.join(out, p)).isFile()).sort()
  return { code: r.status, stdout: r.stdout, out, files, output: read(path.join(gh, 'out')), summary: read(path.join(gh, 'summary')) }
}

const FAILED = [{ testIdentifierString: 'IslandStateUITests/testQuiz()', failureText: 'XCTAssertTrue failed - /Users/someone/x.swift:59' }]

describe('a whole run', () => {
  it('keeps the screened evidence of a failed test and nothing else of the bundle', () => {
    const f = fixture(FAILED, {
      '1-step.png': png(), 'failure-screen.png': png(), 'failure-hierarchy.txt': "Application, label: 'Walnut'\n at /Users/someone/x",
      'leaky.txt': 'token: ' + 'ghp_' + 'a1'.repeat(18), 'Screen Recording.mp4': '\0\0\0\x14ftypmp42', 'UI Snapshot': 'bplist00', 'build.log': 'log',
    })
    const r = run(f)
    expect(r.code).toBe(0)
    const dir = '01-IslandStateUITests-testQuiz'
    expect(r.files).toEqual([`${dir}/01-1-step.png`, `${dir}/05-failure-hierarchy.txt`, `${dir}/06-failure-screen.png`, `${dir}/steps.txt`, 'NOTES.txt', 'manifest.json', 'summary/failures.txt'])
    expect(fs.readFileSync(path.join(r.out, dir, '05-failure-hierarchy.txt'), 'utf8')).toBe("Application, label: 'Walnut'\n at /Users/<user>/x")
    expect(fs.readFileSync(path.join(r.out, dir, '06-failure-screen.png')).includes(Buffer.from('private host'))).toBe(false)
    const steps = fs.readFileSync(path.join(r.out, dir, 'steps.txt'), 'utf8')
    expect(steps).toContain('== run on iPhone 17, iOS Simulator 26.0')
    expect(steps).toContain('+2.50s  Tap "Send" Button')
    expect(steps).toContain('  +2.60s  Synthesize event')
    expect(steps).toContain('+12.00s  XCTAssertTrue failed - Sent 0  <- failure')
    expect(fs.readFileSync(path.join(r.out, 'summary/failures.txt'), 'utf8')).toBe('IslandStateUITests/testQuiz(): XCTAssertTrue failed - /Users/<user>/x.swift:59\n')
    const notes = fs.readFileSync(path.join(r.out, 'NOTES.txt'), 'utf8')
    expect(notes).toContain('leaky.txt: secret-shaped text (github-token)')
    expect(notes).toContain('Screen Recording.mp4: not an image or plain text')
    expect(notes).toContain('build.log: not an image or plain text')
    expect(notes).not.toContain('ghp_')
    expect(r.stdout + r.summary).not.toContain('ghp_')
    const manifest = JSON.parse(fs.readFileSync(path.join(r.out, 'manifest.json'), 'utf8'))
    // the test's own capture counts as the failure's, though XCTest does not mark it so
    expect(manifest.find((m: { file: string }) => m.file.endsWith('06-failure-screen.png')).failure).toBe(true)
    expect(manifest.find((m: { file: string }) => m.file.endsWith('01-1-step.png')).failure).toBe(false)
    expect(r.output).toBe('kept=5\n')
    expect(r.summary).toContain('### iOS UI failure evidence')
    expect(r.summary).toContain('- dropped 3: not an image or plain text')
    expect(r.summary).toContain('- dropped 1: secret-shaped text (github-token)')
    expect(r.summary).toContain('- redacted: home-path 2')
  })

  it('drops the largest files over the cap and says so', () => {
    const f = fixture(FAILED, { '1-big.png': png(4000), '2-mid.png': png(2000), 'failure-screen.png': png(3000) })
    const r = run(f, ['--max-bytes', '5000'])
    expect(r.code).toBe(0)
    expect(r.files.filter((p) => p.endsWith('.png'))).toEqual(['01-IslandStateUITests-testQuiz/03-failure-screen.png'])
    const notes = fs.readFileSync(path.join(r.out, 'NOTES.txt'), 'utf8')
    expect(notes).toMatch(/1-big\.png: over the 5000 byte cap/)
    expect(notes).toMatch(/2-mid\.png: over the 5000 byte cap/)
    const total = r.files.reduce((n, p) => n + fs.statSync(path.join(r.out, p)).size, 0)
    expect(total).toBeLessThan(5000 + 2000) // the cap counts kept attachments; manifest and notes are small
  })

  it('keeps nothing for a passing bundle, a missing one, a corrupt one or a missing tool, and exits 0', () => {
    const pass = run(fixture([], { 'step.png': png() }))
    const missing = run({ ...fixture(FAILED, {}), bundle: '/nonexistent/ios-ui.xcresult' })
    const corrupt = run(fixture(FAILED, { 'step.png': png() }), [], { FAKE_FAIL: 'summary' })
    const noTool = run(fixture(FAILED, {}), ['--tool', '/nonexistent/xcresulttool'])
    for (const [r, note] of [[pass, 'no failed test'], [missing, 'no result bundle'], [corrupt, 'no readable test summary'], [noTool, 'no readable test summary']] as const) {
      expect(r.code).toBe(0)
      expect(r.files).toEqual([])
      expect(r.output).toBe('kept=0\n')
      expect(r.summary).toContain(note)
    }
  })

  it('keeps two tests whose names cut to the same slug in their own directories', () => {
    const long = 'LongNamedUITests/test' + 'TheTimelineKeepsItsPlace'.repeat(4)
    const failed = [{ testIdentifierString: long + 'A()', failureText: 'a' }, { testIdentifierString: long + 'B()', failureText: 'b' }]
    const r = run(fixture(failed, {}), [], { FAKE_FAIL: 'export' })
    const steps = r.files.filter((p) => p.endsWith('/steps.txt'))
    expect(steps).toHaveLength(2)
    expect(steps[0]!.startsWith('01-')).toBe(true)
    expect(steps[1]!.startsWith('02-')).toBe(true)
    for (const p of steps) expect(path.dirname(p).length).toBeLessThanOrEqual(80)
    const manifest = JSON.parse(fs.readFileSync(path.join(r.out, 'manifest.json'), 'utf8'))
    expect(manifest.filter((m: { file: string }) => m.file.endsWith('steps.txt')).map((m: { test: string }) => m.test)).toEqual([long + 'A()', long + 'B()'])
  })

  it('still keeps the step log and the failure text when the attachments do not export', () => {
    const r = run(fixture(FAILED, { 'step.png': png() }), [], { FAKE_FAIL: 'export' })
    expect(r.code).toBe(0)
    expect(r.files).toEqual(['01-IslandStateUITests-testQuiz/steps.txt', 'NOTES.txt', 'manifest.json', 'summary/failures.txt'])
    expect(r.summary).toContain('could not export the attachments of IslandStateUITests/testQuiz()')
  })
})
