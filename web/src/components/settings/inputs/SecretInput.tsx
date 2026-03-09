import { useState } from 'react';

interface SecretInputProps {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}

export function SecretInput({ id, value, onChange, placeholder, readOnly }: SecretInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="secret-input-wrapper">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => { if (!readOnly) onChange(e.target.value); }}
        onFocus={readOnly ? (e) => { e.target.blur(); onChange(''); } : undefined}
        placeholder={placeholder}
        className="secret-input"
        autoComplete="off"
        readOnly={readOnly}
      />
      <button
        type="button"
        className="secret-toggle"
        onClick={() => setVisible(!visible)}
        aria-label={visible ? 'Hide' : 'Show'}
        tabIndex={0}
      >
        {visible ? '◉' : '○'}
      </button>
    </div>
  );
}
