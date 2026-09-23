/**
 * "Build a plugin": the ONE simple way in: describe it, click, and an AI
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
import { SettingsGroup, SettingsRow } from './SettingsSection'
import { SettingsButton } from './inputs/SettingsButton'
import '@/styles/settings-sections-addons.css'

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

  const manual = showManual ? (
    <span className="build-plugin-manual">
      To do it yourself, run <code>{PLUGIN_CREATE_COMMAND}</code> in a terminal
      {showGuideLink && (
        <>
          , or read the{' '}
          <button type="button" className="settings-addons-link" data-testid="build-plugin-guide" onClick={() => navigate('/plugins/new')}>
            step-by-step guide
          </button>
        </>
      )}.
    </span>
  ) : undefined

  return (
    <SettingsGroup heading="Build a plugin" footer={manual} data-testid="build-plugin-card" className="build-plugin-card">
      <SettingsRow
        label="Describe it"
        htmlFor="build-plugin-request"
        wide
        className="settings-row-stacked"
        help={cloud
          ? 'Building needs the Mac console; this replica can only browse.'
          : 'An AI session builds it, and it appears in your sidebar as it takes shape.'}
        error={error ?? undefined}
        control={cloud ? undefined : (
          <span className="settings-addons-inline build-plugin-form">
            <input
              id="build-plugin-request"
              type="text"
              className="settings-input settings-input--long"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void start() } }}
              placeholder="What should it do? For example a Pomodoro timer"
              data-testid="build-plugin-request"
            />
            <SettingsButton
              variant="primary"
              busy={busy}
              busyLabel="Starting..."
              onClick={() => void start()}
              data-testid="build-plugin-start"
            >
              Build it
            </SettingsButton>
          </span>
        )}
      />
    </SettingsGroup>
  )
}
