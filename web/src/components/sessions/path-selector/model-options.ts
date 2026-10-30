/**
 * The model rows a launch can pick on a host: that host's last-known CLI
 * catalog, else the static registry. The draft composer's model pill reads it
 * (DraftSessionPanel).
 */
import { SESSION_MODELS } from '@open-walnut/core';
import { useHostModelCatalog } from '@/hooks/useModelCatalog';
import { formatModelName } from '@/hooks/useSessionUsage';
import { sortByModelStrength } from '@/utils/model-strength-order';
import { catalogRowLabel } from '../ModelPicker';

/** Model dropdown rows: the host's last-known CLI catalog (values = full
 *  provider IDs, sent verbatim to spawn) — falling back to the static registry
 *  only when this host has never produced a catalog. The catalog 'default' row
 *  is folded into the Auto option (Auto = no --model = CLI default) — but its
 *  resolvedModel is surfaced in the Auto label ("Auto (Opus 5 1M)") so the
 *  user knows WHAT Auto launches before starting. */
export function useModelOptions(host?: string | null): {
  options: Array<{ value: string; label: string }>;
  /** Short display name of the model Auto resolves to on this host ('' = unknown). */
  autoResolved: string;
} {
  const catalog = useHostModelCatalog(host);
  if (catalog) {
    return {
      options: sortByModelStrength(
        catalog.models.filter((m) => m.value !== 'default' && !m.disabled),
        (model) => `${model.value} ${model.resolvedModel ?? ''} ${catalogRowLabel(model)}`,
      )
        // Versioned label ("Opus 5 1M", not "Opus") — same rule as the
        // picker's catalogRowLabel: the user must see WHICH version launches.
        .map((m) => ({ value: m.value, label: catalogRowLabel(m) })),
      autoResolved: formatModelName(catalog.models.find((m) => m.value === 'default')?.resolvedModel),
    };
  }
  return {
    options: sortByModelStrength(
      SESSION_MODELS,
      (model) => `${model.cliModel} ${model.label}`,
    ).map((sm) => ({ value: sm.id, label: sm.label })),
    autoResolved: '',
  };
}
