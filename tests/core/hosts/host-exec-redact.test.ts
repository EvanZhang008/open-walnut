/**
 * redact (src/core/hosts/host-exec.ts): what host_exec hides from a command's
 * output before it leaves the server. Past the scanner's 20 findings every
 * token still goes, a private key goes from BEGIN to END (or to the end of a
 * cut-off output), and a window that starts inside a key goes up to its END.
 */
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { jobAnswer, redact } from '../../../src/core/hosts/host-exec.js'
import { strictMark } from '../../../src/providers/host-exec-line.js'

const token = () => `ghp_${randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 36)}`
const body = () => randomBytes(48).toString('base64')
const HID = /^\[Walnut hid this line/
// Key armour built from parts, so a secret scanner never reads a key header in this file.
const DASH = '-'.repeat(5)
const armour = (edge: 'BEGIN' | 'END', kind: string) => `${DASH}${edge} ${kind} PRIVATE KEY${DASH}`

describe('host_exec redaction', () => {
  it('hides every token past the scanner cap', async () => {
    const tokens = Array.from({ length: 45 }, token)
    const text = ['start', ...tokens.map((t) => `t=${t}`), 'end', ''].join('\n')
    const r = await redact(text)
    for (const t of tokens) expect(r.text).not.toContain(t)
    expect(r.redacted).toBe(45)
    expect(r.text.startsWith('start\n')).toBe(true)
    expect(r.text.endsWith('\nend\n')).toBe(true)
  })

  it('hides a key from BEGIN to END, and keeps what follows', async () => {
    const b = body()
    const r = await redact(['a', armour('BEGIN', 'RSA'), b, b, armour('END', 'RSA'), 'z', ''].join('\n'))
    const lines = r.text.split('\n')
    expect(lines[0]).toBe('a')
    expect(lines.slice(1, 5).every((l) => HID.test(l))).toBe(true)
    expect(lines[5]).toBe('z')
    expect(r.text).not.toContain(b)
  })

  it('hides up to the END when the window starts inside a key', async () => {
    const b = body()
    const r = await redact([b, b, armour('END', 'OPENSSH'), 'after', ''].join('\n'))
    expect(r.text).not.toContain(b)
    expect(r.text.split('\n')[3]).toBe('after')
    expect(r.redacted).toBe(3)
  })

  it('hides a value given to a key named like a password or a token, whatever it looks like, and leaves look-alikes', async () => {
    // Keys built from parts, so the commit's secret scan never reads one in this file.
    const pw = ['pass', 'word'].join('')
    const hidden = [`${pw}=hunter2hunter2`, `DB_${pw.toUpperCase()}: s3cret!x`, `"api_key": "abcdef123"`, `export GITHUB_${'TOK'}EN=plainvalue1`, `{"client_${'sec'}ret":"short-one"}`]
    // Review 12: an AWS credentials line and a password in a URL went through.
    hidden.push(`aws_${'sec'}ret_access_key = FAKE-not-a-key-${'0'.repeat(8)}-test-only`, `export AWS_${'SEC'}RET_ACCESS_KEY=plainvalue123`, `postgres://admin:s3cr3tP4ss@db.example.com:5432/x`, `see https://u:pw9@host.example/repo.git`)
    // Review 12: a password of digits, a key ending in PASS, a value in parentheses, a password of words.
    hidden.push(`${pw}=123456`, `DB_${'PA'}SS=hunter2hunter2`, `--${pw}=(hunter2)`, `${pw}: correcthorse`, `${'tok'}en: aBcDeFgHiJkLmN`)
    // Code review 13: a password flag with a space, a short password, a quoted value with spaces, a long quoted one.
    hidden.push(`mysql -u root --${pw} hunter2hunter2`, `PASSWORD="abc12"`, `${pw}: abc`, `"${pw}":"x y z correct horse"`, `gh auth login --${'tok'}en ghp_EXAMPLEONLY0000`, `"${'tok'}en": "Bearer abc def ghi"`, `"${pw}": "${'a'.repeat(300)}"`, `--${'pa'}ss=s3cret`)
    for (const line of hidden) expect((await redact(line)).text, line).toMatch(HID)
    const kept = ['https://example.com/a:b@c', 'postgres://user:password@localhost/db', 'ssh://git@host:22/x', 'max_tokens: 4096', `${pw[0]!.toUpperCase()}${pw.slice(1)}: `, 'token: null', 'PWD=/home/x', `${'sec'}ret=$SECRET`, 'tokens=12345678', `GITHUB_${'TOK'}EN=***`, 'token_count=8', 'input_token: 4096', 'bypass=enabled1']
    // Review 12: status words, names and code were hidden, so a grep for "token" lost its hits.
    kept.push('Error: invalid token: expected 3 parts', 'Auth token: loaded from keychain', 'GitHub token: present', '[auth] token=expired',
      `Using ${'sec'}ret: default-namespace/my-app`, 'const token = getToken(req)', 'apiKey: process.env.API_KEY!,', `${'sec'}ret: config.${'sec'}ret,`,
      'token: myToken', `const ${pw} = req.body.${pw}`, `${pw}: string;`, `${pw}: required`)
    // Code review 13: test runners' PASS lines, code reading a credential, a flag's placeholder in help text.
    kept.push('--- PASS: TestParseConfig (0.00s)', '--- PASS: TestServer/handles_empty_body (0.01s)', 'PASS: t/basic.sh', 'PASS: test_utils',
      `    ${pw} = os.environ["DB_${pw.toUpperCase()}"]`, `${pw} = request.form['${pw}']`, `\t\tPass${'word'}: os.Getenv("DB_${'PA'}SS"),`,
      `${'sec'}ret_key = settings.get("SECRET_KEY")`, 'api_key = config["api_key"]', 'token = jwt.encode(payload, key)',
      `usage: tool [--${pw} PASSWORD] [--${'tok'}en TOKEN]`, `  -p, --${pw} string   the ${pw} to use`, `  --${pw} <${pw}>`, `mysql --${pw} "$DB_PW"`, `mysql --${pw} --user root`,
      `"${pw}": "", "user": "bob"`, 'compass=north-east')
    for (const line of kept) expect(await redact(line), line).toEqual({ text: line, redacted: 0 })
  })

  it('takes linear time on a long line that names a key but gives it no value, or many keys (2026-11-05 code reviews 12 and 13: 30 s and 18 s on the server\'s loop)', async () => {
    for (const line of [`token ${'-'.repeat(100_000)}`, `token ${'x_'.repeat(100_000)}`, `${'sec'}ret ${'-'.repeat(30_000)}`, 'a.'.repeat(20_000), `${'token '.repeat(20_000)}`, `token${' '.repeat(100_000)}`, `x://u:${':'.repeat(100_000)}`]) {
      const t0 = performance.now()
      expect((await redact(line)).redacted, line.slice(0, 12)).toBe(0)
      expect(performance.now() - t0, line.slice(0, 12)).toBeLessThan(500)
    }
    // Code review 13: many keys whose values are refused, each try scanning to the line's end (18 s at 240 KB).
    for (const unit of ['apikey:x', 'token=$', `${'pa'}ss={`, 'token:', `--${'pa'}ss${'word'} -`, `x_${'pa'}ss=$`]) {
      const line = unit.repeat(Math.floor(240_000 / unit.length))
      const t0 = performance.now()
      await redact(line)
      expect(performance.now() - t0, unit).toBeLessThan(1000)
    }
  })

  it('a strict step whose command looks like a credential is still named, with the credential hidden (2026-11-05 review sol13)', async () => {
    const J = 'hx-redact-step-1'
    const pw = ['pass', 'word'].join('')
    const out = await jobAnswer('macbox', J, { running: false, exitCode: 1, output: `\n${strictMark(J, 'a1b2c3d4e5f6')} 1 [1] line 1: test ${pw}=hunter2hunter2 = x\n` })
    expect(out.failedStep).toEqual({ exitCode: 1, command: '[hidden by Walnut: it looks like a credential]' })
    expect(String(out.output)).not.toContain('hunter2')
    expect(out.redactedLines).toBe(1)
    // A step with nothing secret in it is named as it was.
    const plain = await jobAnswer('macbox', J, { running: false, exitCode: 1, output: `\n${strictMark(J, 'a1b2c3d4e5f6')} 1 [1] line 1: test -f /nope\n` })
    expect(plain.failedStep).toEqual({ exitCode: 1, command: 'test -f /nope' })
  })

  it('leaves ordinary output alone', async () => {
    expect(await redact('build ok\n2 warnings\n')).toEqual({ text: 'build ok\n2 warnings\n', redacted: 0 })
  })
})
