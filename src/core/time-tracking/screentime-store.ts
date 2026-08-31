/**
 * Screen Time snapshot store: OUR permanent copy of a history Apple throws away.
 *
 * Apple's Screen Time store keeps roughly two to four weeks and then purges, so
 * screentime-reader.ts can only ever see that window. A day the user wants to
 * look at a year from now has to be copied out while it still exists. This module
 * is that copy, and the copy being permanent is the whole point: NOTHING here
 * unlinks a day file, ever.
 *
 * Layout: WALNUT_HOME/time-tracking/screentime/<local-date>.jsonl. One JSON
 * record per line, three kinds, each carrying (date, deviceId) so a single
 * grepped line stands on its own:
 *
 *   kind:'device'  one per (date, deviceId): Apple's own day total, pickups,
 *                  notifications, the device's name and platform, its
 *                  hour-resolution blocks, and capturedAt (when WE first stored
 *                  this content)
 *   kind:'app'     one per (date, deviceId, bundleId)
 *   kind:'site'    one per (date, deviceId, domain)
 *
 * An app row and a site row stay DIFFERENT KINDS rather than one row with an
 * optional domain, because the read side must never sum them: Apple counts a
 * browser's app time and the domains visited inside it as separate measurements.
 *
 * ── IDEMPOTENT REPLACE, not append ──
 *
 * Apple keeps revising recent days (a phone syncs late, a block gets recounted),
 * so the snapshot schedule re-reads the last couple of weeks on every run.
 * Append-only would multiply every total by the number of runs. A write therefore
 * REPLACES every row of the (date, deviceId) pairs it carries and leaves every
 * other device on that date untouched, through a temp file + rename in the SAME
 * directory (atomic, and never EXDEV).
 *
 * Two rules that follow from "our copy has to outlive Apple's":
 *
 *   - Never rewrite a day we could not read WHOLE. A file over the read cap, or
 *     one whose read failed, is skipped rather than rewritten from a partial
 *     parse: a truncated rewrite is the one way this module could lose history.
 *   - Unchanged is a no-op. A device whose numbers match what is already stored
 *     keeps its original capturedAt and the file is not rewritten at all, so a
 *     settled day stops churning the git-synced data directory every snapshot.
 *
 * ALL fs is async: the web server shares ONE event loop and a sync read here
 * would freeze every route. Every operation on a given date runs through that
 * date's promise chain, so two concurrent snapshots can never interleave their
 * read-modify-write.
 *
 * WALNUT_HOME is re-resolved per call so tests that swap it via mocked constants
 * get isolation without a special hook.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { ScreenTimeBlock, ScreenTimeDay, ScreenTimeSnapshot } from './screentime-reader.js';

/** A day file this large is never parsed whole, and never rewritten at all. */
export const MAX_DAY_FILE_BYTES = 8 * 1024 * 1024;
/** How much of an over-cap day file the READ path parses, from the start. */
const MAX_HEAD_READ_BYTES = 2 * 1024 * 1024;
const MAX_FIELD_LEN = 256;
/**
 * Ceiling on any single ms field. One device cannot be used for more than a day
 * in a day; anything past that is a hand edit or a corrupt line, and clamping
 * (rather than dropping) keeps the rest of the row.
 */
const MAX_ROW_MS = 24 * 60 * 60 * 1000;
/** Pickups, notifications, and the platform enum are small non-negative counts. */
const MAX_COUNT = 1_000_000;
/**
 * Blocks stored per device per day. Apple emits a few dozen (they are
 * hour-resolution), so this only ever bites on corrupt input.
 */
const MAX_BLOCKS = 512;

/** Only these names are day files; a `.tmp` from an interrupted write is not. */
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A control character in an id would let one line forge a second field. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type ScreenTimeRecordKind = 'device' | 'app' | 'site';

/** One stored line. Which optional fields apply depends on `kind`. */
export interface ScreenTimeRecord {
  kind: ScreenTimeRecordKind;
  /** Local YYYY-MM-DD. Repeated on every line so one grepped line is complete. */
  date: string;
  /** Stable per-device id (ZCOREDEVICE.ZIDENTIFIER). The device's identity. */
  deviceId: string;
  /** 'device': Apple's day total. 'app'/'site': that row's own time. */
  ms: number;
  /** 'device' only. A display name that can change; the id is the identity. */
  deviceName?: string;
  /** 'device' only. ZPLATFORM, used only to tell a Mac from a phone. */
  platform?: number;
  /**
   * 'device' only. This row is the Mac Walnut runs on, as decided at capture time
   * from Apple's own -Local store. Stored rather than recomputed on read, because
   * the answer belongs to the moment of capture: replacing a Mac, or restoring
   * this store onto another machine, must not retroactively relabel which of last
   * month's devices was "this one".
   */
  local?: true;
  /** 'device': the day's count. 'app': that app's share of it. */
  pickups?: number;
  notifications?: number;
  /** 'device' only. Hour-resolution blocks, for the timeline. */
  blocks?: ScreenTimeBlock[];
  /** 'device' only. When this content was FIRST stored (see the header note). */
  capturedAt?: string;
  /** 'app' only. */
  bundleId?: string;
  /** 'site' only, lower-cased. */
  domain?: string;
  category?: string;
}

/** One day file as read back. Never throws; unusable lines are counted, not fatal. */
export interface ScreenTimeDayFile {
  date: string;
  records: ScreenTimeRecord[];
  /** Lines that did not parse: a torn tail, a hand edit, a foreign line. */
  skippedLines: number;
  /** The file was over the read cap, so only its head was parsed. */
  truncated?: true;
}

/**
 * Receipt for one write. Every count is here so a caller can prove the replace
 * happened instead of an accumulate: a second snapshot of the same numbers
 * reports the date under `unchanged` with `written` and `replaced` at zero.
 */
export interface ScreenTimeWriteResult {
  /** Dates whose file was rewritten. */
  dates: string[];
  /** Dates already holding exactly this content, so nothing was written. */
  unchanged: string[];
  /** Dates refused: an invalid key, an unreadable file, a failed write. */
  skipped: string[];
  /** Records written for the snapshotted devices. */
  written: number;
  /** Records of OTHER devices on those dates, carried over untouched. */
  kept: number;
  /** Records of the snapshotted devices that existed before and were replaced. */
  replaced: number;
}

// ── paths and per-date serialization ────────────────────────────────────────

function storeDir(): string {
  return path.join(WALNUT_HOME, 'time-tracking', 'screentime');
}

function dayFile(date: string): string {
  return path.join(storeDir(), `${date}.jsonl`);
}

interface StoreState {
  dir: string;
  /** date → tail of that date's operation chain. Pruned as chains settle. */
  chains: Map<string, Promise<void>>;
}

let state: StoreState | null = null;

function current(): StoreState {
  const dir = storeDir();
  if (!state || state.dir !== dir) state = { dir, chains: new Map() };
  return state;
}

/** Drop all in-memory state (tests, and server teardown). */
export function resetScreenTimeStore(): void {
  state = null;
  warnedOnce.clear();
}

/**
 * Run `work` after everything already queued for `date`. Reads join the chain
 * too: a read that lands between the write's read and its rename would answer
 * from a version the caller is about to replace, which is exactly the
 * interleaving that turns a replace back into an accumulate.
 */
function chain<T>(st: StoreState, date: string, work: () => Promise<T>): Promise<T> {
  const prior = st.chains.get(date) ?? Promise.resolve();
  const run = prior.then(work);
  // The stored tail always RESOLVES: a failed operation must not cancel the one
  // queued behind it, and it must not surface as an unhandled rejection either.
  const settled = run.then(() => undefined, () => undefined);
  st.chains.set(date, settled);
  // Forget the date once nothing is queued behind it, so a server running for
  // months does not hold one promise per day it ever touched.
  void settled.then(() => {
    if (st.chains.get(date) === settled) st.chains.delete(date);
  });
  return run;
}

/** One log line per distinct condition per process, never one per snapshot. */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string, data: Record<string, unknown>): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  log.web.warn(message, data);
}

// ── sanitizing ──────────────────────────────────────────────────────────────

function isDateKey(raw: unknown): raw is string {
  return typeof raw === 'string' && DATE_KEY_RE.test(raw);
}

function cleanField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t.length > MAX_FIELD_LEN) return undefined;
  if (hasControlChar(t)) return undefined;
  return t;
}

function clampMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(Math.max(Math.round(raw), 0), MAX_ROW_MS);
}

function clampCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(Math.max(Math.round(raw), 0), MAX_COUNT);
}

/**
 * Blocks, bounded and deterministic. Over the cap the LONGEST blocks survive
 * (they are the ones a timeline can draw) and the survivors go back into
 * chronological order, so dropping the tail of the day never happens.
 */
function cleanBlocks(raw: unknown): ScreenTimeBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ScreenTimeBlock[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const startTs = cleanField((item as ScreenTimeBlock).startTs);
    const ms = clampMs((item as ScreenTimeBlock).ms);
    if (!startTs || ms <= 0) continue;
    out.push({ startTs, ms });
  }
  const kept = out.length > MAX_BLOCKS
    ? [...out].sort((a, b) => b.ms - a.ms).slice(0, MAX_BLOCKS)
    : out;
  return kept.sort((a, b) => a.startTs.localeCompare(b.startTs) || b.ms - a.ms);
}

// ── record builders ─────────────────────────────────────────────────────────
//
// The write path and the parse path BOTH go through these, so a stored line
// round-trips byte-for-byte: field order comes from one place, which is what
// makes the unchanged-is-a-no-op check below a simple string compare.

function deviceRecord(f: {
  date: string; deviceId: string; deviceName: string; platform: number; ms: number;
  pickups: number; notifications: number; blocks: ScreenTimeBlock[]; capturedAt?: string;
  local?: boolean;
}): ScreenTimeRecord {
  return {
    kind: 'device',
    date: f.date,
    deviceId: f.deviceId,
    deviceName: f.deviceName,
    platform: f.platform,
    ms: f.ms,
    pickups: f.pickups,
    notifications: f.notifications,
    ...(f.blocks.length > 0 ? { blocks: f.blocks } : {}),
    ...(f.capturedAt ? { capturedAt: f.capturedAt } : {}),
    ...(f.local ? { local: true as const } : {}),
  };
}

function appRecord(f: {
  date: string; deviceId: string; bundleId: string; ms: number;
  pickups?: number; notifications?: number; category?: string;
}): ScreenTimeRecord {
  return {
    kind: 'app',
    date: f.date,
    deviceId: f.deviceId,
    bundleId: f.bundleId,
    ms: f.ms,
    ...(f.pickups ? { pickups: f.pickups } : {}),
    ...(f.notifications ? { notifications: f.notifications } : {}),
    ...(f.category ? { category: f.category } : {}),
  };
}

function siteRecord(f: {
  date: string; deviceId: string; domain: string; ms: number; category?: string;
}): ScreenTimeRecord {
  return {
    kind: 'site',
    date: f.date,
    deviceId: f.deviceId,
    domain: f.domain,
    ms: f.ms,
    ...(f.category ? { category: f.category } : {}),
  };
}

const KIND_RANK: Record<ScreenTimeRecordKind, number> = { device: 0, app: 1, site: 2 };

function rowId(rec: ScreenTimeRecord): string {
  return rec.bundleId ?? rec.domain ?? '';
}

/**
 * Total order over a day's records. The file is written in this order so two
 * snapshots of the same day produce the same bytes, which keeps the git-synced
 * data directory from showing a diff for a day that did not change.
 */
function sortRecords(records: readonly ScreenTimeRecord[]): ScreenTimeRecord[] {
  return [...records].sort((a, b) => (
    a.deviceId.localeCompare(b.deviceId)
    || KIND_RANK[a.kind] - KIND_RANK[b.kind]
    || b.ms - a.ms
    || rowId(a).localeCompare(rowId(b))
  ));
}

/** Everything about a device's rows EXCEPT when we captured them. */
function contentKey(records: readonly ScreenTimeRecord[]): string {
  return sortRecords(records)
    .map((rec) => JSON.stringify({ ...rec, capturedAt: undefined }))
    .join('\n');
}

/**
 * One day of one device, as lines. Rows are merged by identity on the way in so
 * a caller that hands us the same app twice cannot double that app's time.
 *
 * A website row keeps ONLY its domain: Apple aggregates domain time across
 * browsers, so pinning it to whichever browser's row it arrived on would be an
 * attribution we cannot support.
 */
function recordsForDay(day: ScreenTimeDay, capturedAt: string, local?: boolean): ScreenTimeRecord[] {
  const deviceId = cleanField(day.deviceId);
  if (!deviceId || !isDateKey(day.date)) return [];
  const date = day.date;

  const apps = new Map<string, { ms: number; pickups: number; notifications: number; category?: string }>();
  const sites = new Map<string, { ms: number; category?: string }>();
  for (const app of day.apps ?? []) {
    const ms = clampMs(app.ms);
    if (ms <= 0) continue;
    const category = cleanField(app.category);
    const domain = cleanField(app.domain)?.toLowerCase();
    if (domain) {
      const prev = sites.get(domain);
      sites.set(domain, { ms: Math.min((prev?.ms ?? 0) + ms, MAX_ROW_MS), category: prev?.category ?? category });
      continue;
    }
    const bundleId = cleanField(app.bundleId);
    if (!bundleId) continue;
    const prev = apps.get(bundleId);
    apps.set(bundleId, {
      ms: Math.min((prev?.ms ?? 0) + ms, MAX_ROW_MS),
      pickups: (prev?.pickups ?? 0) + clampCount(app.pickups),
      notifications: (prev?.notifications ?? 0) + clampCount(app.notifications),
      category: prev?.category ?? category,
    });
  }

  const out: ScreenTimeRecord[] = [deviceRecord({
    date,
    deviceId,
    deviceName: cleanField(day.deviceName) ?? deviceId,
    platform: clampCount(day.platform),
    ms: clampMs(day.totalMs),
    pickups: clampCount(day.pickups),
    notifications: clampCount(day.notifications),
    blocks: cleanBlocks(day.blocks),
    capturedAt,
    local,
  })];
  for (const [bundleId, row] of apps) out.push(appRecord({ date, deviceId, bundleId, ...row }));
  for (const [domain, row] of sites) out.push(siteRecord({ date, deviceId, domain, ...row }));
  return out;
}

/**
 * Parse one JSONL line, or null when it is not a usable record. Same tolerance
 * as parseOutsideLine: a torn tail line is expected, never an exception.
 */
export function parseScreenTimeLine(line: string, fallbackDate: string): ScreenTimeRecord | null {
  if (!line.trim()) return null;
  let obj: Partial<ScreenTimeRecord>;
  try {
    obj = JSON.parse(line) as Partial<ScreenTimeRecord>;
  } catch {
    return null; // a torn tail line is expected; skip it
  }
  if (!obj || typeof obj !== 'object') return null;
  const kind = obj.kind;
  if (kind !== 'device' && kind !== 'app' && kind !== 'site') return null;
  const deviceId = cleanField(obj.deviceId);
  if (!deviceId) return null;
  const date = isDateKey(obj.date) ? obj.date : fallbackDate;
  const ms = clampMs(obj.ms);
  const category = cleanField(obj.category);

  if (kind === 'app') {
    const bundleId = cleanField(obj.bundleId);
    if (!bundleId || ms <= 0) return null;
    return appRecord({
      date, deviceId, bundleId, ms,
      pickups: clampCount(obj.pickups),
      notifications: clampCount(obj.notifications),
      category,
    });
  }
  if (kind === 'site') {
    const domain = cleanField(obj.domain)?.toLowerCase();
    if (!domain || ms <= 0) return null;
    return siteRecord({ date, deviceId, domain, ms, category });
  }
  // A device header with a zero total is still kept: "the phone was not touched"
  // is an answer, and dropping it would leave the day looking unsnapshotted.
  return deviceRecord({
    date,
    deviceId,
    deviceName: cleanField(obj.deviceName) ?? deviceId,
    platform: clampCount(obj.platform),
    ms,
    pickups: clampCount(obj.pickups),
    notifications: clampCount(obj.notifications),
    blocks: cleanBlocks(obj.blocks),
    capturedAt: cleanField(obj.capturedAt),
    local: obj.local === true,
  });
}

// ── writes ──────────────────────────────────────────────────────────────────

function emptyResult(): ScreenTimeWriteResult {
  return { dates: [], unchanged: [], skipped: [], written: 0, kept: 0, replaced: 0 };
}

/** Snapshot one device-day. Replaces that (date, deviceId) rather than adding to it. */
export function recordScreenTimeDay(
  day: ScreenTimeDay,
  opts: WriteOptions = {},
): Promise<ScreenTimeWriteResult> {
  return recordScreenTimeDays([day], opts);
}

/** Snapshot a whole reader result. Devices absent from a day are left as stored. */
export function recordScreenTimeSnapshot(
  snapshot: ScreenTimeSnapshot,
  opts: WriteOptions = {},
): Promise<ScreenTimeWriteResult> {
  // The reader decided which device is this Mac (from Apple's -Local store); the
  // flag rides into the stored rows so a read years later does not have to
  // re-derive it against whatever machine is running then.
  return recordScreenTimeDays(snapshot.days, {
    localDeviceIds: snapshot.localDeviceIds,
    ...opts,
  });
}

export interface WriteOptions {
  capturedAt?: string;
  /**
   * Device ids that are the Mac this Walnut runs on. OMITTING this is different
   * from passing an empty list: omitted means "not told", and a stored device
   * keeps whatever `local` flag it already had. Only a caller that actually knows
   * (the reader, from Apple's own -Local store) may relabel a device.
   */
  localDeviceIds?: Iterable<string>;
}

/**
 * Snapshot many device-days. Days sharing a date are written in ONE rewrite of
 * that date, so a two-device day never reads its own half-written file.
 */
export async function recordScreenTimeDays(
  days: readonly ScreenTimeDay[],
  opts: WriteOptions = {},
): Promise<ScreenTimeWriteResult> {
  const result = emptyResult();
  if (days.length === 0) return result;
  const capturedAt = opts.capturedAt ?? new Date().toISOString();
  // null, not an empty set: see WriteOptions.localDeviceIds.
  const local = opts.localDeviceIds ? new Set(opts.localDeviceIds) : null;
  const st = current();

  const byDate = new Map<string, ScreenTimeDay[]>();
  for (const day of days) {
    const date: unknown = day?.date;
    if (!isDateKey(date)) {
      // A date that is not a local day key cannot name a file, and must never be
      // coerced into one: `../x` would write outside the store.
      warnOnce('bad-date', 'screen time snapshot dropped a day with an unusable date', {
        date: typeof date === 'string' ? date.slice(0, 32) : typeof date,
      });
      if (!result.skipped.includes('')) result.skipped.push('');
      continue;
    }
    const list = byDate.get(date) ?? [];
    list.push(day);
    byDate.set(date, list);
  }

  for (const [date, group] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await chain(st, date, () => rewriteDate(date, group, capturedAt, local, result));
  }
  return result;
}

async function rewriteDate(
  date: string,
  days: readonly ScreenTimeDay[],
  capturedAt: string,
  local: ReadonlySet<string> | null,
  acc: ScreenTimeWriteResult,
): Promise<void> {
  const fresh: ScreenTimeRecord[] = [];
  for (const day of days) {
    fresh.push(...recordsForDay(day, capturedAt, local ? local.has(day.deviceId) : undefined));
  }
  if (fresh.length === 0) {
    acc.skipped.push(date);
    return;
  }
  const deviceIds = new Set(fresh.map((rec) => rec.deviceId));
  const file = dayFile(date);

  const stat = await fsp.stat(file).catch(() => null);
  if (stat?.isFile() && stat.size > MAX_DAY_FILE_BYTES) {
    // REFUSE. Rewriting from a partial parse is the only way this store could
    // lose the history it exists to keep, and an oversized file is corrupt or
    // hand-grown rather than something a snapshot should paper over.
    warnOnce(`oversize:${file}`, 'screen time day file over the read cap, so it was not rewritten', {
      file, size: stat.size, cap: MAX_DAY_FILE_BYTES,
    });
    acc.skipped.push(date);
    return;
  }
  let text = '';
  if (stat?.isFile() && stat.size > 0) {
    try {
      text = await fsp.readFile(file, 'utf-8');
    } catch (err) {
      // Same rule: a day we could not read is a day we must not overwrite.
      warnOnce(`unreadable:${file}`, 'screen time day file could not be read, so it was not rewritten', {
        file, error: err instanceof Error ? err.message : String(err),
      });
      acc.skipped.push(date);
      return;
    }
  }

  const kept: ScreenTimeRecord[] = [];
  const prior = new Map<string, ScreenTimeRecord[]>();
  let torn = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const rec = parseScreenTimeLine(line, date);
    if (!rec) { torn++; continue; }
    if (!deviceIds.has(rec.deviceId)) { kept.push(rec); continue; }
    const list = prior.get(rec.deviceId) ?? [];
    list.push(rec);
    prior.set(rec.deviceId, list);
  }

  // Per device, not per file: when one device changed and another did not, the
  // untouched device keeps the capturedAt it was first stored with.
  const freshByDevice = new Map<string, ScreenTimeRecord[]>();
  for (const rec of fresh) {
    const list = freshByDevice.get(rec.deviceId) ?? [];
    list.push(rec);
    freshByDevice.set(rec.deviceId, list);
  }
  let changed = 0;
  for (const [deviceId, rows] of freshByDevice) {
    const before = prior.get(deviceId);
    const beforeHeader = before?.find((rec) => rec.kind === 'device');
    if (local === null && beforeHeader?.local) {
      // The caller did not say which device is this Mac, so the stored answer
      // stands. Dropping the flag here would quietly turn a hidden-by-default Mac
      // row into a phone row on the next scheduled snapshot.
      const header = rows.find((rec) => rec.kind === 'device');
      if (header) header.local = true;
    }
    if (before && contentKey(before) === contentKey(rows)) {
      const header = rows.find((rec) => rec.kind === 'device');
      // Re-assigning an existing key keeps its position, so the line stays
      // byte-identical to what a fresh parse of the file produces.
      if (beforeHeader?.capturedAt && header) header.capturedAt = beforeHeader.capturedAt;
      continue;
    }
    changed++;
  }
  if (changed === 0) {
    // Nothing to say and nothing to churn. The torn lines (if any) stay put:
    // this store does not rewrite a day just to tidy it.
    acc.unchanged.push(date);
    return;
  }

  const body = sortRecords([...kept, ...fresh]).map((rec) => JSON.stringify(rec)).join('\n') + '\n';
  // Same directory, so the rename is atomic and never crosses a device (EXDEV).
  const tmp = `${file}.snapshot-${process.pid}.tmp`;
  try {
    await fsp.mkdir(storeDir(), { recursive: true });
    await fsp.writeFile(tmp, body, 'utf-8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    warnOnce(`write:${file}`, 'screen time day file could not be written', {
      file, error: err instanceof Error ? err.message : String(err),
    });
    acc.skipped.push(date);
    return;
  }
  acc.dates.push(date);
  acc.written += fresh.length;
  acc.kept += kept.length;
  for (const rows of prior.values()) acc.replaced += rows.length;
  if (torn > 0) {
    log.web.info('screen time day file rewritten without its unparseable lines', { date, torn });
  }
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * One day file's records. Bounded: an over-cap file is parsed from its head only
 * and flagged `truncated`, and an unparseable line is counted rather than thrown.
 */
export function readScreenTimeDay(date: string): Promise<ScreenTimeDayFile> {
  if (!isDateKey(date)) return Promise.resolve({ date, records: [], skippedLines: 0 });
  const st = current();
  return chain(st, date, async () => {
    const file = dayFile(date);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) return { date, records: [], skippedLines: 0 };
    let truncated = false;
    let text: string;
    if (stat.size > MAX_DAY_FILE_BYTES) {
      warnOnce(`readcap:${file}`, 'screen time day file over the read cap, reading its head only', {
        file, size: stat.size, headBytes: MAX_HEAD_READ_BYTES,
      });
      text = await readHead(file, MAX_HEAD_READ_BYTES);
      truncated = true;
    } else {
      text = await fsp.readFile(file, 'utf-8').catch(() => '');
    }
    const records: ScreenTimeRecord[] = [];
    let skippedLines = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const rec = parseScreenTimeLine(line, date);
      if (rec) records.push(rec);
      else skippedLines++;
    }
    return { date, records: sortRecords(records), skippedLines, ...(truncated ? { truncated: true as const } : {}) };
  });
}

/** Every date this store holds a file for, ascending. Never throws. */
export async function listScreenTimeDates(): Promise<string[]> {
  const entries = await fsp.readdir(storeDir()).catch(() => [] as string[]);
  return entries
    .filter((name) => DAY_FILE_RE.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

/** The first `limit` bytes, with the (cut) last line dropped. */
async function readHead(file: string, limit: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(limit);
    // A short read is legal, so decode only what arrived: the zero fill left in
    // the rest of the buffer would otherwise be parsed as NUL characters.
    const { bytesRead } = await handle.read(buf, 0, limit, 0);
    const text = buf.subarray(0, bytesRead).toString('utf-8');
    const nl = text.lastIndexOf('\n');
    return nl >= 0 ? text.slice(0, nl + 1) : '';
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}
