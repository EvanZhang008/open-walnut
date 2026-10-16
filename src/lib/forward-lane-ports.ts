/**
 * Which host a loopback connection into this server was opened for.
 *
 * A host replica's requests reach this Mac as a stream the daemon connection splices
 * into a loopback TCP connection to this server (daemon-connection.ts
 * plugFollowerStream). That connection's LOCAL port is the remote port the server sees
 * on the request's socket, so the server can tell which host a request came through
 * from the socket alone, never from a header a client could send (middleware/op-id.ts
 * forwardHostOf). Only loopback sockets are looked up: a port number means nothing for
 * a connection from another machine.
 *
 * The port is registered in the socket's 'connect' listener, added BEFORE any byte is
 * piped into it: Node writes a connecting socket's queued data after its 'connect'
 * listeners run, so the first request byte reaches the server only after the port is
 * known. It is removed when the socket closes.
 */

import type { Socket } from 'node:net';

const hostByPort = new Map<number, string>();

/** Tag the loopback socket a forward lane opened for `hostKey`. Call before writing to it. */
export function registerForwardSocket(socket: Socket, hostKey: string): void {
  socket.once('connect', () => {
    const port = socket.localPort;
    if (!port) return;
    hostByPort.set(port, hostKey);
    socket.once('close', () => {
      if (hostByPort.get(port) === hostKey) hostByPort.delete(port);
    });
  });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The host a server-side socket's peer was opened for, or undefined. */
export function forwardHostOfPeer(remoteAddress: string | undefined, remotePort: number | undefined): string | undefined {
  if (!remoteAddress || !remotePort || !LOOPBACK.has(remoteAddress)) return undefined;
  return hostByPort.get(remotePort);
}

/** Tests only. */
export function _forwardPortsForTesting(): ReadonlyMap<number, string> {
  return hostByPort;
}
