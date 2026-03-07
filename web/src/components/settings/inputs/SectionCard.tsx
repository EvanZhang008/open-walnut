import { useState, type ReactNode, type FormEvent } from 'react';

interface SectionCardProps {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  onSave?: () => Promise<void>;
  /** Show save button. Default: true when onSave provided. */
  showSave?: boolean;
  /** Attention style for unconfigured sections. */
  attention?: boolean;
  /** Success banner text (e.g. "Connected"). */
  banner?: string;
}

export function SectionCard({
  id,
  title,
  description,
  children,
  onSave,
  showSave,
  attention,
  banner,
}: SectionCardProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onSave) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await onSave();
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const hasSaveButton = showSave ?? !!onSave;

  return (
    <form
      id={id}
      className={`settings-section card${attention ? ' settings-attention' : ''}`}
      onSubmit={handleSubmit}
    >
      {banner && (
        <div className="settings-banner settings-banner-success">{banner}</div>
      )}
      <h3 className="settings-section-title">{title}</h3>
      {description && (
        <p className="text-sm text-muted" style={{ margin: '0 0 16px' }}>
          {description}
        </p>
      )}
      {children}
      {error && (
        <div className="text-sm" style={{ color: 'var(--error)', marginTop: 8 }}>
          Error: {error}
        </div>
      )}
      {success && (
        <div className="text-sm" style={{ color: 'var(--success)', marginTop: 8 }}>
          Saved successfully.
        </div>
      )}
      {hasSaveButton && (
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !onSave}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}
    </form>
  );
}
