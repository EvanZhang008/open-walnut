interface NumberInputProps {
  id?: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  suffix?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Commit points for callers that persist on commit rather than per keystroke
   *  (e.g. a write that costs a config file rewrite). Optional — sections using
   *  the shared auto-save keep working unchanged. */
  onBlur?: () => void;
  onEnter?: () => void;
}

export function NumberInput({
  id,
  value,
  onChange,
  suffix,
  placeholder,
  min,
  max,
  step,
  onBlur,
  onEnter,
}: NumberInputProps) {
  return (
    <div className="number-input-wrapper">
      <input
        id={id}
        type="number"
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === '' ? undefined : Number(v));
        }}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        className="number-input"
      />
      {suffix && <span className="number-input-suffix">{suffix}</span>}
    </div>
  );
}
