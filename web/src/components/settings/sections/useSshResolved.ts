/**
 * What ssh resolves for the name a host row dials (`ssh -G`, read on the Walnut machine from
 * ~/.ssh/config: src/core/hosts/ssh-resolve.ts), for the Port and User fields left empty
 * (2026-11-10 review: Add host "demo-devbox-c" showed port 22 while the config said 3461).
 * Shown as the fields' placeholders and one line under Port; never written into the row, so
 * an empty field keeps following ~/.ssh/config.
 */
import { useEffect, useState } from 'react';
import { resolveSshName, type SshResolved } from '@/api/hosts';

const NAME = /^[A-Za-z0-9_:][A-Za-z0-9_.:-]{0,252}$/;
const WAIT_MS = 350;

/** The name ssh dials for a row: a found host by its ~/.ssh/config alias, any other by its hostname. */
export function sshNameOf(host: { discovered?: boolean; alias: string; hostname: string }): string {
  const name = (host.discovered ? host.alias : host.hostname).trim();
  return NAME.test(name) ? name : '';
}

/** The placeholders and the line under Port, from what ssh resolves (null: the plain defaults). */
export function sshResolvedHints(r: SshResolved | null, fields: { port?: number | null; user?: string }): { portPlaceholder: string; userPlaceholder?: string; line?: string } {
  if (!r) return { portPlaceholder: '22' };
  const portEmpty = fields.port === undefined || fields.port === null;
  const userEmpty = !fields.user?.trim();
  const line = r.fromConfig && (portEmpty || userEmpty)
    ? `From ~/.ssh/config: ${r.user ? `${r.user}@` : ''}${r.hostname}, port ${r.port}.`
    : undefined;
  return { portPlaceholder: String(r.port), ...(r.user ? { userPlaceholder: r.user } : {}), ...(line ? { line } : {}) };
}

export function useSshResolved(name: string, active: boolean): SshResolved | null {
  const [answer, setAnswer] = useState<SshResolved | null>(null);
  useEffect(() => {
    if (!active || !name) { setAnswer(null); return; }
    let live = true;
    const t = window.setTimeout(() => {
      void resolveSshName(name).then((r) => { if (live) setAnswer(r && r.name === name ? r : null); });
    }, WAIT_MS);
    return () => { live = false; window.clearTimeout(t); };
  }, [name, active]);
  return answer && answer.name === name ? answer : null;
}
