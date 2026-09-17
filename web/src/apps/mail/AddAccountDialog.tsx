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
import {
  mailFailure,
  type AccountSetupField,
  type AccountSetupPreset,
  type MailProviderSummary,
} from '@/api/mail';
import { log } from '@/utils/log';
import { addMailAccount } from './mail-actions';
import {
  addressFieldName,
  OTHER_PRESET_ID,
  safeHelpUrl,
  unknownPresetKeys,
  withAutoPreset,
  withChosenPreset,
  withTyped,
  type PresetState,
} from './setup-presets';

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

function initialState(fields: AccountSetupField[]): PresetState {
  return { values: initialValues(fields), edited: [], chosen: null };
}

export function AddAccountDialog({ providers, onClose, onAdded }: Props) {
  useModalOverlay(onClose);
  // One provider means there is nothing to choose: skip the picker entirely.
  const [providerId, setProviderId] = useState(providers.length === 1 ? providers[0]!.id : '');
  const provider = useMemo(
    () => providers.find((one) => one.id === providerId),
    [providers, providerId],
  );
  const [state, setState] = useState<PresetState>(
    () => initialState(providers.length === 1 ? providers[0]!.setupFields : []),
  );
  const values = state.values;
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
    setState(initialState(next.setupFields));
    setFailure(null);
  };

  const fields = provider?.setupFields ?? [];
  const presets = provider?.setupPresets ?? [];
  const chosenPreset = presets.find((one) => one.id === state.chosen);
  // The service's credential sentence belongs under the credential. A provider that declares
  // presets but no password field still has to show it somewhere, so it falls to the last field,
  // and to the chip row itself when there are no fields at all (see the form below): "renders
  // nowhere" is the one outcome this must not have.
  const helpAfter = (fields.find((field) => field.kind === 'password') ?? fields.at(-1))?.name;
  const missing = fields.some((field) => field.required && !values[field.name]?.trim());

  // A preset naming a field this form does not have fills nothing the human can see, so the
  // provider's mistake is reported rather than looking like a dead chip. Keyed on the joined
  // names, not on the provider object: the accounts poll hands this dialog a new row object
  // every few seconds, and an effect keyed on that would log the same line forever.
  const unknownKeys = unknownPresetKeys(fields, presets).join(',');
  useEffect(() => {
    if (!providerId || !unknownKeys) return;
    log.warn('mail', 'setup preset names fields this provider does not declare', {
      providerId, unknown: unknownKeys,
    });
  }, [providerId, unknownKeys]);

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

            {presets.length > 0 && (
              <PresetChips
                presets={presets}
                chosen={state.chosen}
                onChoose={(id) => setState((prev) => withChosenPreset(prev, presets, id))}
              />
            )}

            {/* No fields to sit under, so it sits with the chips. `helpAfter` is undefined here. */}
            {fields.length === 0 && chosenPreset?.help && <PresetHelp preset={chosenPreset} />}

            {fields.map((field, index) => (
              <div className="mail-setup-row" key={field.name}>
                <SetupField
                  field={field}
                  value={values[field.name] ?? ''}
                  supersededBy={field.name === helpAfter && !!chosenPreset?.help}
                  inputRef={index === 0 ? firstFieldRef : undefined}
                  onChange={(next) => setState((prev) => {
                    const typed = withTyped(prev, field.name, next);
                    // Only typing into the ADDRESS auto-picks a service, and which field that is
                    // comes from the spec rather than from a name this file assumes.
                    return addressFieldName(fields, typed.values) === field.name
                      ? withAutoPreset(typed, presets, next)
                      : typed;
                  })}
                />
                {/* Outside the field's own label: a link inside a <label> is a link whose click
                    also focuses the input it sits in. */}
                {field.name === helpAfter && chosenPreset?.help && (
                  <PresetHelp preset={chosenPreset} />
                )}
              </div>
            ))}

            {failure && (
              <div className="mail-setup-error" data-testid="mail-add-error">
                {/* The generic hint only when nothing more specific is on screen. With a service
                    chosen, its own sentence IS the credential sentence, and the two can flatly
                    contradict each other: Outlook.com's says an app password is refused, while this
                    one says the credential must be an app password. Two sentences disagreeing about
                    the same field is worse than either alone. */}
                {failure.status === 401 && !chosenPreset?.help && (
                  <p className="mail-setup-error-lead">{AUTH_HINT}</p>
                )}
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

/**
 * The known services, as one row of chips above the form.
 *
 * A radiogroup rather than buttons, because that is what it is: exactly one service applies to an
 * account, and "Other" is a real member of the group (it means "do not guess", not "cancel").
 *
 * The group is labelled BY the visible heading (`aria-labelledby`) rather than with an
 * `aria-label` of its own: two different names for one control is what makes a screen reader
 * announce something nobody on the call can find on screen.
 */
function PresetChips({ presets, chosen, onChoose }: {
  presets: AccountSetupPreset[];
  chosen: string | null;
  onChoose: (id: string) => void;
}) {
  return (
    <div className="mail-setup-field">
      <span className="mail-setup-label" id="mail-preset-row-label">Which service is this?</span>
      <span className="mail-setup-options" role="radiogroup" aria-labelledby="mail-preset-row-label">
        {[...presets, { id: OTHER_PRESET_ID, label: 'Other', values: {} }].map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={`mail-setup-option${preset.id === chosen ? ' active' : ''}`}
            data-testid={`mail-preset-${preset.id === OTHER_PRESET_ID ? 'other' : preset.id}`}
            role="radio"
            aria-checked={preset.id === chosen}
            onClick={() => onChoose(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </span>
      <span className="mail-setup-help">
        Picking one fills the server details. Typing your address picks it for you, and anything you
        have typed yourself is left alone.
      </span>
    </div>
  );
}

/**
 * The chosen service's own sentence about its credential, with the vendor's page behind it.
 *
 * The link text is deliberately NOT "app passwords": four of the five IMAP services want one and
 * Outlook.com no longer accepts one at all, so a label the console assembles would describe the
 * wrong thing for whichever service is the exception. What the page says is the provider's to word,
 * in `help`; this only names whose page it is.
 */
/**
 * The credential sentence, and the steps that get you one.
 *
 * ONE sentence, always: a second line saying the same thing another way is how somebody on
 * Outlook.com was told "this must be an app password" directly under "an app password is refused".
 * The steps are not a second sentence, they are the actions, and they only exist when the provider
 * declared them. When they do, the trailing "setup help" link stands down: the same page is now
 * step two, where it is next to the thing it is for.
 */
function PresetHelp({ preset }: { preset: AccountSetupPreset }) {
  // Checked, not trusted: these urls come from a provider plugin and land in an href. A refused
  // scheme renders the text with no link rather than an href a click would execute.
  const href = safeHelpUrl(preset.helpUrl);
  const steps = (preset.steps ?? []).map((step) => ({ ...step, href: safeHelpUrl(step.url) }));
  return (
    <div className="mail-setup-preset-help" data-testid="mail-preset-help">
      <p className="mail-setup-preset-line">
        {preset.help}
        {href && steps.length === 0 && (
          <>
            {' '}
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="mail-preset-help-link"
            >
              {preset.label} setup help
            </a>
          </>
        )}
      </p>
      {steps.length > 0 && (
        <ol className="mail-setup-steps" data-testid="mail-preset-steps">
          {steps.map((step, index) => (
            <li key={`${index}-${step.text}`}>
              {step.href
                ? (
                  <a
                    href={step.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="mail-preset-step-link"
                  >
                    {step.text}
                  </a>
                )
                : step.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function SetupField({ field, value, inputRef, onChange, supersededBy }: {
  field: AccountSetupField;
  value: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange: (next: string) => void;
  /**
   * A chosen service's own sentence sits right under this field, so its GENERIC help stands down.
   *
   * "Use an app password, never your main account password" is the right thing to say to somebody
   * on Other, and noise directly above "Gmail refuses your normal account password here" followed
   * by the three steps that get one: the same instruction three times, each slightly reworded, is
   * read twice and trusted less. The generic line comes straight back when no service is chosen.
   */
  supersededBy?: boolean;
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
      {field.help && !supersededBy && <span className="mail-setup-help">{field.help}</span>}
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
