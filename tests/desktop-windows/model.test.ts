/**
 * The Windows app's plain logic (desktop-windows/src/model.ts): what a pasted invite is, which
 * step a setup line belongs to, how setup ended, and what the app remembers about the PC.
 * The window itself runs on a real Windows PC in .github/workflows/windows-app.yml.
 */
import { describe, expect, it } from 'vitest'
import { endOf, externalUrl, inferMode, netSummary, originIs, originOf, parseInvite, psQuote, readState, stageOf } from '../../desktop-windows/src/model.js'
import { joinScriptWindows } from '../../src/core/net/net-join-ps1.js'
import { ticketWindowsCommand } from '../../src/core/net/join-ticket.js'

const LINK = 'https://wn.example.dev/join/ABCD-EFGH-JKLM'
const TICKET = 'wn1-eyJ2IjoxfQ_x-y'

describe('parseInvite', () => {
  it.each([
    ['the link', LINK, { link: LINK }],
    ['the link with spaces around it', `  ${LINK}\n`, { link: LINK }],
    ['the PowerShell line for a companion invite', `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm ${LINK}/windows | iex`, { link: LINK }],
    ['the shell line for a companion invite', `curl -fsSL ${LINK} | sh`, { link: LINK }],
    ['a ticket', TICKET, { ticket: TICKET }],
    ['the PowerShell line for a ticket', ticketWindowsCommand(TICKET), { ticket: TICKET }],
    ['a link on a port', 'https://192.0.2.7:8443/join/ABCD', { link: 'https://192.0.2.7:8443/join/ABCD' }],
  ])('reads %s', (_what, text, want) => {
    expect(parseInvite(text)).toEqual(want)
  })

  it.each([
    ['nothing', ''],
    ['a plain web page', 'https://example.com/'],
    ['an http link (a companion is https)', 'http://wn.example.dev/join/ABCD'],
    ['a ticket with nothing after its prefix', 'wn1-'],
    ['a huge paste', 'x'.repeat(5000) + LINK],
  ])('refuses %s', (_what, text) => {
    expect(parseInvite(text)).toBeNull()
  })

  it('never carries a quote or a command into what PowerShell gets', () => {
    expect(parseInvite(`${LINK}'; Remove-Item -Recurse C:\\`)).toEqual({ link: LINK })
    expect(parseInvite(`wn1-abc'; whoami`)).toEqual({ ticket: 'wn1-abc' })
  })

  it('names the Walnut a link came from', () => {
    expect(originOf({ link: LINK })).toBe('https://wn.example.dev')
    expect(originOf({ ticket: TICKET })).toBeUndefined()
  })
})

describe('stageOf', () => {
  it('maps every step line the setup script prints', () => {
    // The script's own Step lines, as Step formats them, and the Linux join's.
    expect(stageOf('  WSL ............... ready (2.3.26.0)')).toBe('wsl')
    expect(stageOf('  WSL ............... not on this PC: Windows asks you next to turn it on (an administrator prompt)')).toBe('wsl')
    expect(stageOf('  Linux ............. downloading Ubuntu 24.04 for WSL (about 350 MB)')).toBe('linux')
    expect(stageOf('  Linux ............. OpenWalnut ready (Ubuntu 24.04, user pc)')).toBe('linux')
    expect(stageOf('  Start with Windows  on (a sign-in item)')).toBe('start')
    expect(stageOf('  Walnut ............ installing')).toBe('walnut')
    expect(stageOf('  Walnut ............ running')).toBe('walnut')
    expect(stageOf('  1/3  Walnut ............ installed (walnut 0.6.24)')).toBe('walnut')
    expect(stageOf('  3/3  Joined .......... yes')).toBe('walnut')
  })

  it('leaves every other line alone', () => {
    for (const l of ['Walnut: setting Walnut up on this PC', '', 'The Ubuntu download failed: timeout. Try again.', 'Linux is ready', '    at line 3']) {
      expect(stageOf(l)).toBeNull()
    }
  })

  it('covers each Step label the script has', () => {
    const labels = [...joinScriptWindows({ ticket: true }).matchAll(/Step '([^']+)'/g)].map((m) => m[1])
    expect(new Set(labels)).toEqual(new Set(['WSL', 'Linux', 'Start menu', 'Start with Windows']))
    for (const label of labels) expect(stageOf('  ' + (label + ' ').padEnd(19, '.') + ' x')).not.toBeNull()
  })
})

describe('the rest', () => {
  it('reads how setup ended from its exit code', () => {
    expect(endOf(0)).toBe('done')
    expect(endOf(3)).toBe('restart')
    for (const c of [1, 6, 255, null]) expect(endOf(c)).toBe('failed')
  })

  it('reads only a state it wrote', () => {
    expect(readState('{"mode":"own","at":"2026-11-02T00:00:00Z"}')).toEqual({ mode: 'own', at: '2026-11-02T00:00:00Z' })
    expect(readState('{"mode":"join","origin":"https://wn.example.dev","at":"x"}')).toEqual({ mode: 'join', origin: 'https://wn.example.dev', at: 'x' })
    expect(readState('{"mode":"join","origin":"javascript:alert(1)"}')).toEqual({ mode: 'join', at: '' })
    for (const t of [null, '', 'nope', '{"mode":"root"}', '[]']) expect(readState(t)).toBeNull()
  })

  it('knows a PC set up before the app, or one whose record was lost, only from definite signs', () => {
    expect(inferMode({ exists: false, consoleActive: false, joined: false })).toBeNull()
    // A setup that stopped halfway (Walnut installed, a join refused, a console that never
    // started) is set up again, never a This PC page that cannot join or a console that never comes.
    expect(inferMode({ exists: true, consoleActive: false, joined: false })).toBeNull()
    expect(inferMode({ exists: true, consoleActive: false, joined: true })).toBe('join')
    expect(inferMode({ exists: true, consoleActive: true, joined: false })).toBe('own')
  })

  it('trusts an origin only exactly', () => {
    expect(originIs('http://localhost:3456/tasks?id=1', 'http://localhost:3456')).toBe(true)
    for (const u of ['http://localhost:3456@evil.example/', 'http://localhost:34560/', 'https://localhost:3456/', 'http://localhost.evil.example:3456/', 'nonsense']) {
      expect(originIs(u, 'http://localhost:3456'), u).toBe(false)
    }
  })

  it('says what walnut net status says', () => {
    const joined = netSummary(JSON.stringify({ available: true, enabled: true, running: true, endpointId: 'e'.repeat(64), lastError: null }, null, 2))
    expect(joined).toEqual({ joined: true, lines: ['Joined to your Walnut: yes', "Walnut's network on this PC: running", `This PC's id: ${'e'.repeat(16)}`] })
    const off = netSummary('{"enabled": false, "running": false, "lastError": "no config"}')
    expect(off).toEqual({ joined: false, lines: ['Joined to a Walnut: no', "Walnut's network on this PC: not running", 'Last problem: no config'] })
    expect(netSummary('walnut net: the daemon did not answer')).toEqual({ joined: false, lines: ['walnut net: the daemon did not answer'] })
    expect(netSummary('')).toEqual({ joined: false, lines: ["This PC's Walnut did not answer."] })
  })

  it('quotes a path for PowerShell, an apostrophe in a user name included', () => {
    expect(psQuote("C:\\Users\\O'Brien\\AppData\\Local\\Programs\\Walnut\\resources\\walnut-setup.ps1")).toBe("'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\Walnut\\resources\\walnut-setup.ps1'")
  })

  it('sends only web pages to the default browser', () => {
    expect(externalUrl('https://github.com/EvanZhang008/open-walnut')).toBe('https://github.com/EvanZhang008/open-walnut')
    expect(externalUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
    for (const u of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'javascript:alert(1)', 'not a url']) expect(externalUrl(u)).toBeNull()
  })
})
