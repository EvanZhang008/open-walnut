/**
 * REGRESSION (real UI): editing a memory file must not destroy its YAML frontmatter.
 *
 * The memory page (`/memory`) edits a memory file in the SHARED WYSIWYG editor and
 * autosaves `editor.storage.markdown.getMarkdown()` over the WHOLE file on a 500 ms
 * debounce — so typing ONE character rewrites the file through tiptap-markdown.
 * Feeding it the raw bytes collapsed the frontmatter: markdown-it reads the closing
 * `---` as a setext-H2 underline, so `---\nname: …\ndescription: >\n…\n---` came
 * back as one `## name: … description: &gt; …` heading, and the serializer's
 * `escapeHTML` left the `>` as a literal `&gt;`.
 *
 * That is not cosmetic for MEMORY.md / USER.md: they are BOUNDED stores whose
 * `## Title` sections are injected into the Personal AI's system prompt every turn, so
 * the collapsed block became a FAKE entry — charged against the char budget and a
 * legal replace/remove target.
 *
 * Only the real editor can prove the fix, because the damage happens inside
 * ProseMirror/tiptap-markdown. So: drive the page as a user (SPA clicks, real
 * keystrokes), let the debounce fire, then read the file back over the API and
 * assert on the BYTES.
 *
 * Fixture: `memory/MEMORY.md` + `memory/USER.md` are seeded in test-server.ts in
 * their real shape (a `description: >` block scalar; a body containing an `<id>`
 * placeholder and a bare `>`).
 */
import { test, expect, type Page } from '@playwright/test'

const API = 'http://localhost:3457'

/** Read a bounded store's raw bytes straight off the server. */
async function readStore(which: 'global' | 'user'): Promise<string> {
  const res = await fetch(`${API}/api/memory/${which}`)
  expect(res.ok, `GET /api/memory/${which}`).toBe(true)
  const body = (await res.json()) as { memory: { content: string } }
  return body.memory.content
}

/** Everything a healthy bounded store must be true of, asserted on the bytes. */
function expectHealthyFrontmatter(content: string, name: string) {
  // A real fenced YAML block, not a collapsed heading.
  expect(content.startsWith('---\n'), `${name}: opens with a fence`).toBe(true)
  expect(/^---\n[\s\S]*?\n---\n/.test(content), `${name}: has a CLOSING fence`).toBe(true)
  // The block-scalar marker survived as YAML, not as an entity.
  expect(content, `${name}: keeps the block scalar`).toContain('description: >')
  expect(content, `${name}: no &gt; artifact`).not.toContain('&gt;')
  expect(content, `${name}: no &lt; artifact`).not.toContain('&lt;')
  // The collapsed-frontmatter fake-entry shape must not exist.
  expect(content, `${name}: no collapsed heading`).not.toMatch(/^## name:/m);
  // Exactly one fence pair — nothing duplicated by a re-attach.
  expect(
    content.split('\n').filter((l) => l.trim() === '---').length,
    `${name}: exactly 2 fence lines`,
  ).toBe(2)
}

/** Open /memory through the SPA and select a Global store by its tree label. */
async function openStore(page: Page, label: 'MEMORY.md' | 'USER.md') {
  // The memory page has no sidebar link; Settings → Memory is the real UI route in.
  await page.goto('/settings')
  await page.waitForLoadState('networkidle')
  const openBtn = page.locator('button', { hasText: 'Open Memory Browser' }).first()
  if (await openBtn.isVisible().catch(() => false)) {
    await openBtn.click()
  } else {
    // Fallback: the settings layout differs by viewport; go directly but still
    // exercise the same React page + data loading.
    await page.goto('/memory')
  }
  await page.waitForLoadState('networkidle')

  const tree = page.locator('.memory-tree-panel')
  await expect(tree).toBeVisible({ timeout: 15000 })
  const globalSection = tree.locator('.memory-tree-section', { hasText: 'Global' })
  await expect(globalSection).toBeVisible({ timeout: 10000 })
  const item = globalSection.locator('.memory-tree-item', { hasText: label })
  await expect(item).toBeVisible({ timeout: 10000 })
  await item.click()

  const editor = page.locator('.memory-detail-pane .notes-editor .tiptap')
  await expect(editor).toBeVisible({ timeout: 15000 })
  // The editor is seeded asynchronously; wait until the body actually rendered.
  await expect(editor).toContainText('#', { timeout: 10000 }).catch(() => {})
  return editor
}

test.describe('memory editor: frontmatter is not destroyed by an edit', () => {
  test('MEMORY.md — the frontmatter never reaches the editor surface', async ({ page }) => {
    const editor = await openStore(page, 'MEMORY.md')
    const visible = (await editor.textContent()) ?? ''
    // Body is editable; metadata is not shown (and so cannot be re-serialized).
    expect(visible).toContain('Release Checklist')
    expect(visible).not.toContain('name: Global Memory')
    expect(visible).not.toContain('description:')
  })

  test('MEMORY.md — typing one character keeps the frontmatter valid', async ({ page }) => {
    const before = await readStore('global')
    expectHealthyFrontmatter(before, 'MEMORY.md (before)')

    const editor = await openStore(page, 'MEMORY.md')
    // A real keystroke at the end of the doc — the exact user action that used to
    // rewrite the whole file through the serializer and collapse the YAML.
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('X')

    // Let the 500 ms debounce fire and the PUT land.
    await expect
      .poll(async () => (await readStore('global')).includes('X'), { timeout: 15000, intervals: [250] })
      .toBe(true)

    const after = await readStore('global')
    expectHealthyFrontmatter(after, 'MEMORY.md (after)')
    // Real entries are all still there, and no fake one was added.
    expect(after).toContain('## Release Checklist')
    expect(after).toContain('## Naming Rule')
    expect(after.split('\n').filter((l) => l.startsWith('## ')).length).toBe(2)
    // The frontmatter block is byte-identical to what was on disk before.
    const fence = (s: string) => /^---\n[\s\S]*?\n---\n/.exec(s)?.[0] ?? ''
    expect(fence(after)).toBe(fence(before))
  })

  test('MEMORY.md — the body prose the serializer used to mangle survives', async ({ page }) => {
    const editor = await openStore(page, 'MEMORY.md')
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('Y')
    await expect
      .poll(async () => (await readStore('global')).includes('Y'), { timeout: 15000, intervals: [250] })
      .toBe(true)

    const after = await readStore('global')
    // `<id>` used to be DELETED outright (unknown HTML element) and the bare `>`
    // used to come back as `&gt;`.
    expect(after, 'tag-shaped placeholder survives').toContain('"Import <id>"')
    expect(after, 'bare gt stays a gt').toContain('a > b')
    expect(after).not.toContain('&gt;')
  })

  test('USER.md — same store, same guarantee', async ({ page }) => {
    const before = await readStore('user')
    expectHealthyFrontmatter(before, 'USER.md (before)')

    const editor = await openStore(page, 'USER.md')
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('Z')
    await expect
      .poll(async () => (await readStore('user')).includes('Z'), { timeout: 15000, intervals: [250] })
      .toBe(true)

    const after = await readStore('user')
    expectHealthyFrontmatter(after, 'USER.md (after)')
    expect(after).toContain('## Identity')
    expect(after.split('\n').filter((l) => l.startsWith('## ')).length).toBe(1)
  })

  test('repeated edits do not accumulate damage', async ({ page }) => {
    const editor = await openStore(page, 'MEMORY.md')
    await editor.click()
    for (const ch of ['1', '2', '3']) {
      await page.keyboard.press('Control+End')
      await page.keyboard.type(ch)
      await expect
        .poll(async () => (await readStore('global')).includes(ch), { timeout: 15000, intervals: [250] })
        .toBe(true)
    }
    const after = await readStore('global')
    expectHealthyFrontmatter(after, 'MEMORY.md (after 3 edits)')
    // The cumulative form of the escaping bug was `&gt;` → `&amp;gt;`.
    expect(after).not.toContain('&amp;')
    expect(after.split('\n').filter((l) => l.startsWith('## ')).length).toBe(2)
  })
})
