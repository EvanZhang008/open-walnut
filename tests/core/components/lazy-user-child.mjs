// A worker that loaded a component's entry and reads more of it later (the way
// transformers.js loads a backend file on first use): for upgrade-in-use.test.ts.
// Plain JS, so node and bun both run it as is.
import { createInterface } from 'node:readline';

const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const mod = await import(process.env.LAZY_ENTRY);
say({ ready: true });
createInterface({ input: process.stdin }).on('line', async () => {
  try {
    say({ value: await mod.later() });
  } catch (err) {
    say({ error: err instanceof Error ? err.message : String(err) });
  }
  process.exit(0);
});
