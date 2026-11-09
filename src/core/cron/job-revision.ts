import { createHash } from 'node:crypto';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function cronJobRevision(job: object): string {
  const fields = Object.entries(job).filter(([key]) => key !== 'state' && key !== 'updatedAtMs');
  return createHash('sha256').update(stable(Object.fromEntries(fields))).digest('hex');
}

export class CronJobChangedError extends Error {
  readonly statusCode = 409;
  readonly code = 'routine_changed';
  constructor() {
    super('The routine changed elsewhere. Read it again before changing it.');
    this.name = 'CronJobChangedError';
  }
}
