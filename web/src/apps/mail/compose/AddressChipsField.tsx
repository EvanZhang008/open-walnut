/**
 * One recipient row: chips plus the input that makes them.
 *
 * A chip is committed by Enter, a comma, a semicolon, Tab, or leaving the field, because those are
 * the five things people actually do, and a field that only commits on Enter loses the address
 * somebody typed before clicking Send. Paste splits, so a column of addresses out of a spreadsheet
 * becomes one chip each instead of one chip that is not an address.
 *
 * An INVALID chip stays on screen, in red, in the words it was typed in. It is not dropped and not
 * repaired: the composer refuses to send while one exists, which is the one moment a typo is cheap
 * to fix.
 */
import { useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { chipLabel, withChips, type AddressChip } from './mail-address';

interface Props {
  label: string;
  /** `to` / `cc` / `bcc`: it is the testid and the input id. */
  name: string;
  chips: AddressChip[];
  onChange: (chips: AddressChip[]) => void;
  autoFocus?: boolean;
  /**
   * Controls that belong to this row, at its right end (the Cc and Bcc reveals on `To`).
   *
   * A sibling of the chips box rather than a child of it: inside, a row of fourteen recipients
   * would wrap the toggles onto a line of their own, halfway across the field.
   */
  trailing?: ReactNode;
}

/** The keys that end a recipient. Tab is here so keyboard-only entry never eats an address. */
const COMMIT_KEYS = new Set(['Enter', ',', ';', 'Tab']);

export function AddressChipsField({ label, name, chips, onChange, autoFocus, trailing }: Props) {
  const [text, setText] = useState('');

  const commit = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    onChange(withChips(chips, trimmed));
    setText('');
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (COMMIT_KEYS.has(event.key)) {
      // Tab still moves on when there is nothing to commit, so the form stays keyboard navigable.
      if (!text.trim() && event.key === 'Tab') return;
      event.preventDefault();
      commit(text);
      return;
    }
    if (event.key === 'Backspace' && !text && chips.length > 0) {
      event.preventDefault();
      onChange(chips.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (!pasted.trim()) return;
    // Always handled here: a paste of one address is the same operation as a paste of twenty, and
    // letting the plain one fall through to the input would leave it uncommitted.
    event.preventDefault();
    commit(`${text} ${pasted}`.trim());
  };

  return (
    <div className="mail-compose-field" data-testid={`mail-compose-field-${name}`}>
      <label className="mail-compose-label" htmlFor={`mail-compose-${name}`}>{label}</label>
      <div className="mail-compose-chips">
        {chips.map((chip) => (
          <span
            key={chip.key}
            className={`mail-chip${chip.valid ? '' : ' invalid'}`}
            data-testid={`mail-compose-chip-${name}`}
            data-address={chip.address}
            data-valid={chip.valid}
            title={chip.valid ? chip.address : 'This is not an address Walnut can send to'}
          >
            {chipLabel(chip)}
            <button
              type="button"
              className="mail-chip-x"
              aria-label={`Remove ${chip.address || chip.raw}`}
              onClick={() => onChange(chips.filter((one) => one.key !== chip.key))}
            >
              &times;
            </button>
          </span>
        ))}
        <input
          id={`mail-compose-${name}`}
          className="mail-compose-chip-input"
          data-testid={`mail-compose-${name}`}
          type="text"
          value={text}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit(text)}
        />
      </div>
      {trailing && <span className="mail-compose-row-trailing">{trailing}</span>}
    </div>
  );
}
