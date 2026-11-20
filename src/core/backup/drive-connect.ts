/**
 * What a finished Google Drive sign-in leaves on this machine, the same from Settings and
 * from a terminal: the tokens, the account's email and the backup folder (found, or made
 * when there is none yet). `signInToDriveInTerminal` is the terminal's sign-in, for
 * `open-walnut backup list | restore | run --type gdrive` on a computer that has never
 * connected Drive (a new computer after a loss).
 */
import readline from 'node:readline';
import {
  completeDriveConnectFromUrl, makeAccessTokenGetter, readDriveTokens, startDriveConnect, writeDriveTokens,
  type DriveTokens, type OAuthClient,
} from './gdrive-oauth.js';
import { driveAbout, findOrCreateFolder } from './stores/drive-store.js';

/** Keep a sign-in's tokens and find (or make) the backup folder; returns what was kept. */
export async function saveDriveConnection(
  dataDir: string,
  client: OAuthClient,
  tokens: DriveTokens,
  folderName: string,
): Promise<{ tokens: DriveTokens; folderCreated: boolean; email?: string }> {
  await writeDriveTokens(dataDir, tokens);
  const getToken = makeAccessTokenGetter(dataDir, client);
  const about = await driveAbout(getToken).catch(() => ({} as { email?: string }));
  const folder = await findOrCreateFolder(folderName, getToken);
  const kept = { ...(await readDriveTokens(dataDir))!, email: about.email, folder_id: folder.id, folder_name: folderName };
  await writeDriveTokens(dataDir, kept);
  return { tokens: kept, folderCreated: folder.created, email: about.email };
}

/**
 * Sign in to Google Drive from a terminal: prints Google's sign-in link and waits for the
 * browser to come back to this computer. When the browser is on another computer (an SSH
 * session), the address it ends on can be pasted here instead.
 */
export async function signInToDriveInTerminal(
  dataDir: string,
  client: OAuthClient,
  folderName: string,
  io: { out: (line: string) => void; input?: NodeJS.ReadableStream } = { out: (l) => console.log(l), input: process.stdin },
): Promise<{ email?: string; folderCreated: boolean }> {
  let settle!: (r: { ok: true; tokens: DriveTokens } | { ok: false; error: string }) => void;
  const done = new Promise<{ ok: true; tokens: DriveTokens } | { ok: false; error: string }>((r) => { settle = r; });
  const { authUrl } = await startDriveConnect(client, { onDone: (r) => settle(r) });
  io.out('Google Drive is not connected on this computer. Open this link in a browser and allow access:');
  io.out(`  ${authUrl}`);
  io.out('Waiting for Google... (browser on another computer? Paste the address it ends on here and press Enter.)');
  // A pasted address finishes the same sign-in; the loopback answer may win the race instead.
  const rl = io.input && (io.input as NodeJS.ReadStream).isTTY !== false
    ? readline.createInterface({ input: io.input, terminal: false })
    : null;
  rl?.on('line', (line) => {
    if (!line.trim()) return;
    completeDriveConnectFromUrl(line).catch((err: unknown) => io.out(`  ${err instanceof Error ? err.message : String(err)}`));
  });
  try {
    const r = await done;
    if (!r.ok) throw new Error(r.error);
    const saved = await saveDriveConnection(dataDir, client, r.tokens, folderName);
    io.out(`Connected to Google Drive${saved.email ? ` as ${saved.email}` : ''} (folder "${folderName}").`);
    return { email: saved.email, folderCreated: saved.folderCreated };
  } finally {
    rl?.close();
  }
}
