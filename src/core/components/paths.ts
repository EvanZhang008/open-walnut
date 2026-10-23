/** Where components live on disk (the layout is in types.ts). */

import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import type { ComponentName, Platform } from './types.js';

/** `<data home>/components`; WALNUT_COMPONENTS_DIR moves it (tests, a shared cache). */
export function componentsRoot(): string {
  return process.env.WALNUT_COMPONENTS_DIR || path.join(WALNUT_HOME, 'components');
}

export function installDir(root: string, name: ComponentName, version: string, platform: Platform): string {
  return path.join(root, name, version, platform);
}

export function downloadsDir(root: string): string {
  return path.join(root, '.downloads');
}

export function lockFile(root: string, name: ComponentName): string {
  return path.join(root, '.locks', `${name}.lock`);
}

/** Written last into the staging dir; an install dir without it was never finished. */
export const MARKER = '.component.json';

export interface InstallMarker {
  name: ComponentName;
  version: string;
  platform: Platform;
  tarSha256: string;
  /** The feature's entry module, relative to the dir (absent in installs made before it was recorded). */
  entry?: string;
  installedAt: string;
}
