/**
 * The one mount point for the grouped inbox's learning surfaces: a mail's correction card and a
 * group's two small cards (`These are important…`, `Rename group`).
 *
 * Rows and group lines never render these themselves; they post a request on the groups bus
 * (`requestMailCorrect`, `requestGroupCard`) and this host, mounted once in `MailApp`, draws the one
 * that is open. A new request replaces the old one, so there is never more than one on screen. Keyed by
 * the request, so opening the card on another row starts it fresh instead of carrying the last row's
 * choices over.
 */
import { useMailLearnRequest } from './mail-groups-bus';
import { MailCorrectPopover } from './MailCorrectPopover';
import { MailGroupCard } from './MailGroupCard';

let requestSeq = 0;
const requestKeys = new WeakMap<object, number>();

function keyOf(request: object): number {
  let key = requestKeys.get(request);
  if (key === undefined) {
    requestSeq += 1;
    key = requestSeq;
    requestKeys.set(request, key);
  }
  return key;
}

export function MailGroupsLearnHost() {
  const request = useMailLearnRequest();
  if (!request) return null;
  const key = keyOf(request);
  if (request.kind === 'correct') return <MailCorrectPopover key={key} request={request} />;
  return <MailGroupCard key={key} request={request} />;
}
