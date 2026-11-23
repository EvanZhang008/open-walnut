/**
 * Provider picker. Cards come from GET /providers, so what the operator sees is
 * whatever THIS build registered plus a live credential probe, no hardcoded
 * list to drift.
 *
 * A provider that can't provision (or whose credentials aren't usable) is still
 * selectable: it routes to the manual paste path, which works everywhere. The
 * pill states that plainly instead of disabling the card and leaving the operator
 * with no next step.
 *
 * A card picks the provider and opens its set-up (CloudSection) in one click, so it carries a go
 * chevron, not a disclosure one.
 */

import type { CloudSetupProvider } from '@/api/cloud-setup';
import { SettingsGroup, SettingsTag } from '../../SettingsSection';
import { ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
import '@/styles/settings-sections-addons.css';

type Tone = 'neutral' | 'warning' | 'success';

function detectPill(provider: CloudSetupProvider): { text: string; tone: Tone } {
  if (provider.detect.available) {
    return provider.canProvision
      ? { text: 'Ready', tone: 'success' }
      : { text: 'Paste a script', tone: 'neutral' };
  }
  if (provider.detect.needs === 'api-token') return { text: 'Needs API token', tone: 'warning' };
  if (provider.detect.needs === 'cli-login') return { text: 'CLI missing or signed out', tone: 'warning' };
  return { text: 'Not ready', tone: 'warning' };
}

interface Props {
  providers: CloudSetupProvider[];
  selected: string | null;
  onSelect: (id: string) => void;
}

export function CloudProviderPicker({ providers, selected, onSelect }: Props) {
  return (
    <SettingsGroup heading="Where should the companion live?" className="cloud-provider-grid">
      <div role="radiogroup" aria-label="Cloud provider" className="settings-addons-contents" data-choice-exempt="settings rows that each open their provider's setup step (the chevron); the row family draws them">
        {providers.map((p) => {
          const pill = detectPill(p);
          const help = [p.costHint, p.detect.detail].filter(Boolean).join('. ').replace(/\.\./g, '.');
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              data-choice-exempt="a settings row that opens this provider's setup step"
              aria-checked={selected === p.id}
              data-provider={p.id}
              className={`settings-row settings-addons-choice cloud-provider-card${selected === p.id ? ' cloud-provider-active' : ''}`}
              onClick={() => onSelect(p.id)}
            >
              <span className="settings-row-copy">
                <span className="settings-row-label cloud-provider-label">{p.label}</span>
                <span className="settings-row-help cloud-provider-detail">
                  {help}
                  {!p.detect.available && p.canProvision && ' Pick it anyway to get the paste-a-script path.'}
                </span>
              </span>
              <span className="settings-row-actions">
                <span className="cloud-pill">
                  <SettingsTag tone={pill.tone}>{pill.text}</SettingsTag>
                </span>
                <span className="cloud-provider-go" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
              </span>
            </button>
          );
        })}
      </div>
    </SettingsGroup>
  );
}
