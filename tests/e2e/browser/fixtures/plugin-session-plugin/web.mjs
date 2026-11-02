// Browser-test plugin for walnut.ui.views.SessionView (tests/e2e/browser/plugin-session-fullscreen.spec.ts).
// Two pages of one App, as a practice plugin has one page per problem, each with the same session
// beside it, which a button hides and shows (kept with walnut.ui.useView, view-state-kept.spec.ts).
// Below the buttons, a practice editor as such a plugin has (view-state-tabs.spec.ts): a clock that
// re-renders the App every 200 ms, the file picked (useView 'file'), and a text box per file, keyed
// by it so a file change remounts it, holding its draft (walnut.ui.useDraft 'code', one per file).
// Hand-written ESM, no build step: React comes from the host runtime.
const React = globalThis.__WALNUT_PLUGIN_HOST__.React
const h = React.createElement

export default {
  activate(walnut) {
    const SessionView = walnut.ui.views.SessionView

    function Editor({ file }) {
      const [draft, setDraft] = walnut.ui.useDraft('code', { id: file })
      return h('textarea', { 'data-testid': 'session-fixture-editor', 'data-file': file, value: draft, onChange: (e) => setDraft(e.target.value), rows: 4, style: { width: '100%' } })
    }

    function ProblemApp({ subpath, navigate }) {
      const [, setTick] = React.useState(0)
      React.useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 200); return () => clearInterval(t) }, [])
      const [file, setFile] = walnut.ui.useView('file', 'a.py')
      const page = subpath === '/two' ? 'two' : 'one'
      const [showPartner, setShowPartner] = walnut.ui.useView('showPartner', true)
      return h('main', { 'data-testid': 'session-fixture-app', style: { display: 'flex', height: '100%', minHeight: 0 } },
        h('nav', { style: { width: 220, padding: 16, flex: 'none' } },
          h('h1', { 'data-testid': 'session-fixture-page' }, `Problem ${page}`),
          h('button', { type: 'button', 'data-testid': 'session-fixture-next', onClick: () => navigate(page === 'one' ? 'two' : 'one') }, 'Next problem'),
          h('button', { type: 'button', 'data-testid': 'session-fixture-partner', onClick: () => setShowPartner((v) => !v) }, showPartner ? 'Hide partner' : 'Show partner'),
          h('p', null, 'File: ', h('span', { 'data-testid': 'session-fixture-file' }, file)),
          ['a.py', 'b.py'].map((f) => h('button', { key: f, type: 'button', 'data-testid': `session-fixture-file-${f}`, onClick: () => setFile(f) }, f)),
          h(Editor, { key: file, file })),
        showPartner
          ? h('section', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
            h(SessionView, { sessionId: 'pw-plugin-session', onClose: () => undefined }))
          : null)
    }

    walnut.ui.app({ id: 'main', title: 'Session View Fixture', component: ProblemApp, placement: 'sidebar' })
  },
}
