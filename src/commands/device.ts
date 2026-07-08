/**
 * `walnut device` — manage device tokens for cloud-mode authentication.
 *
 *   walnut device add <name>     — create a device, print its token ONCE
 *   walnut device revoke <name>  — revoke a device
 *   walnut device list           — list devices (no secrets)
 */

import chalk from 'chalk';
import { createDevice, revokeDevice, listDevices } from '../core/device-auth.js';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';

export async function runDeviceAdd(name: string, globals: GlobalOptions): Promise<void> {
  try {
    const { token, createdAt } = await createDevice(name);
    if (globals.json) {
      outputJson({ name, token, createdAt });
      return;
    }
    console.log('');
    console.log(chalk.bold(`Device "${name}" paired.`));
    console.log('');
    console.log(`  Token:  ${chalk.cyan(token)}`);
    console.log('');
    console.log(chalk.dim('  This token is shown ONCE and cannot be recovered — store it now.'));
    console.log(chalk.dim('  Use it as:  Authorization: Bearer <token>'));
    console.log('');
    // Pairing URI — QR-encodable for future mobile onboarding.
    console.log(`  ${chalk.dim('Pairing URI:')} wn://pair?name=${encodeURIComponent(name)}&token=${token}`);
    console.log('');
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

export async function runDeviceRevoke(name: string, globals: GlobalOptions): Promise<void> {
  const removed = await revokeDevice(name);
  if (globals.json) {
    outputJson({ name, revoked: removed });
    return;
  }
  if (removed) {
    console.log(chalk.green(`Device "${name}" revoked.`));
  } else {
    console.error(chalk.red(`Device "${name}" not found.`));
    process.exitCode = 1;
  }
}

export async function runDeviceList(globals: GlobalOptions): Promise<void> {
  const devices = await listDevices();
  if (globals.json) {
    outputJson({ devices });
    return;
  }
  if (devices.length === 0) {
    console.log(chalk.dim('No devices paired. Add one with: walnut device add <name>'));
    return;
  }
  console.log(chalk.bold(`${devices.length} device(s):`));
  for (const d of devices) {
    const lastUsed = d.lastUsedAt ? `last used ${d.lastUsedAt}` : 'never used';
    console.log(`  ${chalk.cyan(d.name)}  ${chalk.dim(`created ${d.createdAt} · ${lastUsed}`)}`);
  }
}
