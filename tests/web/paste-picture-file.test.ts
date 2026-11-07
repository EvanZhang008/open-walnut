/**
 * A pasted picture is read from the paste's `files`. macOS WebKit hands a
 * pasted PNG there while its `items` entry gave no file, so the notes editor,
 * which read `items` alone, swallowed the paste and inserted nothing
 * (2026-11-07 review, round 7).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { imageFileOf } from '../../web/src/components/notes/image-insert'

const png = () => new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })

function transfer(files: File[], items: Array<{ kind: string; type: string; file: File | null }>): DataTransfer {
  return {
    files: files as unknown as FileList,
    items: items.map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file })) as unknown as DataTransferItemList,
  } as DataTransfer
}

describe('imageFileOf', () => {
  it('takes the picture from files when its items entry gives no file (macOS WebKit)', () => {
    const file = png()
    expect(imageFileOf(transfer([file], [{ kind: 'file', type: 'image/png', file: null }]))).toBe(file)
  })

  it('falls back to an items file when files is empty', () => {
    const file = png()
    expect(imageFileOf(transfer([], [{ kind: 'file', type: 'image/png', file }]))).toBe(file)
  })

  it('finds no picture in a text paste, so the editor handles it', () => {
    expect(imageFileOf(transfer([], [{ kind: 'string', type: 'text/plain', file: null }]))).toBeNull()
    expect(imageFileOf(transfer([], [{ kind: 'file', type: 'image/png', file: null }]))).toBeNull()
    expect(imageFileOf(null)).toBeNull()
  })
})

describe('every paste reads pictures from files', () => {
  it('no web code takes a pasted picture from clipboardData.items', () => {
    const root = path.join(__dirname, '../../web/src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const code = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
          if (/clipboardData\??\.items/.test(code)) offenders.push(path.relative(root, p))
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
