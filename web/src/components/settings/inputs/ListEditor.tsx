import { useState, type KeyboardEvent } from 'react';

interface ListEditorProps {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  /** Render chips inline (default) or as a vertical list. */
  vertical?: boolean;
}

export function ListEditor({ items, onChange, placeholder, vertical }: ListEditorProps) {
  const [input, setInput] = useState('');

  const addItem = () => {
    const trimmed = input.trim();
    if (!trimmed || items.includes(trimmed)) return;
    onChange([...items, trimmed]);
    setInput('');
  };

  const removeItem = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addItem();
    }
  };

  return (
    <div className="list-editor">
      <div className={`list-editor-items${vertical ? ' list-editor-vertical' : ''}`}>
        {items.map((item, i) => (
          <span key={i} className="list-editor-chip">
            <span className="list-editor-chip-text">{item}</span>
            <button
              type="button"
              className="list-editor-chip-remove"
              onClick={() => removeItem(i)}
              aria-label={`Remove ${item}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="list-editor-add">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Add item...'}
        />
        <button type="button" className="btn btn-sm" onClick={addItem} disabled={!input.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}
