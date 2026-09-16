/**
 * What this provider knows about the mail services people actually add.
 *
 * Facts about SOMEBODY ELSE'S service, kept apart from the transport in provider.ts on purpose: a
 * wrong hostname here does not fail at build time, it fails as "Walnut cannot reach my mail" for
 * the one person whose provider it is, so it wants its own file, its own tests and its own review.
 *
 * Two rules the table encodes:
 *
 * - A PRESET NAMES NO PORT. It fills the host and the encryption choice, and `submit` derives the
 *   port from that choice (993/143 for IMAP, 465/587 for submission), which is the only way the
 *   two can never disagree. A preset that wrote `993` looked right until somebody switched the
 *   encryption to STARTTLS underneath it and submitted 993 with STARTTLS, a combination no server
 *   speaks. The fields' placeholders still show the numbers, so nothing is hidden from the human.
 * - `help` IS PER SERVICE. Four of these want an app password and Outlook.com no longer accepts
 *   one at all, so one shared sentence would be a confident wrong answer for the one service where
 *   following it cannot work.
 * - A SERVICE THAT FILES ITS OWN SENT COPY says so here, and setup stamps that on the account
 *   (`serverFilesSentCopy`). Gmail saves anything sent through its own SMTP, so a Walnut copy on
 *   top gives the human two of every message in Sent, and asking them to know that about their own
 *   mail host is asking the wrong person.
 */
import type { AccountSetupPreset } from '../mail/api.js'
import type { SmtpSecurity } from './smtp.js'

/**
 * The port the form MEANT, from what it typed and which encryption it chose.
 *
 * 993 is IMAP over TLS and 143 is IMAP with STARTTLS; 465 and 587 are that pair for submission.
 * These four numbers are the provider's knowledge, so both readings of the field live here:
 *
 * - EMPTY means "whatever this encryption uses", which is what makes a preset able to skip the port.
 * - The canonical port of the OTHER encryption means the same thing, because the only way to get
 *   one is to fill the form in one order and change it in another (fill from a known service, then
 *   switch the encryption underneath). Submitting 993 with STARTTLS reaches a port that is not
 *   speaking STARTTLS, and the human sees "unreachable" for a form that looks correct.
 *
 * Any OTHER number is left exactly as typed: 1143 and 2525 are somebody's real mail host, and
 * second-guessing those would break the accounts that need them.
 */
function portFor(raw: string | undefined, tlsPort: number, plainPort: number, isTls: boolean): number {
  const meant = isTls ? tlsPort : plainPort
  const theOther = isTls ? plainPort : tlsPort
  const typed = Number(raw)
  if (!typed || typed === theOther) return meant
  return typed
}

export function imapPortFor(raw: string | undefined, tls: 'tls' | 'starttls'): number {
  return portFor(raw, 993, 143, tls === 'tls')
}

export function submissionPortFor(raw: string | undefined, security: SmtpSecurity): number {
  // `none` submits on 587 like STARTTLS does: 465 is the implicit-TLS port and nothing else.
  return portFor(raw, 465, 587, security === 'tls')
}

interface KnownService {
  id: string
  label: string
  domains: string[]
  imapHost: string
  smtpHost: string
  /** How that vendor words the credential, since its own words are what a human will look for. */
  help: string
  helpUrl?: string
  /** This service's own SMTP files the Sent copy, so this plugin must not add a second one. */
  savesSentItself?: boolean
}

/** One known service, from the vendor's own documented settings, as the form's data. */
function presetOf(one: KnownService): AccountSetupPreset {
  return {
    id: one.id,
    label: one.label,
    match: one.domains,
    // Host and encryption only. See the file comment for why there is no port here.
    values: {
      imap_host: one.imapHost,
      imap_tls: 'tls',
      smtp_host: one.smtpHost,
    },
    help: one.help,
    ...(one.helpUrl ? { helpUrl: one.helpUrl } : {}),
  }
}

const KNOWN: KnownService[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imapHost: 'imap.gmail.com',
    smtpHost: 'smtp.gmail.com',
    // Verified behaviour, and the reason `server_saves_sent` exists: Gmail files a copy of anything
    // sent through smtp.gmail.com, so an IMAP APPEND on top is the second one the human sees.
    savesSentItself: true,
    help: 'Gmail refuses your normal account password here. Turn on two-step verification, then make an app password for Walnut.',
    helpUrl: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'icloud',
    label: 'iCloud',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imapHost: 'imap.mail.me.com',
    smtpHost: 'smtp.mail.me.com',
    help: 'iCloud Mail needs an app specific password, not the password you sign in with. Your Apple Account needs two factor turned on to make one.',
    helpUrl: 'https://support.apple.com/en-us/102654',
  },
  {
    id: 'outlook',
    label: 'Outlook.com',
    domains: ['outlook.com', 'hotmail.com', 'live.com'],
    imapHost: 'outlook.office365.com',
    smtpHost: 'smtp-mail.outlook.com',
    // The one entry that does NOT say "use an app password", because Microsoft no longer takes
    // one: outlook.office365.com and imap-mail.outlook.com both answer `LOGINDISABLED` with
    // `AUTH=XOAUTH2` as the only mechanism, verified against the live servers on 2026-09-08, and
    // Microsoft's own settings page lists OAuth2 as the authentication method for IMAP, POP and
    // SMTP. Filling the servers is still worth doing, and saying so here is what turns a
    // guaranteed sign-in failure into one sentence read before anybody types a password.
    help: 'Outlook.com no longer accepts a password or an app password for mail apps: Microsoft requires an OAuth sign-in, which this provider cannot do yet, so an account added here will be refused. IMAP also has to be switched on in Outlook.com settings first.',
    helpUrl: 'https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    imapHost: 'imap.fastmail.com',
    smtpHost: 'smtp.fastmail.com',
    help: 'Fastmail needs an app password that includes mail access, never your login password.',
    helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
  },
  {
    id: 'yahoo',
    label: 'Yahoo',
    domains: ['yahoo.com'],
    imapHost: 'imap.mail.yahoo.com',
    smtpHost: 'smtp.mail.yahoo.com',
    help: 'Yahoo Mail needs an app password for other mail apps, not your account password.',
    helpUrl: 'https://help.yahoo.com/kb/SLN15241.html',
  },
]

export const SETUP_PRESETS: AccountSetupPreset[] = KNOWN.map(presetOf)

/**
 * Does this outgoing server file its own Sent copy?
 *
 * Answered from the table above by HOST, not by which preset chip was showing: the host is what the
 * account is actually saved with, and a human who picked "Other" and typed smtp.gmail.com has the
 * same server and the same duplicate-copy problem. `undefined` means "nothing known about this
 * host", which leaves the account on the plugin-level default rather than stamping a guess.
 */
export function serverFilesSentCopy(smtpHost: string | undefined): boolean | undefined {
  const host = smtpHost?.trim().toLowerCase()
  if (!host) return undefined
  const known = KNOWN.find((one) => one.smtpHost.toLowerCase() === host)
  return known?.savesSentItself === true ? true : undefined
}
