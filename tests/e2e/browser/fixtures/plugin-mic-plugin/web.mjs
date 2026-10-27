// Browser-test plugin for walnut.ui.views.MicButton (tests/e2e/browser/plugin-mic.spec.ts).
// Hand-written ESM, no build step: React comes from the host runtime.
const React = globalThis.__WALNUT_PLUGIN_HOST__.React
const h = React.createElement

export default {
  activate(walnut) {
    const MicButton = walnut.ui.views.MicButton

    // Two drafts in one box, the way a chat plugin keeps one per conversation.
    function NoteApp() {
      const [drafts, setDrafts] = React.useState({ first: '', second: '' })
      const [current, setCurrent] = React.useState('first')
      const [sent, setSent] = React.useState([])
      const box = React.useRef(null)
      const mic = React.useRef(null)
      const value = drafts[current]
      const setValue = (text) => setDrafts((all) => ({ ...all, [current]: text }))
      const send = () => {
        mic.current?.clear()
        setSent((all) => [...all, value])
        setValue('')
      }
      const switchTo = (next) => {
        mic.current?.clear()
        setCurrent(next)
      }
      return h('main', { 'data-testid': 'mic-fixture-app', style: { padding: 24, maxWidth: 560 } },
        h('h1', null, 'Quick note'),
        h('p', { 'data-testid': 'mic-fixture-draft' }, current),
        h('textarea', {
          ref: box, 'data-testid': 'mic-fixture-box', rows: 3, style: { width: '100%' },
          value, onChange: (event) => setValue(event.target.value),
        }),
        h('div', { 'data-testid': 'mic-fixture-row', style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
          MicButton ? h(MicButton, { boxRef: box, value, onChange: setValue, handleRef: mic }) : h('span', { 'data-testid': 'mic-fixture-no-mic' }, 'No mic'),
          h('button', { type: 'button', 'data-testid': 'mic-fixture-send', onClick: send }, 'Send'),
          h('button', { type: 'button', 'data-testid': 'mic-fixture-switch', onClick: () => switchTo(current === 'first' ? 'second' : 'first') }, 'Other draft')),
        h('ul', { 'data-testid': 'mic-fixture-sent' }, sent.map((text, index) => h('li', { key: index }, text))))
    }

    walnut.ui.app({ id: 'main', title: 'Quick Note Fixture', component: NoteApp, placement: 'sidebar' })
  },
}
