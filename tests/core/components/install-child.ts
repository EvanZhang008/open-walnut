/**
 * One installer in its own process, for the two-process tests in
 * install.test.ts. Reads its job from INSTALL_CHILD (JSON: root, platform,
 * manifest, options) and prints one JSON line per phase, then the result.
 */
import { installComponent } from '../../../src/core/components/install.js';
import type { ComponentName, ComponentsManifest, Platform } from '../../../src/core/components/types.js';

interface Job {
  name: ComponentName;
  root: string;
  platform: Platform;
  manifest: ComponentsManifest;
  options: Record<string, unknown>;
}

const job = JSON.parse(process.env.INSTALL_CHILD ?? '{}') as Job;
const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

try {
  const inst = await installComponent(job.name, {
    ...job.options,
    root: job.root,
    platform: job.platform,
    manifest: job.manifest,
    onPhase: (phase) => say({ phase }),
  });
  say({ done: inst.dir });
  process.exit(0);
} catch (err) {
  say({ error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code });
  process.exit(1);
}
