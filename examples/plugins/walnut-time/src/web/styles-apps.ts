/**
 * The Apps tab: the split strip, the invitation, the automation hint, and the app /
 * site rows.
 *
 * Its own file rather than more of styles-views.ts, which is already at the length
 * where a reader stops finding things. Same two rules as the other three: every class
 * is prefixed `wt-`, and every colour is a host theme token or a mix of one.
 *
 * It reuses the report row's `wt-bar-*` geometry and only adds what an app row has
 * that a task row does not: the Walnut chip, the nested sites, the site hue. Nothing
 * here restyles a shared class, so styles.ts can keep injecting styles-views.ts last
 * (its narrow-canvas media query needs to stay the final word).
 */
export const APPS_CSS = `
.wt-ap { display: flex; flex-direction: column; gap: 18px; }

/* Compact next to the Overview's cards: this is one sentence split in three, not four
   independent questions. */
.wt-ap-strip { margin-bottom: 0; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.wt-ap-strip .wt-stat { padding: 12px 14px; }
.wt-ap-strip .wt-stat-value { font-size: 21px; }

/* ── Disabled: the invitation ── */

.wt-ap-invite {
  padding: 22px 24px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 12px);
  max-width: 74ch;
}

.wt-ap-invite h2 { font-size: 17px; margin-bottom: 12px; }

.wt-ap-invite ul {
  margin: 0 0 18px;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--fg-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.wt-ap-enable {
  padding: 8px 18px;
  border: 0;
  border-radius: var(--radius-sm, 8px);
  background: var(--accent);
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.wt-ap-enable:hover:not(:disabled) { background: var(--accent-hover); }
.wt-ap-enable:disabled { opacity: 0.5; cursor: default; }

/* ── The Automation grant hint ── */

.wt-ap-hint {
  padding: 10px 13px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-sm, 8px);
  color: var(--fg-secondary);
  font-size: 12.5px;
  line-height: 1.5;
  max-width: 82ch;
}

/* ── App rows ── */

.wt-ap-app { display: flex; flex-direction: column; gap: 4px; }

/* Neutral, not the human accent: this time is NOT Walnut work, and colouring it like
   the Overview's own lane would say it was. */
.wt-ap-fill { background: color-mix(in srgb, var(--fg-secondary) 62%, transparent); }

.wt-ap-chip {
  flex: none;
  font-style: normal;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--wt-human);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

/* Indented, quieter, and scaled inside its app: a breakdown of the row above it. */
.wt-ap-sites {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 2px 0 6px 18px;
  padding-left: 12px;
  border-left: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
}

.wt-ap-site .wt-bar-title { font-size: 12px; color: var(--fg-secondary); }
.wt-ap-site .wt-bar-track { height: 8px; }
.wt-ap-site .wt-bar-value { font-size: 12px; font-weight: 500; color: var(--fg-secondary); }
.wt-ap-fill-site { background: color-mix(in srgb, var(--fg-muted) 55%, transparent); }

.wt-ap-more {
  align-self: flex-start;
  border: 0;
  background: transparent;
  padding: 2px 0;
  font: inherit;
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
}

.wt-ap-more:hover { text-decoration: underline; }

/* Quiet on purpose: turning this off should be easy to find and impossible to hit by
   accident, so it is a text button at the end rather than a button beside the data. */
.wt-ap-pause {
  align-self: flex-start;
  border: 0;
  background: transparent;
  padding: 4px 0;
  font: inherit;
  font-size: 12px;
  color: var(--fg-muted);
  cursor: pointer;
}

.wt-ap-pause:hover:not(:disabled) { color: var(--fg); text-decoration: underline; }
.wt-ap-pause:disabled { opacity: 0.5; cursor: default; }
`
