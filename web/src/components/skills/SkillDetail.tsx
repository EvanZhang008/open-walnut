import { useState, useEffect, useCallback, useRef } from 'react';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';
import type { SkillInfo, RefFile } from '@/api/skills';
import { fetchReferences } from '@/api/skills';
import { formatSize } from '@/utils/format';
import { useAlert } from '@/hooks/useConfirm';
import { useDraft } from '@/hooks/useDraft';
import { draftKey, readDraft } from '@/utils/drafts';

interface SkillDetailProps {
  skill: SkillInfo;
  onSave: (dirName: string, content: string) => Promise<void>;
  onDelete: (dirName: string) => Promise<void>;
  onToggle: (dirName: string, enabled: boolean) => void;
}

export function SkillDetail({ skill, onSave, onDelete, onToggle }: SkillDetailProps) {
  const alert = useAlert();
  // An unsaved edit is a draft of this skill's SKILL.md until Save or Reset, so
  // switching skills, leaving the page or a reload keeps it.
  const draft = useDraft(draftKey('skill-content', skill.dirName), { baseline: skill.content });
  const { text: content, setText: setContent } = draft;
  const [dirty, setDirty] = useState(() => !!readDraft(draft.key));
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refs, setRefs] = useState<RefFile[]>([]);
  const [refsOpen, setRefsOpen] = useState(false);
  const [refsLoaded, setRefsLoaded] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const mic = useRef<BoxMicHandle | null>(null);
  // A plugin owns its skill directory and replaces the file on its next update, so the
  // server refuses the write too — offering an editor here would promise a lasting edit.
  const isReadonly = skill.source === 'workspace' || skill.source === 'plugin';

  // Only reset editor state when switching to a different skill (the draft hook
  // loads that skill's own text). Do NOT depend on skill.content: refetches after
  // toggle/update would overwrite unsaved user edits.
  useEffect(() => {
    mic.current?.clear();
    setDirty(!!readDraft(draftKey('skill-content', skill.dirName)));
    setConfirmDelete(false);
    setRefsOpen(false);
    setRefsLoaded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.dirName]);

  const handleLoadRefs = useCallback(async () => {
    if (refsLoaded) {
      setRefsOpen(!refsOpen);
      return;
    }
    try {
      const files = await fetchReferences(skill.dirName);
      setRefs(files);
      setRefsLoaded(true);
      setRefsOpen(true);
    } catch {
      setRefs([]);
      setRefsLoaded(true);
      setRefsOpen(true);
    }
  }, [skill.dirName, refsOpen, refsLoaded]);

  const handleSave = async () => {
    setSaving(true);
    const sentKey = draft.key;
    try {
      // A transcription still on its way lands after the save, unsaved: drop it now.
      mic.current?.clear();
      await onSave(skill.dirName, content);
      draft.clear(sentKey);
      setDirty(false);
    } catch (err) {
      await alert({ title: 'Save failed', message: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    mic.current?.clear();
    draft.clear();
    setDirty(false);
  };

  const handleDelete = async () => {
    try {
      await onDelete(skill.dirName);
    } catch (err) {
      await alert({ title: 'Delete failed', message: err instanceof Error ? err.message : 'Failed to delete' });
    }
  };

  return (
    <div className="skill-detail">
      <div className="skill-detail-header">
        <div className="skill-detail-title-row">
          <h2 className="skill-detail-name">{skill.name}</h2>
          <span className={`skill-source-badge ${skill.source}`}>{skill.source}</span>
          {!skill.eligible && <span className="skill-badge-ineligible">ineligible</span>}
          {!skill.enabled && <span className="skill-badge-disabled">disabled</span>}
        </div>
        <div className="skill-detail-meta text-sm text-muted">
          <span title={skill.location}>{skill.dirName}</span>
        </div>
        <div className="skill-detail-sizes">
          <span className="skill-size-pill" title="Description text between --- markers, injected into every system prompt for all enabled skills">
            prompt <strong>{formatSize(skill.description.length)}</strong>
          </span>
          <span className="skill-size-pill" title="Full SKILL.md file, loaded on-demand only when agent activates this skill">
            doc <strong>{formatSize(skill.content.length)}</strong>
          </span>
        </div>
        <div className="skill-detail-toggle-row">
          <label className="skill-toggle">
            <input
              type="checkbox"
              checked={skill.enabled}
              onChange={() => onToggle(skill.dirName, !skill.enabled)}
            />
            <span className="skill-toggle-slider" />
          </label>
          <span className="text-sm">{skill.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
      </div>

      <div className="skill-detail-editor">
        <MicField
          boxRef={contentRef}
          text={content}
          setText={(t) => { setContent(t); setDirty(true); }}
          handleRef={mic}
          disabled={isReadonly}
        >
          <textarea
            ref={contentRef}
            data-draft-key={isReadonly ? undefined : draft.key ?? undefined}
            data-no-draft={isReadonly ? 'mirror' : undefined}
            className="skill-detail-textarea"
            value={content}
            onChange={(e) => { setContent(e.target.value); setDirty(true); }}
            readOnly={isReadonly}
            spellCheck={false}
          />
        </MicField>
      </div>

      {!isReadonly && (
        <div className="skill-detail-actions">
          <button className="btn btn-primary" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button className="btn" onClick={handleReset} disabled={!dirty}>
            Reset
          </button>
        </div>
      )}

      {skill.hasReferences && (
        <div className="skill-refs-section">
          <button className="skill-refs-toggle" onClick={handleLoadRefs}>
            <span className={`skill-refs-chevron${refsOpen ? ' rotated' : ''}`}>&#9660;</span>
            References
          </button>
          {refsOpen && (
            <div className="skill-refs-list">
              {refs.length === 0 ? (
                <span className="text-sm text-muted">No reference files</span>
              ) : (
                refs.map((f) => (
                  <div key={f.name} className="skill-ref-item">
                    <span className="skill-ref-name">{f.name}</span>
                    <span className="skill-ref-size text-sm text-muted">{formatSize(f.size)}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {!isReadonly && (
        <div className="skill-detail-danger">
          {!confirmDelete ? (
            <button className="btn btn-danger-outline" onClick={() => setConfirmDelete(true)}>
              Delete Skill
            </button>
          ) : (
            <div className="skill-confirm-delete">
              <span className="text-sm">Delete <strong>{skill.dirName}</strong>? This cannot be undone.</span>
              <div className="skill-confirm-actions">
                <button className="btn btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button className="btn btn-sm btn-danger" onClick={handleDelete}>Delete</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
