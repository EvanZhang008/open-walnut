/** Browser-safe registry. An experiment changes no default until it graduates. */
export const EXPERIMENTAL_FEATURES = [
  {
    id: 'leader_status_follows_workers',
    name: 'Leader status follows workers',
    description: 'Show Working while any worker works, Waiting while all open workers wait, and To read when every worker has finished. Requests that need you keep priority.',
    default: false,
  },
] as const;

export type ExperimentalFeatureId = typeof EXPERIMENTAL_FEATURES[number]['id'];
/** Unknown boolean flags stay on disk for newer versions, but have no effect here. */
export type ExperimentalFlags = Record<string, boolean>;

export function experimentalEnabled(flags: ExperimentalFlags | undefined, id: ExperimentalFeatureId): boolean {
  const feature = EXPERIMENTAL_FEATURES.find((f) => f.id === id)!;
  return typeof flags?.[id] === 'boolean' ? flags[id] : feature.default;
}

export function validExperimentalFlags(value: unknown): value is ExperimentalFlags {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((flag) => typeof flag === 'boolean');
}
