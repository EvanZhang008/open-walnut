/**
 * A read of a remote host's session file that did not come back.
 *
 * The message is the sentence a person reads, in the host's own name
 * (`Remote read failed (<label>): …`). `host` keeps the alias and `detail` the
 * lower layer's words about it, the form a log line needs: the notification
 * bridge groups a host's failures by the alias, and a label with spaces in the
 * message alone named no host (2026-10-22: "Session control relay failed" with
 * no key, so nothing could retire it).
 *
 * `unreachable` is true only when `detail` is a host-link failure for a remote
 * host (the same test that gives a card its `host:<alias>` cause): a slow file
 * read, a missing file or a parse error is not proof the host is down.
 *
 * Leaf module, no imports: the reader throws it and the control relay checks it.
 */
export class RemoteReadError extends Error {
  constructor(
    message: string,
    public readonly host: string,
    public readonly detail: string,
    public readonly unreachable: boolean,
  ) {
    super(message)
    this.name = 'RemoteReadError'
  }
}
