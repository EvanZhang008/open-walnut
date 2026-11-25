/**
 * Ratchet for the launcher's verdicts on elapsed time (src/providers/service-launcher-script.ts).
 * 2026-11-25: the Mac slept between the loop's clock-jump check and its heartbeat check, woke to
 * "no heartbeat for 187 s" and the launcher ended a healthy server. Every verdict in the loop must
 * use the time l_follow read (it notices a sleep and moves the clocks first), so the loop itself
 * reads the clock nowhere else; a new verdict that reads `$(l_now)` on its own fails here.
 */
import { describe, expect, it } from 'vitest'
import { renderLauncherScript } from '../../src/providers/service-launcher-script.js'

const script = renderLauncherScript({
  platform: 'linux', home: '/home/u', executable: '/opt/walnut/bin/walnut', args: ['--service'],
  runtimeDir: '/run/u', stateDir: '/home/u/.local/state/walnut', path: '/usr/bin:/bin',
}, { backend: 'systemd', self: '/home/u/.local/state/walnut/walnut-launcher.sh' })

function body(start: RegExp, end: RegExp): string {
  const from = script.search(start)
  expect(from, String(start)).toBeGreaterThanOrEqual(0)
  const rest = script.slice(from)
  const to = rest.search(end)
  expect(to, String(end)).toBeGreaterThan(0)
  return rest.slice(0, to)
}

describe('the launcher judges elapsed time only on a clock read that noticed a sleep', () => {
  const loop = body(/^while :; do$/m, /^done$/m)

  it('the loop reads the clock only through l_follow', () => {
    expect(loop.split('\n').filter((l) => l.includes('$(l_now)') || /\bdate\b/.test(l))).toEqual([])
    expect(loop).not.toMatch(/\bw_[np]=/)
  })

  it('no verdict anywhere subtracts from a fresh read of the clock: it uses w_n or l_awake_since', () => {
    const fresh = script.split('\n').filter((l) => /\$\(\(\s*\$\(l_now\)\s*-/.test(l)).map((l) => l.trim())
    // The one left only words a log line (how long a service ran, its clock already moved by l_follow).
    expect(fresh).toEqual([expect.stringMatching(/^le_up=\$\(\( \$\(l_now\) - c_at \)\); le_why=/)])
    const request = body(/^l_request\(\) \{$/m, /^\}$/m)
    expect(request.split('\n')[1]?.trim()).toBe('l_follow')
    expect(request.match(/l_awake_since "\$lq_at"/g)).toHaveLength(2)
  })

  it('l_follow runs at the top of a tick and right before the trial and heartbeat verdicts', () => {
    const lines = loop.split('\n').map((l) => l.trim())
    expect(lines[1]).toBe('l_follow')
    const trial = lines.findIndex((l) => l.startsWith('if [ "$s_phase" = trial ]'))
    const beat = lines.findIndex((l) => l.startsWith('hb_t=; hb_b=; hb_p=; read -r hb_t hb_b hb_p'))
    const follows = lines.map((l, i) => (l === 'l_follow' ? i : -1)).filter((i) => i >= 0)
    expect(follows.some((i) => i > 1 && i < trial)).toBe(true)
    expect(lines[beat - 1]).toBe('l_follow')
    // A trial past its deadline is not judged inside the grace after a wake (its beat was asleep too).
    expect(loop).toMatch(/-gt "\$K_TRIAL" \] && \[ "\$w_n" -ge "\$hb_grace" \]; then/)
  })

  it('the tick measures its last stretch before it sleeps, and the launcher\'s own waits take out only what they counted', () => {
    expect(loop).toMatch(/^\s*l_follow; sleep "\$K_TICK" 9>&-$/m)
    expect(body(/^l_stop\(\) \{$/m, /^\}$/m)).toMatch(/l_reap; l_waited \$\(\(ls_n \/ 10\)\)\s*$/)
    expect(body(/^l_bounded\(\) \{$/m, /^\}$/m)).toMatch(/l_waited \$\(\(lt_n \/ 10\)\)\s*$/)
    expect(script).toMatch(/^l_waited\(\) \{ w_p=\$\(\(w_p \+ \$1\)\); \}$/m)
  })

  it('l_follow sets the time the verdicts use and gives the heartbeat a stall period after a jump', () => {
    const follow = body(/^l_follow\(\) \{$/m, /^\}$/m)
    expect(follow).toContain('w_n=$lf_n')
    expect(follow).toMatch(/hb_grace=\$\(\(lf_n \+ K_STALL\)\)/)
    expect(script).toMatch(/hb_grace=\$\(\(w_p \+ K_STALL\)\)/) // a launcher just up
  })
})
