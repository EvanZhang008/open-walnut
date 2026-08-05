#!/usr/bin/env npx tsx
/**
 * Manual latency and accuracy benchmark for quick-task parsing.
 *
 * Usage: npx tsx scripts/bench-quick-parse.mts [modelAlias...]
 * Requires real provider credentials. Add --dry-run to print the synthetic
 * fixture, digest, and model matrix without making provider calls.
 */
import { MODEL_CATALOG } from '../src/agent/providers/model-catalog.js';
import { getConfig } from '../src/core/config-manager.js';
import {
  parseQuickTask,
  type QuickTaskParseEnvelope,
  type QuickTaskParseOptions,
} from '../src/core/quick-task-parse.js';
import type { QuickTaskParse } from '../src/core/types.js';

type BenchmarkParseQuickTask = (
  text: string,
  opts: QuickTaskParseOptions,
) => Promise<QuickTaskParseEnvelope>;

type ParseField = keyof QuickTaskParse;
type ExactExpected = string | boolean | undefined;
type ExpectedValue = ExactExpected | RegExp | readonly Exclude<ExactExpected, undefined>[];
type ExpectedFields = Record<ParseField, ExpectedValue>;

interface Fixture {
  name: string;
  text: string;
  expected: ExpectedFields;
}

interface ModelSelection {
  requested: string;
  id: string;
}

interface Failure {
  model: string;
  input: string;
  field: ParseField;
  expected: string;
  got: string;
  rep: number;
}

const benchmarkParseQuickTask: BenchmarkParseQuickTask = parseQuickTask;
const MODEL_ALIASES = ['haiku', 'sonnet', 'opus'];
const REPS = 3;
const DIGEST_DELTA_REPS = 6;
const FIXED_NOW = new Date('2026-07-20T17:30:00.000Z');
const TIME_ZONE = 'America/Los_Angeles';
const FIELDS: ParseField[] = [
  'title',
  'due_date',
  'pinTier',
  'priority',
  'starred',
  'project',
];

const KNOWN_PROJECTS = ['Fitness', 'Website', 'Groceries', 'Pharmacy', 'Taxes', 'Budget'];

const PROJECT_DIGEST = `Synthetic task history:
- Fitness (2 open) — Book a workout class; Plan a weekend walk
- Website (2 open) — Update the contact page; Review homepage copy
- Groceries (2 open) — Buy milk; Pick up rice
- Pharmacy (1 open) — Refill a prescription
- Taxes (1 open) — Gather tax forms
- Budget (1 open) — Review the monthly budget
- Inbox (2 open) — Schedule an annual checkup; Organize old photos`;

function localCalendarDate(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function dateAtOffset(days: number): string {
  const base = localCalendarDate(FIXED_NOW, TIME_ZONE);
  const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day + days));
  return shifted.toISOString().slice(0, 10);
}

function nextWeekday(targetDay: number): string {
  const today = new Date(`${dateAtOffset(0)}T00:00:00.000Z`);
  const daysAhead = (targetDay - today.getUTCDay() + 7) % 7 || 7;
  return dateAtOffset(daysAhead);
}

function expected(fields: Partial<Record<ParseField, ExpectedValue>> & { title: ExpectedValue }): ExpectedFields {
  return Object.fromEntries(FIELDS.map((field) => [field, fields[field]])) as ExpectedFields;
}

const FIXTURES: Fixture[] = [
  {
    name: 'typo, time, and focus pin',
    text: 'buy milkk tomorrow at 2am, and pinned focus',
    expected: expected({
      title: /^buy milk$/i,
      due_date: `${dateAtOffset(1)}T02:00:00`,
      pinTier: 'focus',
      project: 'Groceries',
    }),
  },
  {
    name: 'urgent with explicit date',
    text: 'Urgent: submit website copy by July 22',
    expected: expected({
      title: /^submit (the )?website copy$/i,
      due_date: dateAtOffset(2),
      priority: 'immediate',
      project: 'Website',
    }),
  },
  {
    name: 'CJK note with time',
    text: '明天下午3点给妈妈打电话',
    expected: expected({
      title: '给妈妈打电话',
      due_date: `${dateAtOffset(1)}T15:00:00`,
    }),
  },
  {
    name: 'star with next weekday',
    text: 'star renew car registration next friday',
    expected: expected({
      title: ['Renew car registration', 'renew car registration'],
      due_date: nextWeekday(5),
      starred: true,
    }),
  },
  {
    name: 'no project match goes to inbox',
    text: 'schedule annual checkup',
    expected: expected({
      title: /^schedule (an )?annual checkup$/i,
    }),
  },
  {
    name: 'backlog phrasing',
    text: 'someday organize old photos',
    expected: expected({
      title: /^organize old photos$/i,
      priority: 'backlog',
    }),
  },
  {
    name: 'specific project match',
    text: 'update the website contact page',
    expected: expected({
      title: /^update (the )?website contact page$/i,
      project: 'Website',
    }),
  },
  {
    name: 'no matching project',
    text: 'replace the hallway light bulb',
    expected: expected({
      title: /^replace the hallway light bulb$/i,
      project: undefined,
    }),
  },
];

function resolveModel(requested: string, providerName: string): ModelSelection {
  const catalog = MODEL_CATALOG[providerName] ?? [];
  const exact = catalog.find((entry) => entry.id.toLowerCase() === requested.toLowerCase());
  if (exact) return { requested, id: exact.id };

  const matches = catalog.filter((entry) => entry.id.toLowerCase().includes(requested.toLowerCase()));
  const preferred = matches.find((entry) => !entry.id.toLowerCase().includes('1m')) ?? matches[0];
  return { requested, id: preferred?.id ?? requested };
}

function parseArgs(argv: string[]): { dryRun: boolean; requestedModels: string[] } {
  let dryRun = false;
  const requestedModels: string[] = [];
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      requestedModels.push(arg);
    }
  }
  return {
    dryRun,
    requestedModels: requestedModels.length > 0 ? requestedModels : MODEL_ALIASES,
  };
}

function formatValue(value: unknown): string {
  if (value === undefined) return '<absent>';
  if (value instanceof RegExp) return value.toString();
  if (Array.isArray(value)) return value.map((item) => JSON.stringify(item)).join(' | ');
  return JSON.stringify(value);
}

function formatExpected(fields: ExpectedFields): string {
  return FIELDS.map((field) => `${field}=${formatValue(fields[field])}`).join(', ');
}

function matchesExpected(actual: unknown, expectedValue: ExpectedValue): boolean {
  if (expectedValue === undefined) return actual === undefined;
  if (expectedValue instanceof RegExp) {
    expectedValue.lastIndex = 0;
    return typeof actual === 'string' && expectedValue.test(actual);
  }
  if (Array.isArray(expectedValue)) return expectedValue.some((candidate) => Object.is(candidate, actual));
  return Object.is(expectedValue, actual);
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

function accuracy(correct: number, total: number): string {
  return `${((correct / total) * 100).toFixed(1)}%`;
}

function optionsFor(modelOverride: string, includeDigest: boolean): QuickTaskParseOptions {
  const options: QuickTaskParseOptions = {
    modelOverride,
    now: FIXED_NOW,
    timeZone: TIME_ZONE,
    knownProjects: KNOWN_PROJECTS,
  };
  if (includeDigest) options.projectDigest = PROJECT_DIGEST;
  return options;
}

function assertEnvelope(value: QuickTaskParseEnvelope): QuickTaskParseEnvelope {
  if (!value || typeof value !== 'object' || !value.parse || typeof value.parse.title !== 'string') {
    throw new Error('parseQuickTask did not return the expected envelope contract');
  }
  if (!Number.isFinite(value.parseMs)) {
    throw new Error('parseQuickTask returned a non-numeric parseMs');
  }
  return value;
}

function printDryRun(providerName: string, models: ModelSelection[]): void {
  console.log('Quick-task parse benchmark dry run');
  console.log(`Provider: ${providerName}`);
  console.log(`Fixed now: ${FIXED_NOW.toISOString()}`);
  console.log(`Time zone: ${TIME_ZONE}`);
  console.log(`Repetitions: ${REPS} per model and fixture`);
  console.log('\nSynthetic project digest:\n' + PROJECT_DIGEST);
  console.log('\nKnown projects:', KNOWN_PROJECTS);

  console.log('\nModels:');
  console.table(models.map((model) => ({ alias: model.requested, model: model.id })));
  console.log('\nFixtures:');
  console.table(FIXTURES.map((fixture) => ({
    fixture: fixture.name,
    input: fixture.text,
    expected: formatExpected(fixture.expected),
  })));
  console.log('\nModel/fixture matrix:');
  console.table(models.flatMap((model) => FIXTURES.map((fixture) => ({
    model: model.id,
    fixture: fixture.name,
  }))));
}

async function runBenchmark(models: ModelSelection[]): Promise<void> {
  const summaryRows: Array<Record<string, string | number>> = [];
  const failures: Failure[] = [];

  for (const model of models) {
    const latencies: number[] = [];
    const scores = Object.fromEntries(FIELDS.map((field) => [field, { correct: 0, total: 0 }])) as Record<
      ParseField,
      { correct: number; total: number }
    >;

    console.log(`\nBenchmarking ${model.id}...`);
    for (const fixture of FIXTURES) {
      for (let rep = 1; rep <= REPS; rep += 1) {
        const envelope = assertEnvelope(await benchmarkParseQuickTask(
          fixture.text,
          optionsFor(model.id, true),
        ));
        latencies.push(envelope.parseMs);

        for (const field of FIELDS) {
          const expectedValue = fixture.expected[field];
          const actualValue = envelope.parse[field];
          scores[field].total += 1;
          if (matchesExpected(actualValue, expectedValue)) {
            scores[field].correct += 1;
          } else {
            failures.push({
              model: model.id,
              input: fixture.text,
              field,
              expected: formatValue(expectedValue),
              got: formatValue(actualValue),
              rep,
            });
          }
        }
      }
    }

    const totalCorrect = FIELDS.reduce((sum, field) => sum + scores[field].correct, 0);
    const totalChecks = FIELDS.reduce((sum, field) => sum + scores[field].total, 0);
    summaryRows.push({
      model: model.id,
      p50: rounded(percentile(latencies, 0.5)),
      p95: rounded(percentile(latencies, 0.95)),
      ...Object.fromEntries(FIELDS.map((field) => [
        `${field} %`,
        accuracy(scores[field].correct, scores[field].total),
      ])),
      'overall %': accuracy(totalCorrect, totalChecks),
    });
  }

  console.log('\nLatency (ms) and accuracy:');
  console.table(summaryRows);
  console.log('\nFailures:');
  if (failures.length === 0) {
    console.log('None');
  } else {
    console.table(failures);
  }

  await runDigestDelta(models[0]);
}

async function runDigestDelta(model: ModelSelection): Promise<void> {
  const withDigest: number[] = [];
  const withoutDigest: number[] = [];
  const fixture = FIXTURES[0];

  console.log(`\nDigest latency comparison on ${model.id} (${DIGEST_DELTA_REPS} reps per variant)...`);
  for (let rep = 0; rep < DIGEST_DELTA_REPS; rep += 1) {
    const variants = rep % 2 === 0 ? [true, false] : [false, true];
    for (const includeDigest of variants) {
      const envelope = assertEnvelope(await benchmarkParseQuickTask(
        fixture.text,
        optionsFor(model.id, includeDigest),
      ));
      (includeDigest ? withDigest : withoutDigest).push(envelope.parseMs);
    }
  }

  const withP50 = percentile(withDigest, 0.5);
  const withoutP50 = percentile(withoutDigest, 0.5);
  console.table([
    {
      variant: 'with digest',
      reps: DIGEST_DELTA_REPS,
      p50: rounded(withP50),
      p95: rounded(percentile(withDigest, 0.95)),
      'p50 delta': 'baseline',
    },
    {
      variant: 'without digest',
      reps: DIGEST_DELTA_REPS,
      p50: rounded(withoutP50),
      p95: rounded(percentile(withoutDigest, 0.95)),
      'p50 delta': `${rounded(withoutP50 - withP50)} ms`,
    },
  ]);
}

async function main(): Promise<void> {
  const { dryRun, requestedModels } = parseArgs(process.argv.slice(2));
  const config = await getConfig();
  const providerName = config.agent?.main_provider ?? 'bedrock';
  const models = requestedModels
    .map((requested) => resolveModel(requested, providerName))
    .filter((selection, index, all) => all.findIndex((item) => item.id === selection.id) === index);

  if (dryRun) {
    printDryRun(providerName, models);
    return;
  }

  await runBenchmark(models);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
