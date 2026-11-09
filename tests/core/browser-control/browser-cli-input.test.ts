/**
 * `walnut browser` for the input agents got from the old relay (core/browser-control/browser-cli.ts):
 * drag, a scroll inside a box, a click by its words, type at a point and slowly, an annotated
 * screenshot and its labels, zoom, each frame's text, and reading a page dialog.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBrowserArgv, runBrowser } from '../../../src/core/browser-control/browser-cli'

describe('parsing the new forms', () => {
  it('drag: each end a ref or X,Y', () => {
    expect(parseBrowserArgv(['drag', 'e3', 'e9'])).toMatchObject({ ok: true, args: { action: 'drag', ref: 'e3', to_ref: 'e9' } })
    expect(parseBrowserArgv(['drag', '100,200', '300.5,240', '--steps', '20'])).toMatchObject({ args: { action: 'drag', x: 100, y: 200, to_x: 300.5, to_y: 240, steps: 20 } })
    expect(parseBrowserArgv(['drag', 'e3', '40,50'])).toMatchObject({ args: { ref: 'e3', to_x: 40, to_y: 50 } })
    expect(parseBrowserArgv(['drag', 'e3'])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['drag', 'here', 'there'])).toMatchObject({ ok: false })
  })

  it('scroll: a direction and a ref in either order, or a point', () => {
    expect(parseBrowserArgv(['scroll', 'e9', 'down', '--by', '300'])).toMatchObject({ args: { action: 'scroll', ref: 'e9', direction: 'down', by: 300 } })
    expect(parseBrowserArgv(['scroll', 'up', 'f2:e4'])).toMatchObject({ args: { action: 'scroll', ref: 'f2:e4', direction: 'up' } })
    expect(parseBrowserArgv(['scroll', 'down', '--at', '600,400', '--trusted'])).toMatchObject({ args: { action: 'scroll', direction: 'down', x: 600, y: 400, trusted: true } })
    // A ref alone still brings it into view.
    const alone = parseBrowserArgv(['scroll', 'e9'])
    expect(alone).toMatchObject({ args: { action: 'scroll', ref: 'e9' } })
    expect(alone.ok && alone.args.direction).toBe(undefined)
  })

  it('click and hover by their words; click-label by its number', () => {
    expect(parseBrowserArgv(['click', '--text', 'Sign in'])).toMatchObject({ ok: true, args: { action: 'click', text: 'Sign in' } })
    expect(parseBrowserArgv(['hover', '--text', 'Account'])).toMatchObject({ args: { action: 'hover', text: 'Account' } })
    const p = parseBrowserArgv(['click', 'e4'])
    expect(p.ok && 'dialogText' in p.args).toBe(false)
    expect(parseBrowserArgv(['click-label', '7', '--trusted'])).toMatchObject({ args: { action: 'click_label', label: 7, trusted: true } })
    expect(parseBrowserArgv(['click_label', '3'])).toMatchObject({ args: { action: 'click_label', label: 3 } })
    expect(parseBrowserArgv(['click-label', 'seven'])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['click-label', '0'])).toMatchObject({ ok: false })
  })

  it('type at a point, and slowly', () => {
    expect(parseBrowserArgv(['type', '--at', '320,180', 'hello', 'there'])).toMatchObject({ args: { action: 'type', x: 320, y: 180, text: 'hello there' } })
    expect(parseBrowserArgv(['type', 'e2', '123456', '--slowly', '--trusted'])).toMatchObject({ args: { action: 'type', ref: 'e2', text: '123456', slowly: true, trusted: true } })
  })

  it('screenshot --annotate, zoom X Y W H [file] (or X,Y,W,H), text --all-frames', () => {
    expect(parseBrowserArgv(['screenshot', '--annotate', 'a.png'])).toMatchObject({ args: { action: 'screenshot', annotate: true, inline: true, format: 'png' }, file: 'a.png' })
    expect(parseBrowserArgv(['zoom', '40', '120', '300', '200', 'part.png'])).toMatchObject({ args: { action: 'zoom', x: 40, y: 120, width: 300, height: 200, inline: true, format: 'png' }, file: 'part.png' })
    expect(parseBrowserArgv(['zoom', '0,0,64.5,32'])).toMatchObject({ args: { action: 'zoom', x: 0, y: 0, width: 64.5, height: 32 } })
    expect(parseBrowserArgv(['zoom', '0,0,64,32', 'z.jpg'])).toMatchObject({ file: 'z.jpg' })
    expect(parseBrowserArgv(['zoom', '1', '2', '3'])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['zoom', 'a', 'b', 'c', 'd'])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['text', '--all-frames'])).toMatchObject({ args: { action: 'text', all_frames: true } })
  })

  it('dialog: read, accept with a prompt\'s text', () => {
    expect(parseBrowserArgv(['dialog', 'read'])).toMatchObject({ args: { action: 'dialog', read: true } })
    const a = parseBrowserArgv(['dialog', 'accept', '--text', 'Ana'])
    expect(a).toMatchObject({ args: { action: 'dialog', accept: true, text: 'Ana' } })
    expect(a.ok && a.args.read).toBe(undefined)
  })
})

describe('what the shell prints', () => {
  const run = async (argv: string[], result: Record<string, unknown>, cwd = os.tmpdir()) => {
    const p = parseBrowserArgv(argv)
    if (!p.ok) throw new Error(p.error)
    let out = ''
    const code = await runBrowser(p, { call: async () => ({ ok: true, result }), say: () => undefined, out: (t) => { out += t }, cwd })
    return { code, out }
  }
  const image = (mime: string) => `data:image/${mime};base64,${Buffer.from([7, 8, 9]).toString('base64')}`

  it('an annotated screenshot: the file, then each number with its ref, role and name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ann-'))
    const { code, out } = await run(['screenshot', '--annotate', 'a.png'], {
      image: image('png'), annotated: true, labels: [{ label: 1, ref: 'e4', role: 'link', name: 'Home' }, { label: 2, ref: 'e9', role: 'button', name: 'Add to cart' }],
    }, dir)
    expect(code).toBe(0)
    expect(out.split('\n')).toEqual([path.join(dir, 'a.png'), '1  [e4] link "Home"', '2  [e9] button "Add to cart"', ''])
    expect(fs.existsSync(path.join(dir, 'a.png'))).toBe(true)
  })

  it('a zoom is saved as a file, as a screenshot is', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-zoom-'))
    const { code, out } = await run(['zoom', '0', '0', '100', '50', 'z.png'], { image: image('png'), zoom: { x: 0, y: 0, width: 100, height: 50 }, pixels: { width: 200, height: 100 } }, dir)
    expect(code).toBe(0)
    expect(out.trim()).toBe(path.join(dir, 'z.png'))
    expect([...fs.readFileSync(path.join(dir, 'z.png'))]).toEqual([7, 8, 9])
  })

  it('a dialog read prints its kind and message; none open prints why', async () => {
    expect((await run(['dialog'], { open: true, dialog: { type: 'prompt', message: 'New name?', default_prompt: 'Untitled' } })).out).toBe('prompt: New name?\n(prompt box holds: Untitled)\n')
    expect((await run(['dialog'], { open: false, note: 'No dialog Walnut saw open on this tab.' })).out).toBe('No dialog Walnut saw open on this tab.\n')
  })

  it('a step that opened a dialog says so, and how to answer it', async () => {
    const { out } = await run(['click', 'e8', '--trusted'], { clicked: 'button "Rename"', dialog: { type: 'confirm', message: 'Delete it?' }, tab: 7 })
    expect(out).toContain('it opened a confirm: Delete it?')
    expect(out).toContain('dialog accept')
  })
})
