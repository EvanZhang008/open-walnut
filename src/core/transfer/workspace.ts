/**
 * Moving a task's workspace to another host: pack it where it is, put the pack
 * on the target, decide where the work lives there. The new session applies
 * the pack itself (clone, apply the patch, unpack untracked files, install what
 * is missing): an agent handles authentication, a missing tool or a conflict
 * far better than a fixed script, and every step it takes is visible.
 *
 * The files travel host to host when the target can reach the source over its
 * own SSH (the daemon there pulls them with scp); otherwise this server relays
 * them in chunks. Whichever worked is remembered in the target's profile, so
 * the next transfer between the same two hosts tries the route that works first.
 */
import path from 'node:path';
import { log } from '../../logging/index.js';
import type { PackMeta, PackReply } from './daemon-transfer-client.js';
import { LOCAL_HOST } from './planner.js';
import { WALNUT_HOME } from '../../constants.js';
import { readHostProfile, recordReach, repoKey, type HostProfile } from '../hosts/host-profile.js';

/**
 * Where a host keeps transfer files: beside this server's own data dir here (an
 * isolated server never writes into another's), `~/.open-walnut-transfers`
 * elsewhere. Outside the data dir on purpose: git-sync never carries packed code
 * to the companion, and the daemon refuses file writes under its own runtime
 * root (`~/.open-walnut/tmp`, where the session streams live), so a transfer
 * file there could never be copied (2026-10-21: clouddev to Mac failed with
 * "fs.copy refused: path outside the mutation floor").
 */
export function transfersDir(host: string): string {
  return host === LOCAL_HOST ? `${WALNUT_HOME.replace(/\/+$/, '')}-transfers` : '~/.open-walnut-transfers';
}

const KEEP_TRANSFER_FILES_MS = 7 * 24 * 3600_000;

/** Remove this machine's transfer files older than a week (the new session has
 *  long applied them). Only `xf-…` entries, never anything else in the folder, and
 *  never a private transcript stage (an `.attempt` inside): a transfer that did not
 *  finish keeps its stage until someone decides about it. */
export async function pruneLocalTransfers(now = Date.now()): Promise<number> {
  const fsp = await import('node:fs/promises');
  const dir = transfersDir(LOCAL_HOST);
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!/^xf-[0-9a-f-]+$/.test(name)) continue;
    const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (!stat || now - stat.mtimeMs < KEEP_TRANSFER_FILES_MS) continue;
    if (await fsp.lstat(path.join(dir, name, '.attempt')).then(() => true, (e: NodeJS.ErrnoException) => e.code !== 'ENOENT')) continue;
    await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

export interface MovedWorkspace {
  meta: PackMeta;
  /** Directory on the target host holding the pack files. */
  bundleDir: string;
  files: string[];
  route: 'direct' | 'relay';
  /** Bytes moved. */
  bytes: number;
}

interface SshTarget { host: string; user?: string; port?: number }

/** How the target host would address the source over its own SSH (none for this Mac). */
async function sshTargetOf(sourceHost: string): Promise<SshTarget | null> {
  if (sourceHost === LOCAL_HOST) return null;
  const { getConfig } = await import('../config-manager.js');
  const def = (await getConfig()).hosts?.[sourceHost] as { hostname?: string; user?: string; port?: number } | undefined;
  const hostname = def?.hostname || sourceHost;
  if (!/^[A-Za-z0-9._-]+$/.test(hostname)) return null;
  return { host: hostname, ...(def?.user ? { user: def.user } : {}), ...(def?.port ? { port: def.port } : {}) };
}

export async function moveWorkspace(opts: {
  transferId: string;
  sourceHost: string;
  sourceCwd: string;
  targetHost: string;
}): Promise<MovedWorkspace> {
  const client = await import('./daemon-transfer-client.js');
  const sourceDir = `${transfersDir(opts.sourceHost)}/${opts.transferId}/pack`;
  const pack: PackReply = await client.packWorkspace(opts.sourceHost, { cwd: opts.sourceCwd, outDir: sourceDir });
  const bundleDir = `${transfersDir(opts.targetHost)}/${opts.transferId}/pack`;
  const bytes = pack.files.reduce((n, f) => n + f.size, 0);

  const ssh = await sshTargetOf(opts.sourceHost);
  const profile = await readHostProfile(opts.targetHost).catch(() => null);
  const knownBad = ssh && profile?.observed.reaches[opts.sourceHost]?.ok === false
    && Date.now() - Date.parse(profile.observed.reaches[opts.sourceHost].at) < 24 * 3600_000;
  if (ssh && !knownBad) {
    try {
      const reach = await client.reachHost(opts.targetHost, ssh);
      if (reach.reachable) {
        const fetched = await client.fetchFromHost(opts.targetHost, {
          ...ssh,
          files: pack.files.map((f) => ({
            remotePath: `${pack.outDir}/${f.name}`, localPath: `${bundleDir}/${f.name}`, size: f.size, sha256: f.sha256,
          })),
        });
        if (fetched.ok) {
          await recordReach(opts.targetHost, opts.sourceHost, true);
          return { meta: pack.meta, bundleDir, files: pack.files.map((f) => f.name), route: 'direct', bytes };
        }
        const why = fetched.results.find((r) => !r.ok)?.error ?? 'copy failed';
        await recordReach(opts.targetHost, opts.sourceHost, false, why);
      } else {
        await recordReach(opts.targetHost, opts.sourceHost, false, reach.error);
      }
    } catch (err) {
      log.session.info('transfer: direct host-to-host copy unavailable, relaying', {
        from: opts.sourceHost, to: opts.targetHost, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const f of pack.files) {
    await client.relayFile(opts.sourceHost, `${pack.outDir}/${f.name}`, opts.targetHost, `${bundleDir}/${f.name}`, { size: f.size, sha256: f.sha256 });
  }
  return { meta: pack.meta, bundleDir, files: pack.files.map((f) => f.name), route: 'relay', bytes };
}

/** The folder a repository goes to on a host that has not seen it. */
export function defaultWorkRoot(profile: HostProfile | null): string {
  const home = profile?.probed?.home;
  return `${home || '~'}/walnut-work`;
}

/**
 * Where the work lives on the target: a path the target already knows for
 * this repository, else a fresh folder under walnut-work named after it.
 * Returns the directory the session starts in (the repo root plus the source's
 * subdirectory) and whether the repository is expected to exist there already.
 */
export function chooseTargetCwd(meta: PackMeta | null, sourceCwd: string, profile: HostProfile | null): {
  cwd: string; repoRoot: string; known: boolean; key: string;
} {
  const folder = path.posix.basename(meta?.root || sourceCwd) || 'workspace';
  const key = repoKey(meta?.remotes?.[0]?.url, folder);
  const knownPath = profile?.observed.repoPaths[key]?.path;
  const repoRoot = knownPath || `${defaultWorkRoot(profile)}/${folder}`;
  const rel = meta?.relCwd ?? '';
  // A repository the host does not have yet starts in its (empty) root, so the
  // session can clone into it; a subdirectory there would make the root non-empty.
  return { cwd: rel && knownPath ? `${repoRoot}/${rel}` : repoRoot, repoRoot, known: !!knownPath, key };
}

/** Steps for the new session to set the workspace up from the pack. */
export function workspaceInstructions(moved: MovedWorkspace, target: { repoRoot: string; known: boolean }): string {
  const m = moved.meta;
  const lines: string[] = [];
  const has = (name: string) => moved.files.includes(name);
  lines.push(`The workspace was packed on the old host and copied here (${moved.route === 'direct' ? 'host to host' : 'through Walnut'}) into ${moved.bundleDir}: ${moved.files.join(', ')}. meta.json there describes it.`);
  if (m.kind === 'git') {
    const remote = m.remotes?.[0];
    lines.push(`It is a git repository${remote ? ` (remote ${remote.name}: ${remote.url})` : ' with no remote'}, branch ${m.branch ?? '(detached)'} at ${m.head ?? 'no commit yet'}.`);
    if (target.known) {
      lines.push(`This host already has it at ${target.repoRoot}. Keep any local changes there: fetch, then check out the branch above (create it at the commit if needed).`);
    } else {
      lines.push(`Set it up at ${target.repoRoot}${remote ? `: clone ${remote.url} into it (it exists and is empty: \`git clone ${remote.url} .\`), then check out ${m.branch ?? m.head}` : ' (`git init` there first)'}.`);
    }
    if (has('repo.bundle')) lines.push(`The commits that are not on the remote are in repo.bundle${m.bundle?.base ? ` (based on ${m.bundle.base})` : ' (a full bundle)'}: \`git fetch <bundle> ${m.branch ?? 'HEAD'}\` and move the branch to it.`);
    if (has('changes.patch')) lines.push('Then apply the uncommitted changes, leaving them uncommitted and unstaged as they were: `git apply changes.patch` (use --3way if it does not apply cleanly).');
    if (has('untracked.tgz')) lines.push('Unpack untracked.tgz at the repository root for the files git does not track.');
    if (!target.known && m.relCwd) lines.push(`The work was in ${m.relCwd} inside the repository: continue there once it is set up.`);
    if (m.untracked?.skipped?.length) lines.push(`Left out (too large to move): ${m.untracked.skipped.slice(0, 20).join(', ')}${m.untracked.skipped.length > 20 ? ', …' : ''}.`);
  } else {
    lines.push(m.tooLarge
      ? 'It was not a git repository and was too large to move; recreate what you need from the conversation.'
      : `It was not a git repository: unpack workspace.tgz into ${target.repoRoot}.`);
  }
  return lines.join('\n');
}
