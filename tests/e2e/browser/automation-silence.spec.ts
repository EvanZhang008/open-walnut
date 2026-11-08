/**
 * A browser under automation makes no sound on the machine it runs on (2026-11-08: a
 * Playwright WebKit run on someone else's Mac, with a person at it, woke its built-in
 * speaker at every page's first click, through the reminder chime's audio unlock).
 *
 * In the real engine: a click opens no audio device, media plays muted and stays muted,
 * and Web Audio reaches the speakers only through a gain of zero. The silencer's logic
 * and the ratchets are tests/web/automation-silence.test.ts.
 */
import { expect, test } from '@playwright/test';

/** A 10 ms silent WAV, so play() has something to start. */
const WAV = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA';

test('a click opens no audio device, and nothing the page plays reaches the speakers', async ({ page }) => {
  // Count every AudioContext the page builds, from before its first script.
  await page.addInitScript(() => {
    const w = window as unknown as { __built: number; AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    w.__built = 0;
    for (const name of ['AudioContext', 'webkitAudioContext'] as const) {
      const Native = w[name];
      if (!Native) continue;
      w[name] = class extends Native { constructor(...a: ConstructorParameters<typeof AudioContext>) { super(...a); w.__built++; } };
    }
  });
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(await page.evaluate(() => (window as unknown as { __walnutSilent?: boolean }).__walnutSilent)).toBe(true);

  // The chime's unlock ran on this: a first pointer press and a key.
  await page.mouse.click(5, 5);
  await page.keyboard.press('Shift');
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as unknown as { __built: number }).__built)).toBe(0);

  const media = await page.evaluate(async (src) => {
    const a = new Audio(src);
    a.muted = false;
    const started = a.play().then(() => 'played', (e: Error) => e.name);
    const mutedAtPlay = a.muted;
    a.muted = false;
    const mutedAfterUnmute = a.muted;
    await started;
    return { mutedAtPlay, mutedAfterUnmute };
  }, WAV);
  expect(media).toEqual({ mutedAtPlay: true, mutedAfterUnmute: true });

  const audio = await page.evaluate(() => {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const back = osc.connect(ctx.destination);
    const patched = !/\[native code\]/.test(AudioNode.prototype.connect.toString());
    void ctx.close();
    return { returnsDestination: back === ctx.destination, patched };
  });
  expect(audio).toEqual({ returnsDestination: true, patched: true });
});

test('every frame is silent from its own first script, an opaque sandbox included', async ({ page }) => {
  // The parent page cannot reach a sandboxed frame without allow-same-origin (a plugin's
  // page, a dev server in the Web view): only the runner's init script (pw-silence.ts) can.
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  const probe = await page.evaluate(() => new Promise((resolve) => {
    addEventListener('message', (e) => { if (e.data && e.data.probe) resolve(e.data); });
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.srcdoc = '<script>var a=new Audio();a.muted=false;a.play().catch(function(){});'
      + 'parent.postMessage({probe:1,silent:window.__walnutSilent===true,muted:a.muted},"*")</' + 'script>';
    document.body.appendChild(f);
  }));
  expect(probe).toEqual({ probe: 1, silent: true, muted: true });
});

test('the browser\'s own media controls cannot unmute it', async ({ page }) => {
  // The native speaker button changes `muted` inside the engine, past the page's setter.
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  await page.evaluate((src) => {
    const a = document.createElement('audio');
    a.controls = true;
    a.src = src;
    a.loop = true;
    a.id = 'pw-silence-audio';
    a.style.cssText = 'position:fixed;left:20px;top:20px;width:300px;z-index:2147483647';
    document.body.appendChild(a);
    (window as unknown as { __unmutedSeen: boolean }).__unmutedSeen = false;
    a.addEventListener('volumechange', () => {
      // Read after the silencer's own capture listener had its turn.
      setTimeout(() => { if (!a.muted) (window as unknown as { __unmutedSeen: boolean }).__unmutedSeen = true; }, 0);
    });
    void a.play().catch(() => {});
  }, WAV);
  const audio = page.locator('#pw-silence-audio');
  const box = (await audio.boundingBox())!;
  // Every spot along the bar, so the speaker button is among them in either engine; each
  // click starts muted and is read on its own (two hits on the button would cancel out).
  const unmutedAt: number[] = [];
  for (let x = 6; x < box.width; x += 5) {
    await audio.evaluate((a: HTMLAudioElement) => { a.muted = true; });
    await page.mouse.click(box.x + x, box.y + box.height / 2);
    await page.waitForTimeout(40);
    if (!(await audio.evaluate((a: HTMLAudioElement) => a.muted))) unmutedAt.push(x);
  }
  expect(unmutedAt).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __unmutedSeen: boolean }).__unmutedSeen)).toBe(false);
});
