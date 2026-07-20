import { useState, useCallback } from 'react';

export type InstallTarget = 'claude-cli' | 'ollama';

const INSTALL_COMMANDS: Record<InstallTarget, string> = {
  'claude-cli': 'npm install -g @anthropic-ai/claude-code',
  ollama: 'brew install ollama',
};

interface InstallButtonProps {
  target: InstallTarget;
  label?: string;
  className?: string;
}

type State = 'idle' | 'copied' | 'error';

export function InstallButton({ target, label = 'Copy install command', className = '' }: InstallButtonProps) {
  const [state, setState] = useState<State>('idle');

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMANDS[target]);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('error');
    }
  }, [target]);

  return (
    <span className={`install-btn-wrap ${className}`}>
      <button
        className={`install-btn${state === 'error' ? ' install-btn--error' : ''}`}
        onClick={handleClick}
        title={INSTALL_COMMANDS[target]}
      >
        {state === 'copied' ? '\u2713 Copied' : state === 'error' ? 'Copy failed' : label}
      </button>
    </span>
  );
}
