/**
 * A sharp proof video of a browser spec, only when PROOF_VIDEO_DIR is set (a normal run does
 * nothing extra). Playwright's own recordVideo is 1 Mbit/s VP8 at the viewport's size, too blurry
 * to read; this takes the page's frames through the DevTools screencast at the device scale
 * factor, draws a pointer dot and a ripple at each press (headless capture has no cursor) and a
 * caption line, and joins the frames with ffmpeg as H.264 CRF 18, by their own timestamps.
 *
 *   const video = await startProofVideo(page)   // before or after the first load
 *   await video.caption('Press Record')          // the first caption starts the capture (no loading screen)
 *   await video.hold()                           // about a second on a result
 *   await video.stop('drawing-narration')        // -> <PROOF_VIDEO_DIR>/drawing-narration.mp4
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'

export interface ProofVideo {
  readonly on: boolean
  caption(text: string): Promise<void>
  hold(ms?: number): Promise<void>
  stop(name: string): Promise<string | null>
}

const OVERLAY = `(() => {
  if (window.__proofOverlay) return; window.__proofOverlay = true;
  const add = () => {
    const style = document.createElement('style');
    style.textContent = '#proof-dot{position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,59,48,.85);box-shadow:0 0 0 3px rgba(255,255,255,.9);pointer-events:none;left:-40px;top:-40px}'
      + '.proof-ripple{position:fixed;z-index:2147483646;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid rgba(255,59,48,.9);pointer-events:none;animation:proof-r .6s ease-out forwards}'
      + '@keyframes proof-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}'
      + '#proof-caption{position:fixed;z-index:2147483645;left:50%;bottom:28px;transform:translateX(-50%);max-width:80%;padding:10px 18px;border-radius:10px;background:rgba(20,20,20,.86);color:#fff;font:600 17px/1.35 -apple-system,system-ui,sans-serif;pointer-events:none;text-align:center}'
      + '#proof-caption:empty{display:none}#proof-tick{position:fixed;left:0;top:0;width:1px;height:1px;opacity:.01;pointer-events:none}';
    document.head.appendChild(style);
    const dot = document.createElement('div'); dot.id = 'proof-dot';
    const cap = document.createElement('div'); cap.id = 'proof-caption';
    const tick = document.createElement('div'); tick.id = 'proof-tick';
    document.body.append(dot, cap, tick);
    window.addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', (e) => {
      const r = document.createElement('div'); r.className = 'proof-ripple';
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.body.appendChild(r); setTimeout(() => r.remove(), 700);
    }, true);
    // A paint every frame, so a still screen still yields frames.
    let n = 0; const spin = () => { tick.style.transform = 'translateX(' + (n++ % 2) + 'px)'; requestAnimationFrame(spin); }; spin();
  };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})()`

const OFF: ProofVideo = { on: false, caption: async () => {}, hold: async () => {}, stop: async () => null }

export async function startProofVideo(page: Page): Promise<ProofVideo> {
  const dir = process.env.PROOF_VIDEO_DIR
  if (!dir) return OFF
  const frames = fs.mkdtempSync(path.join(dir, '.frames-'))
  const stamps: Array<{ file: string; at: number }> = []
  await page.addInitScript(OVERLAY)
  // Started after the page loaded, the init script waits for the next load: draw the pointer and
  // the caption on the page as it is too (OVERLAY runs once per document), or the video has neither.
  await page.evaluate(OVERLAY).catch(() => {})
  const cdp = await page.context().newCDPSession(page)
  // A frame can still arrive after stop() removed the folder (2026-11-22: ENOENT on a late frame
  // failed a passing proof run): frames after stop are dropped.
  let stopped = false
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    if (stopped) return
    const file = path.join(frames, `${String(stamps.length).padStart(6, '0')}.jpg`)
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'))
    stamps.push({ file, at: f.metadata.timestamp ?? Date.now() / 1000 })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  const vp = page.viewportSize() ?? { width: 1280, height: 900 }
  let started = false
  return {
    on: true,
    caption: async (text) => {
      if (!started) {
        started = true
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: vp.width * 2, maxHeight: vp.height * 2, everyNthFrame: 1 })
      }
      await page.evaluate((t) => { const c = document.getElementById('proof-caption'); if (c) c.textContent = t }, text).catch(() => {})
    },
    hold: (ms = 1_200) => page.waitForTimeout(ms),
    stop: async (name) => {
      stopped = true
      await cdp.send('Page.stopScreencast').catch(() => {})
      if (stamps.length < 2) return null
      // Each frame shows until the next one came: the video keeps the real pace.
      const list = stamps.map((s, i) => `file '${s.file}'\nduration ${Math.max(0.001, (stamps[i + 1]?.at ?? s.at + 1) - s.at).toFixed(3)}`).join('\n')
      const listFile = path.join(frames, 'frames.txt')
      fs.writeFileSync(listFile, `ffconcat version 1.0\n${list}\nfile '${stamps.at(-1)!.file}'\n`)
      const out = path.join(dir, `${name}.mp4`)
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
      fs.rmSync(frames, { recursive: true, force: true })
      return out
    },
  }
}
