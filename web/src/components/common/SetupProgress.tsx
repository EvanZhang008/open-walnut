import '@/styles/setup-progress.css';

interface SetupProgressProps {
  label: string;
  /** Omit until the operation reports a measured percentage. */
  percent?: number | null;
  /** A step count instead of a percentage, when the operation reports stages. */
  valueText?: string;
  ariaLabel?: string;
  /** Keep the stage and bar on one line where a host row holds its height. */
  inline?: boolean;
  /** Settings already names the step in the row's label. */
  compact?: boolean;
}

/** A measured bar or an unknown-progress sweep, never a guessed percentage. */
export function SetupProgress({ label, percent, valueText, ariaLabel, inline, compact }: SetupProgressProps) {
  const value = typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined;
  const unknown = value === undefined;
  return (
    <span className={`setup-progress${inline ? ' setup-progress-inline' : ''}${compact ? ' setup-progress-compact' : ''}`}
      data-progress={unknown ? 'unknown' : 'known'}>
      {!compact && <span className="setup-progress-label">{label}</span>}
      <span className="setup-progress-meter">
        <span className="setup-progress-track" role="progressbar" aria-label={ariaLabel ?? label}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}
          aria-valuetext={valueText ?? (unknown ? 'In progress' : undefined)}>
          <span className="setup-progress-fill" style={unknown ? undefined : { width: `${value}%` }} />
        </span>
        {!unknown && <span className="setup-progress-value">{valueText ?? `${Math.round(value)}%`}</span>}
      </span>
    </span>
  );
}
