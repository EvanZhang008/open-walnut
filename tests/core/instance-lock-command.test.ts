import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-instance-lock-command'));

import { TASKS_DIR } from '../../src/constants.js';
import { listForeignDbHolders } from '../../src/core/instance-lock.js';

const DB_FILE = path.join(TASKS_DIR, 'tasks.sqlite');
let holder: ChildProcess | null = null;

beforeEach(async () => {
  await fsp.mkdir(TASKS_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, '');
});

afterEach(async () => {
  if (holder?.exitCode === null) holder.kill('SIGKILL');
  holder = null;
  await fsp.rm(TASKS_DIR, { recursive: true, force: true });
});

describe('foreign DB-holder diagnostics', () => {
  it('reports the full process command instead of only the executable name', async () => {
    holder = spawn('tail', ['-f', DB_FILE], { stdio: 'ignore' });
    let found: { pid: number; command: string } | undefined;
    const deadline = Date.now() + 5_000;
    while (!found && Date.now() < deadline) {
      found = (await listForeignDbHolders()).find((item) => item.pid === holder?.pid);
      if (!found) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(found?.command).toContain('tail -f');
    expect(found?.command).toContain(DB_FILE);
  });
});
