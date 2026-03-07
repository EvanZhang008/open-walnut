import { useState, type KeyboardEvent } from 'react';

interface KeyValueEditorProps {
  entries: Record<string, string | number>;
  onChange: (entries: Record<string, string | number>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  valueType?: 'string' | 'number';
}

export function KeyValueEditor({
  entries,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  valueType = 'string',
}: KeyValueEditorProps) {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const pairs = Object.entries(entries);

  const addEntry = () => {
    const k = newKey.trim();
    if (!k) return;
    const v = valueType === 'number' ? Number(newValue) || 0 : newValue;
    onChange({ ...entries, [k]: v });
    setNewKey('');
    setNewValue('');
  };

  const removeEntry = (key: string) => {
    const next = { ...entries };
    delete next[key];
    onChange(next);
  };

  const updateValue = (key: string, val: string) => {
    const v = valueType === 'number' ? Number(val) || 0 : val;
    onChange({ ...entries, [key]: v });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addEntry();
    }
  };

  return (
    <div className="kv-editor">
      {pairs.map(([key, val]) => (
        <div key={key} className="kv-editor-row">
          <span className="kv-editor-key">{key}</span>
          <input
            type={valueType === 'number' ? 'number' : 'text'}
            value={val}
            onChange={(e) => updateValue(key, e.target.value)}
            className="kv-editor-value"
          />
          <button
            type="button"
            className="kv-editor-remove"
            onClick={() => removeEntry(key)}
            aria-label={`Remove ${key}`}
          >
            ×
          </button>
        </div>
      ))}
      <div className="kv-editor-add">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={keyPlaceholder}
        />
        <input
          type={valueType === 'number' ? 'number' : 'text'}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={valuePlaceholder}
        />
        <button type="button" className="btn btn-sm" onClick={addEntry} disabled={!newKey.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}
