interface NumberInputProps {
  id?: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  suffix?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
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
