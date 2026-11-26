/**
 * The page's stylesheet: every class is prefixed `ni-` (injected CSS is global while the plugin
 * is mounted) and every colour is a host theme token, so light and dark both work. It speaks
 * Settings: a heading over a card, 44px rows with hairlines, 14px labels, 12.5px help.
 */
export const IMPORT_CSS = `
.ni-root {
  box-sizing: border-box;
  max-width: 760px;
  margin: 0 auto;
  padding: 28px 24px 56px;
  color: var(--fg);
  font-family: inherit;
  display: grid;
  gap: 22px;
}
.ni-root *, .ni-root *::before, .ni-root *::after { box-sizing: border-box; }
.ni-root h1 { margin: 0; } /* its type is the console's page title (.page-title) */
.ni-root h2 { margin: 0; font-size: 13px; line-height: 18px; font-weight: 600; color: var(--fg-secondary); }
.ni-root p { margin: 0; }
.ni-lede { margin-top: 4px; max-width: 64ch; color: var(--fg-muted); font-size: 13px; line-height: 18px; }
.ni-muted { color: var(--fg-muted); font-size: 12.5px; line-height: 17px; }
.ni-pad { padding: 8px 10px; }

.ni-block { display: grid; gap: 6px; min-width: 0; }
.ni-block-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 0 15px; }
.ni-block-help { padding: 0 15px; }
.ni-group {
  background: var(--settings-group-bg, var(--card-bg, var(--bg)));
  border: 1px solid var(--settings-group-border, var(--border));
  border-radius: 10px;
  overflow: hidden;
}
.ni-group + .ni-group { margin-top: 8px; }

.ni-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 44px;
  padding: 10px 14px;
}
.ni-row-top { align-items: flex-start; }
.ni-row + .ni-row::before, .ni-steps + .ni-row::before, .ni-row + .ni-steps::before {
  content: '';
  position: absolute;
  top: 0;
  left: 14px;
  right: 14px;
  height: 1px;
  background: var(--settings-hairline, var(--border));
}
.ni-row-copy { flex: 1 1 auto; min-width: 0; display: grid; gap: 3px; font-size: 14px; line-height: 19px; }
.ni-help { color: var(--fg-muted); font-size: 12.5px; line-height: 17px; max-width: 62ch; overflow-wrap: anywhere; }
.ni-help b { color: var(--fg-secondary); font-weight: 600; }
.ni-help[data-tone="warn"] { color: var(--priority-important-text, #9e5300); }
.ni-help[data-tone="error"] { color: var(--settings-error-text, #c4221a); }
.ni-help.ni-note { justify-self: start; padding: 4px 8px; border-radius: 6px; background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--fg); }
.ni-row-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; margin-left: auto; }

.ni-step {
  flex: 0 0 auto;
  align-self: flex-start;
  margin-top: 1px;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--fg-secondary);
  font-size: 11.5px;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.ni-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 999px; background: var(--success, #2f9e5b); }
.ni-dot[data-tone="error"] { background: var(--settings-error-text, #c4221a); }

.ni-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* Keys are the family's (btn, btn-sm, btn-primary, btn-danger); an inline note link is its btn-link,
   left aligned and free to wrap a long path. */
.ni-link { white-space: normal; text-align: left; overflow-wrap: anywhere; }
.ni-plan-actions { position: sticky; bottom: 0; z-index: 1; background: var(--settings-group-bg, var(--card-bg, var(--bg))); }

.ni-input {
  height: 28px;
  min-width: 0;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--input-bg, var(--bg));
  color: var(--fg);
  font: inherit;
  font-size: 13px;
}
.ni-inline-form { display: flex; gap: 8px; margin-top: 6px; max-width: 460px; }
.ni-inline-form .ni-input { flex: 1 1 auto; }
.ni-folder { width: 220px; }
.ni-folder-prefix { color: var(--fg-muted); font-size: 13px; }
.ni-filter { width: 100%; margin-bottom: 6px; }

.ni-choice { display: grid; gap: 6px; margin-top: 6px; }
.ni-radio, .ni-check { display: flex; align-items: center; gap: 8px; font-size: 13.5px; line-height: 18px; cursor: pointer; }
.ni-radio input, .ni-check input { margin: 0; accent-color: var(--accent); }
/* Drawn here: WebKit's own radio reads as filled in dark mode. */
.ni-radio input {
  appearance: none; -webkit-appearance: none; flex: 0 0 auto;
  box-sizing: border-box; width: 14px; min-width: 14px; max-width: 14px; height: 14px; padding: 0; border-radius: 999px;
  border: 1.5px solid var(--fg-muted); background: transparent; cursor: pointer;
}
.ni-radio input:checked { border-color: var(--accent); box-shadow: inset 0 0 0 2.5px var(--settings-group-bg, var(--bg)), inset 0 0 0 7px var(--accent); }
.ni-radio input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ni-radio input:disabled { opacity: 0.5; cursor: default; }
/* Checkboxes too: WebKit's own box is a bright white square on a dark page. */
.ni-check input[type="checkbox"], input.ni-keep {
  appearance: none; -webkit-appearance: none; flex: 0 0 auto; display: inline-grid; place-content: center;
  box-sizing: border-box; width: 14px; min-width: 14px; max-width: 14px; height: 14px; padding: 0; border-radius: 3px;
  border: 1.5px solid var(--fg-muted); background: transparent; cursor: pointer;
}
.ni-check input[type="checkbox"]:checked, input.ni-keep:checked, input.ni-keep:indeterminate { border-color: var(--accent); background: var(--accent); }
.ni-check input[type="checkbox"]:checked::after, input.ni-keep:checked::after {
  content: ''; width: 7px; height: 3.5px; border: solid #fff; border-width: 0 0 1.75px 1.75px; transform: translateY(-1px) rotate(-45deg);
}
input.ni-keep:indeterminate::after { content: ''; width: 7px; height: 1.75px; background: #fff; border: 0; transform: none; }
.ni-check input[type="checkbox"]:focus-visible, input.ni-keep:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ni-check input[type="checkbox"]:disabled, input.ni-keep:disabled { opacity: 0.5; cursor: default; }
.ni-picker { display: grid; gap: 6px; margin-top: 8px; max-width: 520px; }
.ni-picker-list {
  display: grid;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.ni-check { padding: 7px 10px; }
.ni-check + .ni-check { border-top: 1px solid var(--settings-hairline, var(--border)); }
.ni-check-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ni-run-title { font-weight: 600; }
.ni-bar { height: 6px; margin-top: 6px; border-radius: 999px; background: var(--bg-secondary, var(--border)); overflow: hidden; max-width: 520px; }
.ni-bar-fill { height: 100%; width: 0; border-radius: 999px; background: var(--accent); transition: width 0.3s ease; }
.ni-bar-fill[data-indeterminate="true"] { width: 30%; animation: ni-slide 1.2s ease-in-out infinite; }
@keyframes ni-slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
.ni-current { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ni-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 4px; font-size: 12.5px; color: var(--fg-secondary); }
.ni-stat b { color: var(--fg); font-variant-numeric: tabular-nums; }
.ni-stat[data-tone="error"], .ni-stat[data-tone="error"] b { color: var(--settings-error-text, #c4221a); }
.ni-stat[data-tone="warn"], .ni-stat[data-tone="warn"] b { color: var(--priority-important-text, #9e5300); }

.ni-details { padding: 0 14px 12px; font-size: 12.5px; line-height: 17px; color: var(--fg-secondary); }
.ni-row-copy .ni-details { padding: 4px 0 0; }
.ni-details summary { cursor: pointer; color: var(--fg-muted); }
.ni-details ul { margin: 4px 0 0; padding-left: 18px; display: grid; gap: 2px; }
.ni-details-head { display: block; margin-top: 8px; font-weight: 600; color: var(--fg-secondary); }
.ni-detail-group { display: grid; gap: 2px; margin-top: 8px; }
/* A big import lists hundreds of notes: each list scrolls in its own box under its count. */
.ni-detail-group ul { max-height: 200px; overflow-y: auto; padding-right: 6px; }
.ni-detail-group li { padding: 2px 0; }
.ni-acts { display: inline-flex; flex-wrap: wrap; gap: 6px; margin-left: 10px; vertical-align: middle; }
.ni-confirm-inline { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: 10px; }
.ni-confirm-inline .ni-acts { margin-left: 0; }
.ni-list-actions { display: block; padding-left: 18px; margin-top: 4px; }

.ni-plan-summary { font-size: 13.5px; line-height: 19px; max-width: 64ch; }
.ni-steps { position: relative; list-style: none; margin: 0; padding: 4px 0; }
.ni-steps-inner { max-height: none; overflow: visible; padding: 2px 0 0; margin-left: -14px; }
.ni-step-label { cursor: pointer; }
.ni-steps-inner .ni-step-line { padding: 4px 14px; }
.ni-keep { margin: 2px 0 0; }
.ni-keep-space { flex: 0 0 14px; }
.ni-step-line[data-left-out="true"] > .ni-kind, .ni-step-line[data-left-out="true"] > .ni-step-copy > .ni-step-text { opacity: 0.5; text-decoration: line-through; }
.ni-step-line { display: flex; gap: 10px; align-items: flex-start; padding: 7px 14px; }
.ni-step-line[data-ok="false"] { opacity: 0.6; }
.ni-step-copy { display: grid; gap: 1px; min-width: 0; font-size: 13px; line-height: 18px; }
.ni-step-text { overflow-wrap: anywhere; }
.ni-step-copy .ni-preview { padding: 2px 0 0; }
.ni-preview-text { max-height: 320px; overflow-y: auto; margin: 6px 0 0; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); color: var(--fg); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; display: grid; gap: 4px; }
.ni-preview-text p { margin: 0; }
.ni-preview-text[data-full] { max-height: none; }
.ni-compare { display: grid; gap: 6px; margin: 6px 0 4px; min-width: 0; }
.ni-compare-key { display: flex; flex-wrap: wrap; gap: 6px; }
.ni-diff-chip { font-size: 12px; padding: 1px 8px; border-radius: var(--radius-full); }
.ni-diff-chip[data-side="mine"], .ni-diff-line[data-side="mine"] { background: color-mix(in srgb, #d73a49 16%, transparent); }
.ni-diff-chip[data-side="notion"], .ni-diff-line[data-side="notion"] { background: color-mix(in srgb, #22a06b 18%, transparent); }
.ni-diff-line { display: block; min-height: 1.4em; padding-left: 1.6em; text-indent: -1.6em; }
.ni-diff-line[data-side="fold"] { color: var(--fg-secondary); font-style: italic; padding-left: 1.6em; text-indent: 0; }
.ni-diff-mark { display: inline-block; width: 1.6em; text-indent: 0; color: var(--fg-secondary); user-select: none; }
.ni-compare pre { margin: 0; padding: 8px 10px; max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); color: var(--fg); font: 12.5px/18px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.ni-preview-text ul { margin: 0; padding-left: 18px; list-style: disc; display: grid; gap: 1px; }
.ni-preview-heading { font-weight: 600; }
.ni-preview-link { font-weight: 500; }
.ni-kind {
  flex: 0 0 auto;
  min-width: 48px;
  margin-top: 1px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 16px;
  text-align: center;
  color: var(--fg-secondary);
}
.ni-spinner {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  animation: ni-spin 0.9s linear infinite;
}
@keyframes ni-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ni-spinner, .ni-bar-fill[data-indeterminate="true"] { animation: none; }
}
@media (max-width: 560px) {
  .ni-row { flex-wrap: wrap; }
  .ni-row-actions { margin-left: 0; }
  .ni-folder { width: 100%; }
}
`
