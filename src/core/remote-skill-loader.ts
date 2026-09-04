/**
 * Remote skill discovery: lists the skills available on a REMOTE host (where a
 * remote session's `claude -p` actually runs), so the slash-command palette
 * reflects that host's capabilities instead of the Mac's local skills.
 *
 * Reuses the reader-agnostic `discoverPluginSkills` core from plugin-skill-loader,
 * backed by a `SkillFs` that reads over the daemon's fs.* protocol — the same
 * channel `/api/files/list?host=` already uses for remote file mentions. No new
 * daemon command is needed (fs.read + fs.ls already exist).
 *
 * Discovers two remote sources, mirroring the local loader:
 *   - plugin skills:  enabled plugins' <plugin>/skills/<skill>/SKILL.md
 *   - flat skills:    ~/.claude/skills/<skill>/SKILL.md
 */
import path from 'node:path';
import { log } from '../logging/index.js';
import type { DaemonConnection } from '../providers/daemon-connection.js';
import { commandDescription } from '../utils/frontmatter.js';
import {
  discoverPluginSkills,
  parseSkillMeta,
  mapLimit,
  type SkillFs,
  type PluginSkillMeta,
} from './plugin-skill-loader.js';

export interface RemoteSkillMeta {
  dirName: string;
  description: string;
  /** "<plugin>@<marketplace>", or "__flat__" for ~/.claude/skills entries. */
  plugin: string;
}

export interface RemoteCommandMeta {
  name: string;
  description: string;
}

// Remote paths are posix and use ~ (the daemon's fs.* commands expand ~ on the
// remote host). settings.json + plugins dir live under the remote home.
const REMOTE_SETTINGS_FILE = '~/.claude/settings.json';
const REMOTE_PLUGINS_DIR = '~/.claude/plugins';
const REMOTE_FLAT_SKILLS_DIR = '~/.claude/skills';

/** Build a SkillFs that reads the remote host over a daemon connection. */
function daemonSkillFs(conn: DaemonConnection): SkillFs {
  return {
    async readText(p) {
      try {
        const res = await conn.send('fs.read', { path: p, encoding: 'utf-8' });
        if (!res.ok) return null;
        return typeof res.data === 'string' ? res.data : null;
      } catch {
        return null;
      }
    },
    async list(p) {
      try {
        const res = await conn.send('fs.ls', { path: p });
        if (!res.ok) return null;
        const entries = res.entries as Array<{ name: string }> | undefined;
        return entries ? entries.map((e) => e.name) : null;
      } catch {
        return null;
      }
    },
    async isDir(p) {
      try {
        const res = await conn.send('fs.ls', { path: p });
        return res.ok === true;
      } catch {
        return false;
      }
    },
    // Remote paths are always posix; never touch the local separator.
    join: (...parts: string[]) => path.posix.join(...parts),
    // Leave ~ intact — the daemon expands it on the remote host.
    expandHome: (p: string) => p,
  };
}

/** Scan the remote flat ~/.claude/skills/ dir (remote equivalent of listAvailableSkills).
 *  Reads are pipelined (each is a daemon RTT) — sequential awaits over a big
 *  skills dir were the bulk of the 12-22s /api/slash-commands?host= scans. */
async function listRemoteFlatSkills(fs: SkillFs, dir: string = REMOTE_FLAT_SKILLS_DIR): Promise<PluginSkillMeta[]> {
  const entries = await fs.list(dir);
  if (entries === null) return [];
  const metas = await mapLimit(entries, 16, async (entry) => {
    const file = fs.join(dir, entry, 'SKILL.md');
    const raw = await fs.readText(file);
    if (raw === null) return null;
    const meta = parseSkillMeta(raw);
    return {
      dirName: entry,
      name: meta.name ?? entry,
      description: meta.description ?? '',
      location: file,
      plugin: '__flat__',
    };
  });
  return metas.filter((m): m is PluginSkillMeta => m !== null);
}

/**
 * Discover all skills (plugin + flat) available on a remote host.
 * Caller supplies an already-connected DaemonConnection.
 * Deduplicates by `<plugin>:<dirName>` (the CLI's identity for a skill); flat
 * skills are listed first so a bare-name fold shadows plugin copies, matching
 * the local loader where ~/.claude/skills/ wins.
 */
export async function listRemoteSkills(conn: DaemonConnection): Promise<RemoteSkillMeta[]> {
  const fs = daemonSkillFs(conn);

  const [flat, plugin] = await Promise.all([
    listRemoteFlatSkills(fs),
    discoverPluginSkills(fs, {
      settingsFile: REMOTE_SETTINGS_FILE,
      pluginsDir: REMOTE_PLUGINS_DIR,
    }),
  ]);

  // Keyed the way the CLI names them (`<plugin>:<dirName>`, flat skills bare), so
  // two plugins shipping a same-named skill both survive; the discovery palette
  // folds duplicates by bare name later, flat first.
  const seen = new Set<string>();
  const out: RemoteSkillMeta[] = [];
  for (const s of [...flat, ...plugin]) {
    const key = `${s.plugin}:${s.dirName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dirName: s.dirName, description: s.description, plugin: s.plugin });
  }

  log.task.debug('remote-skill-loader: discovered remote skills', {
    flat: flat.length,
    plugin: plugin.length,
    total: out.length,
  });
  return out;
}

/**
 * A remote session's PROJECT skills ({cwd}/.claude/skills/<name>/SKILL.md). The
 * CLI lists these alongside the user-level ones; the palette needs them for
 * descriptions. Same shape as flat skills (plugin `__flat__`).
 */
export async function listRemoteProjectSkills(conn: DaemonConnection, cwd: string): Promise<RemoteSkillMeta[]> {
  const fs = daemonSkillFs(conn);
  const skills = await listRemoteFlatSkills(fs, fs.join(cwd, '.claude', 'skills'));
  return skills.map((s) => ({ dirName: s.dirName, description: s.description, plugin: s.plugin }));
}

/**
 * List a remote session's project commands ({cwd}/.claude/commands/*.md), including
 * one level of nested subcommands (dir/sub.md → "dir:sub"). Mirrors the local
 * scanCommandDir in the slash-commands route, but reads over the daemon.
 */
export async function listRemoteProjectCommands(
  conn: DaemonConnection,
  cwd: string,
): Promise<RemoteCommandMeta[]> {
  const fs = daemonSkillFs(conn);
  const dir = fs.join(cwd, '.claude', 'commands');
  const entries = await fs.list(dir);
  if (entries === null) return [];

  // Pipelined like the skill scans — each read/list is a daemon RTT.
  const perEntry = await mapLimit(entries, 16, async (entry): Promise<RemoteCommandMeta[]> => {
    if (entry.endsWith('.md')) {
      const name = entry.slice(0, -3);
      if (!name) return [];
      const raw = await fs.readText(fs.join(dir, entry));
      return [{ name, description: descOf(raw) }];
    }
    // Possible subcommand directory (dir/sub.md → "dir:sub").
    const subFiles = await fs.list(fs.join(dir, entry));
    if (subFiles === null) return [];
    const subs = await mapLimit(subFiles, 8, async (subFile) => {
      if (!subFile.endsWith('.md')) return null;
      const subName = subFile.slice(0, -3);
      if (!subName) return null;
      const raw = await fs.readText(fs.join(dir, entry, subFile));
      return { name: `${entry}:${subName}`, description: descOf(raw) };
    });
    return subs.filter((s): s is RemoteCommandMeta => s !== null);
  });
  return perEntry.flat();
}

function descOf(raw: string | null): string {
  if (raw === null) return '';
  try {
    return commandDescription(raw);
  } catch {
    return '';
  }
}
