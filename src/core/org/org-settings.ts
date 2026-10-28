/**
 * The org's own names, which the user sets on the Org page: what the org is called (the page's
 * title, default "Org") and the user's own role at the top of the org chart (default "Founder").
 * 2026-10-26, the user: "also the org name can be changed", and the chart shows the user above
 * the CEO with a person's icon.
 *
 * Kept in config.yaml under `org` (`name`, `founder_title`), so every client of this Walnut,
 * the Mac app and a companion's copy included, reads the same names, and a hand edit of the
 * file works too. A blank name means the default.
 */

import { getConfig } from '../config-manager.js';
import { modifyConfigDoc } from '../config-store.js';
import type { Config } from '../types.js';
import { DEFAULT_ORG_INSTRUCTIONS } from './core-instructions.js';

export const ORG_NAME_DEFAULT = 'Org';
export const FOUNDER_TITLE_DEFAULT = 'Founder';
/** Longer names are cut: they are a title and a role, not a sentence. */
export const ORG_NAME_MAX = 60;

export interface OrgSettings {
  name: string;
  founderTitle: string;
  /** Walnut's default core instructions for the CEO and a VP (core-instructions.ts), read-only:
   *  what an editor shows while the user has set none of their own. */
  defaultInstructions: { main: string; lead: string };
}

const clean = (v: unknown, max = ORG_NAME_MAX): string =>
  (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '').slice(0, max);

/** The names as shown: the stored ones, else the defaults. */
export function orgSettingsOf(config: Pick<Config, 'org'>): OrgSettings {
  return {
    name: clean(config.org?.name) || ORG_NAME_DEFAULT,
    founderTitle: clean(config.org?.founder_title) || FOUNDER_TITLE_DEFAULT,
    defaultInstructions: { ...DEFAULT_ORG_INSTRUCTIONS },
  };
}

export async function getOrgSettings(): Promise<OrgSettings> {
  return orgSettingsOf(await getConfig());
}

/** Set either name (a blank one goes back to the default). Returns the names as shown now.
 *  Merged under the config write lock, so renaming the org and the role at once keeps both. */
export async function setOrgSettings(patch: { name?: unknown; founderTitle?: unknown }): Promise<OrgSettings> {
  return modifyConfigDoc((doc) => {
    const before = doc.org && typeof doc.org === 'object' && !Array.isArray(doc.org) ? (doc.org as NonNullable<Config['org']>) : {};
    const next: NonNullable<Config['org']> = { ...before };
    if (patch.name !== undefined) {
      const name = clean(patch.name);
      if (name && name !== ORG_NAME_DEFAULT) next.name = name; else delete next.name;
    }
    if (patch.founderTitle !== undefined) {
      const title = clean(patch.founderTitle);
      if (title && title !== FOUNDER_TITLE_DEFAULT) next.founder_title = title; else delete next.founder_title;
    }
    if (Object.keys(next).length) doc.org = next; else delete doc.org;
    return { write: true, result: orgSettingsOf({ org: next }) };
  });
}
