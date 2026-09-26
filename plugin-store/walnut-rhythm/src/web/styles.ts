/**
 * Rhythm's stylesheet. Every class is prefixed `rhythm-` because injected CSS is
 * global while the plugin is mounted, and every colour is a host theme token (or a
 * mix of one), so the page follows the light and dark themes without knowing which
 * one is on.
 *
 * The page lives in Settings, so it speaks Settings: a heading above a card, 44px
 * rows separated by hairlines, 14px labels with 12.5px help, and the same tokens the
 * Settings shell exports (`--settings-*`). The one thing that is Rhythm's own is the
 * instrument strip at the top: three dials and a thin meter of time at the keyboard.
 */
export const RHYTHM_CSS = `
.rhythm-root {
  box-sizing: border-box;
  max-width: 760px;
  margin: 0 auto;
  padding: 28px 24px 56px;
  color: var(--fg);
  font-family: inherit;
  display: grid;
  gap: 22px;
}
.rhythm-root *, .rhythm-root *::before, .rhythm-root *::after { box-sizing: border-box; }
.rhythm-root h1 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; }
.rhythm-root h2 { margin: 0; font-size: 13px; line-height: 18px; font-weight: 600; color: var(--fg-secondary); }
.rhythm-root p { margin: 0; }
.rhythm-lede { margin-top: 4px; max-width: 64ch; color: var(--fg-muted); font-size: 13px; line-height: 18px; }
.rhythm-muted { color: var(--fg-muted); font-size: 12.5px; line-height: 17px; }
.rhythm-error { color: var(--settings-error-text, #c4221a); font-size: 12.5px; line-height: 17px; }
.rhythm-status { color: var(--fg-secondary); font-size: 12.5px; line-height: 17px; }

/* ── A block: heading line, then the card ── */
.rhythm-block { display: grid; gap: 6px; min-width: 0; }
.rhythm-block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 0 calc(var(--settings-row-pad-x, 14px) + 1px);
}
.rhythm-group {
  background: var(--settings-group-bg, var(--card-bg, var(--bg)));
  border: 1px solid var(--settings-group-border, var(--border));
  border-radius: 10px;
  overflow: hidden;
}
.rhythm-body { display: grid; gap: 12px; padding: 12px var(--settings-row-pad-x, 14px) 14px; }

/* ── Rows, the Settings way: 44px, hairline from the label's x ── */
.rhythm-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 44px;
  padding: 8px var(--settings-row-pad-x, 14px);
}
.rhythm-row + .rhythm-row::before {
  content: '';
  position: absolute;
  top: 0;
  left: var(--settings-row-pad-x, 14px);
  right: 0;
  height: 1px;
  background: var(--settings-hairline, var(--border));
}
.rhythm-row-copy { flex: 1 1 auto; min-width: 0; display: grid; gap: 2px; font-size: 14px; line-height: 19px; }
.rhythm-row-help { color: var(--fg-muted); font-size: 12.5px; line-height: 17px; max-width: 60ch; overflow-wrap: anywhere; }
.rhythm-row-help[data-tone="warn"] { color: var(--priority-important-text, #9e5300); }
.rhythm-row-help[data-tone="error"] { color: var(--settings-error-text, #c4221a); }
.rhythm-row-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; margin-left: auto; }

/* ── The instrument strip ── */
.rhythm-now { display: grid; gap: 14px; padding: 16px var(--settings-row-pad-x, 14px) 14px; }
.rhythm-dials { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.rhythm-dial { display: grid; gap: 4px; min-width: 0; align-content: start; }
.rhythm-dial-label { font-size: 11px; line-height: 14px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-muted); }
.rhythm-dial-value {
  font-size: 26px;
  line-height: 30px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.rhythm-dial-text { font-size: 14px; line-height: 19px; font-weight: 500; padding-top: 5px; overflow-wrap: anywhere; }
.rhythm-meter {
  position: relative;
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--fg) 9%, transparent);
  overflow: hidden;
}
.rhythm-meter-fill {
  position: absolute;
  top: 0; bottom: 0; left: 0;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.6s ease;
}
.rhythm-now[data-phase="due"] .rhythm-meter-fill,
.rhythm-now[data-phase="deferred"] .rhythm-meter-fill { background: var(--priority-important-text, #9e5300); }
.rhythm-now[data-present="false"] .rhythm-meter-fill { background: var(--fg-muted); opacity: 0.5; }
.rhythm-meter-note {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--fg-muted);
  font-size: 11.5px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}

/* ── Buttons: the Settings button's size and shape ── */
.rhythm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.rhythm-button {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--card-bg, var(--bg));
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  line-height: 26px;
  white-space: nowrap;
  cursor: pointer;
}
.rhythm-button:hover:not(:disabled) { background: var(--bg-hover, var(--bg-secondary)); }
.rhythm-button:disabled { opacity: 0.45; cursor: default; }
/* White on the accent. The host's --accent-text is the accent AS text (blue on white),
   never text on blue: using it here painted blue words on a blue button. */
.rhythm-primary { border-color: var(--accent); background: var(--accent); color: #fff; }
.rhythm-primary:hover:not(:disabled) { background: var(--accent-hover, var(--accent)); border-color: var(--accent-hover, var(--accent)); }
.rhythm-link-button { border: 0; padding: 0; background: none; color: var(--accent); font: inherit; font-size: inherit; cursor: pointer; }
.rhythm-link-button:hover { text-decoration: underline; }

/* ── Focus block ── */
.rhythm-two { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 22px; align-items: start; }
.rhythm-pill {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
}
.rhythm-focus[data-phase="focus"] .rhythm-pill,
.rhythm-focus[data-phase="break"] .rhythm-pill { color: var(--accent); border-color: var(--accent); }
.rhythm-picker {
  display: grid;
  max-height: 244px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
.rhythm-option {
  display: grid;
  gap: 1px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  background: none;
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  line-height: 17px;
  text-align: left;
  cursor: pointer;
}
.rhythm-option:last-child { border-bottom: 0; }
.rhythm-option:hover { background: var(--bg-hover, var(--bg-secondary)); }
.rhythm-option-on { background: var(--accent-subtle, color-mix(in srgb, var(--accent) 12%, transparent)); }
.rhythm-option-on .rhythm-option-title { color: var(--accent); font-weight: 600; }
.rhythm-option-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rhythm-option-meta { color: var(--fg-muted); font-size: 12px; line-height: 15px; }
.rhythm-pad { padding: 8px 10px; }

.rhythm-running { display: grid; gap: 6px; justify-items: start; padding: 4px 0 2px; }
.rhythm-countdown {
  font-size: 48px;
  line-height: 52px;
  font-weight: 600;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.rhythm-focus-title { font-size: 14px; line-height: 19px; font-weight: 500; overflow-wrap: anywhere; }

/* ── Today ── */
.rhythm-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; padding: 14px var(--settings-row-pad-x, 14px); }
.rhythm-stat { display: grid; gap: 3px; min-width: 0; }
.rhythm-stat-label { font-size: 11px; line-height: 14px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-muted); }
.rhythm-stat-value { font-size: 20px; line-height: 24px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.rhythm-stat-note { padding: 0 var(--settings-row-pad-x, 14px) 12px; }

/* ── Settings (the host draws its own card; no second frame) ── */
.rhythm-settings .settings-group { margin: 0; }

.rhythm-links { display: flex; flex-wrap: wrap; gap: 16px; padding: 0 calc(var(--settings-row-pad-x, 14px) + 1px); font-size: 13px; }
.rhythm-links a { color: var(--accent); text-decoration: none; }
.rhythm-links a:hover { text-decoration: underline; }

@media (max-width: 680px) {
  .rhythm-root { padding: 20px 16px 48px; }
  .rhythm-two { grid-template-columns: minmax(0, 1fr); }
  .rhythm-dials { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`
