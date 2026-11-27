/**
 * "Organize with Walnut": ask for a plan, read it, apply it or drop it, and undo it after.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ImportStore, PublicState } from './store'
import { inNotes, plural } from './words'
import { Checkbox } from './host-controls'

type Step = NonNullable<PublicState['organize']['plan']>['steps'][number]

function StepGroup({ steps, group, left, setLeft, disabled }: { steps: Step[]; group: { kind: 'move' | 'merge'; dir: string; indexes: number[] }; left: Set<number>; setLeft(next: Set<number>): void; disabled?: boolean }) {
  const id = useId()
  const doable = group.indexes.filter((i) => steps[i].ok)
  const kept = doable.filter((i) => !left.has(i)).length
  const toggleAll = (on: boolean) => {
    const next = new Set(left)
    for (const i of doable) { if (on) next.delete(i); else next.add(i) }
    setLeft(next)
  }
  return (
    <li className="ni-step-group" data-testid="ni-plan-group">
      <div className="ni-step-line" data-left-out={doable.length && !kept ? 'true' : undefined}>
        {doable.length ? <Keep id={id} checked={kept > 0} partly={kept > 0 && kept < doable.length} disabled={disabled} onChange={toggleAll} label={group.kind === 'move' ? `Do these moves into ${short(group.dir) || 'the top of the folder'}` : `Do these merges in ${short(group.dir) || 'the top of the folder'}`} /> : <span className="ni-keep-space" aria-hidden="true" />}
        <span className="ni-kind" data-kind={group.kind}>{group.kind === 'move' ? 'Move' : 'Merge'}</span>
        <div className="ni-step-copy">
          <StepText id={doable.length ? id : undefined}>
            {group.kind === 'move'
              ? <>{plural(group.indexes.length, 'note')} into {short(group.dir) || 'the top of the folder'}</>
              : <>{plural(group.indexes.length, 'merge')} in {short(group.dir) || 'the top of the folder'}</>}
          </StepText>
          {(() => { const why = steps[group.indexes[0]].step.why; return why && group.indexes.every((i) => steps[i].step.why === why) ? <span className="ni-muted">{why}</span> : null })()}
          {kept < doable.length && <span className="ni-muted">{kept ? `${kept} of ${doable.length} kept in the plan` : 'Left out'}</span>}
          <details className="ni-details ni-preview">
            <summary>Show each one</summary>
            <ul className="ni-steps ni-steps-inner">
              {group.indexes.map((i) => (
                <StepLine key={i} item={steps[i]} kept={!left.has(i)} disabled={disabled} onKeep={(on) => { const next = new Set(left); if (on) next.delete(i); else next.add(i); setLeft(next) }} />
              ))}
            </ul>
          </details>
        </div>
      </div>
    </li>
  )
}

function short(path: string): string {
  return path.replace(/\.md$/, '')
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** One step, or a run of moves into one folder (or merges within one) shown as one line. */
type Group = { index: number } | { kind: 'move' | 'merge'; dir: string; indexes: number[] }

function groupSteps(steps: Step[]): Group[] {
  const placeOf = (item: Step): string | null => item.step.kind === 'move' ? dirOf(item.step.to) : item.step.kind === 'merge' ? dirOf(item.step.into) : null
  const groups: Group[] = []
  for (let i = 0; i < steps.length; i++) {
    const kind = steps[i].step.kind
    const dir = placeOf(steps[i])
    if (dir === null || kind === 'index') { groups.push({ index: i }); continue }
    let j = i
    while (j + 1 < steps.length && steps[j + 1].step.kind === kind && placeOf(steps[j + 1]) === dir) j++
    if (j - i + 1 >= 2) groups.push({ kind, dir, indexes: Array.from({ length: j - i + 1 }, (_, k) => i + k) })
    else for (let k = i; k <= j; k++) groups.push({ index: k })
    i = j
  }
  return groups
}

function Keep({ id, checked, partly, disabled, onChange, label }: { id?: string; checked: boolean; partly?: boolean; disabled?: boolean; onChange(next: boolean): void; label: string }) {
  return <Checkbox id={id} className="ni-keep" checked={checked} indeterminate={partly} disabled={disabled} onChange={onChange} aria-label={label} data-testid="ni-step-keep" />
}

/** A step's words; clicking them ticks or unticks its box, as the box does. */
function StepText({ id, children }: { id?: string; children: ReactNode }) {
  return id ? <label htmlFor={id} className="ni-step-text ni-step-label">{children}</label> : <span className="ni-step-text">{children}</span>
}

/** An index page as it will read: headings, list lines, and each link shown by its title. */
function IndexPreview({ content }: { content: string }) {
  const [full, setFull] = useState(false)
  const inline = (text: string) => text.split(/(\[\[[^\]]+\]\])/).map((part, i) => {
    const m = /^\[\[([^\]|]+?)(?:\\?\|([^\]]+))?\]\]$/.exec(part)
    if (!m) return <span key={i}>{part.replace(/\*\*(.+?)\*\*/g, '$1')}</span>
    return <span key={i} className="ni-preview-link">{(m[2] ?? m[1].split('/').pop() ?? '').trim()}</span>
  })
  const out: ReactNode[] = []
  let items: ReactNode[] = []
  const flush = () => { if (items.length) { out.push(<ul key={`l${out.length}`}>{items}</ul>); items = [] } }
  content.split('\n').forEach((line, i) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const item = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (item) { items.push(<li key={i}>{inline(item[1])}</li>); return }
    flush()
    if (heading) out.push(<b key={i} className="ni-preview-heading">{inline(heading[2])}</b>)
    else if (line.trim()) out.push(<p key={i}>{inline(line)}</p>)
  })
  flush()
  const links = (content.match(/\[\[/g) ?? []).length
  // The index's own title (`# …`) is no group heading.
  const headings = content.split('\n').filter((line) => /^#{2,6}\s/.test(line)).length
  return (
    <>
      <span className="ni-muted" data-testid="ni-index-preview-count">{plural(links, 'note')} listed{headings > 1 ? `, under ${headings} headings` : ''}</span>
      <div className="ni-preview-text" data-full={full ? 'true' : undefined} data-testid="ni-index-preview-body">{out}</div>
      {links > 12 && <button type="button" className="btn btn-link ni-link" onClick={() => setFull(!full)} data-testid="ni-index-preview-full">{full ? 'Show less' : 'Show it all'}</button>}
    </>
  )
}

function StepLine({ item, kept, onKeep, disabled }: { item: Step; kept: boolean; onKeep(next: boolean): void; disabled?: boolean }) {
  const id = useId()
  const { step } = item
  let label: string
  let text: string
  if (step.kind === 'move') { label = 'Move'; text = `${short(step.from)} → ${short(step.to)}` }
  else if (step.kind === 'merge') { label = 'Merge'; text = `${step.sources.map(short).join(', ')} → ${short(step.into)}` }
  else { label = 'Index'; text = dirOf(step.path) ? `${short(step.path)}` : `${short(step.path)}, at the folder's top level` }
  return (
    <li className="ni-step-line" data-ok={item.ok ? 'true' : 'false'} data-left-out={item.ok && !kept ? 'true' : undefined} data-testid="ni-plan-step">
      {item.ok ? <Keep id={id} checked={kept} disabled={disabled} onChange={onKeep} label={`Do this step: ${label} ${text}`} /> : <span className="ni-keep-space" aria-hidden="true" />}
      <span className="ni-kind" data-kind={step.kind}>{label}</span>
      <div className="ni-step-copy">
        <StepText id={item.ok ? id : undefined}>{text}</StepText>
        {step.why && <span className="ni-muted">{step.why}</span>}
        {!item.ok && item.problem && <span className="ni-help" data-tone="warn">Skipped: {item.problem}</span>}
        {item.ok && item.note && <span className="ni-help" data-tone="warn" data-testid="ni-step-note">{item.note}</span>}
        {step.kind === 'index' && (
          <details className="ni-details ni-preview" data-testid="ni-index-preview">
            <summary>Show what it will say</summary>
            <IndexPreview content={step.content} />
          </details>
        )}
      </div>
    </li>
  )
}

type Setter<T> = (next: T | ((prev: T) => T)) => void
type UseView = <T>(name: string, initial: T) => [T, Setter<T>]

export function OrganizePanel({ store, state, useView, openNote }: { store: ImportStore; state: PublicState; useView: UseView; openNote(path: string): void }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState(false)
  // null: not typed in yet, so the folder of the last run (or of the last import) shows.
  const [typed, setTyped] = useView<string | null>('organizeFolder', null)
  const [folders, setFolders] = useState<string[] | null>(null)
  const o = state.organize
  const job = state.job
  const lastFolder = o.folder ?? job?.folder ?? state.defaultFolder
  const choosing = o.phase === 'idle' || o.phase === 'failed'
  const folder = choosing ? (typed ?? lastFolder).trim() : lastFolder
  const importing = job?.phase === 'discovering' || job?.phase === 'importing'

  useEffect(() => {
    let live = true
    void store.call<{ folders: string[] }>('folders').then((outcome) => { if (live && outcome.ok) setFolders(outcome.result.folders) })
    return () => { live = false }
  }, [store, state.job?.endedAt, o.phase])

  // Opened (or reloaded) while a plan is made, applied or undone: the run comes into view.
  const section = useRef<HTMLElement>(null)
  const looked = useRef(false)
  useEffect(() => {
    if (looked.current) return
    looked.current = true
    if (o.phase === 'planning' || o.phase === 'applying' || o.phase === 'undoing') {
      requestAnimationFrame(() => section.current?.scrollIntoView({ block: 'center' }))
    }
  }, [o.phase])

  async function run(op: string, args: Record<string, unknown> = {}) {
    setBusy(true)
    setProblem(null)
    const outcome = await store.call(op, args)
    setBusy(false)
    if (!outcome.ok) setProblem(outcome.message)
  }

  // Steps the person left out of the plan (positions in it), kept with the plan they belong to.
  const [leftOut, setLeftOut] = useView<{ plan: string; steps: number[] }>('leftOut', { plan: '', steps: [] })
  const left = new Set(o.plan && leftOut.plan === o.plan.madeAt ? leftOut.steps : [])
  const setLeft = (next: Set<number>) => setLeftOut({ plan: o.plan?.madeAt ?? '', steps: [...next].sort((a, b) => a - b) })
  const steps = o.plan?.steps ?? []
  const okSteps = steps.filter((s) => s.ok)
  const chosenSteps = steps.filter((s, i) => s.ok && !left.has(i))
  const counts = (kind: string) => chosenSteps.filter((s) => s.step.kind === kind).length
  // Until the folder list comes, a folder is not said to be missing.
  const folderExists = !folder || folders === null || folders.includes(folder)
  // A run that stopped part way is undone before a new one: the new one would take its Undo away.
  const unfinished = !!o.backup && !o.backup.finished

  return (
    <section ref={section} className="ni-block" aria-labelledby="ni-organize-head">
      <div className="ni-block-head"><h2 id="ni-organize-head">Organize with Walnut</h2></div>
      <div className="ni-group" data-testid="ni-organize" data-phase={o.phase}>
        {choosing && (
          <div className="ni-row">
            <div className="ni-row-copy">
              <label htmlFor="ni-organize-folder">Folder</label>
              {folder
                ? <span className="ni-help">The folder Walnut reads and tidies, usually where you imported.</span>
                : <span className="ni-help" data-tone="warn">Type the name of a folder to organize.</span>}
            </div>
            <div className="ni-row-actions">
              <span className="ni-folder-prefix" aria-hidden="true">Notes /</span>
              <input
                id="ni-organize-folder"
                aria-label="Folder to organize"
                className="ni-input ni-folder"
                list="ni-organize-folder-list"
                value={typed ?? lastFolder}
                placeholder="Import from Notion"
                onChange={(e) => setTyped(e.target.value)}
                data-testid="ni-organize-folder"
              />
              <datalist id="ni-organize-folder-list">
                {(folders ?? []).map((f) => <option key={f} value={f} />)}
              </datalist>
            </div>
          </div>
        )}
        {choosing && (
          <div className="ni-row">
            <div className="ni-row-copy">
              <span className="ni-help">
                Walnut reads the notes and proposes a plan: it may group related notes into folders, merge duplicates and add index pages. Nothing changes until you apply it, and you can undo it after.
              </span>
              {o.undoneAt && o.phase === 'idle' && (!o.folder || o.folder === folder) && (
                <span className="ni-help" data-testid="ni-undone">
                  {o.keptEdits?.length
                    ? <>The last organize was undone. {plural(o.keptEdits.length, 'note')} you changed or made after it stayed as you left {o.keptEdits.length === 1 ? 'it' : 'them'}, with links pointed back:{' '}
                      {o.keptEdits.slice(0, 5).map((p, i) => <span key={p}>{i ? ', ' : ''}<button className="btn btn-link ni-link" onClick={() => openNote(p)}>{short(o.folder && p.startsWith(`${o.folder}/`) ? p.slice(o.folder.length + 1) : p)}</button></span>)}
                      {o.keptEdits.length > 5 ? ` and ${o.keptEdits.length - 5} more` : ''}.</>
                    : 'The last organize was undone: what it changed is back as it was.'}
                </span>
              )}
              {!folderExists && (job?.phase === 'cancelled' && job.folder === folder
                ? <span className="ni-help" data-testid="ni-organize-nofolder">The import into {inNotes(folder)} was stopped before any note came in. Carry on with it above; then Walnut can tidy it.</span>
                : importing || (!state.history.length && typed === null)
                ? <span className="ni-help" data-testid="ni-organize-nofolder">Import first; then Walnut can tidy {inNotes(folder)}.</span>
                : <span className="ni-help" data-tone="warn" data-testid="ni-organize-nofolder">There is no folder named {folder} in your notes.</span>)}
              {o.phase === 'failed' && o.error && o.folder === folder && folderExists && <span className="ni-help" data-tone="error" role="alert" data-testid="ni-organize-error">{o.error}</span>}
              {unfinished && <span className="ni-help" data-tone="warn" data-testid="ni-undo-first">The last organize of {inNotes(o.backup!.folder)} stopped part way. Undo it first; then you can propose a new plan.</span>}
              {problem && <span className="ni-help" data-tone="error" role="alert">{problem}</span>}
            </div>
            <div className="ni-row-actions">
              {o.backup && (
                <button className="btn" disabled={busy} onClick={() => void run('organize_undo')} data-testid="ni-undo" title={`Reverses the last organize of ${o.backup.folder}`}>
                  {o.phase === 'failed' ? 'Undo' : o.backup.folder === folder ? 'Undo last organize' : `Undo last organize of ${o.backup.folder}`}
                </button>
              )}
              <button className="btn" disabled={busy || importing || !folder || !folderExists || unfinished} onClick={() => void run('organize_plan', { folder })} data-testid="ni-plan">
                {o.phase === 'failed' && o.folder === folder && folderExists && !o.backup ? 'Try again' : folder ? `Propose a plan for ${folder.split('/').pop()}` : 'Propose a plan'}
              </button>
            </div>
          </div>
        )}
        {o.phase === 'planning' && (
          <div className="ni-row">
            <span className="ni-spinner" aria-hidden="true" />
            <div className="ni-row-copy">
              <span data-testid="ni-planning">Walnut is reading {inNotes(folder)}…</span>
              <span className="ni-help">This takes a minute or a few for a big import. You can leave this page.</span>
            </div>
            <div className="ni-row-actions">
              <button className="btn" onClick={() => void run('organize_cancel')} data-testid="ni-plan-cancel">Cancel</button>
            </div>
          </div>
        )}
        {o.phase === 'ready' && o.plan && (
          <>
            <div className="ni-row ni-row-top">
              <div className="ni-row-copy">
                <span className="ni-run-title" data-testid="ni-plan-title">The plan for {inNotes(o.plan.folder)}</span>
                {o.plan.summary && <span className="ni-plan-summary" data-testid="ni-plan-summary">{o.plan.summary}</span>}
                <span className="ni-muted">
                  {[counts('move') && plural(counts('move'), 'move'), counts('merge') && plural(counts('merge'), 'merge'), counts('index') && plural(counts('index'), 'index page', 'index pages')].filter(Boolean).join(' · ') || 'Nothing to change'}
                  {steps.length > okSteps.length ? ` · ${steps.length - okSteps.length} cannot be done` : ''}
                  {okSteps.length > chosenSteps.length ? ` · ${okSteps.length - chosenSteps.length} left out` : ''}
                </span>
                {o.error && <span className="ni-help" data-tone="error" role="alert" data-testid="ni-organize-error">{o.error}</span>}
                {problem && <span className="ni-help" data-tone="error" role="alert">{problem}</span>}
              </div>
            </div>
            {steps.length > 0 && (
              <ul className="ni-steps" data-testid="ni-plan-steps">
                {groupSteps(steps).map((g) => 'dir' in g
                  ? <StepGroup key={`g${g.indexes[0]}`} steps={steps} group={g} left={left} setLeft={setLeft} disabled={busy} />
                  : <StepLine key={g.index} item={steps[g.index]} kept={!left.has(g.index)} disabled={busy} onKeep={(on) => { const next = new Set(left); if (on) next.delete(g.index); else next.add(g.index); setLeft(next) }} />)}
              </ul>
            )}
            {okSteps.length > 0 ? (
              <div className="ni-row ni-plan-actions" data-testid="ni-plan-actions">
                <div className="ni-row-copy">
                  {discarding
                    ? <span data-testid="ni-discard-ask">Discard this plan? A new one takes a while, and may suggest different steps.</span>
                    : <span className="ni-help">Untick a step to leave it out. Undo reverses the whole run, and links to moved or merged notes are fixed.</span>}
                </div>
                <div className="ni-row-actions">
                  {discarding ? (
                    <>
                      <button className="btn" onClick={() => setDiscarding(false)} data-testid="ni-discard-keep">Keep it</button>
                      <button className="btn" disabled={busy} onClick={() => { setDiscarding(false); void run('organize_cancel') }} data-testid="ni-discard-yes">Discard</button>
                    </>
                  ) : (
                    <button className="btn" disabled={busy} onClick={() => setDiscarding(true)} data-testid="ni-discard">Discard</button>
                  )}
                  {!discarding && <button className="btn btn-primary" disabled={busy || !chosenSteps.length} onClick={() => void run('organize_apply', { leaveOut: [...left], plan: o.plan?.madeAt })} data-testid="ni-apply">
                    {chosenSteps.length < okSteps.length ? `Apply ${plural(chosenSteps.length, 'step')}` : 'Apply plan'}
                  </button>}
                </div>
              </div>
            ) : (
              <div className="ni-row">
                <div className="ni-row-copy"><span className="ni-help" data-testid="ni-plan-empty">{o.plan?.steps.length ? 'None of the steps can be done (each says why above), so nothing changes.' : 'Walnut found nothing to change in this folder.'}</span></div>
                <div className="ni-row-actions">
                  <button className="btn" disabled={busy} onClick={() => void run('organize_cancel')} data-testid="ni-discard">Done</button>
                </div>
              </div>
            )}
          </>
        )}
        {(o.phase === 'applying' || o.phase === 'undoing') && (
          <div className="ni-row">
            <span className="ni-spinner" aria-hidden="true" />
            <div className="ni-row-copy">
              <span data-testid={o.phase === 'applying' ? 'ni-applying' : 'ni-undoing'}>
                {o.phase === 'undoing'
                  ? `Putting ${inNotes(o.folder ?? folder)} back…${o.progress?.total ? ` ${o.progress.done} of ${plural(o.progress.total, 'change')}` : ''}`
                  : `Organizing… ${o.progress ? `step ${Math.min(o.progress.done + 1, o.progress.total)} of ${o.progress.total}` : ''}`}
              </span>
              <span className="ni-help">You can leave this page; it carries on.</span>
            </div>
          </div>
        )}
        {o.phase === 'applied' && (
          <div className="ni-row ni-row-top">
            <div className="ni-row-copy">
              <span className="ni-run-title" data-testid="ni-applied">Organized {inNotes(o.folder ?? folder)}: {doneWords(o.result)}{o.result?.skipped.length ? `, ${o.result.skipped.length} skipped` : ''}</span>
              <span className="ni-help">Undo reverses these changes; edits you make meanwhile are kept.</span>
              {o.result && o.result.skipped.length > 0 && (
                <details className="ni-details">
                  <summary>Skipped</summary>
                  <ul>{o.result.skipped.map((s, i) => <li key={i}>{s.why ? `${s.why}: ` : ''}{s.problem}</li>)}</ul>
                </details>
              )}
              {problem && <span className="ni-help" data-tone="error" role="alert">{problem}</span>}
            </div>
            <div className="ni-row-actions">
              <button className="btn" disabled={busy} onClick={() => void run('organize_undo')} data-testid="ni-undo">Undo</button>
              {o.result?.openPath && <button className="btn" onClick={() => openNote(o.result!.openPath!)} data-testid="ni-open-organized">Open in Notes</button>}
              <button className="btn" disabled={busy} onClick={() => void run('organize_cancel')} data-testid="ni-organize-done">Done</button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

/** What a run did, by kind: "12 notes moved, 1 index page written". */
function doneWords(result: PublicState['organize']['result']): string {
  const done = result?.done
  if (!done) return `${plural(result?.applied ?? 0, 'step')} done`
  const parts = [
    done.moved ? `${plural(done.moved, 'note')} moved` : '',
    done.merged ? `${plural(done.merged, 'merge')} made` : '',
    done.indexes ? `${plural(done.indexes, 'index page', 'index pages')} written` : '',
  ].filter(Boolean)
  return parts.join(', ') || 'nothing changed'
}
