/**
 * ErrorSuggestionLink — Renders an actionable suggestion with a Settings deep-link
 * and optional install-command button.
 *
 * Usage:
 *   const sug = getErrorSuggestion(errorText, { host, provider });
 *   {sug && <ErrorSuggestionLink {...sug} />}
 */

import { useNavigate } from 'react-router-dom';
import { InstallButton } from './InstallButton';
import type { ErrorSuggestion } from '@/utils/error-suggestions';

export function ErrorSuggestionLink({ suggestion, settingsHash, settingsLabel, installTarget }: ErrorSuggestion) {
  const navigate = useNavigate();

  return (
    <div className="error-suggestion">
      <span className="error-suggestion-text">{suggestion}</span>
      {settingsHash && settingsLabel && (
        <button
          className="error-suggestion-link"
          onClick={() => navigate(`/settings#${settingsHash}`)}
        >
          {settingsLabel} &rarr;
        </button>
      )}
      {installTarget && (
        <InstallButton target={installTarget} label="Copy install command" className="error-suggestion-install" />
      )}
    </div>
  );
}
