/**
 * `walnut device` — manage device tokens for cloud-mode authentication.
 *
 *   walnut device add <name>     — create a device, print its token ONCE
 *   walnut device revoke <name>  — revoke a device
 *   walnut device list           — list devices (no secrets)
 */

import chalk from 'chalk';
import { createDevice, revokePairing, listDevices } from '../core/device-auth.js';
import { detectLanAddress, detectTailnetAddress } from '../core/pairing-targets.js';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';

/** Matches the `--port` default in src/commands/index.ts. */
const CLI_DEFAULT_PORT = 3456;

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
    // Pairing URI — QR-encodable. Include a reachable server address when we
    // can find one; a URI without `server=` makes the app ask for it by hand.
    const lan = detectLanAddress();
    const server = lan ? `&server=${encodeURIComponent(`http://${lan}:${CLI_DEFAULT_PORT}`)}` : '';
    console.log(`  ${chalk.dim('Pairing URI:')} wn://pair?name=${encodeURIComponent(name)}&token=${token}${server}`);
    // A tailnet address reaches this machine from anywhere the phone is on the same tailnet.
    const tailnet = detectTailnetAddress();
    if (tailnet) {
      const tailnetServer = encodeURIComponent(`http://${tailnet.address}:${CLI_DEFAULT_PORT}`);
      console.log(`  ${chalk.dim('Tailnet URI:')} wn://pair?name=${encodeURIComponent(name)}&token=${token}&server=${tailnetServer}`);
    }
    if (!lan && !tailnet) {
      console.log(chalk.dim('  (no LAN address detected — enter the server address in the app)'));
    }
    console.log('');
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

export async function runDeviceRevoke(name: string, globals: GlobalOptions): Promise<void> {
  // revokePairing also removes the device's push rows and its pairing's copy on
  // the other box, so a lost phone stops getting letter subjects on its lock
  // screen (the console route does the same). What it cannot finish from this
  // process (no bridge here) is queued for the running server.
  const { revoked, push, twin } = await revokePairing(name);
  const pushQueued = !!push?.pending && !!push.queued;
  const pushStuck = !!push?.pending && !push.queued;
  const twinQueued = twin === 'queued';
  const twinStuck = twin === 'failed';
  // Which push rows are still there: this machine's own (its config write
  // failed), the primary's (not reached from here), or both.
  const where = push?.pendingWhere;
  const rowsHere = pushQueued && (where === 'here' || where === 'both');
  const rowsOnPrimary = pushQueued && (where === 'primary' || where === 'both' || where === undefined);
  if (globals.json) {
    outputJson({
      name, revoked,
      ...(push ? { pushTokensRevoked: push.removed, ...(push.pending ? { pushRevokePending: true, pushRevokeQueued: pushQueued, ...(where ? { pushRevokePendingWhere: where } : {}) } : {}) } : {}),
      ...(twin ? { otherBoxCopy: twin } : {}),
    });
    if (revoked && (pushStuck || twinStuck)) process.exitCode = 1;
    return;
  }
  if (!revoked) {
    console.error(chalk.red(`Device "${name}" not found.`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green(`Device "${name}" revoked.`));
  if (rowsHere) console.log(chalk.yellow('  Its push rows on this machine could not be removed yet (writing the config failed).'));
  if (rowsOnPrimary) console.log(chalk.yellow('  The primary could not be reached from here to remove its push rows there.'));
  if (twinQueued) console.log(chalk.yellow('  Its copy on the other box could not be removed from here.'));
  if (pushQueued || twinQueued) console.log(chalk.yellow('  The running Walnut server finishes the rest as soon as it can.'));
  if (pushStuck) console.error(chalk.red(`  Its push notifications may not have stopped: ${push?.pending}`));
  if (twinStuck) console.error(chalk.red('  Its copy on the other box was not removed, so its token may still work there.'));
  if (pushStuck || twinStuck) process.exitCode = 1;
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
