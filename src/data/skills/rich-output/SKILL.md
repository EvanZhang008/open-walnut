---
name: rich-output
description: Write replies as rich HTML that the Walnut web console renders natively while streaming — colored callouts, comparison grids, SVG diagrams, CSS-only steppers/tabs, animations, and sandboxed `html-app` islands for real JavaScript. Load this when explaining something hard (a paper, a codebase, a protocol, a decision) where visual structure beats prose, or when a reply is in rich output mode.
---

# Rich HTML output

The Walnut web console renders raw HTML in an assistant reply as real DOM, streaming it like markdown. You do not need a special syntax or a wrapper: write `<div>`, `<style>`, `<svg>`, `<details>` in the reply and they render. Markdown still works alongside, so use HTML only where it earns its place.

**Use it for**: comparisons, flows, step-by-step walkthroughs, anything with state or hierarchy, term highlighting, depth-on-demand. **Skip it for**: a short answer, a code diff, a list of three things. A wall of boxes is worse than a clean paragraph.

## The three rules that matter

1. **No inline `<script>`** — it is routed to a sandboxed iframe (see Islands) or dropped. Interactivity without JS: `<details>`, CSS `:checked` siblings, `:hover`, `@keyframes`.
2. **Your CSS is auto-scoped to your own message.** Every selector in a `<style>` block is rewritten to match only inside that reply, so plain class names (`.card`, `.row`) are safe and cannot restyle the app. `@keyframes` names are rewritten too. `@font-face`, `@property` and `@import` are dropped.
3. **Other surfaces show raw tags** (phone, notifications, plain-text search snippets). Keep the prose around a widget meaningful on its own; never put the only copy of a fact inside markup.

## Contrast: set both ends, or neither

The one mistake that actually hurts readability. A panel gets a hardcoded pale background and its text is left muted or inherited, so the body copy lands grey-on-pink:

```html
<!-- BAD: background is pinned, text is not -->
<div style="background:#fff5f5;padding:10px"><span style="color:var(--fg-muted)">barely readable</span></div>

<!-- GOOD: both ends pinned -->
<div style="background:#fff5f5;color:#7f1d1d;padding:10px">reads on that panel, and only that panel</div>

<!-- ALSO GOOD: neither end pinned, theme handles it -->
<div style="background:var(--bg-secondary);color:var(--fg);padding:10px">reads in light and dark</div>
```

Same rule inside a panel: a nested `<code>`, a caption, a table cell that inherits `--fg-muted` while sitting on your own background is the usual offender. Hardcoded hex is fine, as long as you own both ends of the pair.

## Recipes

Callout / conclusion card:

```html
<div style="border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:10px;padding:12px 16px;background:var(--bg-secondary)">
<b style="color:var(--accent)">Conclusion</b><br>One sentence that answers the question.
</div>
```

Theme variables keep it readable in dark mode: `--fg`, `--fg-muted`, `--bg`, `--bg-secondary`, `--border`, `--accent`, `--success`, `--warning`, `--error`, `--card-bg`, `--radius-md`, `--font-mono`. Hardcoded hex is allowed but check it survives a dark background.

Depth on demand (native, zero CSS):

```html
<details><summary><b>Why this is safe</b></summary>
<p>The long explanation only a reader who asked for it has to see.</p>
</details>
```

Comparison grid:

```html
<div style="display:flex;gap:10px;flex-wrap:wrap">
  <div style="flex:1;min-width:220px;border:1px solid var(--border);border-radius:10px;padding:10px 12px"><b>Option A</b><br>trade-off</div>
  <div style="flex:1;min-width:220px;border:1px solid var(--border);border-radius:10px;padding:10px 12px"><b>Option B</b><br>trade-off</div>
</div>
```

CSS-only stepper (a wizard the reader clicks through, no JS). Radios hold the state; labels are the buttons:

```html
<div class="wz">
<style>
.wz { border:1px solid var(--border); border-radius:10px; padding:12px 16px }
.wz input[type=radio] { display:none }
.wz .step { display:none }
#s1:checked ~ .body .p1, #s2:checked ~ .body .p2, #s3:checked ~ .body .p3 { display:block }
.wz label { display:inline-block; padding:4px 12px; background:var(--accent); color:#fff; border-radius:6px; cursor:pointer }
</style>
<input type="radio" name="wz" id="s1" checked><input type="radio" name="wz" id="s2"><input type="radio" name="wz" id="s3">
<div class="body">
<div class="step p1"><b>Step 1</b> … <label for="s2">Next →</label></div>
<div class="step p2"><b>Step 2</b> … <label for="s3">Next →</label></div>
<div class="step p3"><b>Step 3</b> … <label for="s1">↻ Restart</label></div>
</div>
</div>
```

Tabs are the same trick with the panels side by side instead of sequential.

SVG diagram (boxes and arrows beat ASCII art; it also scales and picks up theme colors):

```html
<svg viewBox="0 0 420 60" width="100%" style="max-width:420px">
<rect x="4" y="16" width="120" height="30" rx="6" fill="var(--bg-secondary)" stroke="var(--accent)"/>
<text x="64" y="36" text-anchor="middle" font-size="12" fill="var(--fg)">stage one</text>
<text x="132" y="36" font-size="13" fill="var(--fg-muted)">→</text>
<rect x="152" y="16" width="120" height="30" rx="6" fill="var(--bg-secondary)" stroke="var(--success)"/>
<text x="212" y="36" text-anchor="middle" font-size="12" fill="var(--fg)">stage two</text>
</svg>
```

Animation (CSS keyframes need no JS — a pulsing "in progress" dot, a flowing pipe, a bar that fills once, an SVG path that draws itself):

```html
<div class="anim">
<style>
@keyframes pulse { 0%,100% { transform:scale(1); opacity:1 } 50% { transform:scale(1.4); opacity:.5 } }
@keyframes draw { to { stroke-dashoffset:0 } }
.anim .dot { width:10px; height:10px; border-radius:50%; background:var(--success); display:inline-block; animation:pulse 1.1s ease-in-out infinite }
.anim path { stroke-dasharray:240; stroke-dashoffset:240; animation:draw 2s ease-in-out forwards }
</style>
<span class="dot"></span> running…
</div>
```

## Islands: when you genuinely need JavaScript

Anything that has to compute (canvas, a value the reader types, physics, three.js, random) goes in an `html-app` fence. It renders as a seamless sandboxed iframe: auto-height, no border, real JS.

````
```html-app
<div style="font-family:system-ui;padding:8px">
<button id="b">Clicked 0</button>
<script>let n=0;b.onclick=()=>{n++;b.textContent=`Clicked ${n}`}</script>
</div>
```
````

Island limits, by design: no access to Walnut data (no cookies, no `/api`, no parent DOM), no network at all, and it only appears once the fence closes — so keep islands small and put the explanation in the prose above, not inside.

## Streaming behaviour worth knowing

A block freezes once its top-level tag closes, and frozen blocks are never re-rendered — that is what lets the reader click your stepper while the rest of the reply is still arriving. Two consequences: keep one widget in one contiguous block (no blank line in the middle of it), and put the widget before the long tail of prose if you want it clickable early.
