// Browser-test plugin for walnut.ui.views.SessionView (tests/e2e/browser/plugin-session-fullscreen.spec.ts).
// Two pages of one App, as a practice plugin has one page per problem, each with the same session
// beside it, which a button hides and shows (kept with walnut.ui.useView, view-state-kept.spec.ts).
// Hand-written ESM, no build step: React comes from the host runtime.
const React = globalThis.__WALNUT_PLUGIN_HOST__.React
const h = React.createElement

export default {
  activate(walnut) {
    const SessionView = walnut.ui.views.SessionView

    function ProblemApp({ subpath, navigate }) {
      const page = subpath === '/two' ? 'two' : 'one'
      const [showPartner, setShowPartner] = walnut.ui.useView('showPartner', true)
      return h('main', { 'data-testid': 'session-fixture-app', style: { display: 'flex', height: '100%', minHeight: 0 } },
        h('nav', { style: { width: 220, padding: 16, flex: 'none' } },
          h('h1', { 'data-testid': 'session-fixture-page' }, `Problem ${page}`),
          h('button', { type: 'button', 'data-testid': 'session-fixture-next', onClick: () => navigate(page === 'one' ? 'two' : 'one') }, 'Next problem'),
          h('button', { type: 'button', 'data-testid': 'session-fixture-partner', onClick: () => setShowPartner((v) => !v) }, showPartner ? 'Hide partner' : 'Show partner')),
        showPartner
          ? h('section', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
            h(SessionView, { sessionId: 'pw-plugin-session', onClose: () => undefined }))
          : null)
    }

    walnut.ui.app({ id: 'main', title: 'Session View Fixture', component: ProblemApp, placement: 'sidebar' })
  },
}
