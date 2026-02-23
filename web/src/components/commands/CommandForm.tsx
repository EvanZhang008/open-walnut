import { useState, useCallback } from 'react';
import type { CommandDef } from '@/api/commands';

interface CommandFormProps {
  command?: CommandDef;
  onSave: (input: { name: string; content: string; description?: string }) => Promise<void>;
  onCancel: () => void;
}

export function CommandForm({ command, onSave, onCancel }: CommandFormProps) {
  const isEditing = !!command;
  const [name, setName] = useState(command?.name ?? '');
  const [description, setDescription] = useState(command?.description ?? '');
  const [content, setContent] = useState(command?.content ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!content.trim()) {
      setError('Content is required');
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name.trim())) {
      setError('Name must be a lowercase slug (letters, numbers, hyphens)');
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        content: content.trim(),
        description: description.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [name, description, content, onSave]);

  return (
    <form onSubmit={handleSubmit} className="cmd-form card">
      <h3 className="cmd-form-title">{isEditing ? `Edit /${command.name}` : 'New Command'}</h3>

      {error && <div className="cmd-form-error">{error}</div>}

      <div className="cmd-form-section">
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="cmd-name">Name</label>
            <input
              id="cmd-name"
              type="text"
              className="font-mono"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-command"
              disabled={isEditing}
            />
          </div>
          <div className="form-group">
            <label htmlFor="cmd-desc">Description</label>
            <input
              id="cmd-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description shown in autocomplete"
            />
          </div>
        </div>
      </div>

      <div className="cmd-form-section">
        <div className="form-group">
          <label htmlFor="cmd-content">Content</label>
          <textarea
            id="cmd-content"
            className="font-mono cmd-form-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="The instruction/prompt text..."
            rows={8}
          />
        </div>
      </div>

      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving...' : isEditing ? 'Update' : 'Create'}
        </button>
      </div>
    </form>
  );
}
