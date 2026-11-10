/** The actual Mac app shell, in a background test window, with native mouse events. */
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { AUTOMATION_SILENCE_JS } from '../../../src/lib/automation-silence.js';

test('Recent accepts native human input and ignores automatic opens in the Mac app', async ({ request }) => {
  test.skip(process.platform !== 'darwin' || !process.env.WALNUT_RECENT_NATIVE_BINARY, 'Mac native test binary required');
  test.setTimeout(180_000);
  const ids: string[] = [];
  const project = `RecentNative${Date.now()}`;
  const out = process.env.WALNUT_RECENT_EVIDENCE_DIR!;
  await fs.mkdir(out, { recursive: true });
  const silence = `${out}/silence.js`;
  await fs.writeFile(silence, AUTOMATION_SILENCE_JS);
  try {
    for (const title of ['Human alpha', 'Human beta', 'Agent only']) {
      const response = await request.post('/api/tasks', { headers: { 'x-walnut-caller-kind': 'automation' }, data: { title, project } });
      expect(response.ok()).toBe(true);
      ids.push((await response.json()).task.id);
    }
    const run = await new Promise<{ code: number | null; log: string }>((resolve, reject) => {
      const child = spawn(process.env.WALNUT_RECENT_NATIVE_BINARY!, [], { env: {
        ...process.env, WALNUT_TEST_PORT: '3457', WALNUT_RECENT_IDS: ids.join(','), WALNUT_SILENCE_FILE: silence,
        WALNUT_DESKTOP_E2E_BACKGROUND: '1', WALNUT_DESKTOP_E2E_SNAPSHOTS: out,
      } });
      let log = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Native acceptance timed out: ${log}`)); }, 150_000);
      child.stdout.on('data', (data) => { log += data; });
      child.stderr.on('data', (data) => { log += data; });
      child.once('error', reject);
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code, log }); });
    });
    await fs.writeFile(`${out}/native-result.log`, run.log);
    expect(run.log).toContain('RecentHumanTouchTests: passed');
    expect(run.code).toBe(0);
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}?force=true`);
    await request.delete(`/api/projects/${encodeURIComponent(project)}`);
  }
});
