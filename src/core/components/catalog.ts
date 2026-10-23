/**
 * The components Walnut knows, and how each feature names its package. The
 * versions and archives a release pins live in manifest-data.ts (written by
 * scripts/components/build.ts); this file only says what each one is for.
 */

import type { ComponentName } from './types.js';

export interface ComponentDef {
  name: ComponentName;
  /** The feature, as the UI says it. */
  label: string;
  /** The npm package the feature loads. In development (and an npm install) it resolves from Walnut's own node_modules. */
  pkg: string;
  /** Only these operating systems ever have it (audio capture is macOS only). */
  os?: NodeJS.Platform[];
}

export const COMPONENTS: Record<ComponentName, ComponentDef> = {
  embedding: { name: 'embedding', label: 'search by meaning', pkg: '@huggingface/transformers' },
  images: { name: 'images', label: 'image resizing', pkg: 'sharp' },
  'audio-capture': { name: 'audio-capture', label: 'audio capture', pkg: 'screencapturekit-audio-capture', os: ['darwin'] },
};
