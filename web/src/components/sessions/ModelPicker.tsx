import React from 'react';

const MODELS = [
  { id: 'opus', label: 'Opus', description: 'Most capable' },
  { id: 'opus-1m', label: 'Opus 1M', description: '1M context window' },
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced' },
  { id: 'sonnet-1m', label: 'Sonnet 1M', description: '1M context window' },
  { id: 'haiku', label: 'Haiku', description: 'Fastest' },
] as const;

/** Normalize a raw model string (e.g. init event model) to our picker IDs */
function normalizeModelId(raw?: string): string {
  if (!raw) return 'opus';
  const lower = raw.toLowerCase();
  const is1m = lower.includes('[1m]');
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return is1m ? 'sonnet-1m' : 'sonnet';
  return is1m ? 'opus-1m' : 'opus';
}

interface ModelPickerProps {
  currentModel?: string;
  onSwitch: (model: string, immediate: boolean) => void;
  onClose: () => void;
}

export function ModelPicker({ currentModel, onSwitch, onClose }: ModelPickerProps) {
  const normalizedCurrent = normalizeModelId(currentModel);

  // Close on Escape key
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

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
