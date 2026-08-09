/**
 * Configure screen: the choices POST /api/cloud-setup/start actually consumes.
 *
 * Region and instance type are shown ONLY for a driver that provisions and only
 * behind a disclosure — the aws driver forwards them to the CDK app as context,
 * but leaving them blank is the right default (the operator's own CLI/profile
 * default region, and the stack's own instance type). A field the server would
 * ignore is worse than no field, so nothing else from the driver contract is
 * exposed here.
 */

import { useState } from 'react';
import type { CloudSetupDomainMode, CloudSetupProvider } from '@/api/cloud-setup';

export interface ConfigureValues {
  domainMode: CloudSetupDomainMode;
  domain: string;
  region: string;
  instanceType: string;
  credentials: string;
}

interface Props {
  provider: CloudSetupProvider;
  values: ConfigureValues;
  onChange: (next: ConfigureValues) => void;
  onBack: () => void;
  onStart: () => void;
  busy: boolean;
  error: string | null;
}

export function CloudConfigureForm({ provider, values, onChange, onBack, onStart, busy, error }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const set = <K extends keyof ConfigureValues>(key: K, value: ConfigureValues[K]) =>
    onChange({ ...values, [key]: value });

  const needsToken = provider.canProvision && provider.detect.needs === 'api-token';
  const domainMissing = values.domainMode === 'own-domain' && !values.domain.trim();

  return (
    <div className="cloud-configure">
      <p className="cloud-configure-provider">
        Setting up on <strong>{provider.label}</strong> — {provider.costHint}
      </p>

      <fieldset className="cloud-fieldset">
        <legend>Address</legend>

        <label className="cloud-radio">
          <input
            type="radio"
            name="cloud-domain-mode"
            checked={values.domainMode === 'own-domain'}
            onChange={() => set('domainMode', 'own-domain')}
          />
          <span>
            <span className="cloud-radio-label">Own domain (recommended)</span>
            <span className="cloud-radio-note">
              A hostname you control, e.g. <code>walnut.example.com</code>. You&apos;ll add one A
              record during setup.
            </span>
          </span>
        </label>

        {values.domainMode === 'own-domain' && (
          <input
            type="text"
            className="cloud-domain-input"
            value={values.domain}
            placeholder="walnut.example.com"
            aria-label="Domain"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => set('domain', e.target.value.trim())}
          />
        )}

        <label className="cloud-radio">
          <input
            type="radio"
            name="cloud-domain-mode"
            checked={values.domainMode === 'sslip'}
            onChange={() => set('domainMode', 'sslip')}
          />
          <span>
            <span className="cloud-radio-label">Free auto-address (sslip.io)</span>
            <span className="cloud-radio-note">
              Start in 5 minutes with no registrar — the box serves itself at
              <code>&lt;dashed-ip&gt;.sslip.io</code>. For long-term use we recommend your own
              domain: the address changes if the IP ever does.
            </span>
          </span>
        </label>
      </fieldset>

      {needsToken && (
        <label className="cloud-field">
          <span className="cloud-field-label">{provider.label} API token</span>
          <input
            type="password"
            value={values.credentials}
            placeholder="Pasted token — kept in memory, never written to disk"
            aria-label="Provider API token"
            autoComplete="off"
            onChange={(e) => set('credentials', e.target.value)}
          />
        </label>
      )}

      {provider.canProvision && (
        <details className="cloud-advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>Placement (optional)</summary>
          <div className="cloud-advanced-body">
            <label className="cloud-field">
              <span className="cloud-field-label">Region</span>
              <input
                type="text"
                value={values.region}
                placeholder="Leave blank to use your CLI default"
                aria-label="Region"
                onChange={(e) => set('region', e.target.value.trim())}
              />
            </label>
            <label className="cloud-field">
              <span className="cloud-field-label">Instance size</span>
              <input
                type="text"
                value={values.instanceType}
                placeholder="Leave blank for the recommended size"
                aria-label="Instance size"
                onChange={(e) => set('instanceType', e.target.value.trim())}
              />
            </label>
          </div>
        </details>
      )}

      {!provider.canProvision && (
        <p className="cloud-configure-note">
          Walnut will generate the first-boot script for you to paste into your VM, then watch for
          the box to come up and claim it automatically.
        </p>
      )}

      {error && <p className="devices-error">{error}</p>}

      <div className="cloud-actions">
        <button type="button" className="btn" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || domainMissing}
          onClick={onStart}
        >
          {busy ? 'Starting…' : provider.canProvision ? 'Start setup' : 'Generate the script'}
        </button>
      </div>
      {domainMissing && (
        <p className="cloud-validation">Enter a domain, or switch to the free auto-address.</p>
      )}
    </div>
  );
}
