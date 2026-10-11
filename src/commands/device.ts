/**
 * `walnut device` — manage device tokens for cloud-mode authentication.
 *
 *   walnut device add <name> [--owner]  create a device, print its token ONCE
 *   walnut device revoke <name>         revoke a device
 *   walnut device owner <name>          name the Mac a cloud companion belongs to
 *   walnut device list                  list devices (no secrets)
 *
 * These edit auth.json directly: they are this machine's operator, the one
 * caller the device rules always allow (core/device-auth.ts).
 */

import chalk from 'chalk';
import { createDevice, revokePairing, listDevices, readDeviceRegistry, setCompanionOwner, type DeviceRegistry } from '../core/device-auth.js';
import { companionOwnerRecord } from '../core/device-actor.js';
import { detectLanAddress, detectTailnetAddress } from '../core/pairing-targets.js';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';

/** Matches the `--port` default in src/commands/index.ts. */
const CLI_DEFAULT_PORT = 3456;

/**
 * The owner worth naming: the recorded one, else the device that owns the
 * machine credentials (the rule where none is recorded). A Mac's own registry
 * records none, and its machine credentials are its own, so nothing is shown there.
 */
function shownOwner(reg: DeviceRegistry): string | undefined {
  return companionOwnerRecord(reg)?.name;
}

export async function runDeviceAdd(name: string, globals: GlobalOptions, opts: { owner?: boolean } = {}): Promise<void> {
  try {
    const { token, createdAt } = await createDevice(name, opts.owner ? { owner: true } : undefined);
    if (globals.json) {
      outputJson({ name, token, createdAt, ...(opts.owner ? { owner: true } : {}) });
      return;
    }
    console.log('');
    console.log(chalk.bold(`Device "${name}" paired${opts.owner ? ', and this cloud companion now belongs to it' : ''}.`));
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
  const wasOwner = shownOwner(await readDeviceRegistry()) === name;
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
  if (wasOwner) console.log(chalk.dim('  It was the Mac this cloud companion belongs to. The next Mac to connect becomes its owner, or name one with: walnut device owner <name>'));
  if (rowsHere) console.log(chalk.yellow('  Its push rows on this machine could not be removed yet (writing the config failed).'));
  if (rowsOnPrimary) console.log(chalk.yellow('  The primary could not be reached from here to remove its push rows there.'));
  if (twinQueued) console.log(chalk.yellow('  Its copy on the other box could not be removed from here.'));
  if (pushQueued || twinQueued) console.log(chalk.yellow('  The running Walnut server finishes the rest as soon as it can.'));
  if (pushStuck) console.error(chalk.red(`  Its push notifications may not have stopped: ${push?.pending}`));
  if (twinStuck) console.error(chalk.red('  Its copy on the other box was not removed, so its token may still work there.'));
  if (pushStuck || twinStuck) process.exitCode = 1;
}

export async function runDeviceOwner(name: string, globals: GlobalOptions): Promise<void> {
  try {
    const { removedCredentials, changed } = await setCompanionOwner(name);
    if (globals.json) {
      outputJson({ owner: name, removedCredentials, changed });
      return;
    }
    if (!changed) {
      console.log(chalk.green(`This cloud companion already belongs to "${name}". Nothing changed.`));
      return;
    }
    console.log(chalk.green(`This cloud companion now belongs to "${name}".`));
    if (removedCredentials.length > 0) {
      console.log(chalk.dim(`  Removed the connections of the Mac it belonged to before: ${removedCredentials.join(', ')}`));
    }
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

export async function runDeviceList(globals: GlobalOptions): Promise<void> {
  const devices = await listDevices();
  const owner = shownOwner(await readDeviceRegistry());
  if (globals.json) {
    outputJson({ devices, owner: owner ?? null });
    return;
  }
  if (devices.length === 0) {
    console.log(chalk.dim('No devices paired. Add one with: walnut device add <name>'));
    return;
  }
  console.log(chalk.bold(`${devices.length} device(s):`));
  for (const d of devices) {
    const lastUsed = d.lastUsedAt ? `last used ${d.lastUsedAt}` : 'never used';
    console.log(`  ${chalk.cyan(d.name)}${d.name === owner ? chalk.bold('  (owner)') : ''}  ${chalk.dim(`created ${d.createdAt} · ${lastUsed}`)}`);
  }
}
