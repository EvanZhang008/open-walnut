/**
 * tests/e2e/browser/pw-pasteboard.ts: every way to start WebKit on a Mac goes through the private
 * pasteboard, and a launch without it is closed and refused. On a Mac it also builds the library and
 * proves, with a small program that writes only once the redirect is in place, that the general
 * pasteboard request lands on a private one and the real clipboard does not change.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { guardWebkitPasteboard, PASTEBOARD_GUARDED, pasteboardLibrary, WEBKIT_RUNNER } from '../e2e/browser/pw-pasteboard'

type Opts = { executablePath?: string; env?: Record<string, string | number | boolean | undefined> }
function fakeWebkit(writeMark: boolean) {
  const seen: Opts[] = []; let closed = 0
  const start = async (o: Opts = {}) => {
    seen.push(o)
    const mark = o.env?.WALNUT_PW_PASTEBOARD_MARK
    if (writeMark && typeof mark === 'string') fs.writeFileSync(mark, 'x')
    return { close: async () => { closed++ } }
  }
  const type = {
    executablePath: () => '/pw/webkit-1/pw_run.sh',
    launch: start,
    launchPersistentContext: (_dir: string, o?: Opts) => start(o),
    launchServer: start,
  }
  return { type, seen, closed: () => closed }
}

describe('a WebKit test browser on a Mac has its own pasteboard', () => {
  it('changes nothing off a Mac', async () => {
    const f = fakeWebkit(false); const launch = f.type.launch
    guardWebkitPasteboard(f.type, 'linux', () => '/lib.dylib')
    expect(f.type.launch).toBe(launch)
  })

  it('every launch kind goes through the runner with the library, and keeps the caller env', async () => {
    const f = fakeWebkit(true)
    guardWebkitPasteboard(f.type, 'darwin', () => '/lib.dylib')
    await f.type.launch({ env: { KEEP: '1' } })
    await f.type.launchPersistentContext('/tmp/x', {})
    await f.type.launchServer({ executablePath: '/other/pw_run.sh' })
    expect(f.seen).toHaveLength(3)
    for (const o of f.seen) {
      expect(o.executablePath).toBe(WEBKIT_RUNNER)
      expect(o.env?.WALNUT_PW_PASTEBOARD_DYLIB).toBe('/lib.dylib')
    }
    expect(f.seen[0].env?.KEEP).toBe('1')
    expect(f.seen[0].env?.WALNUT_PW_WEBKIT_RUN).toBe('/pw/webkit-1/pw_run.sh')
    expect(f.seen[2].env?.WALNUT_PW_WEBKIT_RUN).toBe('/other/pw_run.sh')
  })

  it("the project's launch env and executablePath are kept, and the launch functions say they are guarded", async () => {
    const f = fakeWebkit(true)
    guardWebkitPasteboard(f.type, 'darwin', () => '/lib.dylib', () => ({ env: { PROJECT: 'yes' }, executablePath: '/project/pw_run.sh' }))
    await f.type.launch({})
    expect(f.seen[0].env?.PROJECT).toBe('yes')
    expect(f.seen[0].env?.WALNUT_PW_WEBKIT_RUN).toBe('/project/pw_run.sh')
    for (const fn of [f.type.launch, f.type.launchPersistentContext, f.type.launchServer]) expect((fn as unknown as Record<symbol, boolean>)[PASTEBOARD_GUARDED]).toBe(true)
  })

  it('a browser that started without the library is closed and refused', async () => {
    const f = fakeWebkit(false)
    guardWebkitPasteboard(f.type, 'darwin', () => '/lib.dylib')
    await expect(f.type.launch({})).rejects.toThrow(/without a pasteboard of its own/)
    expect(f.closed()).toBe(1)
  })

  it('pw-silence, which every Playwright config imports, applies it to WebKit', () => {
    const src = fs.readFileSync(path.join(__dirname, '../e2e/browser/pw-silence.ts'), 'utf8')
    // After the silencer's own catch, and in no try after it.
    const tail = src.slice(src.indexOf('could not silence test browsers'))
    const guard = tail.search(/guardWebkitPasteboard\(core\.webkit/)
    expect(guard, 'the guard is installed outside the silencer try, so it cannot fail quietly').toBeGreaterThan(0)
    expect(tail.slice(0, guard), 'and outside any later try').not.toMatch(/\btry \{/)
  })

  it.skipIf(process.platform !== 'darwin')('on a Mac, the library redirects the general pasteboard and the real one is untouched', () => {
    const lib = pasteboardLibrary()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-pasteboard-probe-'))
    try {
      const probe = path.join(dir, 'probe')
      fs.writeFileSync(`${probe}.m`, `#import <AppKit/AppKit.h>
int main(void) { @autoreleasepool {
  NSPasteboard *g = [NSPasteboard generalPasteboard];
  NSPasteboard *n = [NSPasteboard pasteboardWithName:NSPasteboardNameGeneral];
  if ([g.name isEqualToString:NSPasteboardNameGeneral] || [n.name isEqualToString:NSPasteboardNameGeneral]) { printf("not redirected\\n"); return 1; }
  [g clearContents]; [g setString:@"probe" forType:NSPasteboardTypeString];
  printf("%s %s\\n", g.name.UTF8String, [[n stringForType:NSPasteboardTypeString] UTF8String]);
} return 0; }
`)
      execFileSync('clang', ['-fobjc-arc', '-framework', 'AppKit', '-o', probe, `${probe}.m`])
      const count = () => execFileSync('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount'], { encoding: 'utf8' }).trim()
      const before = count()
      const out = execFileSync(probe, { encoding: 'utf8', env: { ...process.env, DYLD_INSERT_LIBRARIES: lib } })
      expect(out).toMatch(/^walnut-test-pasteboard-\d+ probe$/m)
      expect(count()).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
