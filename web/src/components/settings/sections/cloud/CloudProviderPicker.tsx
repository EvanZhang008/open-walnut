/**
 * Provider picker. Cards come from GET /providers, so what the operator sees is
 * whatever THIS build registered plus a live credential probe — no hardcoded
 * list to drift.
 *
 * A provider that can't provision (or whose credentials aren't usable) is still
 * selectable: it routes to the manual paste path, which works everywhere. The
 * pill states that plainly instead of disabling the card and leaving the operator
 * with no next step.
 */

import type { CloudSetupProvider } from '@/api/cloud-setup';

function detectPill(provider: CloudSetupProvider): { text: string; cls: string } {
  if (provider.detect.available) {
    return provider.canProvision
      ? { text: 'Ready', cls: 'cloud-pill-ready' }
      : { text: 'Paste a script', cls: 'cloud-pill-manual' };
  }
  if (provider.detect.needs === 'api-token') return { text: 'Needs API token', cls: 'cloud-pill-token' };
  if (provider.detect.needs === 'cli-login') return { text: 'CLI missing or signed out', cls: 'cloud-pill-warn' };
  return { text: 'Not ready', cls: 'cloud-pill-warn' };
}

interface Props {
  providers: CloudSetupProvider[];
  selected: string | null;
  onSelect: (id: string) => void;
}

export function CloudProviderPicker({ providers, selected, onSelect }: Props) {
  return (
    <div className="cloud-provider-grid" role="radiogroup" aria-label="Cloud provider">
      {providers.map((p) => {
        const pill = detectPill(p);
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected === p.id}
            data-provider={p.id}
            className={`cloud-provider-card${selected === p.id ? ' cloud-provider-active' : ''}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="cloud-provider-head">
              <span className="cloud-provider-label">{p.label}</span>
              <span className={`cloud-pill ${pill.cls}`}>{pill.text}</span>
            </span>
            <span className="cloud-provider-cost">{p.costHint}</span>
            <span className="cloud-provider-detail">{p.detect.detail}</span>
            {!p.detect.available && p.canProvision && (
              <span className="cloud-provider-fallback">
                Pick it anyway to get the paste-a-script path instead.
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
