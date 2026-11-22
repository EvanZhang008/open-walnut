/**
 * A drill that is killed mid-way (restore-drill.test.ts): it starts a drill of the
 * backups at argv[3] for the home at argv[2] with its folder under argv[4], writes
 * argv[5] once the drill's folder exists, then hangs there until the test kills it.
 */
import fs from 'node:fs';
import { LocalStore } from '../../../../src/core/backup/stores/local-store.js';
import { runRestoreDrill } from '../../../../src/core/backup/restore-drill.js';

const [home, dest, tmpRoot, ready] = process.argv.slice(2);
await runRestoreDrill({
  cfg: { enabled: true, destination: { type: 'r2', bucket: 'b', account_id: '0'.repeat(32), access_key_id: 'AK', secret_access_key: 'S' } },
  dataDir: home,
  store: new LocalStore(dest),
  tmpRoot,
  freeBytes: async () => 1024 ** 4,
  onFolder: async (dir) => {
    fs.writeFileSync(ready, dir);
    await new Promise(() => {});
  },
});
