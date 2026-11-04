/**
 * One backup job at a time on this machine: a backup run, a restore, or the
 * legacy S3 mirror. A restore during a backup would race its prune (which
 * deletes packs), and two backups would upload the same chunks twice.
 */

export type BackupJobKind = 'backup' | 'restore';

let current: { kind: BackupJobKind; promise: Promise<unknown> } | null = null;

export function currentBackupJob(): BackupJobKind | null {
  return current?.kind ?? null;
}

export class BackupBusyError extends Error {
  constructor(readonly running: BackupJobKind) {
    super(running === 'restore' ? 'A restore is running. Try again when it finishes.' : 'A backup is running. Try again when it finishes.');
    this.name = 'BackupBusyError';
  }
}

/**
 * Run `fn` as the one job. A second backup while a backup runs joins it; any
 * other overlap is refused with BackupBusyError.
 */
export function runBackupJob<T>(kind: BackupJobKind, fn: () => Promise<T>): Promise<T> {
  if (current) {
    if (current.kind === kind && kind === 'backup') return current.promise as Promise<T>;
    return Promise.reject(new BackupBusyError(current.kind));
  }
  const promise = fn().finally(() => {
    if (current?.promise === promise) current = null;
  });
  current = { kind, promise };
  return promise;
}
