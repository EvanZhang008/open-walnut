// Browser-test plugin for walnut.ui.link (tests/e2e/browser/link-capture.spec.ts).
// Hand-written ESM, no build step: React comes from the host runtime.
const React = globalThis.__WALNUT_PLUGIN_HOST__.React
const h = React.createElement

function ChatApp({ search }) {
  const params = new URLSearchParams(search)
  const link = params.get('link')
  const url = link ? new URL(link) : null
  const [, channel, ts] = url ? (/^\/archives\/([^/]+)\/p(\d+)/.exec(url.pathname) || []) : []
  return h('div', { 'data-testid': 'link-fixture-app', style: { padding: 24 } },
    h('h1', null, 'Team Chat Fixture'),
    link
      ? h('dl', null,
          h('dt', null, 'Link'), h('dd', { 'data-testid': 'link-fixture-href' }, link),
          h('dt', null, 'Channel'), h('dd', { 'data-testid': 'link-fixture-channel' }, channel || ''),
          h('dt', null, 'Message'), h('dd', { 'data-testid': 'link-fixture-ts' }, ts || ''),
          h('dt', null, 'Thread'), h('dd', { 'data-testid': 'link-fixture-thread' }, url.searchParams.get('thread_ts') || ''),
          h('dt', null, 'Via'), h('dd', { 'data-testid': 'link-fixture-via' }, params.get('via') || ''))
      : h('p', { 'data-testid': 'link-fixture-empty' }, 'No link opened.'))
}

export default {
  activate(walnut) {
    const app = walnut.ui.app({ id: 'main', title: 'Team Chat Fixture', component: ChatApp, placement: 'sidebar' })
    walnut.ui.link?.({
      id: 'permalinks',
      title: 'Team Chat',
      patterns: ['https://*.chat.example.com/archives/*'],
      // A workspace the plugin is not signed into stays with the browser.
      accepts: (url) => url.hostname !== 'unknown.chat.example.com',
      open(url, context) {
        // A channel it cannot read: decline, and the host opens the browser.
        if (url.pathname.startsWith('/archives/CDECLINE/')) return false
        context.navigate(`${app.path}?link=${encodeURIComponent(url.href)}&via=${context.via}`)
        return true
      },
    })
  },
}
