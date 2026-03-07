interface ToggleSwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  id?: string;
}

export function ToggleSwitch({ checked, onChange, label, id }: ToggleSwitchProps) {
  return (
    <label className="toggle-switch-label" htmlFor={id}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggle-switch${checked ? ' toggle-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-thumb" />
      </button>
      {label && <span className="toggle-text">{label}</span>}
    </label>
  );
}
