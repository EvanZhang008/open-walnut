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

import type { CloudSetupDomainMode, CloudSetupProvider, CloudSetupProviderId } from '@/api/cloud-setup';
import { SettingsGroup, SettingsRow, SettingsDisclosure, SettingsNotice } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { SegmentedControl } from '../../inputs/SegmentedControl';
import '@/styles/settings-sections-addons.css';

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
    return `This is created in your ${provider.label} project, the one your API token belongs to; you own it and you pay for it, Walnut only drives the setup.`;
  }
  return `This is created in your own cloud account, the one the CLI on this machine is signed in to; you own it and you pay for it, Walnut only drives the setup.`;
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
      <SettingsGroup>
        <SettingsRow
          className="cloud-configure-provider"
          label={`Setting up on ${provider.label}`}
          help={provider.costHint}
        />
        {showProfilePicker && (
          <SettingsRow
            className="cloud-profile-field"
            label="AWS profile"
            htmlFor="cloud-aws-profile"
            help={provider.detect.available
              ? provider.detect.detail
              : 'The account to deploy into; the box is created and billed there.'}
            control={
              <select
                id="cloud-aws-profile"
                className="settings-select"
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
            }
          />
        )}
      </SettingsGroup>

      {credsNotReady && <SettingsNotice kind="warn">{provider.detect.detail}</SettingsNotice>}

      {provider.canProvision && resources.length > 0 && (
        <SettingsGroup heading="What will happen" className="cloud-whathappens">
          {resources.map((item) => (
            <SettingsRow key={item} label={item} />
          ))}
          <SettingsRow
            className="cloud-whathappens-cost"
            label={`Estimated cost: ${provider.costHint}`}
            help={accountSentence(provider)}
          />
        </SettingsGroup>
      )}

      <SettingsGroup heading="Address" className="cloud-fieldset">
        <SettingsRow
          label="Address"
          control={
            <SegmentedControl
              aria-label="Address"
              name="cloud-domain-mode"
              value={values.domainMode}
              onChange={(v) => set('domainMode', v)}
              options={[
                { value: 'own-domain', label: 'Own domain' },
                { value: 'sslip', label: 'Free auto-address' },
              ]}
            />
          }
          help={values.domainMode === 'own-domain'
            ? 'Recommended: a hostname you control, with one A record added during setup.'
            : 'Starts in 5 minutes with no registrar at <dashed-ip>.sslip.io; the address changes if the IP does.'}
        />
        {values.domainMode === 'own-domain' && (
          <SettingsRow
            label="Domain"
            htmlFor="cloud-domain"
            indent
            wide
            error={domainMissing ? 'Enter a domain, or switch to the free auto-address.' : undefined}
            control={
              <input
                id="cloud-domain"
                type="text"
                className="cloud-domain-input settings-input settings-input--long settings-input--mono"
                value={values.domain}
                placeholder="walnut.example.com"
                aria-label="Domain"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => set('domain', e.target.value.trim())}
              />
            }
          />
        )}
        {needsToken && (
          <SettingsRow
            label={`${provider.label} API token`}
            htmlFor="cloud-api-token"
            help="Kept in memory, never written to disk."
            control={
              <input
                id="cloud-api-token"
                type="password"
                className="settings-input settings-input--short settings-input--mono"
                value={values.credentials}
                aria-label="Provider API token"
                autoComplete="off"
                onChange={(e) => set('credentials', e.target.value)}
              />
            }
          />
        )}
        {provider.canProvision && (
          <SettingsDisclosure id="cloud-placement" label="Placement" summary="Optional">
            <SettingsRow
              label="Region"
              htmlFor="cloud-region"
              control={
                <input id="cloud-region" type="text" className="settings-input settings-input--short"
                  value={values.region} placeholder="Your CLI default" aria-label="Region"
                  onChange={(e) => set('region', e.target.value.trim())} />
              }
            />
            <SettingsRow
              label="Instance size"
              htmlFor="cloud-instance-size"
              control={
                <input id="cloud-instance-size" type="text" className="settings-input settings-input--short"
                  value={values.instanceType} placeholder="Recommended size" aria-label="Instance size"
                  onChange={(e) => set('instanceType', e.target.value.trim())} />
              }
            />
          </SettingsDisclosure>
        )}
        {!provider.canProvision && (
          <SettingsRow
            className="cloud-configure-note"
            label="Paste a first-boot script"
            help="Walnut writes the script for your VM, then watches for the box to come up and claims it."
          />
        )}
      </SettingsGroup>

      {error && <SettingsNotice kind="error" role="alert">{error}</SettingsNotice>}

      <div className="cloud-actions settings-addons-actions">
        <SettingsButton onClick={onBack} disabled={busy}>Back</SettingsButton>
        <SettingsButton variant="primary" disabled={domainMissing} busy={busy} busyLabel="Starting..." onClick={onStart}>
          {provider.canProvision ? 'Start setup' : 'Generate the script'}
        </SettingsButton>
      </div>
    </div>
  );
}
