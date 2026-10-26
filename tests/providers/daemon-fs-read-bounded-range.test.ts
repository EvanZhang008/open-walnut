import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

/** Execute the actual guarded handlers from both twins, without booting a daemon. */
function handler(twin: 'standalone' | 'source', home: string, fsImpl = fs) {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, `../../src/providers/daemon-${twin}.ts`), 'utf8')
  const start = source.indexOf(twin === 'standalone' ? 'const FS_READ_BOUNDED_MAX_BYTES' : 'var FS_READ_BOUNDED_MAX_BYTES')
  const end = source.indexOf('// Bridge-safe image save:', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const context = vm.createContext({ fs: fsImpl, path, crypto, Buffer, HOME_DIR: home,
    sendOk: (out: Record<string, unknown>, _id: number, fields: Record<string, unknown>) => Object.assign(out, { ok: true, ...fields }),
    sendError: (out: Record<string, unknown>, _id: number, error: string) => Object.assign(out, { ok: false, error }),
  })
  return vm.runInContext(`${js}\n(async (cmd) => { const out = {}; await cmdFsReadBounded(out, 1, cmd); return out; })`, context) as
    (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>
}

let home: string
beforeEach(async () => { home = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-bounded-range-')) })
afterEach(async () => { await fsp.rm(home, { recursive: true, force: true }) })

for (const twin of ['standalone', 'source'] as const) {
  describe(`${twin} guarded fs.readBounded ranges`, () => {
    it('probes and reads large files in bounded chunks while legacy whole reads still cap at 2 MB', async () => {
      const call = handler(twin, home)
      const file = path.join(home, 'bytes.mp4')
      // Byte-contract data, not playable encoded media.
      const bytes = Buffer.alloc(3 * 1024 * 1024 + 17)
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
      await fsp.writeFile(file, bytes)
      const probe = await call({ path: file, range: true, offset: 0, length: 0 })
      expect(probe).toMatchObject({ ok: true, data: '', size: bytes.length, offset: 0, encoding: 'base64' })
      expect(typeof probe.version).toBe('string')
      expect(typeof probe.mtimeMs).toBe('number')
      const chunks: Buffer[] = []
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        const reply = await call({ path: file, range: true, offset, length: 1024 * 1024, expectedVersion: probe.version })
        expect(reply).toMatchObject({ ok: true, offset, size: bytes.length, version: probe.version })
        const chunk = Buffer.from(reply.data as string, 'base64')
        expect(chunk.length).toBeLessThanOrEqual(1024 * 1024)
        chunks.push(chunk)
      }
      // toEqual walks a 3 MB buffer one element at a time (over the quick tier's 15 s under
      // bun): compare the bytes natively, and say where they differ when they do.
      const joined = Buffer.concat(chunks)
      expect(joined.length).toBe(bytes.length)
      if (!joined.equals(bytes)) expect.fail(`the chunks differ from the file at byte ${joined.findIndex((b, i) => b !== bytes[i])}`)
      const legacy = await call({ path: file })
      expect(legacy.ok).toBe(false)
      expect(legacy.error).toContain('(EFBIG)')
      const small = path.join(home, 'small.txt')
      await fsp.writeFile(small, 'small whole file')
      const whole = await call({ path: small })
      expect(Buffer.from(whole.data as string, 'base64').toString()).toBe('small whole file')
      expect(whole.offset).toBeUndefined()
    })

    it('rejects invalid offsets/lengths without widening a bridge frame', async () => {
      const call = handler(twin, home)
      const file = path.join(home, 'file.txt')
      await fsp.writeFile(file, 'hello')
      for (const [offset, length] of [[-1, 1], [0, -1], [0, 1024 * 1024 + 1], [0.5, 1], [0, NaN], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
        const reply = await call({ path: file, range: true, offset, length })
        expect(reply.ok).toBe(false)
        expect(reply.error).toContain('(EINVAL)')
      }
      expect(await call({ path: file, range: true, offset: 9, length: 1 })).toMatchObject({ ok: true, data: '', offset: 9, size: 5 })
    })

    it('applies realpath secret denial and regular-file guards even on metadata probes', async () => {
      const call = handler(twin, home)
      await fsp.mkdir(path.join(home, '.ssh'))
      const secret = path.join(home, '.ssh', 'secret.mp4')
      await fsp.writeFile(secret, 'private fixture')
      const link = path.join(home, 'innocent.mp4')
      await fsp.symlink(secret, link)
      for (const file of [secret, link]) {
        for (const length of [0, 1]) {
          const reply = await call({ path: file, range: true, offset: 0, length })
          expect(reply.ok).toBe(false)
          expect(reply.error).toContain('(EDENIED)')
        }
      }
      const directory = await call({ path: home, range: true, offset: 0, length: 0 })
      expect(directory.error).toContain('(ENOTFILE)')
      expect((await call({ path: home + '/../escape.mp4', range: true, offset: 0, length: 0 })).error).toContain('(EDENIED)')
      expect((await call({ path: 'relative.mp4', range: true, offset: 0, length: 0 })).error).toContain('(EDENIED)')
    })

    it('refuses consecutive secret-directory segments outside HOME without rejecting similar or separated segments', async () => {
      const fakeHome = path.join(home, 'user-home')
      await fsp.mkdir(fakeHome)
      const call = handler(twin, fakeHome)
      const denied = path.join(home, 'backup', '.config', 'walnut-secrets', 'bytes.mp4')
      const safe = [
        path.join(home, 'backup', '.config', 'walnut-secrets-copy', 'bytes.mp4'),
        path.join(home, 'backup', '.config', 'ordinary', 'walnut-secrets', 'bytes.mp4'),
      ]
      for (const file of [denied, ...safe]) {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        await fsp.writeFile(file, 'byte fixture')
      }
      const link = path.join(home, 'linked.mp4')
      await fsp.symlink(denied, link)
      for (const file of [denied, link]) {
        const reply = await call({ path: file, range: true, offset: 0, length: 0 })
        expect(reply.ok).toBe(false)
        expect(reply.error).toContain('(EDENIED)')
      }
      for (const file of safe) {
        expect(await call({ path: file, range: true, offset: 0, length: 0 })).toMatchObject({ ok: true, data: '' })
      }
    })

    it('detects replacement/truncation and a file changing during a chunk', async () => {
      const file = path.join(home, 'bytes.mp4')
      await fsp.writeFile(file, 'before')
      const call = handler(twin, home)
      const probe = await call({ path: file, range: true, offset: 0, length: 0 })
      await fsp.writeFile(file, 'new')
      expect((await call({ path: file, range: true, offset: 0, length: 1, expectedVersion: probe.version })).error).toContain('(ESTALE)')
      const fsImpl = { ...fs, promises: { ...fsp, open: async (...args: Parameters<typeof fsp.open>) => {
        const fh = await fsp.open(...args)
        return { stat: () => fh.stat(), close: () => fh.close(), read: async (...readArgs: Parameters<typeof fh.read>) => {
          const result = await fh.read(...readArgs)
          await fsp.writeFile(file, 'changed while reading')
          return result
        } }
      } } } as unknown as typeof fs
      const mutate = handler(twin, home, fsImpl)
      expect((await mutate({ path: file, range: true, offset: 0, length: 1 })).error).toContain('(ESTALE)')
    })

    it('loops through legitimate short OS reads to return an exact chunk', async () => {
      const file = path.join(home, 'bytes.mp4')
      await fsp.writeFile(file, 'abcdefgh')
      const fsImpl = { ...fs, promises: { ...fsp, open: async (...args: Parameters<typeof fsp.open>) => {
        const fh = await fsp.open(...args)
        return { stat: () => fh.stat(), close: () => fh.close(),
          read: (buffer: Buffer, offset: number, length: number, position: number) => fh.read(buffer, offset, Math.min(length, 2), position) }
      } } } as unknown as typeof fs
      const reply = await handler(twin, home, fsImpl)({ path: file, range: true, offset: 1, length: 6 })
      expect(reply.ok).toBe(true)
      expect(Buffer.from(reply.data as string, 'base64').toString()).toBe('bcdefg')
    })
  })
}
