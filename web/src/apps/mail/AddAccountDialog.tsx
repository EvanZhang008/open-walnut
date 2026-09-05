/**
 * Add an account, rendered entirely from the provider's declared `setupFields`.
 *
 * The console knows nothing about any provider's form: no IMAP hostnames, no port defaults, no
 * OAuth. It draws the fields the `/providers` row declares and posts the values back. That is
 * what lets a provider plugin ship a new field without a change here, and it is why the values
 * are never kept: they go to the provider, which owns its config and its secret, so a password
 * exists in exactly one place.
 *
 * A refusal KEEPS THE FORM with what was typed. A dialog that closes on a wrong password makes
 * the human retype every field to find out which one was wrong, and the most common failure here
 * is one that a sentence can fix (a main password where the provider wants an app password).
 *
 * Overlay rules (web/src/AGENTS.md): portalled to body, clamped by `.app-modal` plus a max
 * height of its own, Escape and outside mousedown close it, and pointer events stop at the modal
 * so nothing behind it can treat the gesture as a drag. The provider picker and the select field
 * render INSIDE the dialog rather than as their own portals, so there is no child portal for an
 * outside-click check to exempt.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { mailFailure, type AccountSetupField, type MailProviderSummary } from '@/api/mail';
import { log } from '@/utils/log';
import { addMailAccount } from './mail-actions';

interface Props {
  providers: MailProviderSummary[];
  onClose: () => void;
  onAdded: () => void;
}

/** The one sentence that fixes the most common refusal, in the one place it is useful. */
const AUTH_HINT = 'The server refused the credentials. For most providers this must be an app'
  + ' password, not your main password.';

function initialValues(fields: AccountSetupField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    values[field.name] = field.kind === 'select' ? field.options?.[0]?.value ?? '' : '';
  }
  return values;
}

export function AddAccountDialog({ providers, onClose, onAdded }: Props) {
  useModalOverlay(onClose);
  // One provider means there is nothing to choose: skip the picker entirely.
  const [providerId, setProviderId] = useState(providers.length === 1 ? providers[0]!.id : '');
  const provider = useMemo(
    () => providers.find((one) => one.id === providerId),
    [providers, providerId],
  );
  const [values, setValues] = useState<Record<string, string>>(
    () => initialValues(providers.length === 1 ? providers[0]!.setupFields : []),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ status: number; message: string } | null>(null);

  // Focus the first field, ConfirmDialog's convention (a tick, because the portal has to mount
  // first). Re-runs when a provider is picked, since that is when the form appears.
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => firstFieldRef.current?.focus(), 10);
    return () => clearTimeout(timer);
  }, [providerId]);

  const pickProvider = (next: MailProviderSummary) => {
    setProviderId(next.id);
    setValues(initialValues(next.setupFields));
    setFailure(null);
  };

  const fields = provider?.setupFields ?? [];
  const missing = fields.some((field) => field.required && !values[field.name]?.trim());

  const submit = async () => {
    if (!provider || busy || missing) return;
    setBusy(true);
    setFailure(null);
    try {
      await addMailAccount(provider.id, values);
      onAdded();
    } catch (error) {
      const reason = mailFailure(error);
      // The values are never logged: this is a credential form.
      log.warn('mail', 'account setup refused', { providerId: provider.id, status: reason.status, code: reason.code });
      setFailure({ status: reason.status, message: reason.message });
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    // The dialog ROLE belongs on the dialog, not on the backdrop: with it on the overlay, the
    // scrim is the dialog as far as assistive tech is concerned, and everything inside is
    // "content of the backdrop".
    <div className="app-modal-overlay" onMouseDown={onClose}>
      <div
        className="app-modal mail-add-dialog"
        data-testid="mail-add-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add a mail account"
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="app-modal-title">Add a mail account</div>

        {!provider ? (
          <div className="mail-provider-picker">
            <p className="app-modal-message">Which provider holds this account?</p>
            {providers.map((one) => (
              <button
                type="button"
                className="mail-provider-option"
                key={one.id}
                data-testid="mail-provider-option"
                data-provider-id={one.id}
                onClick={() => pickProvider(one)}
              >
                <span className="mail-provider-label">{one.label}</span>
                <span className="mail-provider-note">
                  {one.capabilities.bodies === 'text' ? 'Plain text bodies' : 'HTML and text bodies'}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <form
            className="mail-setup-form"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}
          >
            {providers.length > 1 && (
              <button
                type="button"
                className="mail-text-btn mail-provider-back"
                onClick={() => { setProviderId(''); setFailure(null); }}
              >
                {provider.label}: change provider
              </button>
            )}

            {fields.length === 0 && (
              <p className="app-modal-message">
                This provider needs no details here. It adds its accounts by itself.
              </p>
            )}

            {fields.map((field, index) => (
              <SetupField
                key={field.name}
                field={field}
                value={values[field.name] ?? ''}
                inputRef={index === 0 ? firstFieldRef : undefined}
                onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
              />
            ))}

            {failure && (
              <div className="mail-setup-error" data-testid="mail-add-error">
                {failure.status === 401 && <p className="mail-setup-error-lead">{AUTH_HINT}</p>}
                <p className="mail-setup-error-detail">{failure.message}</p>
              </div>
            )}

            <div className="app-modal-actions">
              <button type="button" className="app-modal-btn" onClick={onClose}>Cancel</button>
              <button
                type="submit"
                className="app-modal-btn primary"
                data-testid="mail-add-submit"
                disabled={busy || missing}
              >
                {busy ? 'Checking…' : 'Add account'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

function SetupField({ field, value, inputRef, onChange }: {
  field: AccountSetupField;
  value: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange: (next: string) => void;
}) {
  const id = `mail-setup-${field.name}`;
  return (
    <label className="mail-setup-field" htmlFor={id}>
      <span className="mail-setup-label">
        {field.label}
        {field.required && <span className="mail-setup-required" aria-hidden="true">*</span>}
      </span>
      {field.kind === 'select' ? (
        <SelectField field={field} value={value} onChange={onChange} />
      ) : (
        <input
          id={id}
          ref={inputRef}
          className="app-modal-input mail-setup-input"
          data-testid={`mail-setup-${field.name}`}
          type={field.kind === 'password' ? 'password' : 'text'}
          value={value}
          placeholder={field.placeholder}
          autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.help && <span className="mail-setup-help">{field.help}</span>}
    </label>
  );
}

/**
 * A choice rendered as option ROWS, never a native `<select>`.
 *
 * Two reasons, both shipped incidents: a native popup looks foreign inside a styled overlay, and
 * on macOS it swallows the pointerup, so whatever is behind the dialog sees a held pointer. The
 * list is bounded by its own max height instead of growing the dialog.
 */
function SelectField({ field, value, onChange }: {
  field: AccountSetupField;
  value: string;
  onChange: (next: string) => void;
}) {
  const options = field.options ?? [];
  return (
    <span className="mail-setup-options" role="radiogroup" aria-label={field.label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={`mail-setup-option${option.value === value ? ' active' : ''}`}
          data-testid={`mail-setup-${field.name}-${option.value}`}
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}
