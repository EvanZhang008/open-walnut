/**
 * /plugins/new — guided onboarding for plugin authors.
 *
 * The page is built around ONE command (`plugin-cli new … --dev`): everything
 * else here is proof that it worked. The "your plugins" panel reads the same
 * live app catalog the sidebar uses, so when the CLI links a new plugin into
 * this Walnut, the row appears without a refresh — that moment is the payoff,
 * and it's why this is a page instead of a docs link.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import { copyTextRobust } from '@/utils/clipboard'

const CREATE_COMMAND = 'npx @open-walnut/plugin-cli new my-plugin --dev'
const DOCS_URL = 'https://github.com/EvanZhang008/open-walnut/blob/main/docs/reference/plugin-development.md'
const DEMO_URL = 'https://github.com/EvanZhang008/open-walnut/tree/main/examples/plugins/walnut-demo'

const CAPABILITIES = [
  'Sidebar app (native React)',
  'Extra pages',
  'Settings panel',
  'AI tools',
  'Skills',
  'Slash commands',
  'HTTP routes',
  'WebSocket RPC',
  'Hooks',
  'Scheduled actions',
  'Agents',
  'Providers',
  'Task sync',
  'Config + storage',
  'SQLite',
  'Secrets',
  'Events',
]

export function CreatePluginPage() {
  const navigate = useNavigate()
  const apps = useAppCatalog()
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const pluginApps = apps.all.filter((app) => app.kind !== 'core')

  const copyCommand = () => {
    // copyTextRobust, not navigator.clipboard: plain-HTTP LAN access and the
    // macOS WKWebView shell both lack/reject the async clipboard API.
    void copyTextRobust(CREATE_COMMAND).then((result) => {
      if (result === 'failed') return
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="create-plugin-page" data-testid="create-plugin-page">
      <header className="create-plugin-hero">
        <p className="create-plugin-kicker">Plugins</p>
        <h1>Build your own Walnut app</h1>
        <p className="create-plugin-lede">
          A plugin is plain TypeScript and React that runs inside Walnut with full access:
          it can put an app in the sidebar, give the AI new tools, add skills, routes,
          hooks, and more. One command sets up everything.
        </p>
      </header>

      <ol className="create-plugin-steps">
        <li className="create-plugin-step">
          <div className="create-plugin-step-head">
            <span className="create-plugin-step-num">1</span>
            <h2>Run one command</h2>
          </div>
          <p>
            In any terminal on this machine. It scaffolds the project, installs dependencies,
            builds, links it into Walnut, and keeps rebuilding as you save.
          </p>
          <div className="create-plugin-command" data-testid="create-plugin-command">
            <code>{CREATE_COMMAND}</code>
            <button
              type="button"
              className="btn btn-sm"
              onClick={copyCommand}
              data-testid="create-plugin-copy"
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
        </li>

        <li className="create-plugin-step">
          <div className="create-plugin-step-head">
            <span className="create-plugin-step-num">2</span>
            <h2>Watch it appear here</h2>
          </div>
          <p>
            The CLI tells this Walnut to load your plugin the moment the first build succeeds.
            No restart, no refresh: this list is live.
          </p>
          <div className="create-plugin-live" data-testid="create-plugin-live">
            {pluginApps.length === 0 ? (
              <div className="create-plugin-waiting" data-testid="create-plugin-waiting">
                <span className="create-plugin-pulse" aria-hidden="true" />
                Waiting for your first plugin… run the command and its app shows up here.
              </div>
            ) : (
              pluginApps.map((app) => (
                <div key={app.key} className="create-plugin-app-row" data-testid={`create-plugin-app-${app.key}`}>
                  <span className="create-plugin-app-title">{app.title}</span>
                  <code className="create-plugin-app-path">{app.path}</code>
                  <button type="button" className="btn btn-sm" onClick={() => navigate(app.path)}>
                    Open
                  </button>
                </div>
              ))
            )}
          </div>
        </li>

        <li className="create-plugin-step">
          <div className="create-plugin-step-head">
            <span className="create-plugin-step-num">3</span>
            <h2>Make it yours</h2>
          </div>
          <p>
            Edit <code>src/web.tsx</code> for the UI and <code>src/server.ts</code> for
            everything else; each save rebuilds and reloads your plugin in place.
            Everything Walnut can do is on the table:
          </p>
          <div className="create-plugin-caps">
            {CAPABILITIES.map((capability) => (
              <span key={capability} className="create-plugin-cap">{capability}</span>
            ))}
          </div>
          <p className="create-plugin-links">
            <a href={DOCS_URL} target="_blank" rel="noreferrer">Full guide</a>
            <a href={DEMO_URL} target="_blank" rel="noreferrer">Demo plugin (every capability, working)</a>
          </p>
        </li>

        <li className="create-plugin-step">
          <div className="create-plugin-step-head">
            <span className="create-plugin-step-num">4</span>
            <h2>Share it</h2>
          </div>
          <p>
            Push the folder to a git repo or publish it to npm. Anyone installs it from
            Settings → Plugin Store with the URL or package name.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="create-plugin-open-store"
            onClick={() => navigate('/settings#plugin-store')}
          >
            Open Plugin Store
          </button>
        </li>
      </ol>
    </div>
  )
}
