/**
 * The duty switches of the CEO or a VP (src/core/org/duties/), in its Memory &
 * instructions panel (2026-11-19, the user: "each VP can turn on some duty, we need to make
 * it generic"). One switch per registry entry the server lists, so a new duty needs no UI
 * of its own. Each switch saves at once; a refused save flips back and says why.
 */
import { useEffect, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { fetchOrgDuties, setOrgDuty, type OrgDuty } from '@/api/org';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { log } from '@/utils/log';

type Caps = NonNullable<Task['org_duties']>;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function stamp(row: Caps[string] | undefined): string {
  if (!row) return 'Off until you turn it on.';
  const when = new Date(row.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const who = row.by && row.by !== 'human' ? (row.by_name ?? 'an agent') : 'you';
  return `Turned ${row.on ? 'on' : 'off'} by ${who}, ${when}.`;
}

export function NodeDuties({ task }: { task: Pick<Task, 'id' | 'org_role' | 'org_duties'> }) {
  const role = task.org_role === 'main' ? 'main' : 'lead';
  const [list, setList] = useState<OrgDuty[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [caps, setCaps] = useState<Caps>(task.org_duties ?? {});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => { setCaps(task.org_duties ?? {}); }, [task.id, task.org_duties]);
  useEffect(() => {
    let live = true;
    fetchOrgDuties()
      .then((all) => { if (live) setList(all.filter((c) => c.roles.includes(role))); })
      .catch((err) => { if (live) setLoadError(errText(err)); });
    return () => { live = false; };
  }, [role]);

  const flip = async (id: string, on: boolean) => {
    const before = caps;
    setCaps({ ...caps, [id]: { on, at: new Date().toISOString() } });
    setBusy(id);
    setError(null);
    try {
      const node = await setOrgDuty(task.id, id, on);
      setCaps(node.org_duties ?? {});
      log.info('org-duties', 'duty switched', { taskId: task.id, duty: id, on });
    } catch (err) {
      setCaps(before);
      setError({ id, text: errText(err) });
      log.warn('org-duties', 'duty not switched', { taskId: task.id, duty: id, on, error: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <p className="am-note am-error" role="alert" data-testid="am-duties-error">Could not read the duties. {loadError}</p>;
  if (!list?.length) return null;
  return (
    <section className="am-duties" data-testid="am-duties">
      <span className="am-label">Duties</span>
      {list.map((c) => {
        const on = caps[c.id]?.on === true;
        const labelId = `am-duty-${c.id}-label`;
        return (
          <div key={c.id} className="am-duty" data-testid={`am-duty-${c.id}`}>
            <div className="am-duty-text">
              <span id={labelId} className="am-duty-name">{c.name}</span>
              <span className="am-hint">{c.description}</span>
              <span className="am-hint am-duty-stamp" data-testid={`am-duty-${c.id}-stamp`}>{stamp(caps[c.id])}</span>
              {error?.id === c.id && <span className="am-note am-error" role="alert">Not saved. {error.text}</span>}
            </div>
            <ToggleSwitch checked={on} onChange={(v) => void flip(c.id, v)} busy={busy === c.id} aria-labelledby={labelId} data-testid={`am-duty-${c.id}-switch`} />
          </div>
        );
      })}
    </section>
  );
}
