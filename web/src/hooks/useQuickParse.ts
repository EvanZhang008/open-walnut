import { useEffect, useState } from 'react';
import { fetchConfig, updateConfig } from '@/api/config';
import { wsClient } from '@/api/ws';

/**
 * `agent.quick_parse` — whether the composers ask a model to guess a task's
 * project, dates and tier from the sentence being typed. Default OFF.
 *
 * Off by default because the cost lands on the one resource the whole UI shares.
 * On a CLI provider `agent.fast_model` resolves to the catalog's claude_cli haiku,
 * so each parse spawns a whole `claude -p`; measured 2026-09-17, all 144 calls
 * blew the 10s abort in quick-task-parse.ts, and because they are POSTs they took
 * every one of the six connection slots ahead of the GETs painting the screen.
 * Turning this on without also pointing `fast_model` at a direct-API model brings
 * that back — the field comment in src/core/types.ts spells it out.
 *
 * Same shape as useShowPriority, and for the same reason: ONE app-wide value read
 * by several composers, so the module owns a single cached value, a single deduped
 * fetch, and a single `config:changed` subscription rather than a fetch per mount.
 *
 * Starts FALSE and stays false until config actually says otherwise. That matters
 * more here than for a display flag: the failure mode of guessing wrong is a burst
 * of ten-second requests, so "not loaded yet" must read as off.
 *
 * One difference from useShowPriority, and it is the whole reason this file is not a
 * copy of it: MOUNTING A COMPOSER DOES NOT FETCH. useShowPriority is read by task
 * rows that exist at page load, so its one `/api/config` lands during boot; this
 * flag's first reader is the draft column, which appears when the user clicks "+",
 * and opening a draft column is contractually network-free (the request that used to
 * ride that path is exactly what starved the folder picker — see
 * tests/e2e/browser/draft-quick-parse-off.spec.ts scenario 4). So the fetch is
 * explicit: callers invoke `ensureQuickParseLoaded()` at the moments the answer is
 * actually needed — there is text to parse, or the menu showing the switch is open.
 */

let cached: boolean | null = null;
let inflight: Promise<void> | null = null;
let wsBound = false;
let lastSelfChange = 0;
/**
 * Bumped by every user write. A read that started BEFORE the write must not apply
 * its answer afterwards — the menu asks for the value as it opens, so a quick click
 * lands while that GET is still in flight and the stale `false` would arrive a beat
 * later and snap the switch back off. (Caught in WebKit by
 * tests/e2e/browser/draft-quick-parse-off.spec.ts; the parse effect in
 * DraftSessionPanel guards its own responses the same way, with appliedSeq.)
 */
let writeEpoch = 0;
const listeners = new Set<(v: boolean) => void>();

/** Our own write echoes back as config:changed; ignore that window. */
const SELF_CHANGE_COOLDOWN = 3000;

function publish(v: boolean) {
  cached = v;
  for (const l of listeners) l(v);
}

function load(): Promise<void> {
  if (inflight) return inflight;
  const epoch = writeEpoch;
  inflight = fetchConfig()
    .then((c) => { if (epoch === writeEpoch) publish(c.agent?.quick_parse === true); })
    // A failed read settles as OFF rather than as "still unknown". Not defensive
    // sugar: `ensureQuickParseLoaded()` is called from a per-keystroke effect, so
    // leaving the answer unknown would ask again on the NEXT keystroke, and a
    // retry loop hanging off typing is the exact shape this whole flag exists to
    // remove. A config read that failed is not permission anyway, and
    // `config:changed` still re-reads when the server has something to say.
    .catch(() => { if (epoch === writeEpoch) publish(false); })
    .finally(() => { inflight = null; });
  return inflight;
}

function bindConfigChanges() {
  if (wsBound) return;
  wsBound = true;
  wsClient.onEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'agent') return;
    if (Date.now() - lastSelfChange < SELF_CHANGE_COOLDOWN) return;
    void load();
  });
}

/**
 * Read config once per page, on demand. Call it where the answer is needed — with
 * text in the composer, or with the menu that draws the switch open — never on mount.
 */
export function ensureQuickParseLoaded(): Promise<void> {
  if (cached !== null) return Promise.resolve();
  return load();
}

/**
 * Whether the background parse may run. False until config says otherwise.
 *
 * SUBSCRIBE-ONLY: this never issues a request, so a composer can mount for free.
 * Pair it with `ensureQuickParseLoaded()` at the point of use.
 */
export function useQuickParseEnabled(): boolean {
  const [value, setValue] = useState<boolean>(cached ?? false);
  useEffect(() => {
    listeners.add(setValue);
    bindConfigChanges();
    if (cached !== null) setValue(cached);
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

/**
 * Flip the flag: echo to every mounted composer first, then persist.
 *
 * The read-then-spread is required, not defensive: updateConfig replaces the whole
 * `agent` object, so writing `{ agent: { quick_parse } }` on its own would drop
 * main_model, language, available_models and every other sibling key.
 *
 * A failed write reverts the echo. A toggle that stays lit while the config still
 * says off is worse than one that visibly refuses: the next reload would silently
 * undo it.
 */
export function setQuickParseEnabled(v: boolean): void {
  const previous = cached ?? false;
  const epoch = ++writeEpoch;
  publish(v);
  lastSelfChange = Date.now();
  fetchConfig()
    .then((c) => updateConfig({ agent: { ...c.agent, quick_parse: v } }))
    // Only OUR failure reverts: a second click in the meantime owns the value now,
    // and undoing it to this call's `previous` would be a worse lie than the one the
    // revert exists to prevent.
    .catch(() => { if (epoch === writeEpoch) publish(previous); });
}

/** Test seam: reset the module cache so a test starts from "not fetched". */
export function _resetQuickParseForTests(): void {
  cached = null;
  inflight = null;
  lastSelfChange = 0;
  writeEpoch = 0;
}
