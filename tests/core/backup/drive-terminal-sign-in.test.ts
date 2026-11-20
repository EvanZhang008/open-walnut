/**
 * `open-walnut backup list | restore --type gdrive` on a computer that never connected Drive
 * (a new one after a loss): the terminal prints Google's sign-in link and finishes the sign-in
 * itself, by the browser coming back to this computer or by the address pasted from a browser
 * elsewhere. Before 2026-11-20 it said to connect Drive in the app first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import type { OAuthClient } from '../../../src/core/backup/gdrive-oauth.js';
import { readDriveTokens } from '../../../src/core/backup/gdrive-oauth.js';
import { signInToDriveInTerminal } from '../../../src/core/backup/drive-connect.js';
import { startFakeGoogleDrive, type FakeGoogleDrive } from '../../helpers/fake-google-drive.js';

let fake: FakeGoogleDrive;
let savedEnv: NodeJS.ProcessEnv;
let client: OAuthClient;
let home: string;

beforeEach(async () => {
  savedEnv = { ...process.env };
  fake = await startFakeGoogleDrive();
  Object.assign(process.env, fake.env);
  client = { clientId: fake.env.WALNUT_GDRIVE_CLIENT_ID, clientSecret: fake.env.WALNUT_GDRIVE_CLIENT_SECRET, source: 'builtin' };
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-drive-cli-'));
});

afterEach(async () => {
  process.env = savedEnv;
  await fake.close();
  await fsp.rm(home, { recursive: true, force: true });
});

/** Runs the sign-in, handing each printed line to `onLine`. */
function signIn(onLine: (line: string) => void, input?: PassThrough) {
  const lines: string[] = [];
  const result = signInToDriveInTerminal(home, client, 'Walnut Backup', {
    out: (l) => { lines.push(l); onLine(l); },
    input,
  });
  return { lines, result };
}

const linkIn = (line: string): string | null => (line.trim().startsWith('http') ? line.trim() : null);

describe('Google Drive sign-in from a terminal', () => {
  it('prints the link, the browser comes back here, and the tokens and folder are kept', async () => {
    const { lines, result } = signIn((l) => {
      const url = linkIn(l);
      // The fake consents at once and sends the browser to this computer's listener.
      if (url) void fetch(url, { redirect: 'follow' });
    });
    expect(await result).toMatchObject({ folderCreated: true });
    expect(lines[0]).toMatch(/not connected on this computer/);
    expect(lines.at(-1)).toMatch(/^Connected to Google Drive/);
    const tokens = await readDriveTokens(home);
    expect(tokens?.folder_id).toBeTruthy();
    expect(tokens?.folder_name).toBe('Walnut Backup');
    expect(fake.files().filter((f) => f.mimeType === 'application/vnd.google-apps.folder')).toHaveLength(1);
  });

  it('a browser on another computer: the address it ends on, pasted, finishes the same sign-in', async () => {
    const input = new PassThrough();
    const { result } = signIn((l) => {
      const url = linkIn(l);
      if (!url) return;
      void (async () => {
        // Not followed: the browser elsewhere cannot reach this computer's listener.
        const landing = (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
        input.write('not an address\n');
        input.write(`${landing}\n`);
      })();
    }, input);
    await result;
    expect((await readDriveTokens(home))?.folder_id).toBeTruthy();
  });

  it('a sign-in that Google refuses fails with its reason, and keeps nothing', async () => {
    const input = new PassThrough();
    const { result } = signIn((l) => {
      const url = linkIn(l);
      if (!url) return;
      const state = new URL(url).searchParams.get('state');
      input.write(`http://127.0.0.1:1/?state=${state}&error=access_denied\n`);
    }, input);
    await expect(result).rejects.toThrow(/not allowed to use Google Drive/);
    expect(await readDriveTokens(home)).toBeNull();
  });
});
