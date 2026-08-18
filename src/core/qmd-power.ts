import { execFile } from 'node:child_process';

const POWER_CHECK_CACHE_MS = 60_000;
const POWER_CHECK_TIMEOUT_MS = 2_000;
const BATTERY_RETRY_AFTER_MS = 5 * 60_000;

let cachedAt = 0;
let cachedOnBattery = false;

export class QmdBatteryPowerDeferredError extends Error {
  readonly retryAfterMs = BATTERY_RETRY_AFTER_MS;

  constructor() {
    super('QMD background indexing deferred while running on battery power');
    this.name = 'QmdBatteryPowerDeferredError';
  }
}

export function parsePmsetBatteryPower(output: string): boolean {
  return /drawing from ['"]Battery Power['"]/i.test(output);
}

async function readMacBatteryPower(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile(
      '/usr/bin/pmset',
      ['-g', 'batt'],
      { timeout: POWER_CHECK_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error ? false : parsePmsetBatteryPower(stdout));
      },
    );
  });
}

export async function assertQmdBackgroundIndexPowerAvailable(): Promise<void> {
  if (
    process.platform !== 'darwin'
    || process.env.WALNUT_QMD_ALLOW_BATTERY_INDEXING === '1'
  ) {
    return;
  }

  const now = Date.now();
  if (now - cachedAt >= POWER_CHECK_CACHE_MS) {
    cachedOnBattery = await readMacBatteryPower();
    cachedAt = Date.now();
  }

  if (cachedOnBattery) throw new QmdBatteryPowerDeferredError();
}
