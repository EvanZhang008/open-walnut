/**
 * Daemon-runtime hooks — load user YAML, compile to the pushable rules JSON.
 *
 * A daemon hook is ONE self-contained YAML file in ~/.open-walnut/hooks/ with
 * `runtime: daemon`. No side files: everything the daemon needs must be inside
 * the YAML, because the compiled JSON is the ONLY thing that travels to the
 * remote host (hooks.configure RPC). The user never has to wonder whether the
 * daemon "has" some referenced file — there is nothing to reference.
 *
 * Security model: rule CONTENT can only come from files on the user's own disk
 * (this loader). The REST/Settings surface may toggle `enabled`, never write
 * rule bodies — someone with API access can switch existing hooks on/off but
 * cannot inject new behavior. (That is also why Phase 1 ships no run-script
 * action: pushing executable text needs its own review.)
 *
 * Default posture: zero hooks. The repo ships TEMPLATES (src/data/hook-templates/),
 * never active hooks; installing one = copying it into ~/.open-walnut/hooks/.
 * Back-compat sugar: config `session.cron_policy: 'session-only'` compiles the
 * built-in session-only-cron rule set as if the user had the template installed
 * (their own file with the same id wins).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import {
  builtinSessionOnlyCronHook,
  type DaemonHookAction,
  type DaemonHookPoint,
  type DaemonHookRule,
  type DaemonHooksConfig,
} from '../../providers/daemon-core.js';
import type { Config } from '../types.js';

const HOOKS_DIR = path.join(WALNUT_HOME, 'hooks');

const VALID_POINTS: ReadonlySet<string> = new Set<DaemonHookPoint>([
  'cron.create', 'cron.created', 'cron.fire', 'session.reap',
]);
const VALID_ACTIONS: ReadonlySet<string> = new Set<DaemonHookAction>([
  'deny', 'inject', 'evict', 'strip-own-rows', 'log',
]);

/** Parsed + validated user file (before compilation). */
export interface DaemonHookFile {
  id: string;
  file: string;
  name?: string;
  description?: string;
  enabled: boolean;
  rules: DaemonHookRule[];
  /** Validation problems — a hook with any is listed but never compiled. */
  errors: string[];
}

interface RawHookYaml {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  runtime?: unknown;
  enabled?: unknown;
  rules?: unknown;
}

function validateRules(raw: unknown, errors: string[]): DaemonHookRule[] {
  if (!Array.isArray(raw)) {
    errors.push('rules must be a list');
    return [];
  }
  const rules: DaemonHookRule[] = [];
  raw.forEach((r, i) => {
    if (!r || typeof r !== 'object') { errors.push(`rules[${i}] is not a map`); return; }
    const rule = r as Record<string, unknown>;
    if (typeof rule.on !== 'string' || !VALID_POINTS.has(rule.on)) {
      errors.push(`rules[${i}].on must be one of: ${[...VALID_POINTS].join(', ')}`);
      return;
    }
    if (typeof rule.action !== 'string' || !VALID_ACTIONS.has(rule.action)) {
      errors.push(`rules[${i}].action must be one of: ${[...VALID_ACTIONS].join(', ')}`);
      return;
    }
    if (rule.when !== undefined) {
      if (rule.when === null || typeof rule.when !== 'object' || Array.isArray(rule.when)) {
        errors.push(`rules[${i}].when must be a flat map of dot-path → value`);
        return;
      }
      // Values must be primitives: the evaluator matches with strict equality,
      // so a nested object (the natural YAML spelling `when: {input: {durable:
      // true}}`) would compile fine and then never match anything. Fail loud.
      for (const [k, v] of Object.entries(rule.when)) {
        if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
          errors.push(`rules[${i}].when["${k}"] must be a primitive — use a dot-path key (e.g. "input.durable": true), not a nested map`);
          return;
        }
      }
    }
    // Key order matters for the wire hash (JSON.stringify is insertion-ordered):
    // keep {on, when, action} to match builtinSessionOnlyCronHook, so installing
    // the shipped template compiles to the SAME hash as the config sugar.
    rules.push({
      on: rule.on as DaemonHookPoint,
      ...(rule.when ? { when: rule.when as Record<string, unknown> } : {}),
      action: rule.action as DaemonHookAction,
    });
  });
  return rules;
}

// Bounds on the sync scan: this runs on the server event loop (per host per
// (re)connect + on config:changed), which is fine for a handful of small
// YAMLs but must not be derailable by a 50MB stray file or a dumped node_modules.
const MAX_HOOK_FILES = 64;
const MAX_HOOK_FILE_BYTES = 64 * 1024;

/** Scan ~/.open-walnut/hooks/*.yaml for runtime:daemon hooks. Never throws. */
export function loadDaemonHookFiles(): DaemonHookFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  } catch { return []; }
  if (entries.length > MAX_HOOK_FILES) {
    log.session.warn('daemon hooks dir has too many files — extra ones ignored', {
      count: entries.length, max: MAX_HOOK_FILES,
    });
    entries = entries.slice(0, MAX_HOOK_FILES);
  }

  const out: DaemonHookFile[] = [];
  for (const file of entries) {
    const full = path.join(HOOKS_DIR, file);
    try {
      if (fs.statSync(full).size > MAX_HOOK_FILE_BYTES) {
        out.push({
          id: file.replace(/\.ya?ml$/, ''), file, enabled: false, rules: [],
          errors: [`file exceeds ${MAX_HOOK_FILE_BYTES} bytes — a hook YAML should be tiny`],
        });
        continue;
      }
      const raw = yaml.load(fs.readFileSync(full, 'utf-8')) as RawHookYaml | null;
      if (!raw || typeof raw !== 'object') continue;
      // .yaml hooks may later grow a server runtime; this module only owns
      // daemon ones. But a TYPO ('Daemon', 'demon') would silently drop the
      // hook the user thinks is installed — flag anything unrecognized.
      if (raw.runtime !== 'daemon') {
        if (raw.runtime !== undefined && raw.runtime !== 'server') {
          log.session.warn('hook file has unrecognized runtime — ignored', { file, runtime: String(raw.runtime) });
        }
        continue;
      }
      const errors: string[] = [];
      const id = typeof raw.id === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw.id) && raw.id.length <= 64 ? raw.id : null;
      if (!id) errors.push('id must be kebab-case (a-z0-9 segments joined by single hyphens, max 64 chars)');
      const rules = validateRules(raw.rules, errors);
      if (!errors.length && rules.length === 0) errors.push('no valid rules');
      out.push({
        id: id ?? file.replace(/\.ya?ml$/, ''),
        file,
        name: typeof raw.name === 'string' ? raw.name : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        enabled: raw.enabled !== false,
        rules,
        errors,
      });
    } catch (err) {
      out.push({
        id: file.replace(/\.ya?ml$/, ''), file, enabled: false, rules: [],
        errors: [`unreadable: ${err instanceof Error ? err.message : String(err)}`],
      });
    }
  }
  return out;
}

/**
 * Compile everything pushable into the wire config. Deterministic (sorted by
 * id) so the hash is stable across restarts and the daemon can skip no-ops.
 */
export function compileDaemonHooks(config: Config): DaemonHooksConfig {
  const files = loadDaemonHookFiles();

  // Dedupe by id, first file wins (readdir order = alphabetical). Duplicate
  // ids are almost always a stale copy (x.yaml + x.backup.yaml with the same
  // id) — compiling both would UNION their actions in the daemon, so an
  // `enabled: false` on one copy would NOT shadow the other. Fail toward one.
  const seen = new Map<string, string>();
  const hooks: DaemonHooksConfig['hooks'] = [];
  for (const f of files) {
    if (f.errors.length) {
      log.session.warn('daemon hook file skipped (invalid)', { file: f.file, errors: f.errors });
      continue;
    }
    const winner = seen.get(f.id);
    if (winner) {
      log.session.warn('daemon hook file skipped (duplicate id)', { file: f.file, id: f.id, winner });
      continue;
    }
    seen.set(f.id, f.file);
    hooks.push({ id: f.id, enabled: f.enabled, rules: f.rules });
  }

  // Config sugar → built-in rule set, unless a user FILE claims the id — even
  // an invalid one: silently substituting the built-in rules for a file the
  // user deliberately edited (and broke) would resurrect rules they removed.
  const userOwnsId = files.some((f) => f.id === 'session-only-cron');
  if (config.session?.cron_policy === 'session-only' && !userOwnsId) {
    hooks.push(builtinSessionOnlyCronHook());
  }

  hooks.sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash('sha256').update(JSON.stringify(hooks)).digest('hex').slice(0, 16);
  return { version: 1, hash, hooks };
}
