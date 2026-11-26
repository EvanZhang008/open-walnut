/**
 * A free port for a server a spec starts itself (a second fixture server, a plugin store, a site),
 * taken OUTSIDE the OS's ephemeral range.
 *
 * Every spec used to take one with `listen(0)`, close it and hand the number on. That number is an
 * ephemeral port, and the child it went to opens port-0 listeners of its own before it binds the
 * number (since a734e46141 the fixture server's in-process daemon door is one): the OS can give the
 * door the port just freed. Then the door answered the fixture's readiness probe on that port
 * (`walnut-daemon ok`, an HTTP 200) and the spec read it as the server (2026-11-26,
 * plugin-update-round3.spec: `"walnut-daemon ok" is not valid JSON`). A port from 20000 to 29999 is
 * never handed out for `listen(0)` (Linux's range starts at 32768, macOS's and Windows' at 49152),
 * so nothing the child opens on port 0 can take it. It is the way a dev server picks one, too: Walnut's
 * session-servers detector does not probe a young listener on an OS-assigned port (it may serve a single
 * login callback), so the session-servers specs need a port from this range anyway.
 *
 * tests/scripts/fixture-port-guard.test.ts fails when a spec reserves a port its own way again.
 */
import net from 'node:net'

const FROM = 20_000
const SPAN = 10_000

function freeOn(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)))
  })
}

/** Never the same port twice in one process: a spec may ask for several at once (Promise.all). */
const handedOut = new Set<number>()

export async function reservePort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = FROM + Math.floor(Math.random() * SPAN)
    if (handedOut.has(port)) continue
    handedOut.add(port)
    if (await freeOn(port)) return port
  }
  throw new Error(`no free fixture port between ${FROM} and ${FROM + SPAN - 1}`)
}
