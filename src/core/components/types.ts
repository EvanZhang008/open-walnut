/**
 * Components: the big optional parts of Walnut that are not inside the compiled
 * file and are downloaded the first time a feature needs them
 * (docs/plan/walnut-single-binary.md, "Components").
 *
 *   <data home>/components/
 *     <name>/<version>/<platform>/        one unpacked archive (a small node_modules tree)
 *       .component.json                   written into the staging dir before the rename: an install is all or nothing
 *     .downloads/<asset>(.part)           archives on their way in (a host can be handed one here)
 *     .locks/<name>.lock                  one installer per component across processes
 *
 * git-sync ignores components/ (src/integrations/git-sync.ts): platform binaries
 * never ride the data plane.
 */

export const COMPONENT_NAMES = ['embedding', 'images', 'audio-capture'] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

/** What a component archive is built for: the platform and, on Linux, the C library. */
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface ManifestPlatformEntry {
  /** The file name on the release (and in .downloads/). */
  asset: string;
  /** Compressed bytes as the build wrote them: what the UI shows, and the download's size bound. */
  size: number;
  /** Bytes of the tar inside: the unpack bound. */
  tarSize: number;
  /**
   * SHA-256 of the tar inside the .tar.gz. The build makes the tar byte for byte
   * reproducible, which a gzip stream is not across compressors, so any rebuild
   * of the same packages verifies against this pin.
   */
  tarSha256: string;
}

export interface ManifestComponent {
  version: string;
  /** The release tag the assets are attached to. */
  tag: string;
  /** The feature's entry module, relative to the unpacked dir. */
  entry: string;
  /** The npm packages inside, for the record. */
  packages: Record<string, string>;
  platforms: Partial<Record<Platform, ManifestPlatformEntry>>;
}

export interface ComponentsManifest {
  schema: 1;
  /** owner/name of the GitHub repo whose releases hold the assets. */
  repo: string;
  components: Record<ComponentName, ManifestComponent>;
}

/** `waiting`: another Walnut process on this data home holds the install lock. */
export type ComponentState = 'unsupported' | 'missing' | 'waiting' | 'downloading' | 'installing' | 'ready' | 'failed';

export interface ComponentStatus {
  name: ComponentName;
  /** The feature, as the UI says it ("search by meaning"). */
  label: string;
  state: ComponentState;
  platform: Platform | null;
  /** The version in use when ready (an older install while the pinned one is on its way), else the pinned one. */
  version: string | null;
  /** Ready from Walnut's own node_modules (development, an npm install), or from a downloaded archive. */
  source?: 'bundled' | 'installed';
  /** Download size in bytes, for "Downloading search by meaning, 40 MB". */
  size?: number;
  progress?: { done: number; total: number | null };
  /** Why the last install failed, or why the component does not exist for this platform. */
  error?: string;
  /** Machine-readable failure: network, http, size, checksum, disk, deadline, locked, unsupported, aborted. */
  code?: string;
  updatedAt: string;
}

export class ComponentError extends Error {
  /** `status`: the HTTP status, when a server answered with an error. */
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = 'ComponentError';
  }
}

/**
 * A failure that trying again cannot fix: the release does not have the asset
 * (an HTTP 4xx other than 408 and 429), it is not the archive this Walnut pins
 * (checksum, size), or there is no build for this system. Only a person retries
 * those; an automatic trigger never does.
 */
export function isPermanentFailure(code: string | undefined, status?: number): boolean {
  if (code === 'checksum' || code === 'size' || code === 'unsupported') return true;
  return code === 'http' && status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function componentErrorCode(err: unknown): string {
  if (err instanceof ComponentError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'disk';
  if ((err as { name?: string } | null)?.name === 'AbortError') return 'aborted';
  return 'network';
}
