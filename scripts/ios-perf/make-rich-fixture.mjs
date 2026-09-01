#!/usr/bin/env node
// Transcript fixture for verifying RICH HTML rendering in the iOS app on a real
// session page (not the DEBUG timeline harness).
//
//   node scripts/ios-perf/make-rich-fixture.mjs > /tmp/rich-ios/fixture.json
//   PORT=3512 FIXTURE=/tmp/rich-ios/fixture.json node scripts/ios-perf/mock-server.mjs
//
// then point the simulator app at that port (see scripts/ios-perf-check.sh's L2
// block for the `defaults write walnut.serverUrl` recipe) and open the session.
//
// The bodies are the shapes the `rich-output` skill teaches, one per message, so
// a single screenshot covers a theme-variable card, a `<style>` block that lands
// in a DIFFERENT chunk than the markup it styles, hardcoded panels with both
// colour ends set, an inline SVG, CSS-only interactivity, and a sandboxed
// `html-app` island. Kept in sync BY HAND with the Swift copy in
// ios-native/Walnut/Timeline/TimelineRichFixtures.swift — they are read side by
// side when the rendering changes, and neither one is a test oracle.

const bodies = [
  `Here is what the trace actually shows.

<div style="border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:10px;padding:12px 16px;background:var(--bg-secondary)">
<b style="color:var(--accent)">Conclusion</b><br>The retry storm is the symptom; the cache stampede is the cause.
</div>

The rest of this reply is ordinary markdown, so it stays a native text row.`,

  `<style>
.grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.cell { padding:10px; border-radius:8px; background:var(--bg-secondary); color:var(--fg); }
.cell b { color:var(--accent); }
</style>

<div class="grid">
  <div class="cell"><b>Before</b><br>3 round trips per file</div>
  <div class="cell"><b>After</b><br>1 batched call</div>
</div>`,

  `<div style="display:flex;gap:8px;flex-wrap:wrap">
  <div style="background:#fff5f5;color:#7f1d1d;padding:10px;border-radius:8px;flex:1 1 120px">Fails closed</div>
  <div style="background:#f0fdf4;color:#14532d;padding:10px;border-radius:8px;flex:1 1 120px">Fails open</div>
</div>`,

  // A background pinned with the text colour left to inherit, which is what real
  // replies keep writing (16 of 25 production rich messages did). The nested
  // `<code>`/`<blockquote>`/`<a>` carry the app's own themed colours, so this card
  // is also the one that shows whether a paired panel switches the whole variable
  // set or only its own `color`.
  `<div style="background:#fff5f5;padding:10px;border-radius:8px">
  Retry budget exhausted after the third attempt.
</div>

<div style="background:#f0f0f0;padding:10px;border-radius:8px;margin-top:8px">
  Run <code>stat /tmp/oom-dash/ghost-file-*.log</code> before touching the queue.
  <blockquote>The daemon owns the pipe, not the server.</blockquote>
  <a href="https://example.com/runbook">Runbook</a>
</div>

<div style="background:#161b22;padding:10px;border-radius:8px;margin-top:8px">
  Mirror case: a dark panel with <code>--verbose</code> in a light transcript.
</div>`,

  // SVG text is painted by `fill`, whose initial value is BLACK. A label that sets
  // none is invisible on a dark page, unless the diagram painted a light shape behind
  // it, in which case black is right and the page's near-white ink is what vanishes.
  // Both were measured on real replies, so both are here.
  `<svg viewBox="0 0 260 40" style="width:100%;max-width:320px">
  <rect x="1" y="6" width="120" height="28" rx="6" fill="none" stroke="var(--accent)"/>
  <text x="10" y="24" font-size="11">outline: label is on the page</text>
</svg>

<svg viewBox="0 0 260 40" style="width:100%;max-width:320px">
  <rect x="1" y="6" width="258" height="28" rx="6" fill="#ffffff"/>
  <text x="10" y="24" font-size="11">filled: label is on the author's box</text>
</svg>`,

  `<svg viewBox="0 0 260 70" style="width:100%;max-width:320px">
  <rect x="2" y="18" width="70" height="34" rx="6" fill="none" stroke="var(--accent)"/>
  <text x="37" y="39" font-size="11" text-anchor="middle" fill="var(--fg)">phone</text>
  <line x1="72" y1="35" x2="108" y2="35" stroke="var(--border-strong)"/>
  <rect x="108" y="18" width="70" height="34" rx="6" fill="none" stroke="var(--accent)"/>
  <text x="143" y="39" font-size="11" text-anchor="middle" fill="var(--fg)">server</text>
  <line x1="178" y1="35" x2="214" y2="35" stroke="var(--border-strong)"/>
  <rect x="214" y="18" width="44" height="34" rx="6" fill="none" stroke="var(--accent)"/>
  <text x="236" y="39" font-size="11" text-anchor="middle" fill="var(--fg)">CLI</text>
</svg>`,

  `<details style="border:1px solid var(--border);border-radius:8px;padding:8px 12px">
<summary style="cursor:pointer;color:var(--accent)">Why the deadline is 30s</summary>
<p style="color:var(--fg)">Whoever holds the shorter deadline defines the contract.</p>
</details>`,

  `Tap the button — this one really is running JavaScript.

\`\`\`html-app
<div style="font:-apple-system-body;font-family:-apple-system,sans-serif;color:#1c1c1e">
  <button id="b" style="padding:8px 14px;border-radius:8px;border:1px solid #8B5A2B;background:#fff;color:#8B5A2B">counted 0</button>
  <script>
    let n = 0;
    document.getElementById('b').onclick = () => { n++; document.getElementById('b').textContent = \`counted \${n}\`; };
  </script>
</div>
\`\`\``,
];

const messages = [];
let i = 0;
const ts = () => new Date(Date.UTC(2026, 7, 8, 6, 0, i)).toISOString();
for (const text of bodies) {
  i += 1;
  messages.push({ role: 'user', text: `Explain part ${i} visually.`, timestamp: ts() });
  i += 1;
  messages.push({ role: 'assistant', text, timestamp: ts() });
}

process.stdout.write(JSON.stringify({
  version: 1,
  sessionId: 'rich-html-session',
  exportedAt: ts(),
  truncated: false,
  messages,
}, null, 2) + '\n');
