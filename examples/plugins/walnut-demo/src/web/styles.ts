export const DEMO_CSS = `
.wd-root {
  --wd-gap: 16px;
  display: grid;
  gap: var(--wd-gap);
  padding: 20px;
  max-width: 100%;
  box-sizing: border-box;
  color: var(--fg);
  font-family: inherit;
  overflow-x: hidden;
}
.wd-root *, .wd-root *::before, .wd-root *::after { box-sizing: border-box; }
.wd-root h1 { margin: 4px 0 6px; font-size: 22px; line-height: 1.2; }
.wd-root h3 { margin: 0; font-size: 14px; font-weight: 650; }
.wd-root p { margin: 0; }
.wd-root code { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }

.wd-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.wd-header p { color: var(--fg-muted); font-size: 13px; max-width: 68ch; }
.wd-kicker { color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }

.wd-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.wd-tab {
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card-bg);
  color: var(--fg-secondary);
  font-size: 13px;
  cursor: pointer;
}
.wd-tab:hover { background: var(--bg-hover); }
.wd-tab-active { border-color: var(--accent); background: var(--accent-subtle); color: var(--accent); font-weight: 600; }
.wd-tabs-inner { margin-bottom: 10px; }

.wd-section { display: block; min-width: 0; }
.wd-grid { display: grid; gap: var(--wd-gap); grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: start; }
.wd-compact .wd-grid { grid-template-columns: 1fr; }
.wd-stack { display: grid; gap: var(--wd-gap); }

.wd-card {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-bg);
  box-shadow: var(--card-shadow);
}
.wd-card-head { display: grid; gap: 4px; }
.wd-card-head p { color: var(--fg-muted); font-size: 12px; line-height: 1.45; }
.wd-card-body { display: grid; gap: 12px; min-width: 0; }

.wd-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; min-width: 0; }
.wd-action { display: grid; gap: 8px; min-width: 0; }
.wd-action-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.wd-button {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--fg);
  font-size: 13px;
  font-weight: 550;
  cursor: pointer;
}
.wd-button:hover:not(:disabled) { background: var(--bg-hover); }
.wd-button:disabled { opacity: 0.55; cursor: default; }
.wd-button-primary { border-color: var(--accent); background: var(--accent-subtle); color: var(--accent); }
.wd-button-danger { border-color: var(--error); color: var(--error); background: transparent; }
.wd-button:focus-visible, .wd-tab:focus-visible, .wd-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.wd-input {
  flex: 1 1 200px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}

.wd-chip {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
  background: var(--bg-tertiary);
  color: var(--fg-secondary);
}
.wd-chip-ok { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
.wd-chip-bad { background: color-mix(in srgb, var(--error) 18%, transparent); color: var(--error); }
.wd-chip-warn { background: color-mix(in srgb, var(--warning) 20%, transparent); color: var(--warning); }

.wd-muted { color: var(--fg-muted); font-size: 12px; }
.wd-empty { padding: 24px; color: var(--fg-muted); font-size: 13px; text-align: center; }
.wd-deeplink {
  padding: 8px 10px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
  user-select: all;
}

.wd-receipt { border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-secondary); overflow: hidden; }
.wd-receipt-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.wd-receipt[data-ok="false"] { border-color: color-mix(in srgb, var(--error) 45%, var(--border)); }
.wd-receipt pre, .wd-events pre {
  margin: 0;
  padding: 10px;
  max-height: 220px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
}

.wd-facts { display: grid; gap: 6px; margin: 0; }
.wd-facts > div { display: flex; gap: 10px; justify-content: space-between; align-items: baseline; font-size: 12px; }
.wd-facts dt { color: var(--fg-muted); }
.wd-facts dd { margin: 0; text-align: right; overflow-wrap: anywhere; }

.wd-tokens { display: grid; gap: 6px; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); margin: 0; padding: 0; list-style: none; }
.wd-tokens li { display: flex; gap: 8px; align-items: center; min-width: 0; }
.wd-swatch { width: 18px; height: 18px; flex: 0 0 auto; border: 1px solid var(--border); border-radius: 5px; }

.wd-events { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.wd-events li { display: grid; gap: 4px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-secondary); }
.wd-events span { font-size: 11px; }

.wd-table-wrap { overflow-x: auto; }
.wd-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.wd-table th, .wd-table td { padding: 7px 8px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
.wd-table th { color: var(--fg-muted); font-weight: 600; white-space: nowrap; }

/* Host views are full surfaces: give them a real box and let them scroll inside it. */
.wd-view-host {
  min-height: 420px;
  max-height: 70vh;
  min-width: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card-bg);
}
.wd-compact .wd-view-host { min-height: 340px; max-height: 60vh; }

.wd-settings { padding: 0; }
`
