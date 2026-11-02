/**
 * Two "@" sources for the picker specs (mention-sources.spec.ts), registered in the
 * fixture server's own process the way a plugin's would be:
 *
 *   team-chat  people and channels (keyword "chat", alias "tc"); deterministic rows
 *   late       answers every search after 3 s, so All shows its rows only later, under
 *              everything else, without ever holding the list
 *   stuck      never answers, so its tab shows the timeout state
 *
 * Notes, the built-in source, reads the fixture's notes folder (vault-note.md).
 */
import { registerMentionSource } from '../../../src/core/mention-sources/registry'

const CHAT_ROWS = [
  { ref: 'user:U1', title: 'Alice Chen', subtitle: '@alice · DM 2h ago', kind: 'person', keys: ['alice', '@alice'] },
  { ref: 'user:U2', title: 'Bob Stone', subtitle: '@bob · DM yesterday', kind: 'person', keys: ['bob', '@bob'] },
  { ref: 'channel:C9', title: '#deploy-alerts', subtitle: 'channel · you posted recently', kind: 'channel', keys: ['deploy-alerts'] },
  { ref: 'channel:C7', title: '#garden-club', subtitle: 'channel', kind: 'channel', keys: ['garden-club'] },
]

export function installMentionSourcesFixture(): void {
  registerMentionSource('fixture', {
    id: 'team-chat',
    label: 'Chat',
    keyword: 'chat',
    aliases: ['tc'],
    kinds: ['person', 'channel'],
    order: 20,
    async search(q, { limit }) {
      const n = q.toLowerCase()
      return CHAT_ROWS.filter((r) => !n || r.title.toLowerCase().includes(n) || r.keys.some((k) => k.includes(n))).slice(0, limit)
    },
    async resolve(ref) {
      const row = CHAT_ROWS.find((r) => r.ref === ref)
      return row ? `Chat ${row.kind} ${row.title} (${ref}). FIXTURE_SOURCE_CARD` : null
    },
  })
  registerMentionSource('fixture', {
    id: 'late',
    label: 'Late',
    keyword: 'late',
    kinds: ['message'],
    order: 80,
    // Well past what Notes takes on a loaded CI runner (2026-11-02: 2.4 s at load 16 against a
    // 1.5 s Late), so the order the spec checks is the product's, not the machine's.
    timeoutMs: 8000,
    async search(q) {
      await new Promise((r) => setTimeout(r, 3000))
      return [{ ref: 'm:1', title: `Late answer for ${q || 'nothing'}`, subtitle: 'arrives after 3 s' }]
    },
    async resolve(ref) {
      return ref === 'm:1' ? 'Late message m:1. FIXTURE_LATE_CARD' : null
    },
  })
  registerMentionSource('fixture', {
    id: 'stuck',
    label: 'Stuck',
    keyword: 'stuck',
    order: 90,
    timeoutMs: 300,
    search: () => new Promise(() => {}),
    resolve: async () => null,
  })
}
