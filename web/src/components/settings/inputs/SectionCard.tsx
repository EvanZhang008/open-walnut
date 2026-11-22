/**
 * The save-on-submit section wrapper. It owns the saving/error lifecycle; the
 * header and spacing come from SettingsSection. Success is reported through
 * the pane's `Saved` indicator (no inline success notice); a failure shows
 * `Not saved` in the header and a `Couldn't save` notice under the form.
 */
import { useState, type ReactNode, type FormEvent } from 'react'
import { SettingsSection, SettingsNotice } from '../SettingsSection'
import { saveErrorMessage, useSettingsSaved } from '../settings-pane-context'
import { SettingsButton } from './SettingsButton'

interface SectionCardProps {
  id: string
  title: string
  description?: string
  children: ReactNode
  onSave?: () => Promise<void>
  /** Show save button. Default: true when onSave provided. */
  showSave?: boolean
  /**
   * Save is the view's one main action (blue) only while there is something to save; a form that
   * knows it has nothing unsaved passes false and Save is the plain key (default: true).
   */
  saveIsMain?: boolean
  /** Attention style for unconfigured sections. */
  attention?: boolean
  /** Persistent state banner text (e.g. "Connected"). */
  banner?: string
  /** Header-right pane actions. */
  actions?: ReactNode
}

export function SectionCard({
  id,
  title,
  description,
  children,
  onSave,
  showSave,
  saveIsMain = true,
  attention,
  banner,
  actions,
}: SectionCardProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { notifySaved, notifySaveFailed } = useSettingsSaved()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!onSave) return
    setSaving(true)
    setError(null)
    try {
      await onSave()
      notifySaved()
    } catch (err) {
      const message = saveErrorMessage(err)
      setError(message)
      notifySaveFailed(message)
    } finally {
      setSaving(false)
    }
  }

  const hasSaveButton = showSave ?? !!onSave

  return (
    <SettingsSection
      as="form"
      id={id}
      title={title}
      description={description}
      actions={actions}
      onSubmit={handleSubmit}
      {...(attention ? { className: 'settings-card-attention' } : {})}
      {...(banner
        ? { banner: <div className="settings-banner settings-banner-success">{banner}</div> }
        : {})}
      footer={
        <>
          {error && (
            <SettingsNotice kind="error" role="alert">
              Couldn't save: {error}
            </SettingsNotice>
          )}
          {hasSaveButton && (
            <div className="form-actions settings-form-actions">
              <SettingsButton
                type="submit"
                variant={saveIsMain ? 'primary' : 'default'}
                busy={saving}
                busyLabel="Saving..."
                disabled={!onSave}
              >
                Save
              </SettingsButton>
            </div>
          )}
        </>
      }
    >
      {children}
    </SettingsSection>
  )
}
