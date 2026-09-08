/**
 * Picking a known service in the add-an-account form, as pure arithmetic.
 *
 * A person with a Gmail address should not have to know what `imap.gmail.com` is: the provider
 * declares the answer (`setupPresets`), and typing the address is enough to choose it. Everything
 * here is data in, data out, so the dialog holds one state object and this file holds the rules.
 *
 * Two rules are load bearing, and both are about not being clever with someone's typing:
 *
 * - A HAND-TYPED VALUE IS NEVER OVERWRITTEN. A preset fills only fields the person has not
 *   touched, so somebody on a mail host that needs port 143 can set it, keep typing their
 *   address, and still have it there when they submit. `edited` is what remembers that, and it
 *   is deliberately separate from "has a value": a field a PREVIOUS preset filled must be
 *   replaced when another one is chosen, or switching Gmail to iCloud leaves Google's hosts in.
 * - NOTHING IS EVER CLEARED. Choosing "Other" only stops the auto-fill, and an address whose
 *   domain matches nothing leaves the form exactly as it is. Emptying fields somebody is looking
 *   at, because they typed one more character of their address, is worse than a wrong guess.
 *
 * "Other" is a CHOICE, not a mode with no way out: while it is chosen, typing an address fills
 * nothing, and clicking any real chip both fills that service and re-arms the matching. That is
 * why it is a member of the same radio group rather than a checkbox off to one side.
 */
import type { AccountSetupField, AccountSetupPreset } from '@/api/mail';

/** The "none of these" chip. Not a provider id, so it can never collide with one. */
export const OTHER_PRESET_ID = '__other__';

export interface PresetState {
  values: Record<string, string>;
  /** Field names the person typed into by hand. */
  edited: string[];
  /** The chosen preset id, `OTHER_PRESET_ID`, or null while nothing is chosen. */
  chosen: string | null;
}

/**
 * The domain half of an address, lowercased. Empty when there is not one yet.
 *
 * ONE trailing dot is stripped: `alice@gmail.com.` is the fully qualified spelling of the same
 * domain, mail clients accept it, and a matcher that compares strings would otherwise treat it as
 * an unknown host and quietly stop filling the servers.
 */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return '';
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain.endsWith('.') ? domain.slice(0, -1) : domain;
}

/** An address shaped enough to have a domain: no spaces, one `@`, a dot in the domain. */
const ADDRESS_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The preset for an address, or undefined.
 *
 * Case-folded on BOTH sides: a preset declares lowercase domains, and `Alice@Gmail.com` is the
 * same account as `alice@gmail.com` to every mail server on earth.
 */
export function presetForAddress(
  presets: AccountSetupPreset[],
  address: string,
): AccountSetupPreset | undefined {
  const domain = domainOf(address);
  if (!domain) return undefined;
  return presets.find((preset) => preset.match?.some((one) => one.trim().toLowerCase() === domain));
}

/**
 * Which field holds the address.
 *
 * The field named `address` when the provider declares one, and otherwise the LAST non-password
 * field whose whole value is shaped like an address. The fallback keeps this from being a naming
 * convention the contract never stated: a provider free to call its fields anything still gets the
 * behaviour.
 *
 * Three details, each one a wrong guess avoided:
 *
 * - The SHAPE is required, not merely an `@`. A display name reading `Alice @ Work` contains one,
 *   and picking that field means every keystroke of somebody's name re-runs the service matching.
 * - The value must be the whole field, so `Alice <alice@gmail.com>` in a display-name field is not
 *   mistaken for the address field either.
 * - LAST, not first, because a form that holds two address-shaped values (a login and an alias, a
 *   username above a contact address) means the later one: forms put the identity first and the
 *   mailbox after it, and the login half is the one that is often not an address at all.
 */
export function addressFieldName(
  fields: AccountSetupField[],
  values: Record<string, string>,
): string | undefined {
  const named = fields.find((field) => field.name === 'address' && field.kind !== 'password');
  if (named) return named.name;
  const shaped = fields.filter(
    (field) => field.kind !== 'password' && ADDRESS_SHAPE.test((values[field.name] ?? '').trim()),
  );
  return shaped.at(-1)?.name;
}

/** Fill from a preset, skipping every field the person typed into themselves. */
export function valuesWithPreset(state: PresetState, preset: AccountSetupPreset): Record<string, string> {
  const next = { ...state.values };
  for (const [name, value] of Object.entries(preset.values)) {
    if (state.edited.includes(name)) continue;
    next[name] = value;
  }
  return next;
}

/**
 * The person typed into `name`.
 *
 * The value is recorded as hand-typed even when it is being emptied: clearing a port that a
 * preset filled is a decision, and re-filling it on the next keystroke of the address would
 * undo it.
 */
export function withTyped(state: PresetState, name: string, value: string): PresetState {
  return {
    ...state,
    values: { ...state.values, [name]: value },
    edited: state.edited.includes(name) ? state.edited : [...state.edited, name],
  };
}

/**
 * Auto-select from whatever the address field now holds.
 *
 * Stays out of the way while "Other" is the choice, and does nothing when the domain matches no
 * preset. The address field itself is never in a preset's `values`, so this cannot fight the typing
 * that triggered it.
 *
 * An address retyped to a foreign domain leaves the chosen chip and its values ALONE, and that was
 * a decision rather than an oversight. Clearing them was considered and rejected: emptying fields
 * somebody is looking at, because they typed one more character, is worse than a stale guess they
 * can see and change. The honest consequence is stated here because it is a real one: the form WILL
 * submit that service's servers with the new address, and the mail server's own refusal is the
 * feedback (a wrong host answers `unreachable`, a right host with the wrong account answers
 * `auth`). Both reach the dialog as a message that keeps the form, with every value still visible.
 * The chip row shows which service is filled in, so the mismatch is on screen the whole time.
 */
export function withAutoPreset(
  state: PresetState,
  presets: AccountSetupPreset[],
  address: string,
): PresetState {
  if (state.chosen === OTHER_PRESET_ID) return state;
  const preset = presetForAddress(presets, address);
  if (!preset) return state;
  return { ...state, chosen: preset.id, values: valuesWithPreset(state, preset) };
}

/**
 * A chip was clicked: the same fill as an address match.
 *
 * "Other" fills nothing and clears nothing, and picking a real chip afterwards re-arms the address
 * matching, because `withAutoPreset` only stands down while `chosen` IS "Other".
 */
export function withChosenPreset(
  state: PresetState,
  presets: AccountSetupPreset[],
  id: string,
): PresetState {
  if (id === OTHER_PRESET_ID) return { ...state, chosen: OTHER_PRESET_ID };
  const preset = presets.find((one) => one.id === id);
  if (!preset) return state;
  return { ...state, chosen: preset.id, values: valuesWithPreset(state, preset) };
}

/**
 * What a preset fills that this form cannot render, in the provider's own terms.
 *
 * Two mistakes, and both are invisible without this. A typo in a NAME (`imap_hostname`) writes a
 * key nothing renders, so the form looks untouched while the chip says the servers were filled in.
 * A wrong VALUE for a `select` is worse, because something does change: the option row ends up with
 * nothing highlighted, so a field that had a valid choice a moment ago now shows none, and the
 * submitted value is one the provider never offered.
 *
 * Reported rather than repaired: the console cannot know which option the provider meant. The
 * values still travel to `submit`, because the provider named them and may read them there.
 */
export function unknownPresetKeys(
  fields: AccountSetupField[],
  presets: AccountSetupPreset[],
): string[] {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const unknown = new Set<string>();
  for (const preset of presets) {
    for (const [name, value] of Object.entries(preset.values)) {
      const field = byName.get(name);
      if (!field) {
        unknown.add(name);
        continue;
      }
      // A select with no declared options has nothing to contradict, so it is left alone.
      if (field.kind !== 'select' || !field.options?.length) continue;
      if (!field.options.some((option) => option.value === value)) unknown.add(`${name}=${value}`);
    }
  }
  return [...unknown];
}

/**
 * The help page's URL, only when it is one a browser should be sent to.
 *
 * `helpUrl` arrives from a PROVIDER PLUGIN and lands in an `href`, so it is checked here rather
 * than trusted: `javascript:` in an href runs in this page, and the mail renderer already refuses
 * that family of schemes (`DANGEROUS_SCHEME` in mail-html.ts). Same posture, one allowed pair.
 * Anything else, including a relative path or an unparseable string, renders no link at all: a
 * missing link is a small loss, and the sentence next to it still says what to do.
 */
export function safeHelpUrl(helpUrl: string | undefined): string | undefined {
  if (!helpUrl) return undefined;
  try {
    const parsed = new URL(helpUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? helpUrl : undefined;
  } catch {
    return undefined;
  }
}
