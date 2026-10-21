/**
 * Whether the cloud companion runs this Mac's build (/api/cloud/companion-build).
 * Twin of the server's `CompanionBuildView` (src/core/companion-build/mac.ts);
 * keep the two in step by hand.
 */

import { apiGet, apiPost, apiPut } from './client';

export type CompanionBuildState =
  | 'off' | 'no_companion' | 'checking' | 'current' | 'updating' | 'failed'
  | 'unmanaged' | 'box_off' | 'refused_credential' | 'unreachable';

export interface CompanionBuildView {
  state: CompanionBuildState;
  /** This Mac's build id; null before it is known or when it runs from source. */
  mine: string | null;
  /** The build the companion runs, as it last said. */
  theirs: string | null;
  /** `cloud_bridge.auto_update` (default on). */
  autoUpdate: boolean;
  step?: 'uploading' | 'installing' | 'starting';
  /** 0..1 while uploading. */
  progress?: number;
  message?: string;
  logTail?: string;
  at: number;
}

const BASE = '/api/cloud/companion-build';

/** `background`: a repeat read while the row shows, which yields to what paints the screen. */
export function getCompanionBuild(opts: { background?: boolean } = {}): Promise<CompanionBuildView> {
  return apiGet<CompanionBuildView>(BASE, undefined, { quietStatuses: [404], ...(opts.background ? { priority: 'low' as const } : {}) });
}

export function retryCompanionBuild(): Promise<CompanionBuildView> {
  return apiPost<CompanionBuildView>(`${BASE}/retry`);
}

export function setCompanionAutoUpdate(autoUpdate: boolean): Promise<CompanionBuildView> {
  return apiPut<CompanionBuildView>(BASE, { auto_update: autoUpdate });
}
