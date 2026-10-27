/**
 * "Make your own" on the Apps page: describe an app in one sentence and a Walnut
 * session builds it as a plugin, hot-loading it into the sidebar while the user
 * watches. Same start as the Build a plugin card on /plugins/new (BuildPluginCard:
 * the prompt, the working directory, the project), drawn as the page's last card.
 *
 * The by-hand route shows the scaffold command that works today: the plugin tools
 * are not on npm yet, so it runs from a clone of open-walnut.
 *
 * A cloud replica has no CLI and no daemon, so it gets no Build button there.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { quickStartSession } from '@/api/sessions'
import { fetchInstallDir, fetchIsCloudReplica } from '@/api/config'
import { openSessionOnHome } from '@/utils/open-session'
import { copyTextRobust } from '@/utils/clipboard'
import { BUILD_CWD, buildPrompt } from '@/components/settings/build-plugin-prompt'
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic'
import { useDraft } from '@/hooks/useDraft'
import { draftKey } from '@/utils/drafts'
import '@/styles/apps-make-mic.css'

/** The by-hand loop, one command per line, as README.md shows it. */
export const MANUAL_PLUGIN_COMMANDS = [
  'npm run build:plugins',
  'node packages/plugin-cli/dist/cli.js new my-plugin --dev --no-install',
] as const

const IDEAS = ['A Pomodoro timer tied to my current task', 'A reading list from my notes', 'A weekly review page', 'A board of my open pull requests']

export function MakeAppCard() {
  const navigate = useNavigate()
  // The description typed and not built yet survives leaving the page; a started session ends it.
  // The same key as the Build a plugin card: both start the same build.
  const draft = useDraft(draftKey('build-plugin', 'new'))
  const { text: request, setText: setRequest } = draft
  const requestRef = useRef<HTMLInputElement | null>(null)
  const mic = useRef<BoxMicHandle | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Unknown until the server answers: no Build form flashes up on a replica.
  const [cloud, setCloud] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    void fetchIsCloudReplica().then(setCloud, () => setCloud(false))
    return () => clearTimeout(copiedTimer.current)
  }, [])

  const start = async () => {
    if (busy || !request.trim()) return
    setBusy(true)
    setError(null)
    const sentKey = draft.key
    try {
      const installDir = await fetchInstallDir()
      const result = await quickStartSession({
        cwd: BUILD_CWD,
        createCwd: true,
        project: 'Walnut Plugins',
        message: buildPrompt(request, installDir),
      })
      draft.clear(sentKey)
      mic.current?.clear()
      // Land on the session column so the user watches it build.
      if (result.sessionId) openSessionOnHome(result.sessionId, navigate)
      else navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const copy = () => {
    void copyTextRobust(MANUAL_PLUGIN_COMMANDS.join('\n')).then(() => {
      setCopied(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="apps-make" data-testid="apps-make-card">
      <h3 className="apps-make-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" /></svg>
        Describe an app in one sentence
      </h3>
      <p className="apps-make-sub">
        {cloud === true
          ? 'Building needs the Mac console; this replica can only browse.'
          : 'A Walnut session writes it as a plugin and loads it into your sidebar while you watch.'}
      </p>
      {cloud === false && (
        <>
          <form
            className="apps-make-ask"
            onSubmit={(e) => { e.preventDefault(); void start() }}
          >
            <input
              ref={requestRef}
              type="text"
              data-draft-key={draft.key ?? undefined}
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder="What should it do? For example a Pomodoro timer tied to my current task"
              aria-label="Describe the app"
              disabled={busy}
              data-testid="build-plugin-request"
            />
            <BoxMic boxRef={requestRef} text={request} setText={setRequest} handleRef={mic} disabled={busy} />
            <button
              type="submit"
              className="apps-make-go"
              disabled={busy || !request.trim()}
              title={!request.trim() ? 'Describe it first.' : undefined}
              data-testid="build-plugin-start"
            >
              {busy ? 'Starting...' : 'Build it'}
            </button>
          </form>
          {error && <div className="apps-make-error" role="alert">{error}</div>}
          <div className="apps-make-ideas" role="group" aria-label="Ideas">
            {IDEAS.map((idea) => (
              <button key={idea} type="button" onClick={() => { mic.current?.clear(); setRequest(idea) }} disabled={busy}>{idea}</button>
            ))}
          </div>
        </>
      )}
      <details className="apps-make-manual" data-testid="apps-make-manual">
        <summary>Rather build it by hand?</summary>
        <p>In a clone of open-walnut (the plugin tools are not on npm yet), run:</p>
        <pre data-testid="apps-make-command">{MANUAL_PLUGIN_COMMANDS.join('\n')}</pre>
        <div className="apps-make-manual-row">
          <button type="button" onClick={copy} data-testid="apps-make-copy">{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className="apps-make-link" onClick={() => navigate('/plugins/new')} data-testid="build-plugin-guide">Step-by-step guide</button>
        </div>
      </details>
    </div>
  )
}
