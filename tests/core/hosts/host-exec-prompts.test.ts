/**
 * Which host_exec lines can show a password dialog on a Mac's screen
 * (src/core/hosts/host-exec-prompts.ts). 2026-11-03: `security show-keychain-info` and
 * `security find-generic-password` through host_exec each put a SecurityAgent dialog on
 * someone else's Mac (its login keychain was locked) and hung until stopped.
 *
 * The line is read the way a shell reads it, so a path, a wrapper, a separator, a
 * command substitution or quotes do not hide the run, and a word that only contains
 * "security" is not one.
 */
import { describe, expect, it } from 'vitest'
import { promptRisk } from '../../../src/core/hosts/host-exec-prompts.js'

const RUNS: Array<[string, string]> = [
  ['security show-keychain-info', 'security show-keychain-info'],
  ['security find-generic-password -s svc -w', 'security find-generic-password'],
  ['/usr/bin/security unlock-keychain ~/Library/Keychains/login.keychain-db', 'security unlock-keychain'],
  ['"/usr/bin/security" find-identity -v -p codesigning', 'security find-identity'],
  ["'security' dump-keychain", 'security dump-keychain'],
  ['s\\ecurity find-internet-password', 'security find-internet-password'],
  ['sudo security add-trusted-cert -d cert.pem', 'security add-trusted-cert'],
  ['sudo -n -u admin security delete-certificate -c x', 'security delete-certificate'],
  ['env -i PATH=/usr/bin security find-certificate -a', 'security find-certificate'],
  ['TOKEN=1 security find-generic-password -s a', 'security find-generic-password'],
  ['ls; security show-keychain-info', 'security show-keychain-info'],
  ['true && security show-keychain-info || echo no', 'security show-keychain-info'],
  ['echo a | security import key.p12', 'security import'],
  ['ls\nsecurity lock-keychain', 'security lock-keychain'],
  ['PW=$(security find-generic-password -s a -w)', 'security find-generic-password'],
  ['echo "token: $(security find-generic-password -s a -w)"', 'security find-generic-password'],
  ['echo `security find-generic-password -s a -w`', 'security find-generic-password'],
  ['diff <(security dump-keychain) old.txt', 'security dump-keychain'],
  ["sh -c 'security show-keychain-info'", 'security show-keychain-info'],
  ['bash -lc "security unlock-keychain"', 'security unlock-keychain'],
  ['zsh -l -c "cd /tmp && security show-keychain-info"', 'security show-keychain-info'],
  ['eval "security find-generic-password -s a"', 'security find-generic-password'],
  ['exec security show-keychain-info', 'security show-keychain-info'],
  ["exec '/usr/bin/security' 'find-generic-password' '-s' 'a'", 'security find-generic-password'],
  ['timeout 5 security show-keychain-info', 'security show-keychain-info'],
  ['nohup security show-keychain-info &', 'security show-keychain-info'],
  ['xargs -n 1 security find-certificate -c < names.txt', 'security find-certificate'],
  ['find . -name "*.p12" -exec security import {} \\;', 'security import'],
  ['if security show-keychain-info; then echo unlocked; fi', 'security show-keychain-info'],
  ['for i in 1 2; do security show-keychain-info; done', 'security show-keychain-info'],
  ['{ security show-keychain-info; }', 'security show-keychain-info'],
  ['(cd /tmp && security show-keychain-info)', 'security show-keychain-info'],
  ['time -p security show-keychain-info', 'security show-keychain-info'],
  ['arch -arm64 security find-identity', 'security find-identity'],
  ['launchctl asuser 501 security show-keychain-info', 'security show-keychain-info'],
  ['security -i', 'security -i'],
  ['security -q find-generic-password -s a', 'security find-generic-password'],
  ['bash <<EOF\nsecurity show-keychain-info\nEOF', 'security show-keychain-info'],
  ['bash -s <<< "security show-keychain-info"', 'security show-keychain-info'],
  ["echo 'security show-keychain-info' | sh", 'a script that runs security'],
  ['cat <<EOF | bash\nsecurity show-keychain-info\nEOF', 'a script that runs security'],
  ["printf '%s\\n' 'security dump-keychain' | tee /tmp/x | zsh", 'a script that runs security'],
  ['python3 - <<\'EOF\'\nimport subprocess\nsubprocess.run(["security", "find-generic-password", "-s", "a"])\nEOF', 'a script that runs security'],
  // (child_process.exec in the script text, so the cross-platform ratchet reads no spawn of a Mac tool here.)
  ["node -e \"require('child_process').exec('security find-generic-password -s a')\"", 'a script that runs security'],
  ["node --eval=\"require('child_process').exec('security dump-keychain')\"", 'a script that runs security'],
  ["perl -ne 'system(\"security dump-keychain\")' list.txt", 'a script that runs security'],
  ["ruby -rjson -e 'system(\"security\", \"show-keychain-info\")'", 'a script that runs security'],
  ['security cms -S -N me -i msg.txt', 'security cms'],
  ["python3 -c \"import subprocess; subprocess.run(['security', 'show-keychain-info'])\"", 'a script that runs security'],
  ['osascript -e \'do shell script "security find-generic-password -s a -w"\'', 'a script that runs security'],
  ['osascript -e \'do shell script "ls /var/root" with administrator privileges\'', 'osascript with administrator privileges'],
]

const NOT_RUNS: string[] = [
  'echo ===',
  'aws ec2 describe-security-groups --security-group-ids sg-1',
  'aws ec2 authorize-security-group-ingress --group-id sg-1',
  'grep -ri security docs/',
  'git commit -m "security fix"',
  'echo security',
  'cat security.txt',
  'ls /usr/bin/security',
  'which security',
  'command -v security',
  'type security',
  'man security',
  'test -x /usr/bin/security && echo yes',
  '[ -x /usr/bin/security ] && echo yes',
  'echo hi > security',
  'cat <<EOF\nsecurity show-keychain-info\nEOF',
  'security',
  'security -h',
  'security help',
  'security list-keychains',
  'security default-keychain',
  'security login-keychain',
  'security error -25308',
  'npm run security-scan',
  'brew install --cask security-tools-x',
  'ssh devbox security show-keychain-info',
  'echo $((1+2)); echo done',
  '# security show-keychain-info',
  'bash ./build.sh',
  "sh -c 'security list-keychains'",
  // Only an interpreter's own script text counts, never its other words (2026-11-03 review).
  'python3 -m pytest tests/security',
  'pytest -k security tests/',
  'node x.js && git commit -m "fix security bug"',
  'bash ./build.sh && git commit -m "security fix"',
  'swift test --filter security',
  'swift build --product security-scanner',
  'python3 scripts/check.py --rule security',
  'grep -rn security src | python3 -c "import sys; print(len(sys.stdin.read()))"',
  'cat security-notes.md | python3 summarize.py',
  "ruby -e 'puts 1' security.json",
  'osascript ~/scripts/notify.scpt security',
  'npx eslint --rule security/detect-object-injection src',
  'security cms -D -i ~/Library/MobileDevice/Provisioning\\ Profiles/x.mobileprovision',
  'security cms -D -i x.mobileprovision | plutil -p -',
  'osascript -e \'tell application "Finder" to get name of every disk\'',
]

describe('host_exec: a command that can show a password dialog', () => {
  it.each(RUNS)('refuses %j', (line, what) => {
    expect(promptRisk(line)?.what).toBe(what)
  })

  it.each(NOT_RUNS)('lets %j run', (line) => {
    expect(promptRisk(line)).toBeNull()
  })

  it('names the kind of dialog', () => {
    expect(promptRisk('security show-keychain-info')?.kind).toBe('keychain')
    expect(promptRisk('osascript -e \'do shell script "id" with administrator privileges\'')?.kind).toBe('admin-password')
  })

  it('reads a long line in a moment', () => {
    const line = Array.from({ length: 2000 }, (_, i) => `echo "step ${i} $(date) \`hostname\`" | tee -a log-${i}.txt`).join('; ')
    const t0 = Date.now()
    expect(promptRisk(line)).toBeNull()
    expect(promptRisk(`${line}; security show-keychain-info`)?.what).toBe('security show-keychain-info')
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
})

describe('host_exec: reading a line costs one pass', () => {
  it('a chain of -exec words or wrappers is read in a moment (2026-11-03 review: 32 -exec words took over a second)', () => {
    const t0 = Date.now()
    expect(promptRisk(`find . ${Array.from({ length: 2000 }, () => '-exec').join(' ')} true`)).toBeNull()
    expect(promptRisk(`find . ${Array.from({ length: 2000 }, () => '-exec').join(' ')} security show-keychain-info \;`)?.what).toBe('security show-keychain-info')
    expect(promptRisk(`${'sudo '.repeat(8000)}true`)).toBeNull()
    expect(promptRisk(`${'sudo '.repeat(10)}security show-keychain-info`)?.what).toBe('security show-keychain-info')
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})
