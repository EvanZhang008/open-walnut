/**
 * Project detail pane — the `Tracking` section (S14 acceptance 6, 8, 9).
 *
 * What only a browser can answer, and therefore what this file exists for:
 *   - the note really RENDERS as markdown in the pane (a Status paragraph, a
 *     Workstreams table), through the vault's own renderer;
 *   - `[[task:ab12cd34]]` stays PLAIN TEXT — the pinned choice. The note renderer
 *     has no task-ref extension, and adding one only in this pane would make
 *     Walnut and Obsidian disagree about the same bytes;
 *   - hostile note content is INERT: a `<script>`, an `onerror` image and a
 *     `javascript:` link all run nothing (the notePurify policy in markdown.ts);
 *   - `Open in Notes` navigates to the note;
 *   - the three states: note present / key set but note deleted / no key at all.
 *
 * RUN IT IN BOTH ENGINES. The Mac app is a WKWebView, so acceptance 9 is only met
 * when this file has passed under chromium AND webkit:
 *     npx playwright test tests/e2e/browser/project-tracking.spec.ts
 *     PW_WEBKIT=1 npx playwright test --project=webkit tests/e2e/browser/project-tracking.spec.ts
 * There is deliberately NO `test.use({ browserName: 'webkit' })` here — that pin
 * only holds at a spec file's top level and would force every run to WebKit.
 *
 * Seeding goes through the REAL APIs (the project registry, the notes vault, the
 * metadata merge), because the thing under test is exactly that chain:
 * metadata.tracking_note → fetchNoteContent → renderNoteMarkdown → the pane.
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const API = 'http://localhost:3457'

/**
 * A tracking note that has been FILLED IN (a real workstream row), plus content
 * no sanitizer may let through. Deliberately not the fresh skeleton: that one
 * asserts nothing about the project — its format examples live in HTML comments —
 * so it has no row to assert against. `<!-- format example -->` is here too, to
 * pin that a comment stays invisible in the pane the way it does in Obsidian.
 */
const HOSTILE_NOTE = `---
project: PLACEHOLDER
kind: project-tracking
updated: 2026-09-21T14:10Z
---

## Status

Waiting on the design review, then the migration window.

## Workstreams

| Item | State | Owner task | Last update | Source |
| --- | --- | --- | --- | --- |
| Design review | in progress | [[task:ab12cd34]] | Sep 21 | mail: RFC v3 from the platform list |

## Open questions

<!-- format example: - Who owns the migration window? (raised in mail, Sep 20) -->

<script>window.__trackingPwned = 'script'</script>
<img src="x" onerror="window.__trackingPwned = 'onerror'">

- [Click me](javascript:window.__trackingPwned = 'href')

## Log

- 2026-09-21 14:10 triage: RFC v3 arrived (mail)
`

/** Create the project row, write its note, and point the registry at it. */
async function seedTrackedProject(
  request: APIRequestContext,
  project: string,
  body: string,
): Promise<string> {
  const notePath = `Projects/${project}/Tracking.md`
  // A task is what makes the project row exist AND puts the group in the panel.
  const task = await request.post(`${API}/api/tasks`, { data: { title: `${project} seed task`, project } })
  expect(task.ok()).toBeTruthy()
  // PUT creates a note in notes-v2 (there is no POST create).
  const note = await request.put(`${API}/api/notes-v2/content/${notePath}`, {
    data: { content: body.replace('PLACEHOLDER', project) },
  })
  expect(note.ok()).toBeTruthy()
  const meta = await request.put(`${API}/api/projects/${project}/metadata`, {
    data: { tracking_note: notePath },
  })
  expect(meta.ok()).toBeTruthy()
  return notePath
}

/** Open the project's detail pane from the TodoPanel group header. */
async function openProjectPane(page: import('@playwright/test').Page, project: string) {
  const projBtn = page.locator('.todo-group-name-btn', { hasText: project }).first()
  await projBtn.waitFor({ state: 'visible', timeout: 15_000 })
  await projBtn.click()
  const pane = page.locator('.project-detail-pane')
  await expect(pane).toBeVisible({ timeout: 10_000 })
  return pane
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await showEverything(page)
})

test('the tracking note renders in the pane, and its markup is inert', async ({ page, request }) => {
  const project = 'TrackedProj'
  await seedTrackedProject(request, project, HOSTILE_NOTE)

  await page.reload()
  await showEverything(page)
  const pane = await openProjectPane(page, project)

  const section = pane.locator('.project-tracking-section')
  await expect(section).toBeVisible({ timeout: 10_000 })
  await expect(section).toContainText('Tracking')

  // Rendered markdown, not a raw dump: the Status prose and a real table.
  const body = section.locator('.project-tracking-note')
  await expect(body).toBeVisible()
  await expect(body).toContainText('Waiting on the design review')
  await expect(body.locator('table')).toBeVisible()
  await expect(body.locator('th', { hasText: 'Owner task' })).toBeVisible()
  await expect(body.locator('td', { hasText: 'Design review' })).toBeVisible()

  // PINNED: a task ref is plain text. No link, no chip, no invented markup.
  await expect(body).toContainText('[[task:ab12cd34]]')
  expect(await body.locator('a[href*="ab12cd34"]').count()).toBe(0)

  // A markdown comment is invisible here exactly as it is in Obsidian — this is
  // what lets a fresh skeleton carry its format examples without stating them.
  await expect(body).not.toContainText('format example')
  await expect(body).not.toContainText('<!--')

  // Frontmatter is metadata: it must not render. Its closing `---` is a setext
  // underline, so an unsplit note printed `project: … kind: …` as a heading.
  await expect(body).not.toContainText('kind: project-tracking')
  expect(await body.locator('h2', { hasText: 'project:' }).count()).toBe(0)

  // Nothing in the note executed, and nothing dangerous survived sanitizing.
  expect(await page.evaluate(() => (window as unknown as { __trackingPwned?: string }).__trackingPwned)).toBeUndefined()
  expect(await body.locator('script').count()).toBe(0)
  expect(await body.locator('[onerror]').count()).toBe(0)
  for (const href of await body.locator('a').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))) {
    expect(href.toLowerCase().startsWith('javascript:')).toBe(false)
  }
  // An <img> may survive as an element; what must not survive is its handler.
  expect(await body.locator('img[onerror]').count()).toBe(0)
})

test('Open in Notes navigates to the note', async ({ page, request }) => {
  const project = 'TrackedNavProj'
  const notePath = await seedTrackedProject(request, project, HOSTILE_NOTE)

  await page.reload()
  await showEverything(page)
  const pane = await openProjectPane(page, project)

  // A real click, not a goto: this is the SPA route the human takes.
  await pane.locator('.project-tracking-open').click()
  await expect(page).toHaveURL(new RegExp(`/notes\\?path=${encodeURIComponent(encodeURIComponent(notePath))}`))
  // The Notes page opened THAT note, not just the page.
  await expect(page.locator('.notes-page, .notes-layout').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Waiting on the design review').first()).toBeVisible({ timeout: 15_000 })
})

test('a project with no tracking_note has no Tracking section at all', async ({ page, request }) => {
  const project = 'UntrackedProj'
  const task = await request.post(`${API}/api/tasks`, { data: { title: 'Untracked seed task', project } })
  expect(task.ok()).toBeTruthy()

  await page.reload()
  await showEverything(page)
  const pane = await openProjectPane(page, project)

  // The other sections are there, so this is a real pane — the Tracking one is
  // absent, not empty. An empty box would advertise a feature nobody asked for.
  await expect(pane).toContainText('About')
  expect(await pane.locator('.project-tracking-section').count()).toBe(0)
})

test('a key pointing at a deleted note says so and offers nothing broken', async ({ page, request }) => {
  const project = 'TrackedGoneProj'
  const notePath = await seedTrackedProject(request, project, HOSTILE_NOTE)
  const del = await request.delete(`${API}/api/notes-v2/content/${notePath}`)
  expect(del.ok()).toBeTruthy()

  await page.reload()
  await showEverything(page)
  const pane = await openProjectPane(page, project)

  const section = pane.locator('.project-tracking-section')
  await expect(section).toBeVisible({ timeout: 10_000 })
  await expect(section).toContainText('not in the vault any more')
  await expect(section).toContainText(notePath)
  // No button that would land the human on a note that is not there.
  expect(await section.locator('.project-tracking-open').count()).toBe(0)
})
