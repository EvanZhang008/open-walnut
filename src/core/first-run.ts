/**
 * First-run setup: a few questions a fresh install asks once (2026-11-05, the user:
 * "we ask some q, so far only the remotes host which one to add").
 *
 * The rule is in the config itself, so it holds for every install kind (npm, the
 * install script, the Mac app): the config.yaml a fresh install creates gets
 * `first_run: { at, steps }` when the server seeds it (seedConfigDefaults). The web
 * app asks every step in `steps` that `answered` does not hold yet. A config made
 * before this existed has no `first_run`, so an existing user is never asked; a step
 * added in a later release joins `FIRST_RUN_STEPS` and reaches only installs created
 * after it, because `steps` is fixed when the config is created.
 *
 * Not stamped on a cloud companion (its ssh config is not the person's), a host
 * replica (it holds the Mac's copy), or a server under a test runner (its fixture
 * pages would open under the dialog) unless the test asks with WALNUT_FIRST_RUN_SETUP=1.
 *
 * An older Walnut reads the field as an unknown key and keeps it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Config } from './types.js'
import { underTestRunner } from '../lib/real-ssh-guard.js'
import { CONFIG_HISTORY_DIR_NAME } from './config-history-name.js'

/**
 * What only a used data home holds. An empty config alone does not make a fresh install:
 * a config.yaml that was lost or emptied (and its backup with it) reads as `{}` too, and that
 * person's work is still there (2026-11-11 reviews). Files, and directories that count once
 * they hold anything (boot makes some of them empty before the config is seeded).
 * config.yaml.history (core/config-history.ts) holds dated copies of a config Walnut wrote.
 */
export const USED_HOME_MARKERS = [
  'config.yaml.bak', 'tasks/tasks.json', 'sessions.json', 'sessions.sqlite', 'chat-history.json', 'cron-jobs.json',
] as const
export const USED_HOME_DIRS = ['notes', 'boards', 'human-inbox', 'tasks/archive', 'memory/sessions', CONFIG_HISTORY_DIR_NAME] as const

/** Does this data home already hold someone's work (a marker file, or a marker dir with anything in it)? */
export async function homeHoldsWork(home: string): Promise<boolean> {
  for (const marker of USED_HOME_MARKERS) {
    if (await fs.access(path.join(home, marker)).then(() => true, () => false)) return true
  }
  for (const dir of USED_HOME_DIRS) {
    const entries = await fs.readdir(path.join(home, dir)).catch(() => [] as string[])
    if (entries.some((e) => !e.startsWith('.'))) return true
  }
  return false
}

/** Every question, in the order asked. */
export const FIRST_RUN_STEPS = ['hosts'] as const
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number]

export function isFirstRunStep(value: unknown): value is FirstRunStep {
  return typeof value === 'string' && (FIRST_RUN_STEPS as readonly string[]).includes(value)
}

/** May this server stamp a fresh config? Never a replica: the questions are the leader's. */
export function firstRunStampAllowed(env: NodeJS.ProcessEnv = process.env, follower = false): boolean {
  if (follower) return false
  if (env.WALNUT_FIRST_RUN_SETUP === '0') return false
  return !underTestRunner(env) || env.WALNUT_FIRST_RUN_SETUP === '1'
}

/**
 * Stamp `doc` (the stored config, inside the write lock) when it is a fresh one: no key
 * at all, so nothing was ever saved. Returns whether it wrote.
 */
export function stampFirstRun(doc: Record<string, unknown>, now: Date = new Date()): boolean {
  if (Object.keys(doc).length > 0) return false
  doc.first_run = { at: now.toISOString(), steps: [...FIRST_RUN_STEPS] }
  return true
}

/** The steps this install still asks, in order. */
export function pendingFirstRunSteps(config: Pick<Config, 'first_run'>): FirstRunStep[] {
  const fr = config.first_run
  if (!fr || !Array.isArray(fr.steps)) return []
  const answered = fr.answered && typeof fr.answered === 'object' ? fr.answered : {}
  return FIRST_RUN_STEPS.filter((s) => fr.steps!.includes(s) && typeof answered[s] !== 'string')
}

/**
 * Record an answer in the stored config (inside the write lock). A config with no
 * `first_run` (an install from before, reopening the question from Settings) gets
 * nothing written: there is nothing it would be asked again.
 */
export function recordFirstRunAnswer(doc: Record<string, unknown>, step: FirstRunStep, now: Date = new Date()): boolean {
  const fr = doc.first_run
  if (!fr || typeof fr !== 'object' || Array.isArray(fr)) return false
  const row = fr as { answered?: unknown }
  const answered = row.answered && typeof row.answered === 'object' && !Array.isArray(row.answered)
    ? row.answered as Record<string, unknown>
    : {}
  if (typeof answered[step] === 'string') return false
  row.answered = { ...answered, [step]: now.toISOString() }
  return true
}
