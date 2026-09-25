/**
 * Rhythm's stylesheet. Every class is prefixed `rhythm-` because injected CSS is
 * global while the plugin is mounted, and every colour is a host theme token (or a
 * mix of one), so the App follows the light and dark themes without knowing which
 * one is on.
 */
export const RHYTHM_CSS = `
.rhythm-root {
  box-sizing: border-box;
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 28px 48px;
  color: var(--fg);
  font-family: inherit;
  display: grid;
  gap: 16px;
}
.rhythm-root *, .rhythm-root *::before, .rhythm-root *::after { box-sizing: border-box; }
.rhythm-root h1 { margin: 0 0 4px; font-size: 22px; line-height: 1.2; }
.rhythm-root h2 { margin: 0; font-size: 14px; font-weight: 600; }
.rhythm-root p { margin: 0; }
.rhythm-muted { color: var(--fg-muted); font-size: 13px; line-height: 1.45; }
.rhythm-error { color: var(--danger, #d64545); font-size: 13px; line-height: 1.45; }
.rhythm-note { color: var(--fg-secondary, var(--fg)); font-size: 13px; }
.rhythm-pad { padding: 8px 10px; }
.rhythm-page-head p { max-width: 68ch; }

.rhythm-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  align-items: start;
}
.rhythm-card {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 10px);
  background: var(--bg-secondary);
}
.rhythm-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rhythm-pill {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font-size: 12px;
}
.rhythm-focus[data-phase="focus"] .rhythm-pill,
.rhythm-focus[data-phase="break"] .rhythm-pill { color: var(--accent); border-color: var(--accent); }

.rhythm-stats { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.rhythm-stat { display: grid; gap: 4px; min-width: 0; }
.rhythm-stat-label { color: var(--fg-muted); font-size: 12px; }
.rhythm-stat-value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.rhythm-stat-text { font-size: 14px; font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; }

.rhythm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.rhythm-button {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 7px);
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.rhythm-button:hover:not(:disabled) { background: var(--bg-hover, var(--bg-secondary)); }
.rhythm-button:disabled { opacity: 0.55; cursor: default; }
.rhythm-primary { border-color: var(--accent); background: var(--accent); color: var(--accent-text, #fff); }
.rhythm-primary:hover:not(:disabled) { background: var(--accent-hover, var(--accent)); }
.rhythm-link-button { border: 0; padding: 0; background: none; color: var(--accent); font: inherit; cursor: pointer; }

.rhythm-picker {
  display: grid;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 7px);
  background: var(--bg);
}
.rhythm-option {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  background: none;
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.rhythm-option:last-child { border-bottom: 0; }
.rhythm-option:hover { background: var(--bg-hover, var(--bg-secondary)); }
.rhythm-option-on { background: var(--accent-subtle, color-mix(in srgb, var(--accent) 14%, transparent)); }
.rhythm-option-on .rhythm-option-title { color: var(--accent); font-weight: 600; }
.rhythm-option-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rhythm-option-meta { color: var(--fg-muted); font-size: 12px; }

.rhythm-running { display: grid; gap: 8px; justify-items: start; }
.rhythm-countdown { font-size: 44px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.rhythm-focus-title { font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }

.rhythm-rows { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 12px; margin: 0; font-size: 13px; }
.rhythm-rows dt { color: var(--fg-muted); }
.rhythm-rows dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

.rhythm-links { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; }
.rhythm-links a { color: var(--accent); text-decoration: none; }
.rhythm-links a:hover { text-decoration: underline; }
`
