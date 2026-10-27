import { useState, useCallback, useRef } from 'react';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';
import type { CommandDef } from '@/api/commands';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';

interface CommandFormProps {
  command?: CommandDef;
  onSave: (input: { name: string; content: string; description?: string }) => Promise<void>;
  onCancel: () => void;
}

export function CommandForm({ command, onSave, onCancel }: CommandFormProps) {
  const isEditing = !!command;
  // Each field is a draft of this command (or of the new one) until Create/Update or Cancel.
  const formId = command?.name ?? 'new';
  const nameDraft = useDraft(draftKey('command-form', formId, 'name'), { baseline: command?.name ?? '' });
  const descDraft = useDraft(draftKey('command-form', formId, 'description'), { baseline: command?.description ?? '' });
  const contentDraft = useDraft(draftKey('command-form', formId, 'content'), { baseline: command?.content ?? '' });
  const { text: name, setText: setName, clear: clearName } = nameDraft;
  const { text: description, setText: setDescription, clear: clearDesc } = descDraft;
  const { text: content, setText: setContent, clear: clearContent } = contentDraft;
  const clearDrafts = useCallback((keys?: Array<string | null>) => {
    [clearName, clearDesc, clearContent].forEach((clear, i) => clear(keys ? keys[i] : undefined));
  }, [clearName, clearDesc, clearContent]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const mic = useRef<BoxMicHandle | null>(null);

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
    const sentKeys = [nameDraft.key, descDraft.key, contentDraft.key];
    try {
      // A transcription still on its way lands after the save, unsaved: drop it now.
      mic.current?.clear();
      await onSave({
        name: name.trim(),
        content: content.trim(),
        description: description.trim() || undefined,
      });
      clearDrafts(sentKeys);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [name, description, content, onSave, nameDraft.key, descDraft.key, contentDraft.key, clearDrafts]);

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
              data-draft-key={nameDraft.key ?? undefined}
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
              data-draft-key={descDraft.key ?? undefined}
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
          <MicField boxRef={contentRef} text={content} setText={setContent} handleRef={mic}>
            <textarea
              ref={contentRef}
              id="cmd-content"
              data-draft-key={contentDraft.key ?? undefined}
              className="font-mono cmd-form-textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="The instruction/prompt text..."
              rows={8}
            />
          </MicField>
        </div>
      </div>

      <div className="form-actions">
        <button type="button" className="btn" onClick={() => { clearDrafts(); onCancel(); }}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving...' : isEditing ? 'Update' : 'Create'}
        </button>
      </div>
    </form>
  );
}
