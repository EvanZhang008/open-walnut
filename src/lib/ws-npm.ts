/**
 * WebSockets on bun: the npm `ws` package, as on Node. Every Walnut module
 * imports `#ws` (package.json "imports"): Node resolves it to `ws`, bun (the
 * "bun" condition, from source and in a compiled file) to this file.
 *
 * bun answers a bare `ws` import with its own WebSocket, and its bundler keeps
 * that import external, so no plugin can redirect it. bun's client has no socket
 * under it (`_socket` is undefined) and its server socket counts no bytes
 * (`bytesRead` stays 0), while the link checks read exactly those: the bytes of
 * a reply still arriving, which no event reports until its whole frame is in
 * (DaemonConnection's liveness and read progress, the cloud daemon tunnel's
 * heartbeat). On bun a large file on a slow link was judged silent and cut. A
 * path into the package is not remapped, so bun runs the same `ws` as Node.
 */
// @ts-expect-error the package's own ES entry ships no declaration file (types come from `ws` through `#ws`)
export { default, createWebSocketStream, Receiver, Sender, WebSocket, WebSocketServer } from '../../node_modules/ws/wrapper.mjs'
