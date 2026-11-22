import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

// Stub the Bedrock SDK so test-connection never hits the network: any client we
// build reports a clean turn. runCredentialProcess still runs for real (it's a
// local shell command), so the credential-process WIRING is exercised end-to-end.
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: class {
    messages = { create: async () => ({ content: [], stop_reason: 'end_turn', usage: { output_tokens: 1 } }) };
    constructor(_opts: unknown) { /* record nothing; shape-only stub */ }
  },
}));

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js';
import { configRouter } from '../../../src/web/routes/config.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetWriteLockForTest } from '../../../src/core/config-manager.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  _resetWriteLockForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/config', () => {
  it('returns default config when no config file exists', async () => {
    const app = createApp();
    const res = await request(app).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body.config).toBeDefined();
    expect(res.body.config.version).toBe(1);
    expect(res.body.config.defaults).toBeDefined();
    expect(res.body.config.defaults.priority).toBe('none');
  });

  it('reports which build is running (package version, no build when run from source)', async () => {
    const { getBuildInfo } = await import('../../../src/lib/build-info.js');
    const res = await request(createApp()).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body.build).toEqual(getBuildInfo());
    expect(res.body.build.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.body.build.commit).toBeNull();
    expect(res.body.build.dirty).toBe(false);
  });
});

describe('PUT /api/config', () => {
  it('saves config and can read it back', async () => {
    const app = createApp();

    const newConfig = {
      version: 1,
      user: { name: 'Test User' },
      defaults: { priority: 'immediate', project: 'work' },
      provider: { type: 'claude-code' },
    };

    const putRes = await request(app)
      .put('/api/config')
      .send(newConfig);

    expect(putRes.status).toBe(200);
    expect(putRes.body.ok).toBe(true);

    // Read it back
    const getRes = await request(app).get('/api/config');
    expect(getRes.status).toBe(200);
    expect(getRes.body.config.user.name).toBe('Test User');
    expect(getRes.body.config.defaults.priority).toBe('immediate');
  });

  it('persists host-scoped external import exclusions', async () => {
    const app = createApp();
    const external_session_import = { excluded_cwds: { __local__: ['/tmp/probes'], buildbox: ['/home/dev/probes'] } };
    expect((await request(app).put('/api/config').send({ external_session_import })).status).toBe(200);
    const raw = yaml.load(await fs.readFile(CONFIG_FILE, 'utf8')) as any;
    expect(raw.external_session_import).toEqual(external_session_import);
  });

  it.each([null, [], { excluded_cwds: [] }, { excluded_cwds: { __local__: '/' } },
    { excluded_cwds: { __local__: ['/'] } }, { excluded_cwds: { __local__: ['relative/path'] } },
    { excluded_cwds: { __local__: [42] } }])('rejects malformed import exclusions: %j', async config => {
    const app = createApp();
    expect((await request(app).put('/api/config').send({ external_session_import: config })).status).toBe(400);
  });

  it('keeps the skill listing cap of Claude Code sessions when it is in range', async () => {
    const app = createApp();
    expect((await request(app).put('/api/config').send({ session: { skill_listing_desc_chars: 200 } })).status).toBe(200);
    const raw = yaml.load(await fs.readFile(CONFIG_FILE, 'utf8')) as any;
    expect(raw.session.skill_listing_desc_chars).toBe(200);
  });

  it.each([39, 1537, 100.5, '200', true])('rejects a skill listing cap outside 40..1536: %j', async value => {
    const app = createApp();
    const res = await request(app).put('/api/config').send({ session: { skill_listing_desc_chars: value } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/skill_listing_desc_chars/);
  });

  it('partial PUT preserves unmentioned config sections', async () => {
    const app = createApp();

    // Seed config with ms_todo section
    const initial = {
      version: 1,
      user: { name: 'TestUser' },
      defaults: { priority: 'none', project: 'personal' },
      ms_todo: { client_id: 'abc-123', tenant_id: 'xyz-789' },
      agent: { model: 'claude-opus-4' },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    // Send partial update — only change defaults
    const putRes = await request(app)
      .put('/api/config')
      .send({ defaults: { priority: 'immediate', project: 'work' } });

    expect(putRes.status).toBe(200);

    // Read raw file to verify ms_todo survived
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const onDisk = yaml.load(raw) as any;

    expect(onDisk.ms_todo).toEqual({ client_id: 'abc-123', tenant_id: 'xyz-789' });
    expect(onDisk.user.name).toBe('TestUser');
    expect(onDisk.defaults.priority).toBe('immediate');
  });

  it('persists a Bedrock aws_credential_export command', async () => {
    const app = createApp();
    const putRes = await request(app)
      .put('/api/config')
      .send({
        providers: {
          bedrock: { api: 'bedrock', region: 'us-west-2', aws_credential_export: 'my-export-cmd' },
        },
      });
    expect(putRes.status).toBe(200);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const onDisk = yaml.load(raw) as any;
    expect(onDisk.providers.bedrock.aws_credential_export).toBe('my-export-cmd');
  });

  // `companion` names the cloud companion (replication/companion-keep.ts).
  it('refuses a new host saved under the alias companion, with a plain message; nothing is written', async () => {
    const app = createApp();
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, hosts: { dev: { hostname: 'dev.example' } } }), 'utf-8');
    const before = await fs.readFile(CONFIG_FILE, 'utf-8');
    const res = await request(app).put('/api/config').send({ hosts: { dev: { hostname: 'dev.example' }, companion: { hostname: 'box.example' } } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'The name "companion" is taken by the cloud companion. Give this host another alias.',
      code: 'host_alias_taken',
      field: 'hosts.companion',
    });
    expect(await fs.readFile(CONFIG_FILE, 'utf-8')).toBe(before);
    // Any other alias saves.
    expect((await request(app).put('/api/config').send({ hosts: { dev: { hostname: 'dev.example' }, 'companion-2': { hostname: 'box.example' } } })).status).toBe(200);
  });

  it('only the person moves where backups go; a session may still pause them or change the interval', async () => {
    const app = createApp();
    const dest = { type: 'r2', bucket: 'mine', account_id: 'acct', access_key_id: 'k', secret_access_key: 's' };
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, backup: { enabled: true, interval_hours: 24, destination: dest } }), 'utf-8');
    const agent = { 'x-walnut-caller-sid': 'session-under-test' };
    for (const backup of [
      { enabled: true, destination: { ...dest, bucket: 'theirs' } },
      { enabled: true, destination: { ...dest, endpoint: 'https://elsewhere.example' } },
      { enabled: true, destination: { type: 'gdrive', client_id: 'other.apps.googleusercontent.com' } },
      // A service kept for later is one click from being the destination.
      { enabled: true, destination: dest, other_destinations: [{ type: 's3', bucket: 'theirs', region: 'us-east-1' }] },
      // Less history kept deletes backups at the next prune.
      { enabled: true, destination: dest, retention: { daily: 1, weekly: 0 } },
      // Encrypted or readable in the cloud is the person's choice, either way (unset reads as off here).
      { enabled: true, destination: dest, encrypt: true },
      // Marking the key saved turns encryption on for a setup with the switch unset.
      { enabled: true, destination: dest, recovery_key_saved_at: '2026-11-19T00:00:00Z' },
    ]) {
      const r = await request(app).put('/api/config').set(agent).send({ backup });
      expect(r.status, JSON.stringify(backup)).toBe(403);
      expect(r.body).toMatchObject({ code: 'person_at_this_machine' });
    }
    expect((await request(app).put('/api/config').set(agent).send({ backup: { enabled: false, interval_hours: 12, destination: dest } })).status).toBe(200);
    const saved = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as { backup: { enabled: boolean; interval_hours: number; destination: { bucket: string } } };
    expect(saved.backup).toMatchObject({ enabled: false, interval_hours: 12, destination: { bucket: 'mine' } });
    // A session's write that leaves the kind as it is still saves (the switch spelled out, same value).
    expect((await request(app).put('/api/config').set(agent).send({ backup: { enabled: false, interval_hours: 12, destination: dest, encrypt: false } })).status).toBe(200)
    // The person moves it.
    expect((await request(app).put('/api/config').send({ backup: { enabled: true, destination: { ...dest, bucket: 'new' } } })).status).toBe(200);
  });

  it('only the person changes the leader switch\'s machines and witnesses', async () => {
    const app = createApp();
    const section = { witnesses: [{ id: 'w1', dir: '/srv/w1' }], machines: [{ id: 'm1', home: '/srv/a', standby_dir: '/srv/as', port: 3456 }] };
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, leader_switch: section }), 'utf-8');
    const agent = { 'x-walnut-caller-sid': 'session-under-test' };
    const r = await request(app).put('/api/config').set(agent).send({ leader_switch: { machines: [{ ...section.machines[0], start_command: ['/bin/sh', '-c', 'x'] }] } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'person_at_this_machine' });
    // Sent back unchanged (a whole-config round trip): fine.
    expect((await request(app).put('/api/config').set(agent).send({ leader_switch: section })).status).toBe(200);
    expect((await request(app).put('/api/config').send({ leader_switch: { back_window_hours: 24 } })).status).toBe(200);
  });

  it('a session never turns encryption off: not by the switch, not by dropping the saved-key mark', async () => {
    const app = createApp();
    const dest = { type: 'r2', bucket: 'mine', account_id: 'acct', access_key_id: 'k', secret_access_key: 's' };
    const agent = { 'x-walnut-caller-sid': 'session-under-test' };
    for (const start of [
      { enabled: true, destination: dest, encrypt: true },
      { enabled: true, destination: dest, recovery_key_saved_at: '2026-11-01T00:00:00Z' },
    ]) {
      await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, backup: start }), 'utf-8');
      for (const backup of [
        { ...start, encrypt: false },
        { enabled: true, destination: dest, recovery_key_saved_at: null, encrypt: null },
      ]) {
        const r = await request(app).put('/api/config').set(agent).send({ backup });
        expect(r.status, `${JSON.stringify(start)} -> ${JSON.stringify(backup)}`).toBe(403);
      }
      const onDisk = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as { backup: Record<string, unknown> };
      expect(onDisk.backup).toMatchObject(start);
    }
  });

  // The hosts a leader offers their one Walnut service to (providers/service-launcher-flag.ts).
  it('host_service_offer: a PUT stores it, GET shows it, a write of another section keeps it, [] clears it, a bad shape is refused', async () => {
    const app = createApp();
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, hosts: { devbox: { hostname: 'devbox.example' } } }), 'utf-8');
    const onDisk = async () => yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as any;

    expect((await request(app).put('/api/config').send({ host_service_offer: ['devbox'] })).status).toBe(200);
    expect((await onDisk()).host_service_offer).toEqual(['devbox']);
    expect((await request(app).get('/api/config')).body.config.host_service_offer).toEqual(['devbox']);

    // A Settings page's whole-section write of something else leaves it alone.
    const page = { origin: 'http://localhost:3456', 'sec-fetch-mode': 'cors' };
    expect((await request(app).put('/api/config').set(page).send({ user: { name: 'Pat' } })).status).toBe(200);
    expect((await onDisk()).host_service_offer).toEqual(['devbox']);

    for (const bad of ['devbox', [''], [7], { devbox: true }]) {
      const res = await request(app).put('/api/config').send({ host_service_offer: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.field).toBe('host_service_offer');
    }
    expect((await onDisk()).host_service_offer).toEqual(['devbox']);

    expect((await request(app).put('/api/config').send({ host_service_offer: [] })).status).toBe(200);
    expect((await onDisk()).host_service_offer).toEqual([]);
  });

  // An older leader does not know host_service_offer: its reads and writes carry a top-level key
  // they do not know, as this build does with one a newer build may add (future_section below).
  it('a top-level key the build does not know is read and kept by reads, saves and partial writes', async () => {
    const app = createApp();
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, host_service_offer: ['devbox'], future_section: { on: true } }), 'utf-8');
    const { getConfig, saveConfig } = await import('../../../src/core/config-manager.js');
    const read = await getConfig() as any;
    expect(read.host_service_offer).toEqual(['devbox']);
    expect(read.future_section).toEqual({ on: true });
    await saveConfig(read);
    expect((await request(app).put('/api/config').send({ defaults: { priority: 'immediate' } })).status).toBe(200);
    const onDisk = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as any;
    expect(onDisk.host_service_offer).toEqual(['devbox']);
    expect(onDisk.future_section).toEqual({ on: true });
  });

  it('a real host already saved as companion keeps saving', async () => {
    const app = createApp();
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, hosts: { companion: { hostname: 'box.example' } } }), 'utf-8');
    const res = await request(app).put('/api/config').send({ hosts: { companion: { hostname: 'box.example', user: 'me' } } });
    expect(res.status).toBe(200);
    const onDisk = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as any;
    expect(onDisk.hosts.companion).toMatchObject({ hostname: 'box.example', user: 'me' });
  });
});

describe('POST /api/config/test-connection — credential_process', () => {
  it('runs the credential command and reports authMethod=credential_process', async () => {
    const app = createApp();
    // A command that prints valid temp creds; the mocked SDK keeps this off the
    // network, so we exercise runCredentialProcess + the wiring, not Bedrock.
    const creds = { Credentials: { AccessKeyId: 'ASIA_X', SecretAccessKey: 's', SessionToken: 't', Expiration: '2099-01-01T00:00:00Z' } };
    const cmd = `printf '%s' '${JSON.stringify(creds)}'`;

    const res = await request(app)
      .post('/api/config/test-connection')
      .send({ bedrock_region: 'us-west-2', bedrock_credential_export: cmd });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.authMethod).toBe('credential_process');
  });

  it('reports an honest error when the credential command fails (not a hang)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/config/test-connection')
      .send({ bedrock_region: 'us-west-2', bedrock_credential_export: 'exit 7' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/awsCredentialExport command failed/);
  });
});
