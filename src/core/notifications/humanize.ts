/**
 * Error-notification humanizer: the ONE translation layer between a log line and
 * a card a person can read.
 *
 * The Errors rail used to show the producer's own words verbatim — titles were
 * raw log messages ('transport start failed', 'stream-convergence VIOLATION:
 * streamed message(s) missing from persisted history') and bodies were the log
 * meta serialized as JSON ('[web] {"holders":[{"pid":22198,…'). That is a log
 * file with a red dot, not a notification: the user cannot tell what broke, what
 * it means, or whether three cards are one problem.
 *
 * So every error record now gets three things derived here, at WRITE time (so the
 * iOS app and /api/v1 consumers get the same copy, not just the web panel):
 *   - `category` — the family it belongs to, which is what the rail groups by.
 *   - `title` — a short human sentence fragment.
 *   - `message` — ONE plain sentence saying what it means.
 * The raw technical line survives as the record's `detail`, behind a toggle. It
 * is never the primary body again.
 *
 * Design rules this file encodes:
 *   - PURE, and deliberately import-free. The log-error bridge is installed BY
 *     the logging layer's sink and must stay leaf-ish (see the import-closure
 *     note in log-error-bridge.ts), and a rule table is worth unit-testing
 *     without booting anything.
 *   - Rules are ORDERED and explicit, never a clever generic parser: each entry
 *     matches one production error family, so a rule can be read next to the
 *     log call it translates. An unmatched error still degrades to something
 *     readable (see `fallbackTitle`) — it must NEVER fall back to a JSON dump.
 *   - Redaction is the CALLER's job, not this module's. `publishErrorNotification`
 *     redacts its body before calling in, so its output is already clean; the log
 *     bridge reads raw log meta, so it redacts the sentence this returns (one
 *     regex per new card, off any hot path). A pure translator that also had to
 *     own a security property would invite exactly one caller to forget.
 *   - Plugin ids are DATA: they arrive from the user's own installed plugins at
 *     runtime, so no plugin name appears anywhere in this file.
 */

export interface HumanizedError {
  /** The family this error belongs to — the Errors rail groups by it. */
  category: string;
  /** Short human title for the card. */
  title: string;
  /** One plain sentence. Empty string = the title says everything. */
  message: string;
}

export interface HumanizeErrorInput {
  /** The producer's title (a log message, or a hand-written notification title). */
  title: string;
  /** The producer's body, when it wrote one (hand-published notifications do). */
  body?: string;
  /** Logger subsystem (`session`, `web`, `plugin/<id>`, `<id>/http`, …). */
  subsystem?: string;
  /** The condition id, when the producer named one (see notification-lifecycle.md). */
  recoveryKey?: string;
  /** Structured log meta — the raw material for most messages below. */
  meta?: Record<string, unknown>;
}

export interface HumanizeOptions {
  /**
   * Redaction hook, applied to every piece of FREE TEXT this module reads
   * (title, body, string-valued meta) BEFORE any rule sees it.
   *
   * Injected rather than imported so this module stays pure and import-free, and
   * applied at ENTRY rather than to the finished sentence for a specific reason:
   * a sentence is truncated on its way out (`firstSentence`), and a cut landing
   * inside `Bearer <token>` would leave the token with its recognizable prefix
   * gone — redacting after that point would silently miss it. Cleaning the raw
   * material first means no rule can compose a secret into its output at all.
   */
  sanitize?: (text: string) => string;
}

// ── Category labels ──────────────────────────────────────────────────────────
//
// A closed set (plus one open slot: a plugin's own display name). Kept small on
// purpose — a category the user sees twice is a group; a category they see once
// is just a longer title.

export const CATEGORY_SESSIONS = 'Sessions';
export const CATEGORY_API = 'API';
export const CATEGORY_DATA = 'Data & Sync';
export const CATEGORY_SERVER = 'Server';
export const CATEGORY_INTERNAL = 'Internal';
export const CATEGORY_CLOUD = 'Cloud';
export const CATEGORY_TASKS = 'Tasks';
export const CATEGORY_AI = 'Personal AI';
export const CATEGORY_AUTOMATION = 'Automation';
export const CATEGORY_OTHER = 'Other';

/**
 * Subsystem root → category, for Walnut's OWN subsystems.
 *
 * Doubles as the core-subsystem check: a root present here is core, so a root
 * that is ABSENT is treated as a plugin's own logger and becomes that plugin's
 * display name (same assumption `recoveryKeyOf` makes in log-error-bridge.ts —
 * a plugin's bespoke subsystem name IS its id). Keep in step with the
 * CORE_SUBSYSTEM_ROOTS denylist over there; the cost of a missing root is only
 * that its errors group under the plugin-ish capitalized name instead of a
 * Walnut category.
 */
const SUBSYSTEM_CATEGORY: Record<string, string> = {
  session: CATEGORY_SESSIONS,
  obs: CATEGORY_SESSIONS,
  daemon: CATEGORY_SESSIONS,
  subagent: CATEGORY_AI,
  agent: CATEGORY_AI,
  web: CATEGORY_API,
  ws: CATEGORY_API,
  git: CATEGORY_DATA,
  memory: CATEGORY_DATA,
  bus: CATEGORY_INTERNAL,
  notif: CATEGORY_INTERNAL,
  heartbeat: CATEGORY_INTERNAL,
  hook: CATEGORY_AUTOMATION,
  cron: CATEGORY_AUTOMATION,
  skill: CATEGORY_AUTOMATION,
  task: CATEGORY_TASKS,
  usage: CATEGORY_INTERNAL,
  stt: CATEGORY_INTERNAL,
  audio: CATEGORY_INTERNAL,
  browser: CATEGORY_INTERNAL,
  calendar: CATEGORY_INTERNAL,
  // Plugin INFRASTRUCTURE is not one plugin's condition (mirrors the bridge).
  'plugin-loader': CATEGORY_INTERNAL,
  'plugin-sources': CATEGORY_INTERNAL,
};

// ── Small string helpers ─────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A plugin id as a display name: `acme` → `Acme`, `plugin-a` → `Plugin A`. */
export function titleizeId(id: string): string {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The first sentence of an error string, as a sentence.
 *
 * Error strings are frequently a stack of causes ('X failed: Y\n  at Z'); the
 * card shows the first claim and the Details toggle keeps the rest. Splits on
 * period-SPACE (not bare '.') so a path or a filename — `ui-prefs.json:` — is
 * never cut in half, and collapses newlines for the same reason.
 */
export function firstSentence(text: string | undefined, max = 220): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const line = clean.split(/(?<=[.!?])\s(?=[A-Z(])/)[0] ?? clean;
  const cut = line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
}

/**
 * A readable title for an error nobody wrote a rule for.
 *
 * Strips the two things that make a log line unreadable as a title — an inline
 * JSON/brace blob and a trailing technical tail — then upper-cases the first
 * letter. Deliberately does NOT lower-case the rest: an ALL-CAPS marker word is
 * the producer's emphasis, and 'GET /api/x' must keep its shape.
 */
export function fallbackTitle(rawTitle: string, max = 120): string {
  let out = (rawTitle ?? '').replace(/\s+/g, ' ').trim();
  // An embedded object/array dump belongs in Details, never in a title.
  out = out.replace(/[[{][^[{]*["':][^[{]*[\]}]/g, '').trim();
  // Producer-side separators left dangling by the strip above.
  out = out.replace(/[\s—:;,-]+$/, '').trim();
  if (!out) return 'Something went wrong';
  if (out.length > max) out = `${out.slice(0, max - 1).trimEnd()}…`;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Whether a body is a raw log dump (`[subsystem] {"k":…}`) rather than prose. */
export function isRawMetaBody(body: string | undefined): boolean {
  return !!body && /^\[[\w/@.-]+\]\s*[{[]/.test(body.trim());
}

// ── Category derivation ──────────────────────────────────────────────────────

/**
 * Category from the CONDITION id, which is the strongest structural signal
 * available: the producer already declared what kind of thing this is (see the
 * recoveryKey shapes table in docs/reference/notification-lifecycle.md).
 *
 * The frontend keeps a small mirror of this mapping for records written before
 * this feature (notification-model.ts `categoryOf`) — the key shapes are the
 * contract between the two, so extend both together.
 */
export function categoryFromRecoveryKey(recoveryKey: string | undefined): string | undefined {
  const key = str(recoveryKey);
  if (!key) return undefined;
  if (key.startsWith('plugin:')) {
    const id = key.slice('plugin:'.length).trim();
    return id ? titleizeId(id) : undefined;
  }
  if (key.startsWith('session:') || key.startsWith('task:')) return CATEGORY_SESSIONS;
  if (key.startsWith('route:')) return CATEGORY_API;
  if (key.startsWith('bus:')) return CATEGORY_INTERNAL;
  switch (key) {
    case 'git':
    case 'git:compaction':
    case 'backup':
    case 'disk':
      return CATEGORY_DATA;
    case 'server-lifecycle':
      return CATEGORY_SERVER;
    case 'task-db-writers':
      return CATEGORY_INTERNAL;
    case 'send-path':
      return CATEGORY_CLOUD;
    default:
      return undefined;
  }
}

/** Category from the logger subsystem (`plugin/<id>`, `<id>/http`, `session`, …). */
export function categoryFromSubsystem(subsystem: string | undefined): string | undefined {
  const raw = str(subsystem);
  if (!raw) return undefined;
  const [root, second] = raw.split('/').map((s) => s.trim());
  if (!root) return undefined;
  // `plugin/<id>` (the loader's per-plugin logger) names the plugin one segment
  // deeper — its own root is the generic word.
  if (root === 'plugin') return second ? titleizeId(second) : CATEGORY_INTERNAL;
  const core = SUBSYSTEM_CATEGORY[root];
  if (core) return core;
  // Not one of ours → a plugin's own logger; its root is its id.
  return titleizeId(root);
}

/** The plugin display name this error belongs to, if it belongs to one. */
function pluginNameOf(input: HumanizeErrorInput): string | undefined {
  const fromMeta = str(input.meta?.pluginId);
  if (fromMeta) return titleizeId(fromMeta);
  const key = str(input.recoveryKey);
  if (key?.startsWith('plugin:')) {
    const id = key.slice('plugin:'.length).trim();
    if (id) return titleizeId(id);
  }
  const raw = str(input.subsystem);
  if (!raw) return undefined;
  const [root, second] = raw.split('/').map((s) => s.trim());
  if (root === 'plugin' && second) return titleizeId(second);
  if (root && !SUBSYSTEM_CATEGORY[root]) return titleizeId(root);
  return undefined;
}

/** The best error string available in the meta, whatever the producer called it. */
function metaError(meta: Record<string, unknown> | undefined): string | undefined {
  return str(meta?.error) ?? str(meta?.err) ?? str(meta?.reason) ?? str(meta?.cause)
    ?? str(meta?.detail) ?? str(meta?.message);
}

/** An HTTP-ish status the producer recorded, for a "the API said no" sentence. */
function metaStatus(meta: Record<string, unknown> | undefined): number | undefined {
  return num(meta?.statusCode) ?? num(meta?.status);
}

// ── The rule list ────────────────────────────────────────────────────────────

interface Rule {
  /** Stable id — tests name rules by this, so a rename is a visible change. */
  id: string;
  match: (input: HumanizeErrorInput) => boolean;
  render: (input: HumanizeErrorInput) => { title: string; message: string };
  /** Category this family belongs to regardless of key/subsystem. */
  category?: string | ((input: HumanizeErrorInput) => string | undefined);
}

/** Case-insensitive "the title starts with / contains" helpers. */
const starts = (t: string, prefix: string): boolean =>
  t.toLowerCase().startsWith(prefix.toLowerCase());
const has = (t: string, needle: string): boolean =>
  t.toLowerCase().includes(needle.toLowerCase());

/** A route-error title: `GET /api/x → 500 (8ms)`. */
const ROUTE_TITLE_RE = /^(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS)\s+\//;
/** `subscriber "main-ai" threw on event "subagent:result" (async)`. */
const BUS_TITLE_RE = /^subscriber\s+"([^"]+)"\s+threw\s+on\s+event\s+"([^"]+)"/i;

/**
 * Producer titles that are ALREADY written for a human — pass them through, and
 * give each its own category so the pass-through rule doesn't have to guess one
 * (a 'Keep-Awake Released' card is not a Data & Sync problem).
 */
const HUMAN_TITLE_CATEGORY: Array<{ re: RegExp; category: string }> = [
  { re: /^(Data (Repo|Backup|Sync)|S3 Backup|Backup )/i, category: CATEGORY_DATA },
  { re: /^(Data Disk|Disk )/i, category: CATEGORY_DATA },
  { re: /^Keep-Awake/i, category: CATEGORY_SERVER },
  { re: /^(Phone send|.* message\(s\) waiting)/i, category: CATEGORY_CLOUD },
];

function humanTitleCategory(title: string): string | undefined {
  return HUMAN_TITLE_CATEGORY.find((e) => e.re.test(title.trim()))?.category;
}

/** A "the working folder is gone" error, whatever wording the OS gave it. */
function looksLikeMissingDir(text: string | undefined): boolean {
  return !!text && /no longer exists|ENOENT|no such file|does not exist|not a directory/i.test(text);
}

/**
 * Ordered families. First match wins, so a specific rule must precede a general
 * one (the plugin rules are last for exactly that reason: a plugin's HTTP error
 * may also look like a generic 'API error').
 */
const RULES: Rule[] = [
  // ── Sessions ──
  {
    id: 'transport-start-failed',
    category: CATEGORY_SESSIONS,
    match: (i) => starts(i.title, 'transport start failed'),
    render: (i) => {
      const cwd = str(i.meta?.cwd);
      const err = metaError(i.meta);
      if (cwd && (looksLikeMissingDir(err) || !err)) {
        return {
          title: "Couldn't start a session",
          message: `The working folder no longer exists: ${cwd}`,
        };
      }
      return { title: "Couldn't start a session", message: firstSentence(err) };
    },
  },
  {
    id: 'session-delivery-failed',
    category: CATEGORY_SESSIONS,
    match: (i) => starts(i.title, 'Session Delivery Failed'),
    render: (i) => ({
      title: "Message couldn't be delivered",
      // The producer's body already ends with the reassurance sentence ("Your
      // message was not lost…") — that IS the human message, so it is preserved
      // verbatim rather than re-summarized into a second, weaker copy.
      message: (i.body ?? '').trim() || firstSentence(metaError(i.meta)),
    }),
  },
  {
    id: 'session-error',
    category: CATEGORY_SESSIONS,
    match: (i) => starts(i.title, 'Session Error'),
    render: (i) => ({
      title: 'A session hit an error',
      message: firstSentence(i.body ?? metaError(i.meta)),
    }),
  },
  {
    id: 'subagent-error',
    category: CATEGORY_SESSIONS,
    match: (i) => starts(i.title, 'Subagent Error'),
    render: (i) => ({
      title: 'A subagent run failed',
      message: firstSentence(i.body ?? metaError(i.meta)),
    }),
  },
  {
    id: 'stream-convergence-violation',
    category: CATEGORY_SESSIONS,
    match: (i) => has(i.title, 'stream-convergence VIOLATION'),
    render: (i) => {
      const missing = Array.isArray(i.meta?.missing) ? i.meta.missing.length : undefined;
      const checked = num(i.meta?.checked);
      const detail = missing !== undefined && checked !== undefined
        ? `${missing} of ${checked} streamed message${checked === 1 ? '' : 's'} `
        : missing !== undefined
          ? `${missing} streamed message${missing === 1 ? '' : 's'} `
          : 'Some streamed output ';
      return {
        title: 'Some session output may not have been saved',
        message: `${detail}never made it into this session's saved history.`,
      };
    },
  },
  {
    id: 'self-report-unparseable',
    category: CATEGORY_SESSIONS,
    match: (i) => has(i.title, 'self-report UNPARSEABLE'),
    render: () => ({
      title: "A session's summary couldn't be parsed",
      message: "The session finished but wrote its summary in an unexpected format, so the task note was left unchanged.",
    }),
  },

  // ── Internal ──
  {
    id: 'second-writer',
    category: CATEGORY_INTERNAL,
    match: (i) => has(i.title, 'SECOND WRITER'),
    render: (i) => {
      const holders = Array.isArray(i.meta?.holders) ? i.meta.holders : [];
      const first = holders[0] as { pid?: unknown } | undefined;
      const pid = num(first?.pid);
      return {
        title: 'Another process is writing the task database',
        message: pid !== undefined
          ? `Tasks can silently disappear while this lasts (pid ${pid}).`
          : 'Tasks can silently disappear while this lasts.',
      };
    },
  },
  {
    id: 'bus-subscriber-threw',
    category: CATEGORY_INTERNAL,
    match: (i) => BUS_TITLE_RE.test(i.title),
    render: (i) => {
      const m = BUS_TITLE_RE.exec(i.title);
      const subscriber = m?.[1];
      const event = m?.[2];
      return {
        title: 'An internal event handler failed',
        message: subscriber && event
          ? `The "${subscriber}" handler failed while handling "${event}".`
          : 'An event handler threw while processing an event.',
      };
    },
  },

  // ── Server ──
  {
    id: 'server-exit',
    category: CATEGORY_SERVER,
    match: (i) => starts(i.title, 'SERVER EXIT'),
    render: (i) => {
      const reason = i.title.slice('SERVER EXIT:'.length).trim() || i.title;
      if (/SIGTERM|SIGHUP|killed by another process|terminal closed/i.test(reason)) {
        return {
          title: 'Walnut was stopped (killed by another process)',
          message: 'This is normal during a deploy, when a replacement server takes over.',
        };
      }
      return {
        title: 'Walnut stopped unexpectedly',
        message: firstSentence(metaError(i.meta)) || `The server process ended: ${reason}`,
      };
    },
  },

  // ── API ──
  {
    id: 'route-5xx',
    category: CATEGORY_API,
    match: (i) => ROUTE_TITLE_RE.test(i.title.trim()),
    render: (i) => {
      // The endpoint + status IS the terse human title here — only the
      // per-occurrence latency tail is dropped (it made every repeat look like
      // a different problem).
      const title = i.title.trim().replace(/\s*\(\d+(?:\.\d+)?m?s\)\s*$/, '');
      const status = /→\s*(\d{3})/.exec(title)?.[1] ?? metaStatus(i.meta)?.toString();
      return {
        title,
        message: status
          ? `This API endpoint is failing (HTTP ${status}).`
          : 'This API endpoint is failing.',
      };
    },
  },

  // ── Producer titles that are already human prose: category only ──
  {
    id: 'already-human',
    // The condition id wins when the producer named one ('disk' → Data & Sync,
    // 'send-path' → Cloud); the title table is the fallback for the handful of
    // one-shot monitors that carry no key.
    category: (i) => categoryFromRecoveryKey(i.recoveryKey) ?? humanTitleCategory(i.title),
    match: (i) => !!humanTitleCategory(i.title),
    render: (i) => ({ title: i.title.trim(), message: (i.body ?? '').trim() }),
  },

  // ── Plugin sync families (plugin NAME is runtime data, never hardcoded) ──
  {
    id: 'plugin-push-failed',
    category: (i) => pluginNameOf(i),
    match: (i) => !!pluginNameOf(i)
      && (/^failed to push task\b/i.test(i.title) || /^pushtask failed/i.test(i.title)),
    render: (i) => ({
      title: `${pluginNameOf(i)} couldn't save a task change`,
      message: firstSentence(metaError(i.meta)) || 'The change stays local until the next sync succeeds.',
    }),
  },
  {
    id: 'plugin-sync-repeating',
    category: (i) => pluginNameOf(i),
    match: (i) => !!pluginNameOf(i) && /sync failing repeatedly/i.test(i.title),
    render: (i) => {
      const times = num(i.meta?.consecutiveFailures);
      return {
        title: `${pluginNameOf(i)} sync keeps failing`,
        message: firstSentence(metaError(i.meta))
          || (times !== undefined ? `${times} sync attempts in a row have failed.` : 'Sync has failed several times in a row.'),
      };
    },
  },
  {
    id: 'plugin-reconcile-failed',
    category: (i) => pluginNameOf(i),
    match: (i) => !!pluginNameOf(i) && /full reconcile failed/i.test(i.title),
    render: (i) => ({
      title: `${pluginNameOf(i)} full sync failed`,
      message: firstSentence(metaError(i.meta)) || 'The full comparison against the remote list did not finish.',
    }),
  },
  {
    id: 'plugin-api-error',
    category: (i) => pluginNameOf(i),
    match: (i) => !!pluginNameOf(i) && /\bapi error\b/i.test(i.title),
    render: (i) => {
      const status = metaStatus(i.meta);
      const op = str(i.meta?.operationName);
      return {
        title: `${pluginNameOf(i)} API request failed`,
        message: firstSentence(metaError(i.meta))
          || [
            status !== undefined ? `The request came back HTTP ${status}` : 'The request failed',
            op ? ` (${op})` : '',
            '.',
          ].join(''),
      };
    },
  },
  {
    id: 'plugin-generic',
    category: (i) => pluginNameOf(i),
    // Anything else from a plugin's own logger. Keeps the producer's title (it
    // is usually already a phrase, e.g. 'sprint fetch failed') but replaces the
    // JSON body with a sentence and gives the card the plugin's category so all
    // of that plugin's failures group together — the three-cards-that-are-one-
    // problem complaint this feature exists for.
    match: (i) => !!pluginNameOf(i),
    render: (i) => {
      const status = metaStatus(i.meta);
      return {
        title: fallbackTitle(i.title),
        message: firstSentence(metaError(i.meta))
          || (status !== undefined ? `The request came back HTTP ${status}.` : ''),
      };
    },
  },
];

/** Rule ids, in order. Exported so a test can pin the precedence list. */
export const HUMANIZE_RULE_IDS: readonly string[] = RULES.map((r) => r.id);

/**
 * Every free-text field, run through the caller's redactor. Meta is walked one
 * level deep: `holders: [{ pid, command }]` is the deepest shape any rule reads,
 * and an unbounded walk over arbitrary log meta on a write path is not worth the
 * cost when the alternative (redacting the output) is the unsafe one.
 */
function sanitizeInput(
  input: HumanizeErrorInput,
  sanitize: (text: string) => string,
): HumanizeErrorInput {
  const clean = (v: unknown): unknown => (typeof v === 'string' ? sanitize(v) : v);
  let meta: Record<string, unknown> | undefined;
  if (input.meta) {
    meta = {};
    for (const [k, v] of Object.entries(input.meta)) {
      meta[k] = Array.isArray(v) ? v.map(clean) : clean(v);
    }
  }
  return {
    ...input,
    title: sanitize(input.title ?? ''),
    ...(input.body !== undefined ? { body: sanitize(input.body) } : {}),
    ...(meta ? { meta } : {}),
  };
}

/**
 * Translate one error notification into `{ category, title, message }`.
 *
 * Precedence for the category: an explicit rule → the recoveryKey shape → the
 * logger subsystem → 'Other'. The rule wins because it identified the exact
 * family; the key and subsystem are structural fallbacks that also cover the
 * long tail nobody wrote a rule for (which is most of the volume).
 */
export function humanizeErrorNotification(
  rawInput: HumanizeErrorInput,
  options: HumanizeOptions = {},
): HumanizedError {
  // Redact the raw material ONCE, up front (see HumanizeOptions.sanitize for why
  // it cannot be done to the finished sentence). Only string values are touched;
  // ids, counts and arrays pass through as they are.
  const input = options.sanitize ? sanitizeInput(rawInput, options.sanitize) : rawInput;

  const rule = RULES.find((r) => {
    try {
      return r.match(input);
    } catch {
      // A malformed meta must never cost the user their notification.
      return false;
    }
  });

  const structural = categoryFromRecoveryKey(input.recoveryKey)
    ?? categoryFromSubsystem(input.subsystem)
    ?? CATEGORY_OTHER;

  if (rule) {
    const ruleCategory = typeof rule.category === 'function' ? rule.category(input) : rule.category;
    let rendered: { title: string; message: string };
    try {
      rendered = rule.render(input);
    } catch {
      rendered = { title: fallbackTitle(input.title), message: '' };
    }
    return {
      category: ruleCategory || structural,
      title: rendered.title.trim() || fallbackTitle(input.title),
      message: rendered.message.trim(),
    };
  }

  // Unmatched: still readable. A prose body written by a producer is a fine
  // message; a raw meta dump is NOT and is dropped here (the caller keeps it as
  // the record's `detail`).
  const prose = isRawMetaBody(input.body) ? undefined : str(input.body);
  return {
    category: structural,
    title: fallbackTitle(input.title),
    message: prose ? firstSentence(prose) : firstSentence(metaError(input.meta)),
  };
}
