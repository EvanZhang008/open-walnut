import { describe, it, expect } from 'vitest';
import type { DaemonConnection } from '../../src/providers/daemon-connection.js';
import {
  listRemoteSkills,
  listRemoteProjectCommands,
} from '../../src/core/remote-skill-loader.js';

/**
 * Build a fake DaemonConnection whose fs.read/fs.ls answer from an in-memory tree.
 * Keys are POSIX paths with ~ expanded to /home/user (mimics daemon ~ expansion).
 */
function fakeConn(files: Record<string, string>, dirs: Record<string, string[]>): DaemonConnection {
  const norm = (p: string) => p.replace(/^~(?=\/|$)/, '/home/user');
  const send = async (cmd: string, params: Record<string, unknown>) => {
    const p = norm(params.path as string);
    if (cmd === 'fs.read') {
      if (p in files) return { ok: true, data: files[p], encoding: 'utf-8' };
      return { ok: false, error: 'ENOENT' };
    }
    if (cmd === 'fs.ls') {
      if (p in dirs) return { ok: true, entries: dirs[p].map((name) => ({ name })), resolvedPath: p };
      return { ok: false, error: 'ENOENT' };
    }
    return { ok: false, error: `unknown cmd ${cmd}` };
  };
  return { send } as unknown as DaemonConnection;
}

const skillMd = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}`;

describe('listRemoteSkills', () => {
  it('discovers plugin skills via remote settings + marketplace manifest', async () => {
    const files: Record<string, string> = {
      '/home/user/.claude/settings.json': JSON.stringify({
        enabledPlugins: { 'eks-tools@aim': true },
      }),
      '/home/user/.claude/plugins/known_marketplaces.json': JSON.stringify({
        aim: { source: { source: 'directory', path: '/home/user/.aim/cc-plugins' } },
      }),
      '/home/user/.aim/cc-plugins/.claude-plugin/marketplace.json': JSON.stringify({
        plugins: [{ name: 'eks-tools', source: './eks-tools' }],
      }),
      '/home/user/.aim/cc-plugins/eks-tools/skills/eks-investigate-ticket/SKILL.md':
        skillMd('eks-investigate-ticket', 'Investigate EKS tickets'),
    };
    const dirs: Record<string, string[]> = {
      '/home/user/.aim/cc-plugins/eks-tools/skills': ['eks-investigate-ticket'],
    };

    const skills = await listRemoteSkills(fakeConn(files, dirs));
    const eks = skills.find((s) => s.dirName === 'eks-investigate-ticket');
    expect(eks).toMatchObject({
      dirName: 'eks-investigate-ticket',
      description: 'Investigate EKS tickets',
      plugin: 'eks-tools@aim',
    });
  });

  it('flat skills are attributed to __flat__ (no plugin label)', async () => {
    const files: Record<string, string> = {
      '/home/user/.claude/skills/my-flat/SKILL.md': skillMd('my-flat', 'A flat skill'),
    };
    const dirs: Record<string, string[]> = {
      '/home/user/.claude/skills': ['my-flat'],
    };
    const skills = await listRemoteSkills(fakeConn(files, dirs));
    expect(skills.find((s) => s.dirName === 'my-flat')?.plugin).toBe('__flat__');
  });

  it('discovers flat ~/.claude/skills and plugin skills, keyed the way the CLI names them (flat listed first)', async () => {
    const files: Record<string, string> = {
      '/home/user/.claude/settings.json': JSON.stringify({
        enabledPlugins: { 'p@aim': true },
      }),
      '/home/user/.claude/plugins/known_marketplaces.json': JSON.stringify({
        aim: { source: { source: 'directory', path: '/home/user/.aim/cc-plugins' } },
      }),
      '/home/user/.aim/cc-plugins/.claude-plugin/marketplace.json': JSON.stringify({
        plugins: [{ name: 'p', source: './p' }],
      }),
      // same dirName "dup" in both a flat skill and the plugin
      '/home/user/.claude/skills/dup/SKILL.md': skillMd('dup', 'flat version'),
      '/home/user/.aim/cc-plugins/p/skills/dup/SKILL.md': skillMd('dup', 'plugin version'),
      '/home/user/.aim/cc-plugins/p/skills/only-plugin/SKILL.md': skillMd('only-plugin', 'plugin only'),
    };
    const dirs: Record<string, string[]> = {
      '/home/user/.claude/skills': ['dup'],
      '/home/user/.aim/cc-plugins/p/skills': ['dup', 'only-plugin'],
    };

    const skills = await listRemoteSkills(fakeConn(files, dirs));
    // The CLI knows `dup` (flat) AND `p:dup` (plugin) as two commands, so both
    // survive; the flat one is listed first so a fold by bare name shadows the
    // plugin copy, as the discovery palette does.
    expect(skills.map((s) => `${s.plugin}:${s.dirName}`)).toEqual(['__flat__:dup', 'p@aim:dup', 'p@aim:only-plugin']);
    expect(skills.find((s) => s.dirName === 'dup')?.description).toBe('flat version');
  });

  it('returns empty when remote has no settings/skills', async () => {
    const skills = await listRemoteSkills(fakeConn({}, {}));
    expect(skills).toEqual([]);
  });

  it('skips plugins whose dir cannot be resolved', async () => {
    const files: Record<string, string> = {
      '/home/user/.claude/settings.json': JSON.stringify({
        enabledPlugins: { 'ghost@aim': true },
      }),
      '/home/user/.claude/plugins/known_marketplaces.json': JSON.stringify({
        aim: { source: { source: 'directory', path: '/home/user/.aim/cc-plugins' } },
      }),
      // no marketplace.json, no convention dir → unresolvable
    };
    const skills = await listRemoteSkills(fakeConn(files, {}));
    expect(skills).toEqual([]);
  });
});

describe('listRemoteProjectCommands', () => {
  it('lists flat + nested project commands from {cwd}/.claude/commands', async () => {
    const cwd = '/workplace/proj';
    const files: Record<string, string> = {
      '/workplace/proj/.claude/commands/deploy.md': '---\ndescription: Deploy it\n---\nrun',
      '/workplace/proj/.claude/commands/review/pr.md': '---\ndescription: Review PR\n---\nrun',
    };
    const dirs: Record<string, string[]> = {
      '/workplace/proj/.claude/commands': ['deploy.md', 'review'],
      '/workplace/proj/.claude/commands/review': ['pr.md'],
    };

    const cmds = await listRemoteProjectCommands(fakeConn(files, dirs), cwd);
    expect(cmds).toContainEqual({ name: 'deploy', description: 'Deploy it' });
    expect(cmds).toContainEqual({ name: 'review:pr', description: 'Review PR' });
  });

  it('returns empty when no commands dir', async () => {
    const cmds = await listRemoteProjectCommands(fakeConn({}, {}), '/workplace/proj');
    expect(cmds).toEqual([]);
  });
});
