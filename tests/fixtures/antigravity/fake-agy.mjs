// A stand-in for Google's Antigravity CLI (`agy`), as much of it as the sign-in uses
// (src/providers/acp-engine-sign-in.ts). Its words are the real CLI's (agy 1.5.14, read with no
// account). The sign-in it keeps is a file in $HOME, like agy's file storage.
//
//   --version            "1.5.14"
//   acp --login          prints the link and the prompt, reads one line:
//                          "good" signs in (exit 0), "hang" never answers, anything else exits 1
//                        FAKE_AGY_LOGIN=other-link  a link to another site; =exit  ends before any link;
//                        =silent  prints nothing and waits; =close-stdin  shows the link, then closes its stdin
//   acp                  an ACP server: initialize, authenticate (oauth-personal answers by the
//                        sign-in file), logout (removes it)
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const args = process.argv.slice(2)
const home = process.env.HOME || '/tmp'
const signedIn = path.join(home, '.gemini', 'antigravity-cli', 'fake-sign-in')
const seen = path.join(home, '.gemini', 'antigravity-cli', 'fake-env.json')

function record() {
  fs.mkdirSync(path.dirname(seen), { recursive: true })
  fs.writeFileSync(seen, JSON.stringify({
    SSH_CONNECTION: process.env.SSH_CONNECTION ?? null,
    AGY_ACP_FORCE_FILE_STORAGE: process.env.AGY_ACP_FORCE_FILE_STORAGE ?? null,
    args,
  }))
}

if (args[0] === '--version') {
  process.stdout.write('1.5.14\n')
  process.exit(0)
}

if (args[0] === 'acp' && args[1] === '--login') {
  record()
  const mode = process.env.FAKE_AGY_LOGIN || ''
  if (mode === 'exit') { process.stderr.write('Error: login unavailable\n'); process.exit(2) }
  if (mode === 'silent') { setInterval(() => {}, 1 << 30) }
  else if (mode === 'close-stdin') {
    // Shows the link, then stops reading: a code written after this is EPIPE for the writer.
    const link = 'https://accounts.google.com/o/oauth2/auth?client_id=fake&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=s'
    process.stdout.write(`Open this link in a browser to log in with Google:\n\n  ${link}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`)
    fs.closeSync(0)
    setTimeout(() => { process.stdout.write('Error: stopped reading\n'); process.exit(1) }, 1500)
  }
  else {
    const link = mode === 'other-link'
      ? 'https://example.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback'
      : 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fake.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=fakestate'
    process.stdout.write(`Open this link in a browser to log in with Google:\n\n  ${link}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`)
    const rl = readline.createInterface({ input: process.stdin })
    let answered = false
    rl.on('line', (line) => {
      if (answered) return
      answered = true
      const code = line.trim()
      if (code === 'hang') { setInterval(() => {}, 1 << 30); return }
      if (code === 'good') {
        fs.mkdirSync(path.dirname(signedIn), { recursive: true })
        fs.writeFileSync(signedIn, 'signed in\n', { mode: 0o600 })
        process.stdout.write('Logged in.\n')
        process.exit(0)
      }
      process.stdout.write('\ncouldn\'t log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."\n')
      process.exit(1)
    })
    rl.on('close', () => { if (!answered) { process.stdout.write('Error: login cancelled: no authorization code was entered\n'); process.exit(1) } })
  }
} else if (args[0] === 'acp') {
  record()
  const rl = readline.createInterface({ input: process.stdin })
  const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
  rl.on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, auth: { logout: {} } },
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' },
        authMethods: [{ id: 'oauth-personal' }, { id: 'oauth-business' }, { id: 'gemini-api-key' }, { id: 'agent-platform' }],
      } })
    } else if (msg.method === 'authenticate') {
      if (msg.params?.methodId === 'gemini-api-key' || fs.existsSync(signedIn)) send({ id: msg.id, result: {} })
      else send({ id: msg.id, error: { code: -32603, message: 'No browser is available here (this is a remote (SSH) session). Run `agy acp --login` in a terminal on this machine, then retry; or use a Gemini API key.' } })
    } else if (msg.method === 'logout') {
      fs.rmSync(signedIn, { force: true })
      send({ id: msg.id, result: {} })
    } else {
      send({ id: msg.id, error: { code: -32601, message: 'Method not found' } })
    }
  })
} else {
  process.stderr.write(`fake agy: unknown arguments ${args.join(' ')}\n`)
  process.exit(64)
}
