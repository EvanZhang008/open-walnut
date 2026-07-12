import { describe, it, expect, beforeAll } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { resolveAttachmentPath } from '../../src/web/routes/notes-attachment.js'
import { NOTES_DIR } from '../../src/constants.js'

// Build a fixture under the (test-overridden) NOTES_DIR mirroring the 3 real
// Obsidian embed forms: a bare name in an _attachment folder, a vault-relative
// path, and (implicitly) the legacy Notion/ prefix that must be stripped.
beforeAll(async () => {
  const att = path.join(NOTES_DIR, 'Areas', 'Travel', '_attachment')
  await fsp.mkdir(att, { recursive: true })
  await fsp.writeFile(path.join(att, 'Untitled.png'), 'x')
  await fsp.writeFile(path.join(att, '5C01F4A6.png'), 'x')
  const att2 = path.join(NOTES_DIR, 'Areas', 'Records', '_attachment')
  await fsp.mkdir(att2, { recursive: true })
  await fsp.writeFile(path.join(att2, 'Quarterly Report Draft.pdf'), 'x')
  // A loose (non-_attachment) file to prove _attachment is preferred.
  await fsp.writeFile(path.join(NOTES_DIR, 'loose.png'), 'x')
})

describe('resolveAttachmentPath', () => {
  it('bare name → resolves into _attachment', async () => {
    expect(await resolveAttachmentPath('5C01F4A6.png'))
      .toBe(path.join(NOTES_DIR, 'Areas', 'Travel', '_attachment', '5C01F4A6.png'))
  })
  it('bare PDF with spaces → resolves', async () => {
    expect(await resolveAttachmentPath('Quarterly Report Draft.pdf'))
      .toBe(path.join(NOTES_DIR, 'Areas', 'Records', '_attachment', 'Quarterly Report Draft.pdf'))
  })
  it('legacy Notion/-prefixed path → strips prefix, resolves vault-relative', async () => {
    expect(await resolveAttachmentPath('Notion/Areas/Travel/_attachment/Untitled.png'))
      .toBe(path.join(NOTES_DIR, 'Areas', 'Travel', '_attachment', 'Untitled.png'))
  })
  it('vault-relative path → resolves directly', async () => {
    expect(await resolveAttachmentPath('Areas/Travel/_attachment/Untitled.png'))
      .toBe(path.join(NOTES_DIR, 'Areas', 'Travel', '_attachment', 'Untitled.png'))
  })
  it('Notion/-prefixed bare-ish path that no longer exists falls back to basename search', async () => {
    // stale folder under Notion/ → vault-relative miss → basename search finds it
    expect(await resolveAttachmentPath('Notion/old/path/5C01F4A6.png'))
      .toBe(path.join(NOTES_DIR, 'Areas', 'Travel', '_attachment', '5C01F4A6.png'))
  })
  it('loose file (not in _attachment) still resolves by basename', async () => {
    expect(await resolveAttachmentPath('loose.png')).toBe(path.join(NOTES_DIR, 'loose.png'))
  })
  it('traversal escape → null', async () => {
    expect(await resolveAttachmentPath('../../etc/passwd')).toBeNull()
    expect(await resolveAttachmentPath('Areas/../../secret.png')).toBeNull()
  })
  it('nonexistent name → null', async () => {
    expect(await resolveAttachmentPath('does-not-exist-xyz.png')).toBeNull()
  })
})
