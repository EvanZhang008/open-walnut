/**
 * Shared read/write for HEARTBEAT.md — used by both AI tools and REST routes.
 */
import fsp from 'node:fs/promises';
import { HEARTBEAT_FILE } from '../constants.js';

/** Read HEARTBEAT.md content. Returns empty string if the file doesn't exist. */
export async function readHeartbeatChecklist(): Promise<string> {
  try {
    return await fsp.readFile(HEARTBEAT_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Write content to HEARTBEAT.md. */
export async function writeHeartbeatChecklist(content: string): Promise<void> {
  await fsp.writeFile(HEARTBEAT_FILE, content, 'utf-8');
}
