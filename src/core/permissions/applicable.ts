/**
 * Whether this server has macOS permissions to report: a Mac console, never a
 * cloud replica (TCC does not exist anywhere else). One answer for the report
 * (darwin.ts) and for GET /api/config's `macAccess` fact, which keeps the
 * Settings "macOS Access" entry off a server where that pane has nothing to show.
 */
import { isFollower } from '../server-role.js';

export function permissionsApplicable(): boolean {
  return process.platform === 'darwin' && !isFollower();
}
