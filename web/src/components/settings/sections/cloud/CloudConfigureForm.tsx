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
import type { CloudSetupDomainMode, CloudSetupProvider, CloudSetupProviderId } from '@/api/cloud-setup';

/**
 * What each driver actually creates, per provider — NOT one generic list.
 * Only aws groups its resources in a CloudFormation stack and takes daily
 * snapshots; promising those on Hetzner would be a lie the operator discovers
 * when they go looking for a backup that was never configured.
 */
const CREATED_RESOURCES: Record<CloudSetupProviderId, string[]> = {
  aws: [
    'One small EC2 instance and a private network for it',
    'A static public IP (Elastic IP), so your address survives a restart',
    'An encrypted 30 GB disk, kept if the instance is ever replaced',
    'A daily snapshot schedule, keeping the last 7',
    'All of it in one CloudFormation stack, so it deletes as one unit',
  ],
  hetzner: [
    'One small server (2 vCPU) running Ubuntu 24.04',
    'A public IPv4 address',
    'A firewall allowing inbound web traffic only (ports 80 and 443)',
  ],
  azure: [
    'One small VM running Ubuntu 24.04',
    'A static public IP, so your address survives a restart',
    'A network security group allowing inbound web traffic only (80 and 443)',
    'All of it in one resource group (walnut-cloud), so it deletes as one unit',
  ],
  gcp: [
    'One small VM (e2-small) running Ubuntu 24.04',
    'A reserved static IP address, so your address survives a restart',
    'A firewall rule for inbound web traffic (80 and 443), scoped to this VM only',
  ],
  manual: [],
};

/** Where the resources land, phrased by how this driver gets its credential. */
function accountSentence(provider: CloudSetupProvider): string {
  if (provider.detect.needs === 'api-token') {
    return `This is created in YOUR ${provider.label} project — the one your API token belongs to. You own it and you pay for it; Walnut only drives the setup.`;
  }
  return `This is created in YOUR OWN cloud account — the one the CLI on this machine is signed in to. You own it and you pay for it; Walnut only drives the setup.`;
}

export interface ConfigureValues {
  domainMode: CloudSetupDomainMode;
  domain: string;
  region: string;
  instanceType: string;
  credentials: string;
  /** Chosen local CLI credential profile (aws). Empty = the CLI's own default. */
  profile: string;
}

interface Props {
  provider: CloudSetupProvider;
  values: ConfigureValues;
  onChange: (next: ConfigureValues) => void;
  onBack: () => void;
  onStart: () => void;
  /** Re-probes the driver with the chosen profile so the verdict updates in place. */
  onProfileChange: (profile: string) => void;
  busy: boolean;
  error: string | null;
}

export function CloudConfigureForm({
  provider, values, onChange, onBack, onStart, onProfileChange, busy, error,
}: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const set = <K extends keyof ConfigureValues>(key: K, value: ConfigureValues[K]) =>
    onChange({ ...values, [key]: value });

  const needsToken = provider.canProvision && provider.detect.needs === 'api-token';
  const domainMissing = values.domainMode === 'own-domain' && !values.domain.trim();
  const resources = CREATED_RESOURCES[provider.id] ?? [];
  // Only worth a picker when there is a real choice to make.
  const profiles = provider.detect.profiles ?? [];
  const showProfilePicker = provider.canProvision && profiles.length > 1;
  // Surfaced as a warning, NOT a hard block on Start. The probe is advisory and
  // can be a false negative (its 5s cap reports a slow CLI as "can't tell"), so
  // gating the button on it would wedge the wizard for someone whose credentials
  // are fine. The operator sees the reason and decides.
  const credsNotReady = provider.canProvision && !needsToken && !provider.detect.available;

  return (
    <div className="cloud-configure">
      <p className="cloud-configure-provider">
        Setting up on <strong>{provider.label}</strong> — {provider.costHint}
      </p>

      {showProfilePicker && (
        <label className="cloud-field cloud-profile-field">
          <span className="cloud-field-label">AWS profile</span>
          <select
            value={values.profile}
            aria-label="AWS profile"
            disabled={busy}
            onChange={(e) => onProfileChange(e.target.value)}
          >
            <option value="">Default profile</option>
            {profiles.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <span className="cloud-field-note">
            {provider.detect.available
              ? provider.detect.detail
              : 'Pick the account to deploy into — the box is created there and billed there.'}
          </span>
        </label>
      )}

      {credsNotReady && (
        <p className="cloud-configure-warn">{provider.detect.detail}</p>
      )}

      {provider.canProvision && resources.length > 0 && (
        <section className="cloud-whathappens">
          <h4 className="cloud-whathappens-title">What will happen</h4>
          <ul className="cloud-whathappens-list">
            {resources.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="cloud-whathappens-cost">
            Estimated cost: <strong>{provider.costHint}</strong>. {accountSentence(provider)}
          </p>
        </section>
      )}

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
              domain: the address changes if the IP ever does, and because sslip.io shares one
              set of Let&apos;s Encrypt rate limits across every user worldwide, the first
              certificate can occasionally take a while to issue.
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
