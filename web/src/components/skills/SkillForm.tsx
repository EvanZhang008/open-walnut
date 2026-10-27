import { useRef, useState } from 'react';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';

interface SkillFormProps {
  onSave: (input: { dirName: string; content: string; target: 'claude' | 'walnut' }) => Promise<void>;
  onCancel: () => void;
}

const SKILL_TEMPLATE = `---
name: my-skill
description: A brief description of what this skill does
---

# My Skill

Instructions for the AI agent when this skill is activated.
`;

export function SkillForm({ onSave, onCancel }: SkillFormProps) {
  // The new skill's name and SKILL.md are drafts until Create Skill or Cancel.
  const nameDraft = useDraft(draftKey('skill-form', 'new', 'dirName'));
  const contentDraft = useDraft(draftKey('skill-form', 'new', 'content'), { baseline: SKILL_TEMPLATE });
  const { text: dirName, setText: setDirName } = nameDraft;
  const { text: content, setText: setContent } = contentDraft;
  const [target, setTarget] = useState<'claude' | 'walnut'>('claude');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const mic = useRef<BoxMicHandle | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirName.trim()) {
      setError('Skill name is required');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(dirName)) {
      setError('Name must be alphanumeric, hyphens, or underscores only');
      return;
    }
    setSaving(true);
    setError('');
    const sentKeys = [nameDraft.key, contentDraft.key] as const;
    try {
      // A transcription still on its way lands after the save, unsaved: drop it now.
      mic.current?.clear();
      await onSave({ dirName: dirName.trim(), content, target });
      nameDraft.clear(sentKeys[0]);
      contentDraft.clear(sentKeys[1]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create skill');
      setSaving(false);
    }
  };

  return (
    <form className="skill-form card" onSubmit={handleSubmit}>
      <h3 className="skill-form-title">New Skill</h3>
      {error && <div className="skill-form-error">{error}</div>}
      <div className="skill-form-section">
        <label className="skill-form-label">Directory Name</label>
        <input
          data-draft-key={nameDraft.key ?? undefined}
          type="text"
          className="skill-form-input"
          value={dirName}
          onChange={(e) => setDirName(e.target.value)}
          placeholder="my-skill-name"
          autoFocus
        />
      </div>
      <div className="skill-form-section">
        <label className="skill-form-label">Location</label>
        <select
          className="skill-form-select"
          value={target}
          onChange={(e) => setTarget(e.target.value as 'claude' | 'walnut')}
        >
          <option value="claude">~/.claude/skills/</option>
          <option value="walnut">~/.open-walnut/skills/</option>
        </select>
      </div>
      <div className="skill-form-section">
        <label className="skill-form-label">SKILL.md Content</label>
        <MicField boxRef={contentRef} text={content} setText={setContent} handleRef={mic}>
          <textarea
            ref={contentRef}
            data-draft-key={contentDraft.key ?? undefined}
            className="skill-form-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            spellCheck={false}
          />
        </MicField>
      </div>
      <div className="skill-form-actions">
        <button type="button" className="btn" onClick={() => { nameDraft.clear(); contentDraft.clear(); onCancel(); }}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Creating...' : 'Create Skill'}
        </button>
      </div>
    </form>
  );
}
