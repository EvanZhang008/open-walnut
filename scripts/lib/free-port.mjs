/**
 * A free TCP port for a server a script starts later, picked BELOW the OS's ephemeral range.
 *
 * The OS hands ports in its ephemeral range to every outbound connection and every
 * listen(0) on the machine. A port picked there with listen(0) and then closed is free only
 * until the next of those: a script that starts its server later, or restarts it on the
 * same port, can find it taken (2026-11-02, the binary matrix's macos-26 rehearsal: the
 * runner handed out 49179 to the rehearsal and 49186 to the daemon seconds later, and the
 * restarted server died with EADDRINUSE on 49179). Below the range the OS picks nothing,
 * so only a program that asks for that very port could take it.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'

/** [first, last] of the OS's ephemeral port range, from the OS when it says, else its default. */
export function ephemeralRange() {
  try {
    if (process.platform === 'linux') {
      const [lo, hi] = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number)
      if (lo > 1024 && hi >= lo) return [lo, hi]
    } else if (process.platform === 'darwin' || process.platform === 'freebsd') {
      const read = (k) => Number(execFileSync('sysctl', ['-n', k], { encoding: 'utf8', timeout: 5_000 }).trim())
      const lo = read('net.inet.ip.portrange.first')
      const hi = read('net.inet.ip.portrange.last')
      if (lo > 1024 && hi >= lo) return [lo, hi]
    }
  } catch { /* fall back to the platform's default */ }
  return process.platform === 'linux' ? [32768, 60999] : [49152, 65535]
}

/** The ports picked from: up to 15000 right below the ephemeral range, never under 10000. */
export function pickRange([lo] = ephemeralRange()) {
  const top = lo - 1
  // A range that starts this low leaves no room below it: pick from 10000 to 20000.
  if (top < 11_000) return [10_000, 20_000]
  return [Math.max(10_000, top - 15_000), top]
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    const done = () => s.close(() => resolve(true))
    if (host) s.listen(port, host, done)
    else s.listen(port, done)
  })
}

/** A port below the ephemeral range that nothing listens on, on loopback and on every address. */
export async function freePort({ range = pickRange(), tries = 200 } = {}) {
  const [from, to] = range
  for (let i = 0; i < tries; i++) {
    const port = from + Math.floor(Math.random() * (to - from + 1))
    if (await canListen(port, '127.0.0.1') && await canListen(port)) return port
  }
  throw new Error(`no free port in ${from}-${to} after ${tries} tries`)
}
