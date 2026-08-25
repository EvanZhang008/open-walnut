/**
 * "Build a plugin" — the ONE simple way in: describe it, click, and an AI
 * session starts building it. No terminal, no copied commands: the session
 * runs `plugin-cli new --dev` itself, and the watcher links the plugin into
 * this running Walnut so it appears live while the session works.
 *
 * Shared by the Plugins section (Settings) and /plugins/new. The manual path
 * stays one line below (the command itself), per the house rule that every
 * AI flow keeps a direct manual route. On a cloud replica the action hides:
 * a replica has no CLI and no daemon, so "Build it" there would mint a task
 * plus a session that can never run.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { quickStartSession } from '@/api/sessions'
import { fetchInstallDir, fetchIsCloudReplica } from '@/api/config'
import { openSessionOnHome } from '@/utils/open-session'

export const PLUGIN_CREATE_COMMAND = 'npx @open-walnut/plugin-cli new my-plugin --dev'

/** Where AI-built plugins live. quick-start expands `~` server-side and
 *  `createCwd` mkdirs it, so this works on a fresh machine. */
const BUILD_CWD = '~/walnut-plugins'

function buildPrompt(request: string, installDir: string | null): string {
  const want = request.trim()
  // The npm package may not be published yet; hand the session the fallback it
  // cannot discover on its own (a fresh ~/walnut-plugins has nothing to read).
  const fallback = installDir
    ? `If that npx package is not on the registry yet (404), use the Walnut checkout at ${installDir}: run \`npm run build:plugins\` there once, then \`node ${installDir}/packages/plugin-cli/dist/cli.js new <name> --dev\` from this directory.`
    : 'If that npx package is not on the registry yet (404), clone https://github.com/EvanZhang008/open-walnut, run `npm install && npm run build:plugins` in it, then `node <checkout>/packages/plugin-cli/dist/cli.js new <name> --dev` from this directory.'
  return [
    'Build a new Walnut plugin for me.',
    '',
    'Setup: pick a short kebab-case name from my request (ask me if unclear), then run',
    '`npx @open-walnut/plugin-cli new <name> --dev` in the current directory. ' + fallback,
    'Keep that watcher running: it links the plugin into my running Walnut and',
    'hot-reloads it on every save, so I can watch it appear in my sidebar while you',
    'work. The scaffold\'s README documents the full plugin API.',
    '',
    want ? `What I want: ${want}` : 'Start by asking me what the plugin should do.',
  ].join('\n')
}

export function BuildPluginCard({ showGuideLink = true, showManual = true }: {
  showGuideLink?: boolean
  showManual?: boolean
} = {}) {
  const navigate = useNavigate()
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cloud, setCloud] = useState(false)
  useEffect(() => { void fetchIsCloudReplica().then(setCloud) }, [])

  const start = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const installDir = await fetchInstallDir()
      const result = await quickStartSession({
        cwd: BUILD_CWD,
        createCwd: true,
        project: 'Walnut Plugins',
        message: buildPrompt(request, installDir),
      })
      setRequest('')
      // Land on the session column so the user watches it build.
      if (result.sessionId) openSessionOnHome(result.sessionId, navigate)
      else navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="build-plugin-card" data-testid="build-plugin-card">
      <div className="build-plugin-head">
        <strong>Build a plugin</strong>
        <span>
          {cloud
            ? 'Describe it on your Mac and an AI session builds it there. Building needs the Mac console; this replica can only browse.'
            : 'Describe it, and an AI session builds it. It appears in your sidebar as it takes shape.'}
        </span>
      </div>
      {!cloud && (
        <div className="build-plugin-form">
          <input
            type="text"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void start() } }}
            placeholder="What should it do? e.g. a Pomodoro timer in the sidebar"
            data-testid="build-plugin-request"
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => void start()}
            data-testid="build-plugin-start"
          >
            {busy ? 'Starting…' : 'Build it'}
          </button>
        </div>
      )}
      {error && <p className="text-sm" style={{ color: 'var(--priority-immediate)' }}>{error}</p>}
      {showManual && (
        <p className="build-plugin-manual text-xs text-muted">
          Prefer to do it yourself? Run <code>{PLUGIN_CREATE_COMMAND}</code> in a terminal
          {showGuideLink && (
            <>
              , or read the{' '}
              <button type="button" className="link-button" data-testid="build-plugin-guide" onClick={() => navigate('/plugins/new')}>
                step-by-step guide
              </button>
            </>
          )}.
        </p>
      )}
    </div>
  )
}
