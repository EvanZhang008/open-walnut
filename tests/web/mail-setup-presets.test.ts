/**
 * Picking a known service in the add-an-account form: the arithmetic, without a browser.
 *
 * Two of these are the whole reason the state carries `edited` at all, and both have a cost a
 * human pays: a preset that overwrites a hand-typed port silently undoes a decision somebody made
 * on purpose (their mail host is one of the ones that really does need 143), and a preset that
 * refuses to replace a value an EARLIER preset wrote leaves Google's servers behind on an iCloud
 * account. The rest pin the two shapes a matcher gets wrong: the case of what was typed, and an
 * address that matches nothing at all.
 */
import { describe, expect, it } from 'vitest';
import type { AccountSetupField, AccountSetupPreset } from '../../web/src/api/mail';
import {
  addressFieldName,
  domainOf,
  OTHER_PRESET_ID,
  presetForAddress,
  safeHelpUrl,
  unknownPresetKeys,
  valuesWithPreset,
  withAutoPreset,
  withChosenPreset,
  withTyped,
  type PresetState,
} from '../../web/src/apps/mail/setup-presets';

const FIELDS: AccountSetupField[] = [
  { name: 'address', label: 'Email address', kind: 'text', required: true },
  { name: 'password', label: 'Password', kind: 'password', required: true },
  { name: 'imap_host', label: 'IMAP server', kind: 'text', required: true },
  { name: 'imap_port', label: 'Port', kind: 'text' },
  { name: 'imap_tls', label: 'Encryption', kind: 'select', options: [
    { value: 'tls', label: 'TLS (port 993)' },
    { value: 'starttls', label: 'STARTTLS (port 143)' },
  ] },
  { name: 'smtp_host', label: 'Outgoing (SMTP) server', kind: 'text' },
  { name: 'smtp_port', label: 'Outgoing port', kind: 'text' },
];

// SYNTHETIC presets, not copies of the shipped ones: the real IMAP presets deliberately carry no
// port (the encryption choice decides it inside `submit`), while the CONTRACT lets a preset fill any
// field the provider declares. These keep a port precisely so the generic fill, and the rule that a
// hand-typed port is never overwritten, are both exercised on a field somebody really does edit.
const GMAIL: AccountSetupPreset = {
  id: 'gmail',
  label: 'Gmail',
  match: ['gmail.com', 'googlemail.com'],
  values: {
    imap_host: 'imap.gmail.com',
    imap_port: '993',
    imap_tls: 'tls',
    smtp_host: 'smtp.gmail.com',
    smtp_port: '587',
  },
  help: 'Gmail needs an app password.',
  helpUrl: 'https://myaccount.google.com/apppasswords',
};

const ICLOUD: AccountSetupPreset = {
  id: 'icloud',
  label: 'iCloud',
  match: ['icloud.com', 'me.com', 'mac.com'],
  values: {
    imap_host: 'imap.mail.me.com',
    imap_port: '993',
    imap_tls: 'tls',
    smtp_host: 'smtp.mail.me.com',
    smtp_port: '587',
  },
};

const PRESETS = [GMAIL, ICLOUD];

function freshState(): PresetState {
  return {
    values: { address: '', password: '', imap_host: '', imap_port: '', imap_tls: 'tls', smtp_host: '', smtp_port: '' },
    edited: [],
    chosen: null,
  };
}

/** What the dialog does on one keystroke in the address field. */
function typeAddress(state: PresetState, address: string): PresetState {
  return withAutoPreset(withTyped(state, 'address', address), PRESETS, address);
}

describe('the domain of an address', () => {
  it('lowercases it and ignores the local part', () => {
    expect(domainOf('alice@Gmail.com')).toBe('gmail.com');
    expect(domainOf('Alice.Smith+mail@GOOGLEMAIL.COM')).toBe('googlemail.com');
    // An address with an @ in the quoted local part: the LAST one separates the domain.
    expect(domainOf('"odd@name"@gmail.com')).toBe('gmail.com');
  });

  it('has no answer for text that is not an address yet', () => {
    expect(domainOf('alice')).toBe('');
    expect(domainOf('')).toBe('');
    expect(domainOf('alice@')).toBe('');
  });

  it('strips one trailing dot, which is the same domain fully qualified', () => {
    expect(domainOf('alice@gmail.com.')).toBe('gmail.com');
    expect(presetForAddress(PRESETS, 'alice@gmail.com.')?.id).toBe('gmail');
    // Only ONE. A doubled dot is not a spelling of anything, so it stays wrong rather than being
    // massaged into a match.
    expect(domainOf('alice@gmail.com..')).toBe('gmail.com.');
  });
});

describe('which preset an address picks', () => {
  it('matches a declared domain whatever the typing looked like', () => {
    expect(presetForAddress(PRESETS, 'alice@Gmail.com')?.id).toBe('gmail');
    expect(presetForAddress(PRESETS, 'alice@googlemail.com')?.id).toBe('gmail');
    expect(presetForAddress(PRESETS, 'alice@me.com')?.id).toBe('icloud');
  });

  it('matches nothing for a domain nobody declared, and never guesses at a near miss', () => {
    expect(presetForAddress(PRESETS, 'alice@example.invalid')).toBeUndefined();
    // A SUBDOMAIN is a different mail host: mail.gmail.com.example.invalid must not be Gmail.
    expect(presetForAddress(PRESETS, 'alice@gmail.com.example.invalid')).toBeUndefined();
    expect(presetForAddress(PRESETS, 'alice')).toBeUndefined();
  });
});

describe('typing an address', () => {
  it('fills the server fields and records which service it chose', () => {
    const state = typeAddress(freshState(), 'alice@gmail.com');
    expect(state.chosen).toBe('gmail');
    expect(state.values).toMatchObject({
      address: 'alice@gmail.com',
      imap_host: 'imap.gmail.com',
      imap_port: '993',
      imap_tls: 'tls',
      smtp_host: 'smtp.gmail.com',
      smtp_port: '587',
    });
    // The credential is never a preset's business.
    expect(state.values.password).toBe('');
  });

  it('leaves the form untouched when the domain matches nothing', () => {
    const state = typeAddress(freshState(), 'alice@example.invalid');
    expect(state.chosen).toBeNull();
    expect(state.values.imap_host).toBe('');
    expect(state.values.smtp_host).toBe('');
  });

  it('never overwrites a value the person typed by hand', () => {
    // The order that matters: a hand-typed port, and only THEN the address that would fill it.
    let state = withTyped(freshState(), 'imap_port', '1993');
    state = typeAddress(state, 'alice@gmail.com');
    expect(state.chosen).toBe('gmail');
    expect(state.values.imap_port).toBe('1993');
    // Everything the person did not touch is still filled.
    expect(state.values.imap_host).toBe('imap.gmail.com');

    // And re-typing the address (the same domain, one character more) does not get a second go.
    state = typeAddress(state, 'alice2@gmail.com');
    expect(state.values.imap_port).toBe('1993');
  });

  it('does replace what an EARLIER preset filled, so switching service is complete', () => {
    let state = typeAddress(freshState(), 'alice@gmail.com');
    state = typeAddress(state, 'alice@me.com');
    expect(state.chosen).toBe('icloud');
    expect(state.values.imap_host).toBe('imap.mail.me.com');
    expect(state.values.smtp_host).toBe('smtp.mail.me.com');
  });

  it('keeps a hand-emptied field empty', () => {
    // Clearing a filled port is a decision, and the next keystroke of the address must not undo it.
    let state = typeAddress(freshState(), 'alice@gmail.com');
    state = withTyped(state, 'imap_port', '');
    state = typeAddress(state, 'alice@gmail.com');
    expect(state.values.imap_port).toBe('');
  });
});

describe('choosing a chip', () => {
  it('fills the same values a matching address would have', () => {
    const typed = typeAddress(freshState(), 'someone@example.invalid');
    const chosen = withChosenPreset(typed, PRESETS, 'gmail');
    expect(chosen.chosen).toBe('gmail');
    expect(chosen.values.imap_host).toBe('imap.gmail.com');
    // The address the person typed is theirs, and a chip does not rewrite it.
    expect(chosen.values.address).toBe('someone@example.invalid');
  });

  it('Other clears nothing and stops the auto-fill for good', () => {
    let state = typeAddress(freshState(), 'alice@gmail.com');
    state = withChosenPreset(state, PRESETS, OTHER_PRESET_ID);
    expect(state.chosen).toBe(OTHER_PRESET_ID);
    // Nothing was cleared: the fields the human is looking at stay as they are.
    expect(state.values.imap_host).toBe('imap.gmail.com');

    // And a matching address no longer fills anything, including after an edit.
    state = withTyped(state, 'imap_host', 'imap.example.invalid');
    state = typeAddress(state, 'bob@me.com');
    expect(state.chosen).toBe(OTHER_PRESET_ID);
    expect(state.values.imap_host).toBe('imap.example.invalid');
  });

  it('ignores an id no provider declared', () => {
    const state = withChosenPreset(freshState(), PRESETS, 'nothing-like-this');
    expect(state.chosen).toBeNull();
    expect(state.values.imap_host).toBe('');
  });
});

describe('which field the address is in', () => {
  it('is the field named address when the provider declares one', () => {
    expect(addressFieldName(FIELDS, freshState().values)).toBe('address');
  });

  it('falls back to a non-password field whose whole value is shaped like an address', () => {
    const fields: AccountSetupField[] = [
      { name: 'label', label: 'Name', kind: 'text' },
      { name: 'secret', label: 'App password', kind: 'password' },
      { name: 'login', label: 'Login', kind: 'text' },
    ];
    expect(addressFieldName(fields, { label: 'Work', secret: 'p@ss', login: 'alice@gmail.com' })).toBe('login');
    // Nothing looks like an address yet, so nothing is guessed at.
    expect(addressFieldName(fields, { label: 'Work', secret: 'p@ss', login: '' })).toBeUndefined();
  });

  it('is not fooled by a display name that merely contains an @', () => {
    const fields: AccountSetupField[] = [
      { name: 'label', label: 'Display name', kind: 'text' },
      { name: 'login', label: 'Login', kind: 'text' },
    ];
    // `Alice @ Work` has an @ and is not an address. Picking it would re-run the service matching
    // on every keystroke of somebody's name.
    expect(addressFieldName(fields, { label: 'Alice @ Work', login: '' })).toBeUndefined();
    expect(addressFieldName(fields, { label: 'Alice @ Work', login: 'alice@gmail.com' })).toBe('login');
    // A name-and-address string is not the address field either: the value has to BE the address.
    expect(addressFieldName(fields, { label: 'Alice <alice@gmail.com>', login: '' })).toBeUndefined();
    // A password is never considered, however address-shaped it happens to be.
    expect(addressFieldName(
      [{ name: 'secret', label: 'Password', kind: 'password' }],
      { secret: 'alice@gmail.com' },
    )).toBeUndefined();
  });

  it('prefers the LAST address-shaped field, because forms put the identity before the mailbox', () => {
    const fields: AccountSetupField[] = [
      { name: 'login', label: 'Login', kind: 'text' },
      { name: 'mailbox', label: 'Mailbox address', kind: 'text' },
    ];
    expect(addressFieldName(fields, { login: 'alice@corp.invalid', mailbox: 'alice@gmail.com' }))
      .toBe('mailbox');
  });
});

describe('the help link', () => {
  it('passes an http or https page through', () => {
    expect(safeHelpUrl('https://myaccount.google.com/apppasswords'))
      .toBe('https://myaccount.google.com/apppasswords');
    expect(safeHelpUrl('http://help.example.invalid/app-passwords'))
      .toBe('http://help.example.invalid/app-passwords');
  });

  it('refuses a scheme a click would execute, so no link renders at all', () => {
    // `helpUrl` comes from a PROVIDER PLUGIN and lands in an href. The mail renderer already
    // refuses this family (DANGEROUS_SCHEME in mail-html.ts) and this is the same posture: the
    // sentence still renders and says what to do, it just has nothing clickable behind it.
    expect(safeHelpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHelpUrl('JavaScript:alert(1)')).toBeUndefined();
    expect(safeHelpUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeHelpUrl('vbscript:msgbox(1)')).toBeUndefined();
  });

  it('refuses anything that is not an absolute URL, and an absent one', () => {
    expect(safeHelpUrl('/app-passwords')).toBeUndefined();
    expect(safeHelpUrl('help.example.invalid/passwords')).toBeUndefined();
    expect(safeHelpUrl('')).toBeUndefined();
    expect(safeHelpUrl(undefined)).toBeUndefined();
  });
});

describe('a preset the form cannot render', () => {
  it('names the keys no field declares, so a provider typo is reportable', () => {
    const typo: AccountSetupPreset = {
      id: 'typo', label: 'Typo', values: { imap_hostname: 'imap.example.invalid', imap_port: '993' },
    };
    expect(unknownPresetKeys(FIELDS, [GMAIL, typo])).toEqual(['imap_hostname']);
    expect(unknownPresetKeys(FIELDS, PRESETS)).toEqual([]);
  });

  it('names a select value the field does not offer, which is the worse half of the same mistake', () => {
    // This one CHANGES something: the option row ends up with nothing highlighted, so a field that
    // had a valid choice a moment ago shows none, and the submitted value is one the provider never
    // offered. Reported with the value, since that is what makes it findable in the provider.
    const wrongOption: AccountSetupPreset = {
      id: 'ssl', label: 'SSL', values: { imap_host: 'imap.example.invalid', imap_tls: 'ssl' },
    };
    expect(unknownPresetKeys(FIELDS, [wrongOption])).toEqual(['imap_tls=ssl']);
    // The valid one stays silent, and a text field is never option-checked.
    expect(unknownPresetKeys(FIELDS, [GMAIL])).toEqual([]);
    expect(unknownPresetKeys(FIELDS, [{
      id: 'text', label: 'Text', values: { imap_host: 'anything at all' },
    }])).toEqual([]);
  });

  it('leaves a select with no declared options alone, since there is nothing to contradict', () => {
    const fields: AccountSetupField[] = [{ name: 'mode', label: 'Mode', kind: 'select' }];
    expect(unknownPresetKeys(fields, [{
      id: 'any', label: 'Any', values: { mode: 'whatever' },
    }])).toEqual([]);
  });

  it('still fills the keys that do exist', () => {
    const state = valuesWithPreset(freshState(), {
      id: 'partial', label: 'Partial', values: { imap_host: 'imap.example.invalid' },
    });
    expect(state.imap_host).toBe('imap.example.invalid');
    expect(state.smtp_host).toBe('');
  });
});
