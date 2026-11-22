/**
 * A drill that is killed mid-way (restore-drill.test.ts, tests/e2e/restore-drill-boot.test.ts):
 * it starts a drill of the backups at argv[3] for the home at argv[2] with its folder under
 * argv[4], writes argv[5] once it reaches the step argv[6] names, then hangs there until the
 * test kills it. `folder` (the default): the drill's folder exists, no boot. `server`: its
 * trial server answers; `spawn`: its trial server was just started and boots; the file holds
 * that server's pid.
 */
import fs from 'node:fs';
import { LocalStore } from '../../../../src/core/backup/stores/local-store.js';
import { runRestoreDrill } from '../../../../src/core/backup/restore-drill.js';

const [home, dest, tmpRoot, ready, step = 'folder'] = process.argv.slice(2);
const hang = () => new Promise<void>(() => {});
await runRestoreDrill({
  cfg: { enabled: true, destination: { type: 'r2', bucket: 'b', account_id: '0'.repeat(32), access_key_id: 'AK', secret_access_key: 'S' } },
  dataDir: home,
  store: new LocalStore(dest),
  tmpRoot,
  freeBytes: async () => 1024 ** 4,
  boot: step !== 'folder',
  ...(step === 'server' ? { onServer: async (pid: number) => { fs.writeFileSync(ready, String(pid)); await hang(); } }
    : step === 'spawn' ? { onSpawn: async (pid: number) => { fs.writeFileSync(ready, String(pid)); await hang(); } }
      : { onFolder: async (dir: string) => { fs.writeFileSync(ready, dir); await hang(); } }),
});
