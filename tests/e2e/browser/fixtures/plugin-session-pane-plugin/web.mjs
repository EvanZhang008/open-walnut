// Browser-test plugin for AppContribution.sessionPane (tests/e2e/browser/session-app-pane.spec.ts).
// Sketch: a pane that prints the props Walnut hands it, picks one of two documents, opens its
// standalone page, closes itself, and crashes on request. Notes: a second pane, so the App view
// draws tabs. Plain: an App with no pane, which must never be offered beside a session.
// Hand-written ESM, no build step: React comes from the host runtime.
const React = globalThis.__WALNUT_PLUGIN_HOST__.React
const h = React.createElement

export default {
  activate(walnut) {
    const page = (testId, text) => () => h('main', { 'data-testid': testId, style: { padding: 24 } }, text)

    function SketchPane(props) {
      const [crash, setCrash] = React.useState(false)
      if (crash) throw new Error('fixture pane crashed')
      return h('section', {
        'data-testid': 'pane-fixture-sketch',
        'data-session-id': props.sessionId,
        'data-task-id': props.taskId ?? '',
        'data-pane-id': props.paneId,
        'data-base-path': props.basePath,
        style: { padding: 16 },
      },
      h('p', null, 'Document: ', h('span', { 'data-testid': 'pane-fixture-doc' }, props.documentPath ?? 'none')),
      ['plans/a.sketch', 'plans/b.sketch'].map((doc) => h('button', {
        key: doc, type: 'button', 'data-testid': `pane-fixture-pick-${doc.slice(6, 7)}`, onClick: () => props.onDocumentPathChange(doc),
      }, doc)),
      h('button', { type: 'button', 'data-testid': 'pane-fixture-standalone', onClick: () => props.navigate(props.basePath) }, 'Open standalone'),
      h('button', { type: 'button', 'data-testid': 'pane-fixture-crash', onClick: () => setCrash(true) }, 'Crash'),
      h('button', { type: 'button', 'data-testid': 'pane-fixture-done', onClick: props.onClose }, 'Done'))
    }

    function NotesPane(props) {
      return h('section', { 'data-testid': 'pane-fixture-notes', style: { padding: 16 } }, `Notes for ${props.sessionId}`)
    }

    walnut.ui.app({ id: 'sketch', title: 'Sketch Fixture', component: page('pane-fixture-sketch-page', 'Sketch standalone'), sessionPane: SketchPane, order: 10 })
    walnut.ui.app({ id: 'notes', title: 'Notes Fixture', component: page('pane-fixture-notes-page', 'Notes standalone'), sessionPane: NotesPane, order: 20 })
    walnut.ui.app({ id: 'plain', title: 'Plain Fixture', component: page('pane-fixture-plain-page', 'Plain standalone'), order: 30 })
  },
}
