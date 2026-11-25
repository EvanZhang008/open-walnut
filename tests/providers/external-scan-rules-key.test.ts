/**
 * The kept verdicts of the outside-session scan survive a land: the rules key reads a function's
 * source without the numbers a bundler adds to its names.
 *
 * 2026-11-25 on the Mac, after verdicts were first kept across restarts: every restart's first
 * scan still parsed 10,166 of 10,166 transcript heads. The production build names the scan's
 * helpers `fsp121`, `CHUNK_BYTES3`, `readChunk2`: numbers that move whenever another module of
 * the build adds or drops the same name, so each land made a new key and dropped the file.
 */
import { describe, it, expect } from 'vitest'
import { withoutBundlerSuffixes } from '../../src/providers/external-session-scan-core.js'

// As one production build printed walkHeadLines (shortened), and as the next one would.
const built = 'async function walkHeadLines(filePath,size,onEntry){let fh=null;try{fh=await fsp121.open(filePath,"r");let buf=Buffer.alloc(Math.min(CHUNK_BYTES3,size));return readChunk2(fh,buf)}catch{return!1}}'
const rebuilt = 'async function walkHeadLines(filePath,size,onEntry){let fh=null;try{fh=await fsp124.open(filePath,"r");let buf=Buffer.alloc(Math.min(CHUNK_BYTES4,size));return readChunk3(fh,buf)}catch{return!1}}'
const unbundled = 'async function walkHeadLines(filePath,size,onEntry){let fh=null;try{fh=await fsp.open(filePath,"r");let buf=Buffer.alloc(Math.min(CHUNK_BYTES,size));return readChunk(fh,buf)}catch{return!1}}'

describe('the rules key of kept scan verdicts', () => {
  it('is the same for two builds that only renamed what the bundler numbers', () => {
    expect(withoutBundlerSuffixes(built)).toBe(withoutBundlerSuffixes(rebuilt))
    expect(withoutBundlerSuffixes(built)).toBe(withoutBundlerSuffixes(unbundled))
  })

  it('still changes when the code reads a transcript another way', () => {
    const otherWay = rebuilt.replace('Math.min(CHUNK_BYTES4,size)', 'Math.max(CHUNK_BYTES4,size)')
    expect(withoutBundlerSuffixes(otherWay)).not.toBe(withoutBundlerSuffixes(built))
    // Numbers that stand alone are values, not names: they stay.
    expect(withoutBundlerSuffixes('x.slice(0, 12)')).toBe('x.slice(0, 12)')
  })
})
