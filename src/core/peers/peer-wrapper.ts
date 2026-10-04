/**
 * Peer-note envelope, shared by session_send (the one send surface) and any
 * delivery that carries ANOTHER SESSION's words into a CLI's stdin.
 *
 * v2 (2026-09): one `<walnut-message kind="peer-note" …>` tag instead of the
 * prose header + sha1 fence. The serializer escapes the body so it can never
 * open or close a tag, so a forged header inside the text is still just body;
 * the `note` attribute says in one place what three sentences of framing used
 * to, and the receiver spends its context on the message instead.
 */
import { createEnvelopeKit, type EnvelopeMessageOptions, type EnvelopeSender } from './envelope-kit.js';

/** The wording lives in envelope-kit.ts, shared with the host daemons. */
const kit = createEnvelopeKit();

export type PeerSender = EnvelopeSender;

/** `opts.title` is the sender's one-line TL;DR; the reader's card shows it until opened. */
export function buildPeerWrapper(originalText: string, sender: PeerSender, opts?: EnvelopeMessageOptions): string {
  return kit.buildPeerWrapper(originalText, sender, opts);
}
