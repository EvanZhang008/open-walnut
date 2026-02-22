const MODELS = [
  { id: 'opus', label: 'Opus', description: 'Most capable' },
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced' },
  { id: 'haiku', label: 'Haiku', description: 'Fastest' },
] as const;

interface ModelPickerProps {
  currentModel?: string;
  onSwitch: (model: string, immediate: boolean) => void;
  onClose: () => void;
}

export function ModelPicker({ currentModel, onSwitch, onClose }: ModelPickerProps) {
  // Normalize current model to match our model IDs
  const normalizedCurrent = currentModel?.toLowerCase().includes('haiku') ? 'haiku'
    : currentModel?.toLowerCase().includes('sonnet') ? 'sonnet'
    : 'opus';

  return (
    <div className="model-picker">
      <div className="model-picker-header">
        <span className="model-picker-title">Switch Model</span>
        <span className="model-picker-current">Current: {normalizedCurrent}</span>
        <button className="model-picker-close" onClick={onClose} type="button">&times;</button>
      </div>
      <div className="model-picker-options">
        {MODELS.map((m) => (
          <div
            key={m.id}
            className={`model-picker-option${m.id === normalizedCurrent ? ' model-picker-option-active' : ''}`}
          >
            <div className="model-picker-option-name">{m.label}</div>
            <div className="model-picker-option-desc">{m.description}</div>
            {m.id !== normalizedCurrent && (
              <div className="model-picker-option-actions">
                <button
                  className="btn btn-sm model-picker-btn"
                  onClick={() => onSwitch(m.id, false)}
                  type="button"
                >
                  Next turn
                </button>
                <button
                  className="btn btn-sm model-picker-btn-immediate"
                  onClick={() => onSwitch(m.id, true)}
                  type="button"
                  title="Interrupt current turn and switch immediately"
                >
                  Now
                </button>
              </div>
            )}
            {m.id === normalizedCurrent && (
              <div className="model-picker-option-badge">Active</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
