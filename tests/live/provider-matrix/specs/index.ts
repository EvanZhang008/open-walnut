import type { ProviderSpec } from '../provider-spec.js'
import { codexSpec } from './codex.js'
import { claudeSpec } from './claude.js'

/** All registered providers. Adding a provider = one spec file + one entry. */
export const PROVIDER_SPECS: ProviderSpec[] = [codexSpec, claudeSpec]
