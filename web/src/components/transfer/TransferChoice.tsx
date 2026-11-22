/**
 * One choice of a Transfer dialog row (harness, host, permissions, directory, start): a radio
 * whose words are its name, a "Now" tag when it is what the task runs on today, an optional kind
 * tag, and a line under it (what it does, or why it is blocked). The shared Radio draws it
 * (standard.md, "Choice controls": one of a few choices that each need words).
 */
import type { ReactNode } from 'react';
import { Radio } from '@/components/controls';

export function TransferChoice({ group, checked, disabled, onPick, name, now, tag, sub, title, testId }: {
  /** The row it belongs to: radios of one row share a native group (arrow keys move within it). */
  group: string;
  checked: boolean;
  disabled?: boolean;
  onPick: () => void;
  name: ReactNode;
  now?: boolean;
  tag?: ReactNode;
  sub?: ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <Radio
      name={`xfer-${group.toLowerCase()}`}
      rowClassName="xfer-opt-row"
      checked={checked}
      disabled={disabled}
      onChange={onPick}
      title={title}
      data-testid={testId}
      label={(
        <span className="xfer-opt-line">
          <span className="xfer-opt-name wn-title">{name}</span>
          {now && <span className="badge badge-accent xfer-now">Now</span>}
          {tag && <span className="badge xfer-opt-tag"><span>{tag}</span></span>}
        </span>
      )}
      detail={sub}
    />
  );
}
