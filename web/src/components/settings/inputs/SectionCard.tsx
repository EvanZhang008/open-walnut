/**
 * The save-on-submit section wrapper. It owns the saving/error/success lifecycle;
 * the BOX, header and spacing come from SettingsSection so this card is
 * geometrically identical to the hand-built sections (Apps, Repositories, Usage …).
 */
import { useState, useRef, useEffect, type ReactNode, type FormEvent } from 'react';
import { SettingsSection, SettingsNotice } from '../SettingsSection';

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
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear success timer on unmount to avoid setState on unmounted component
  useEffect(() => () => clearTimeout(successTimerRef.current), []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onSave) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    clearTimeout(successTimerRef.current);
    try {
      await onSave();
      setSuccess(true);
      successTimerRef.current = setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const hasSaveButton = showSave ?? !!onSave;

  return (
    <SettingsSection
      as="form"
      id={id}
      title={title}
      description={description}
      onSubmit={handleSubmit}
      {...(attention ? { className: 'settings-card-attention' } : {})}
      {...(banner
        ? { banner: <div className="settings-banner settings-banner-success">{banner}</div> }
        : {})}
      footer={
        <>
          {error && <SettingsNotice kind="error">Error: {error}</SettingsNotice>}
          {success && <SettingsNotice kind="success">Saved successfully.</SettingsNotice>}
          {hasSaveButton && (
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving || !onSave}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}
        </>
      }
    >
      {children}
    </SettingsSection>
  );
}
