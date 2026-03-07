import { useState } from 'react';

interface SecretInputProps {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export function SecretInput({ id, value, onChange, placeholder }: SecretInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="secret-input-wrapper">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="secret-input"
        autoComplete="off"
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
