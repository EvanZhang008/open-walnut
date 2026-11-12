#!/usr/bin/env bun
/**
 * Proof videos: turn a Playwright .webm into a crisp MP4, and check that an MP4 is one.
 *
 *   bun scripts/proof-video.mjs encode <file.webm | dir>...   MP4 next to each .webm
 *   bun scripts/proof-video.mjs check  <file.mp4 | dir>...    exit 1 if any MP4 is too small or too soft
 *
 * Why a second encode: Playwright's recorder writes VP8 at realtime speed with a 1 Mbit/s cap
 * (playwright-core lib/server/videoRecorder.js), and a WebM does not play everywhere a person
 * opens a proof clip. The MP4 is H.264 at CRF 18, yuv420p, with its index up front
 * (+faststart), so it plays in a browser, in Slack and on a phone as soon as it loads. The
 * frames come in at the size the context records (tests/e2e/browser/pw-video.ts sizes them to
 * the engine's frames), and nothing here scales them.
 *
 * The check fails a clip whose long side is under 1280 px (Playwright's default recording is
 * 800x450, 2026-11-12, and blurs every word on screen), and one encoded too coarsely: an x264
 * clip must be a CRF encode at CRF 20 or finer, read from the settings x264 writes into the
 * stream; a clip from another encoder must carry 1 Mbit/s at least. Bitrate alone is no
 * measure of a screen recording: a sharp 2560x1440 CRF 18 clip of a page that mostly sits
 * still runs at 100 to 400 kbit/s (measured 2026-11-12), so a floor on it fails good clips.
 * It needs ffprobe on PATH.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MIN_LONG_SIDE = 1280
export const MIN_BITRATE = 1_000_000
export const MAX_CRF = 20

/** H.264 at CRF 18: the encode every proof MP4 gets. */
export function encodeArgs(input, output) {
  return ['-y', '-loglevel', 'error', '-i', input, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]
}

export function mp4PathFor(webm) {
  return webm.replace(/\.webm$/i, '') + '.mp4'
}

/** Whether a tool runs here (ffmpeg, ffprobe). */
export function hasTool(name, run = spawnSync) {
  const r = run(name, ['-version'], { stdio: 'ignore' })
  return !r.error && r.status === 0
}

/** Encode one .webm to the MP4 beside it; returns the MP4's path. Throws with ffmpeg's error. */
export function encodeMp4(webm, { run = spawnSync, ffmpeg = 'ffmpeg' } = {}) {
  const out = mp4PathFor(webm)
  const r = run(ffmpeg, encodeArgs(webm, out), { encoding: 'utf8' })
  if (r.error) throw new Error(`${ffmpeg}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${ffmpeg} failed on ${webm}: ${(r.stderr || '').trim().slice(-400)}`)
  return out
}

/** Width, height, fps, bitrate (bit/s), codec and duration from ffprobe's JSON. */
export function parseProbe(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json
  const v = (data.streams ?? []).find((s) => s.codec_type === 'video')
  if (!v) return null
  const [num, den] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number)
  const duration = Number(data.format?.duration ?? v.duration ?? 0)
  let bitrate = Number(data.format?.bit_rate ?? v.bit_rate ?? 0)
  const size = Number(data.format?.size ?? 0)
  if (!bitrate && size && duration) bitrate = Math.round((size * 8) / duration)
  return { width: Number(v.width), height: Number(v.height), fps: den ? num / den : 0, bitrate, codec: v.codec_name, duration }
}

export function probeVideo(file, { run = spawnSync, ffprobe = 'ffprobe' } = {}) {
  const r = run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' })
  if (r.error) throw new Error(`${ffprobe}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${ffprobe} failed on ${file}: ${(r.stderr || '').trim().slice(-400)}`)
  return parseProbe(r.stdout)
}

/**
 * The rate control x264 wrote into the stream ("x264 - core 164 ... rc=crf ... crf=18.0"), from
 * the head of the file (with +faststart the index comes first, then the first frame's SEI).
 * Null for a clip x264 did not encode.
 */
export function parseX264Settings(text) {
  const at = text.indexOf('x264 - core ')
  if (at < 0) return null
  const head = text.slice(at, at + 4096)
  const rc = /\brc=(\w+)/.exec(head)?.[1] ?? null
  const crf = /\bcrf=([\d.]+)/.exec(head)
  return { rc, crf: crf ? Number(crf[1]) : null }
}

export function readX264Settings(file, bytes = 8 << 20) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size))
    fs.readSync(fd, buf, 0, buf.length, 0)
    return parseX264Settings(buf.toString('latin1'))
  } finally {
    fs.closeSync(fd)
  }
}

/** The problems of one probed clip; an empty list is a pass. `x264` is readX264Settings's answer. */
export function judgeVideo(info, x264 = null, { minLongSide = MIN_LONG_SIDE, minBitrate = MIN_BITRATE, maxCrf = MAX_CRF } = {}) {
  if (!info) return ['no video stream']
  const problems = []
  const long = Math.max(info.width, info.height)
  if (!(long >= minLongSide)) problems.push(`${info.width}x${info.height}: the long side is under ${minLongSide} px`)
  if (x264) {
    if (x264.rc !== 'crf' || x264.crf === null) problems.push(`x264 rate control ${x264.rc ?? 'unknown'}: not a CRF encode`)
    else if (x264.crf > maxCrf) problems.push(`x264 CRF ${x264.crf}: coarser than CRF ${maxCrf}`)
  } else if (!(info.bitrate >= minBitrate)) {
    problems.push(`${Math.round(info.bitrate / 1000)} kbit/s from an encoder other than x264: under ${Math.round(minBitrate / 1000)} kbit/s`)
  }
  return problems
}

export function describe(info, x264 = null) {
  const crf = x264?.crf != null ? ` crf ${x264.crf}` : ''
  return `${info.width}x${info.height} ${info.codec}${crf} ${Math.round(info.fps * 100) / 100} fps ${Math.round(info.bitrate / 1000)} kbit/s ${info.duration.toFixed(1)} s`
}

/** Files with one of `exts` under each path (a file is taken as it is). */
export function collect(paths, exts) {
  const out = []
  const walk = (p) => {
    const st = fs.statSync(p)
    if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e))
    else if (exts.some((x) => p.toLowerCase().endsWith(x))) out.push(p)
  }
  for (const p of paths) walk(p)
  return out
}

function main(argv) {
  const [cmd, ...paths] = argv
  if (!['encode', 'check'].includes(cmd) || !paths.length) {
    console.error('usage: bun scripts/proof-video.mjs encode|check <file | dir>...')
    return 2
  }
  if (cmd === 'encode') {
    if (!hasTool('ffmpeg')) { console.error('proof-video: no ffmpeg on PATH, so no MP4'); return 1 }
    let failed = 0
    for (const webm of collect(paths, ['.webm'])) {
      try { console.log(encodeMp4(webm)) } catch (e) { failed += 1; console.error(e.message) }
    }
    return failed ? 1 : 0
  }
  if (!hasTool('ffprobe')) { console.error('proof-video: no ffprobe on PATH, so nothing was checked'); return 1 }
  const files = collect(paths, ['.mp4'])
  if (!files.length) { console.error(`proof-video: no .mp4 under ${paths.join(' ')}`); return 1 }
  let bad = 0
  for (const f of files) {
    const info = probeVideo(f)
    const x264 = readX264Settings(f)
    const problems = judgeVideo(info, x264)
    if (problems.length) bad += 1
    console.log(`${problems.length ? 'LOW ' : 'ok  '} ${f}: ${info ? describe(info, x264) : 'no video'}${problems.length ? ` (${problems.join('; ')})` : ''}`)
  }
  return bad ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2))
