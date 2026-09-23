/**
 * Provider picker. Cards come from GET /providers, so what the operator sees is
 * whatever THIS build registered plus a live credential probe, no hardcoded
 * list to drift.
 *
 * A provider that can't provision (or whose credentials aren't usable) is still
 * selectable: it routes to the manual paste path, which works everywhere. The
 * pill states that plainly instead of disabling the card and leaving the operator
 * with no next step.
 */

import type { CloudSetupProvider } from '@/api/cloud-setup';
import { SettingsGroup, SettingsTag } from '../../SettingsSection';
import { ChevronGlyph } from '../../settings-glyphs';
import '@/styles/settings-sections-addons.css';

type Tone = 'neutral' | 'warning' | 'success';

function detectPill(provider: CloudSetupProvider): { text: string; cls: string; tone: Tone } {
  if (provider.detect.available) {
    return provider.canProvision
      ? { text: 'Ready', cls: 'cloud-pill-ready', tone: 'success' }
      : { text: 'Paste a script', cls: 'cloud-pill-manual', tone: 'neutral' };
  }
  if (provider.detect.needs === 'api-token') return { text: 'Needs API token', cls: 'cloud-pill-token', tone: 'warning' };
  if (provider.detect.needs === 'cli-login') return { text: 'CLI missing or signed out', cls: 'cloud-pill-warn', tone: 'warning' };
  return { text: 'Not ready', cls: 'cloud-pill-warn', tone: 'warning' };
}

interface Props {
  providers: CloudSetupProvider[];
  selected: string | null;
  onSelect: (id: string) => void;
}

export function CloudProviderPicker({ providers, selected, onSelect }: Props) {
  return (
    <SettingsGroup heading="Where should the companion live?" className="cloud-provider-grid">
      <div role="radiogroup" aria-label="Cloud provider" className="settings-addons-contents">
        {providers.map((p) => {
          const pill = detectPill(p);
          const help = [p.costHint, p.detect.detail].filter(Boolean).join('. ').replace(/\.\./g, '.');
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
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
                <span className={`cloud-pill ${pill.cls}`}>
                  <SettingsTag tone={pill.tone}>{pill.text}</SettingsTag>
                </span>
                <ChevronGlyph size={12} className="settings-disclosure-chevron" />
              </span>
            </button>
          );
        })}
      </div>
    </SettingsGroup>
  );
}
