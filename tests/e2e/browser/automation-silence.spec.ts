/**
 * A browser under automation makes no sound on the machine it runs on (2026-11-08: a
 * Playwright WebKit run on someone else's Mac, with a person at it, woke its built-in
 * speaker at every page's first click, through the reminder chime's audio unlock).
 *
 * In the real engine: the app tries no audio, media never plays, an autoplay element is
 * paused, and an AudioContext gets no output device. The silencer's logic and the ratchets
 * are tests/web/automation-silence.test.ts.
 */
import { expect, test } from '@playwright/test';

/** A 10 ms silent WAV, so play() has something to start. */
const WAV = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA';

type Tried = { contexts: number; blocked: number; plays: number; speech: number };
const tried = () => (window as unknown as { __walnutAudio: Tried }).__walnutAudio;

test('the app tries no audio at all, and nothing a page plays reaches an audio device', async ({ page, browserName }) => {
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(await page.evaluate(() => (window as unknown as { __walnutSilent?: boolean }).__walnutSilent)).toBe(true);

  // The chime's unlock ran on this: a first pointer press and a key. The app itself must
  // try nothing: no AudioContext, no media, no speech.
  await page.mouse.click(5, 5);
  await page.keyboard.press('Shift');
  await page.waitForTimeout(600);
  expect(await page.evaluate(tried)).toEqual({ contexts: 0, blocked: 0, plays: 0, speech: 0 });

  // Whatever a page does, media never plays.
  const media = await page.evaluate(async (src) => {
    const a = new Audio(src);
    a.muted = false;
    const result = await a.play().then(() => 'played', (e: Error) => e.name);
    return { result, paused: a.paused, muted: a.muted };
  }, WAV);
  expect(media).toEqual({ result: 'NotAllowedError', paused: true, muted: true });

  // An autoplay element is paused as it starts.
  const auto = await page.evaluate(async (src) => {
    const a = document.createElement('audio');
    a.autoplay = true;
    a.src = src;
    document.body.appendChild(a);
    let ran = false;
    a.addEventListener('playing', () => { setTimeout(() => { if (!a.paused) ran = true; }, 0); });
    await new Promise((r) => setTimeout(r, 800));
    a.remove();
    return { paused: a.paused, muted: a.muted, ran };
  }, WAV);
  expect(auto).toEqual({ paused: true, muted: true, ran: false });

  // An AudioContext gets no output device: Chromium runs it without one, WebKit cannot.
  const ctx = await page.evaluate(() => {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    try {
      const c = new Ctor();
      const sink = (c as unknown as { sinkId: unknown }).sinkId;
      void c.close();
      return { made: true, sink: typeof sink === 'object' && sink ? (sink as { type: string }).type : sink };
    } catch (e) {
      return { made: false, error: (e as Error).name };
    }
  });
  expect(ctx).toEqual(browserName === 'chromium' ? { made: true, sink: 'none' } : { made: false, error: 'NotSupportedError' });
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
    f.srcdoc = '<script>var a=new Audio();a.muted=false;a.play().then(function(){return "played"},function(e){return e.name})'
      + '.then(function(r){parent.postMessage({probe:1,silent:window.__walnutSilent===true,muted:a.muted,play:r},"*")})</' + 'script>';
    document.body.appendChild(f);
  }));
  expect(probe).toEqual({ probe: 1, silent: true, muted: true, play: 'NotAllowedError' });
});

test('the browser\'s own media controls cannot unmute it or play it', async ({ page }) => {
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
    (window as unknown as { __playingSeen: boolean }).__playingSeen = false;
    a.addEventListener('playing', () => {
      setTimeout(() => { if (!a.paused) (window as unknown as { __playingSeen: boolean }).__playingSeen = true; }, 0);
    });
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
  expect(await page.evaluate(() => (window as unknown as { __playingSeen: boolean }).__playingSeen), 'its play button plays nothing').toBe(false);
});
