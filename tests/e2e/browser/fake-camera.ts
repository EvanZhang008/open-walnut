/**
 * A fake camera for the chat camera's specs: a Y4M clip of a whiteboard on
 * which a small box diagram is drawn step by step (API, then QUEUE, then
 * WORKER, the arrows between them and a red ring), so the stills picked from a
 * recording really differ. Chromium plays it as the camera and loops it
 * (fake-mic.ts fakeCameraArgs). Nothing here opens a real camera.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CAM_W = 640
export const CAM_H = 360
const FPS = 5
const SECONDS = 16

type Yuv = [number, number, number]
const BOARD: Yuv = [228, 128, 128]
const FRAME: Yuv = [120, 128, 128]
const BLUE: Yuv = [62, 178, 112]
const RED: Yuv = [82, 98, 214]

/** 5x7 letters for the labels. */
const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
}

class Picture {
  y = new Uint8Array(CAM_W * CAM_H)
  u = new Uint8Array((CAM_W / 2) * (CAM_H / 2))
  v = new Uint8Array((CAM_W / 2) * (CAM_H / 2))
  dot(x: number, y: number, c: Yuv) {
    if (x < 0 || y < 0 || x >= CAM_W || y >= CAM_H) return
    this.y[y * CAM_W + x] = c[0]
    const i = (y >> 1) * (CAM_W / 2) + (x >> 1)
    this.u[i] = c[1]
    this.v[i] = c[2]
  }
  fill(x0: number, y0: number, w: number, h: number, c: Yuv) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.dot(x, y, c)
  }
  box(x: number, y: number, w: number, h: number, c: Yuv, t = 4) {
    this.fill(x, y, w, t, c); this.fill(x, y + h - t, w, t, c); this.fill(x, y, t, h, c); this.fill(x + w - t, y, t, h, c)
  }
  text(s: string, x: number, y: number, c: Yuv, k = 3) {
    for (const ch of s) {
      const g = FONT[ch]
      if (g) g.forEach((row, r) => [...row].forEach((bit, col) => { if (bit === '1') this.fill(x + col * k, y + r * k, k, k, c) }))
      x += 6 * k
    }
  }
  arrow(x0: number, x1: number, y: number, c: Yuv) {
    this.fill(x0, y - 2, x1 - x0, 4, c)
    for (let i = 0; i < 10; i++) { this.fill(x1 - i, y - i, 3, 1, c); this.fill(x1 - i, y + i, 3, 1, c) }
  }
  ring(cx: number, cy: number, r: number, c: Yuv) {
    for (let a = 0; a < 720; a++) {
      const t = (a / 720) * Math.PI * 2
      for (let w = 0; w < 4; w++) this.dot(Math.round(cx + (r + w) * Math.cos(t) * 1.6), Math.round(cy + (r + w) * Math.sin(t)), c)
    }
  }
}

/** The board at `sec` seconds: each part appears at its time. */
function boardAt(sec: number): Picture {
  const p = new Picture()
  p.fill(0, 0, CAM_W, CAM_H, [70, 128, 128])
  p.fill(30, 24, CAM_W - 60, CAM_H - 48, BOARD)
  p.box(30, 24, CAM_W - 60, CAM_H - 48, FRAME, 8)
  if (sec >= 0) { p.box(70, 150, 130, 60, BLUE); p.text('API', 108, 170, BLUE) }
  if (sec >= 3) p.arrow(204, 252, 180, BLUE)
  if (sec >= 5) { p.box(256, 150, 130, 60, RED); p.text('QUEUE', 276, 170, RED) }
  if (sec >= 8) p.arrow(390, 438, 180, BLUE)
  if (sec >= 10) { p.box(442, 150, 130, 60, BLUE); p.text('WORKER', 454, 170, BLUE, 3) }
  if (sec >= 13) p.ring(321, 248, 16, RED)
  return p
}

/** The whole clip as Y4M (4:2:0), written to a temp folder of its own; answers its path. */
export function writeWhiteboardY4m(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fake-camera-'))
  const file = path.join(dir, 'whiteboard.y4m')
  const fd = fs.openSync(file, 'w')
  try {
    fs.writeSync(fd, `YUV4MPEG2 W${CAM_W} H${CAM_H} F${FPS}:1 Ip A1:1 C420jpeg\n`)
    let last = -1
    let pic = boardAt(0)
    for (let f = 0; f < FPS * SECONDS; f++) {
      const sec = Math.floor(f / FPS)
      if (sec !== last) { pic = boardAt(sec); last = sec }
      fs.writeSync(fd, 'FRAME\n')
      fs.writeSync(fd, pic.y)
      fs.writeSync(fd, pic.u)
      fs.writeSync(fd, pic.v)
    }
  } finally {
    fs.closeSync(fd)
  }
  return file
}
