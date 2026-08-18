/**
 * The PRIMARY's trust boundary for a relayed chat turn's images.
 *
 * A cloud replica stages a phone's pictures on this box through the daemon's
 * `image.save`, then names them by PATH in the `server.chat.turn` payload. Those
 * paths arrive over the network, so `adoptRelayedImagePaths` is the gate that
 * decides what the primary is willing to read and echo into chat history (from
 * where `GET /api/images/:filename` will happily serve it back). The rules it
 * must hold, each one a way a compromised or buggy replica could otherwise turn
 * a chat message into an arbitrary file read:
 *
 *  - only the daemon's fixed mobile staging directory, one flat filename;
 *  - no traversal, no symlink escape, no non-image extension;
 *  - ALL-OR-NOTHING: a short/partial set is a refusal, never a quietly
 *    shortened attachment list, because answering "what is this?" about a
 *    picture the model never saw is worse than an honest fallback.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-relayed-images'))

import { IMAGES_DIR, MOBILE_STAGED_IMAGES_DIR } from '../../../src/constants.js'
import { adoptRelayedImagePaths, isRelayedImageStagingPath, fitsImageSaveLimits } from '../../../src/web/routes/images.js'

/** 1×1 PNG. Real image bytes: sharp must accept them, magic bytes must match. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Write one file into the staging dir exactly as the daemon's image.save would. */
async function stageFile(name: string, base64 = TINY_PNG_BASE64): Promise<string> {
  await fs.mkdir(MOBILE_STAGED_IMAGES_DIR, { recursive: true })
  const p = path.join(MOBILE_STAGED_IMAGES_DIR, name)
  await fs.writeFile(p, Buffer.from(base64, 'base64'))
  return p
}

beforeEach(async () => {
  await fs.rm(MOBILE_STAGED_IMAGES_DIR, { recursive: true, force: true })
  await fs.rm(IMAGES_DIR, { recursive: true, force: true })
})

afterAll(async () => {
  await fs.rm(IMAGES_DIR, { recursive: true, force: true }).catch(() => {})
})

describe('the staging-path gate', () => {
  it('accepts what the daemon produces and nothing else', () => {
    expect(isRelayedImageStagingPath(path.join(MOBILE_STAGED_IMAGES_DIR, '1700000000-abcd1234.png'))).toBe(true)
    expect(isRelayedImageStagingPath(path.join(MOBILE_STAGED_IMAGES_DIR, 'x.jpg'))).toBe(true)

    // Traversal, a sibling dir, a nested dir, an absolute secret, a bare name,
    // a non-image extension, and non-strings are all refused. Each of these is a
    // file the primary must never read on a replica's word.
    for (const bad of [
      path.join(MOBILE_STAGED_IMAGES_DIR, '..', '..', '..', 'etc', 'passwd'),
      path.join(MOBILE_STAGED_IMAGES_DIR, 'sub', 'x.png'),
      path.join(IMAGES_DIR, 'x.png'),
      '/etc/passwd',
      '/Users/someone/.aws/credentials',
      path.join(MOBILE_STAGED_IMAGES_DIR, 'payload.sh'),
      path.join(MOBILE_STAGED_IMAGES_DIR, 'id_rsa'),
      'x.png',
      '',
      null,
      undefined,
      42,
      { filename: 'x.png' },
    ]) {
      expect(isRelayedImageStagingPath(bad as unknown)).toBe(false)
    }
  })

  it('refuses a traversal path even when the file really exists', async () => {
    // The traversal target is a REAL readable image, so only the gate stops it.
    await fs.mkdir(IMAGES_DIR, { recursive: true })
    const outside = path.join(IMAGES_DIR, 'outside.png')
    await fs.writeFile(outside, Buffer.from(TINY_PNG_BASE64, 'base64'))

    const traversal = path.join(MOBILE_STAGED_IMAGES_DIR, '..', 'outside.png')
    expect(await adoptRelayedImagePaths([traversal])).toBeNull()
  })

  it('refuses a symlink planted inside the staging dir (escape after the dirname check)', async () => {
    await fs.mkdir(IMAGES_DIR, { recursive: true })
    const secret = path.join(IMAGES_DIR, 'secret.png')
    await fs.writeFile(secret, Buffer.from(TINY_PNG_BASE64, 'base64'))
    await fs.mkdir(MOBILE_STAGED_IMAGES_DIR, { recursive: true })
    const link = path.join(MOBILE_STAGED_IMAGES_DIR, 'link.png')
    await fs.symlink(secret, link)

    // Passes the dirname check by construction — the realpath re-assertion is
    // the only thing standing between a replica and an arbitrary file read.
    expect(isRelayedImageStagingPath(link)).toBe(true)
    expect(await adoptRelayedImagePaths([link])).toBeNull()
  })
})

describe('adopting staged images into this box\'s own store', () => {
  it('re-saves each staged file under IMAGES_DIR and returns the ordinary turn shape', async () => {
    const a = await stageFile('1700000001-aaaa1111.png')
    const b = await stageFile('1700000002-bbbb2222.png')

    const adopted = await adoptRelayedImagePaths([a, b])
    expect(adopted).not.toBeNull()
    expect(adopted!.savedImages).toHaveLength(2)
    expect(adopted!.imageContentBlocks).toHaveLength(2)

    for (const saved of adopted!.savedImages) {
      // Landed in the primary's OWN image store, not left in the daemon's
      // staging dir: that is what makes GET /api/images/:filename serve it and
      // history hydration treat it like any locally-attached picture.
      expect(path.dirname(saved.filePath)).toBe(IMAGES_DIR)
      expect(saved.filename).toBe(path.basename(saved.filePath))
      await expect(fs.access(saved.filePath)).resolves.toBeUndefined()
    }
    // Model-facing blocks are real base64, the shape runAgentLoop consumes.
    const first = adopted!.imageContentBlocks[0]
    expect(first.type).toBe('image')
    expect(first.source.type).toBe('base64')
    expect(first.source.data.length).toBeGreaterThan(0)
  })

  it('still adopts when the staging dir is reached through a SYMLINKED root', async () => {
    // Production regression guard. The real staging dir lives under /tmp, and on
    // macOS /tmp is a symlink to /private/tmp — so realpath() of a staged file
    // yields a DIFFERENT prefix than the constant it is compared against. Getting
    // this wrong refuses every legitimate image and makes every phone image turn
    // degrade to the fallback loop with no error anywhere. Caught by this suite
    // on the first run, so it stays pinned.
    const real = await stageFile('1700000099-9999aaaa.png')
    const linkedDir = path.join(path.dirname(IMAGES_DIR), 'images-link')
    await fs.rm(linkedDir, { recursive: true, force: true }).catch(() => {})
    await fs.symlink(IMAGES_DIR, linkedDir)
    try {
      const viaLink = path.join(linkedDir, 'mobile', path.basename(real))
      // Not a staging-dir path by name, so the gate refuses it — the CALLER only
      // ever passes daemon-produced paths, and this asserts the gate is literal.
      expect(isRelayedImageStagingPath(viaLink)).toBe(false)
      // …while the canonical path still adopts, symlinked ancestors and all.
      expect(await adoptRelayedImagePaths([real])).not.toBeNull()
    } finally {
      await fs.rm(linkedDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('refuses the whole set when ONE staged file has vanished (reaped /tmp)', async () => {
    const present = await stageFile('1700000003-cccc3333.png')
    const missing = path.join(MOBILE_STAGED_IMAGES_DIR, '1700000004-dddd4444.png')

    expect(await adoptRelayedImagePaths([present, missing])).toBeNull()
  })

  it('refuses the whole set when ONE path fails the gate', async () => {
    const good = await stageFile('1700000005-eeee5555.png')
    expect(await adoptRelayedImagePaths([good, '/etc/hosts'])).toBeNull()
  })

  it('refuses an empty list and a list longer than one message may carry', async () => {
    expect(await adoptRelayedImagePaths([])).toBeNull()
    const many = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) => stageFile(`170000001${i}-ffff666${i}.png`)),
    )
    expect(await adoptRelayedImagePaths(many)).toBeNull()
  })
})

describe('the staging directory is the SAME dir on both sides of the bridge', () => {
  it('matches the daemon twins\' IMAGE_SAVE_DIR expression', async () => {
    // No compiler link exists between this server constant and the daemon's own
    // IMAGE_SAVE_DIR: the daemon is a separately-built binary. If either side is
    // moved, adoption silently refuses every relayed image (the dirname gate
    // rejects it) and every image turn quietly degrades to the fallback loop —
    // a regression that looks like "images just don't use the primary anymore".
    expect(MOBILE_STAGED_IMAGES_DIR).toBe(path.join(IMAGES_DIR, 'mobile'))

    const root = path.resolve(import.meta.dirname, '../../..')
    for (const twin of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
      const src = await fs.readFile(path.join(root, twin), 'utf-8')
      expect(src).toMatch(/IMAGE_SAVE_DIR = path\.join\(DAEMON_DIR, 'images', 'mobile'\)/)
    }
  })
})

describe('the image.save size gate the replica applies before the wire', () => {
  it('accepts an ordinary picture and refuses what the daemon would refuse', () => {
    expect(fitsImageSaveLimits(TINY_PNG_BASE64)).toBe(true)
    expect(fitsImageSaveLimits('')).toBe(false)
    // Past the daemon's base64 ceiling (14,000,000 chars).
    expect(fitsImageSaveLimits('A'.repeat(14_000_004))).toBe(false)
    // Under the base64 ceiling but over the 10 MiB DECODED cap (which starts at
    // ~13,981,014 base64 chars) — the check that actually binds for real photos,
    // and the one a length-only implementation would wave through.
    expect(fitsImageSaveLimits('A'.repeat(13_990_000))).toBe(false)
    expect(fitsImageSaveLimits('A'.repeat(13_000_000))).toBe(true)
  })
})
