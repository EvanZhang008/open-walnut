import { describe, it, expect, beforeEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('host-profile'));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  addHostNote, classifyHost, hostProfileSummary, probeIsStale, readHostProfile, recordProbedFacts,
  recordReach, recordRepoPath, repoKey, updateHostProfile, type HostFacts,
} from '../../../src/core/hosts/host-profile.js';
import { chooseTargetCwd } from '../../../src/core/transfer/workspace.js';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

function facts(over: Partial<HostFacts> = {}): HostFacts {
  return {
    os: { platform: 'linux', release: '6.1', prettyName: 'Ubuntu 24.04' }, arch: 'x64', cpus: 8, memBytes: 32 * 1024 ** 3,
    home: '/home/dev', proxyEnv: {}, cloud: { imds: false }, internet: { github: true },
    tools: { git: 'git version 2.43.0', node: 'v22.3.0', docker: null }, uptimeSec: 3600, probedAt: new Date().toISOString(),
    ...over,
  } as HostFacts;
}

describe('naming the kind of machine', () => {
  it('a cloud VM with a public address', () => {
    const c = classifyHost(facts({ cloud: { imds: true, provider: 'aws', instanceType: 't4g.large', region: 'us-west-1', hasPublicIpv4: true } }));
    expect(c.kind).toBe('public-cloud-vm');
    expect(c.reasons.join(' ')).toContain('t4g.large');
  });
  it('a cloud VM on a private network', () => {
    expect(classifyHost(facts({ cloud: { imds: true, hasPublicIpv4: false }, proxyEnv: { https: true } })).kind).toBe('private-cloud-vm');
  });
  it('a managed Linux machine in a company domain', () => {
    const c = classifyHost(facts({ fqdn: 'box-17.corp.example.com', proxyEnv: { https: true } }));
    expect(c.kind).toBe('dev-box');
    expect(c.reasons).toContain('its name is in the corp.example.com domain');
  });
  it('a Mac with no cloud metadata', () => {
    expect(classifyHost(facts({ os: { platform: 'darwin', release: '25.6' } })).kind).toBe('laptop');
  });
  it('a probe that skipped the network still classifies', () => {
    expect(classifyHost(facts({ cloud: null, internet: null })).kind).toBe('unknown');
  });
});

describe('learning a host over time', () => {
  it('starts empty, then fills from a probe, observations and notes', async () => {
    const empty = await readHostProfile('devbox');
    expect(empty).toMatchObject({ kind: 'unknown', notes: [] });
    expect(probeIsStale(empty)).toBe(true);
    expect(hostProfileSummary(empty, 'devbox')).toContain('No probe of this host yet');

    await recordProbedFacts('devbox', facts({ fqdn: 'box.lab.example.org' }));
    await recordRepoPath('devbox', 'https://github.com/acme/marina', '/home/dev/src/marina');
    await recordReach('devbox', 'cloud', false, 'Permission denied (publickey)');
    await addHostNote('devbox', { key: 'Node', fact: 'node comes from nvm; run `nvm use 22` first' });
    await addHostNote('devbox', { key: 'node', fact: 'node 22 is the system default now' });

    const p = await readHostProfile('devbox');
    expect(p.kind).toBe('dev-box');
    expect(probeIsStale(p)).toBe(false);
    expect(p.notes).toHaveLength(1);
    expect(p.notes[0]).toMatchObject({ key: 'node', fact: 'node 22 is the system default now' });
    expect(p.observed.reaches.cloud).toMatchObject({ ok: false });
    const summary = hostProfileSummary(p, 'devbox');
    expect(summary).toContain('a managed development machine');
    expect(summary).toContain('Installed: git 2.43.0, node 22.3.0');
    expect(summary).toContain('Not found on PATH: docker');
    expect(summary).toContain('https://github.com/acme/marina at /home/dev/src/marina');
    expect(summary).toContain('- node: node 22 is the system default now');
  });

  it('a kind the user set survives the next probe', async () => {
    await updateHostProfile('pc', (p) => { p.kind = 'laptop'; p.kindSetByUser = true; });
    await recordProbedFacts('pc', facts({ cloud: { imds: true, hasPublicIpv4: true } }));
    expect((await readHostProfile('pc')).kind).toBe('laptop');
  });

  it('concurrent notes are all kept', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => addHostNote('busy', { key: `k${i}`, fact: `f${i}` })));
    expect((await readHostProfile('busy')).notes).toHaveLength(10);
  });

  it('refuses an alias that is not a plain host name', async () => {
    await expect(readHostProfile('../etc')).rejects.toThrow(/Invalid host alias/);
  });

  it('a repository key never carries credentials', () => {
    expect(repoKey('https://user:token@github.com/Acme/Marina.git', 'marina')).toBe('https://github.com/acme/marina');
    expect(repoKey(undefined, 'notes')).toBe('dir:notes');
  });
});

describe('choosing where the work lives on the target', () => {
  const meta = { kind: 'git' as const, root: '/Users/me/src/marina', relCwd: 'packages/core', createdAt: '', remotes: [{ name: 'origin', url: 'git@github.com:acme/marina.git' }] };
  it('a host that knows the repository reuses its checkout', async () => {
    await recordRepoPath('devbox', repoKey(meta.remotes[0].url, 'marina'), '/home/dev/work/marina');
    const p = await readHostProfile('devbox');
    expect(chooseTargetCwd(meta, '/Users/me/src/marina/packages/core', p)).toEqual({
      cwd: '/home/dev/work/marina/packages/core', repoRoot: '/home/dev/work/marina', known: true, key: 'git@github.com:acme/marina',
    });
  });
  it('a host that does not gets a fresh folder under walnut-work in its home', async () => {
    await recordProbedFacts('fresh', facts());
    const p = await readHostProfile('fresh');
    expect(chooseTargetCwd(meta, '', p)).toMatchObject({ repoRoot: '/home/dev/walnut-work/marina', known: false });
  });
  it('a host never probed falls back to the home shorthand', () => {
    expect(chooseTargetCwd(null, '/tmp/scratch', null)).toMatchObject({ cwd: '~/walnut-work/scratch', known: false });
  });
});
