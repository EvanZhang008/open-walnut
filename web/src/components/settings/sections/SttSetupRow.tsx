/**
 * The one primary row a Mac without working dictation sees: "Set up
 * dictation", a sentence saying exactly what will happen, and one button. When
 * something must be installed by hand first (Homebrew), the row says which and
 * gives the official command instead of a button that could only fail.
 */

import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { CopyButton } from '../inputs/CopyButton';
import { HOMEBREW_INSTALL_COMMAND, type SetupPlan } from './stt-setup-plan';

export function SttSetupRow({ plan, onSetup, error }: { plan: SetupPlan; onSetup: () => void; error?: string | null }) {
  if (plan.blocker === 'homebrew') {
    return (
      <SettingsRow
        label="Set up dictation"
        className="stt-setup-row"
        data-testid="stt-setup-row"
        data-blocker="homebrew"
        help={<>Install Homebrew first, then come back here. In Terminal, run <code>{HOMEBREW_INSTALL_COMMAND}</code></>}
        control={<CopyButton text={HOMEBREW_INSTALL_COMMAND} data-testid="stt-copy-homebrew" />}
      />
    );
  }
  return (
    <SettingsRow
      label="Set up dictation"
      className="stt-setup-row"
      data-testid="stt-setup-row"
      help={plan.help}
      error={error ?? undefined}
      control={<SettingsButton variant="primary" data-testid="stt-setup-button" onClick={onSetup}>Set up</SettingsButton>}
    />
  );
}
