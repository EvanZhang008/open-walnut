/**
 * Agent Activity: what agents may use, the grants a task holds now, and every time an agent
 * asked, got an item, or was refused (the sealed agent log, core/vault/agent-log.ts). The
 * switch is the person's, the same three as in Settings: Any (agents list and use; sensitive
 * items still ask), Ask (each use asks; an approval lasts the grant length), or Off (no list; an
 * agent may only ask for one item, which the person approves or not). Each grant can be ended
 * here, and every use says how the value went: shown as plaintext, given to a command, filled
 * into a page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMinuteNow } from '@/utils/minute-clock';
import { vaultApi, VaultApiError, isLockedError, type AgentLogEntry, type AgentPolicy, type AgentsSwitch, type VaultItemSummary } from '@/api/vault'
import { SiteTile } from './ItemView'
import { RobotIcon } from './pw-icons'
import { fullTime, pointInTime, timeAgo } from '@/utils/time'
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel'
import { Radio } from '@/components/controls'
import { EmptyState, LoadingState } from '@/components/common/EmptyState'

export const SWITCH: Array<{ value: AgentsSwitch; label: string; help: string }> = [
  { value: 'allow', label: 'Any', help: 'Agents see the list and use what they need. Items marked sensitive still ask you; items set to never stay never.' },
  { value: 'ask', label: 'Ask', help: 'Agents see the list; each use asks you on your Mac or phone, and an approval lasts the grant length.' },
  { value: 'off', label: 'Off', help: 'Agents see nothing. One may only ask you for one item it names; if you approve, it gets it for the grant length.' },
]

const USE_TEXT: Record<string, string> = { reveal: 'showed plaintext', env: 'gave it to a command', fill: 'filled it into a page' }

function untilText(until: string | null): string {
  return until === null ? 'until you revoke it' : `until ${pointInTime(until)}`
}

const REASON: Record<string, string> = {
  agent_never: 'the item is never given to agents',
  agents_off: 'agent access was off',
  agent_paused: 'paused after three denials',
  agent_rate: 'too many in ten minutes',
}

function line(e: AgentLogEntry): { verb: string; tone: 'ok' | 'ask' | 'bad' } {
  const what = e.fields?.length && !(e.fields.length === 1 && e.fields[0] === 'password') ? e.fields.join(', ') : 'the password'
  switch (e.kind) {
    case 'released': return { verb: `got ${what}${e.use && e.use !== 'list' ? `, ${USE_TEXT[e.use]}` : ''}${e.via === 'allow' ? ' (allowed without asking)' : e.via === 'approvals-off' ? ' (Approvals are off)' : e.via === 'grant' ? ' (task grant)' : ` (you approved${e.approvedBy ? ` on ${e.approvedBy}` : ''})`}`, tone: 'ok' }
    case 'listed': return { verb: `read the list (${e.count ?? 0} item${e.count === 1 ? '' : 's'})`, tone: 'ask' }
    case 'revoked': return { verb: 'lost its grant (you ended it)', tone: 'bad' }
    case 'synced': return { verb: e.summary ?? 'synced from Bitwarden', tone: 'ok' }
    case 'fill': return { verb: `had the login filled into a browser page without seeing it${e.via === 'allow' ? ' (allowed without asking)' : e.via === 'grant' ? ' (task grant)' : ' (you approved)'}`, tone: 'ok' }
    case 'asked': return { verb: `asked for ${what}`, tone: 'ask' }
    case 'denied': return { verb: `was denied ${what}`, tone: 'bad' }
    case 'expired': return { verb: 'asked; nobody answered in time', tone: 'bad' }
    default: return { verb: `was refused: ${REASON[e.reason ?? ''] ?? e.reason ?? 'refused'}`, tone: 'bad' }
  }
}

export function AgentActivity({ items, onOpen, onLocked }: { items: VaultItemSummary[]; onOpen: (id: string) => void; onLocked: () => void }) {
  const [policy, setPolicy] = useState<AgentPolicy | null>(null)
  const [log, setLog] = useState<AgentLogEntry[] | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const hostLabel = useHostDisplayLabels()

  const fail = useCallback((err: unknown) => {
    if (isLockedError(err)) { onLocked(); return }
    setError(err instanceof Error ? err.message : String(err))
  }, [onLocked])

  const load = useCallback(() => {
    vaultApi.agentPolicy().then(setPolicy).catch(fail)
    vaultApi.agentLog().then(setLog).catch(fail)
  }, [fail])
  useEffect(() => { load() }, [load])

  const setSwitch = (v: AgentsSwitch) => {
    setError(''); setNote('')
    vaultApi.setAgentsSwitch(v).then((p) => { setPolicy(p); setNote(v === 'off' ? 'Agent access is off. Every grant ended.' : '') }).catch(fail)
  }
  const revoke = (id: string) => {
    setError(''); setNote('')
    vaultApi.revokeGrant(id).then(() => { setNote('Grant ended.'); load() }).catch(fail)
  }
  const endGrants = () => {
    vaultApi.endAgentGrants().then((r) => { setNote(`Ended ${r.grants} grant${r.grants === 1 ? '' : 's'}${r.asks ? ` and withdrew ${r.asks} ask${r.asks === 1 ? '' : 's'}` : ''}.`); load() }).catch(fail)
  }

  // The last day moves with the clock, not with the log: read the minute clock.
  const minute = useMinuteNow()
  const counts = useMemo(() => {
    const day = minute - 86_400_000
    const recent = (log ?? []).filter((e) => Date.parse(e.at) > day)
    return { got: recent.filter((e) => e.kind === 'released' || e.kind === 'fill').length, asked: recent.filter((e) => e.kind === 'asked').length, refused: recent.filter((e) => e.kind === 'denied' || e.kind === 'refused').length }
  }, [log, minute])

  return (
    <div className="pw-detail pw-agents" data-testid="pw-agents">
      <div className="pw-detail-head">
        <span className="pw-shield ok"><RobotIcon size={28} /></span>
        <div className="pw-detail-title">
          <h2>Agent Activity</h2>
          <span className="pw-detail-type">What your agents may use, and every time they asked. Kept encrypted on the computer Walnut runs on.</span>
        </div>
      </div>

      <div className="pw-card pw-agents-policy">
        <div className="pw-f-label pw-card-label" id="pw-agents-policy-label">When an agent asks for a password</div>
        {/* Each choice needs a line of words: a column of radios (standard.md, "Choice controls"). */}
        <div className="pw-radio-col" role="group" aria-labelledby="pw-agents-policy-label">
          {SWITCH.map((o) => (
            <Radio key={o.value} name="pw-agents-policy" checked={policy?.agents === o.value} disabled={!policy}
              onChange={() => setSwitch(o.value)} data-testid={`pw-agents-${o.value}`} label={o.label} detail={o.help} />
          ))}
        </div>
        {note && <p className="pw-hint" role="status">{note}</p>}
        {error && <p className="pw-hint pw-hint-bad" role="alert">{error}</p>}
      </div>

      <div className="pw-sec-tiles">
        <div className="pw-sec-tile"><b>{counts.got}</b><span>Given today</span></div>
        <div className="pw-sec-tile"><b>{counts.asked}</b><span>Asked today</span></div>
        <div className={`pw-sec-tile${counts.refused ? ' warn' : ''}`}><b>{counts.refused}</b><span>Refused today</span></div>
      </div>

      {!!policy?.grants.length && (
        <div className="pw-card">
          <div className="pw-f-label pw-card-label">Granted for a while</div>
          {policy.grants.map((g) => {
            const it = byId.get(g.itemId)
            return (
              <div key={g.id ?? `${g.asker}-${g.itemId}`} className="pw-agent-row" data-testid="pw-grant">
                {it && <SiteTile item={it} size={26} />}
                <span className="pw-agent-text">
                  <b>{it?.title ?? g.itemTitle ?? 'An item'}</b>
                  <span>{g.taskTitle ?? (g.asker.startsWith('host:') ? `a script on ${hostLabel(g.asker.slice(5))}` : g.asker.replace(/^task:/, 'task '))}{g.fields?.length ? ` · ${g.fields.join(', ')}` : ''}{g.use ? ` · ${g.use === 'reveal' ? 'shown to it' : g.use === 'env' ? 'in a command' : 'filled in a page'}` : ''} · {untilText(g.until)}{g.approvedBy ? ` · approved on ${g.approvedBy}` : ''}</span>
                </span>
                {g.id && <button type="button" className="btn btn-sm" onClick={() => revoke(g.id)} data-testid="pw-grant-revoke">Revoke</button>}
              </div>
            )
          })}
          <button type="button" className="btn btn-sm" onClick={endGrants} data-testid="pw-end-grants">End all grants</button>
        </div>
      )}

      <div className="pw-card" data-testid="pw-agent-log">
        <div className="pw-f-label pw-card-label">Recent</div>
        {log === null && <LoadingState title="Loading agent activity…" />}
        {log?.length === 0 && (
          <EmptyState
            title="No agent has asked for anything yet"
            hint={<>A task asks with <code>walnut pass</code> or the password ops, and you approve it here, on your Mac, or on your phone.</>}
          />
        )}
        {log?.map((e, i) => {
          const it = e.itemId ? byId.get(e.itemId) : undefined
          const l = line(e)
          return (
            <div key={`${e.at}-${i}`} className={`pw-agent-row pw-agent-${l.tone}`} data-testid="pw-agent-entry">
              {it ? <button type="button" className="pw-agent-tile" onClick={() => onOpen(it.id)} aria-label={`Open ${it.title}`}><SiteTile item={it} size={26} /></button> : <span className="pw-agent-dot" />}
              <span className="pw-agent-text">
                <span><b>{e.taskTitle ?? (e.host ? `A script on ${hostLabel(e.host)}` : 'A script')}</b> {l.verb}{e.itemTitle ? <> of <b>{e.itemTitle}</b></> : null}</span>
                {(e.purpose || e.command) && (
                  <span className="pw-agent-why">{e.purpose ? `“${e.purpose}”` : ''}{e.purpose && e.command ? ' · ' : ''}{e.command && <code>{e.command}</code>}</span>
                )}
              </span>
              <span className="pw-agent-when" title={`${fullTime(e.at)}${e.sessionId ? ` · session ${e.sessionId}` : ''}`}>{timeAgo(e.at)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
