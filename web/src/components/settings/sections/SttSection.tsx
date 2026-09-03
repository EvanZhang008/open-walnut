import { useState, useEffect } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SttDetectionPanel } from './SttDetectionPanel';
import { invalidateSttStatusCache } from '@/hooks/useSttStatus';
import { useAutoSave } from '@/hooks/useAutoSave';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  onReload?: () => void;
}

/**
 * Voice, both directions: dictation in (the STT engine + language) and read-aloud
 * out (TTS provider + voice, formerly a collapsible under Integrations). The
 * section id stays `stt` — the mic button and the install spec deep-link to it.
 */
export function SttSection({ config, onSave, onReload }: Props) {
  const handleConfigured = () => {
    invalidateSttStatusCache();
    onReload?.();
  };

  const [ttsProvider, setTtsProvider] = useState(config.tools?.tts?.provider ?? '');
  const [ttsVoice, setTtsVoice] = useState(config.tools?.tts?.voice ?? '');

  useEffect(() => {
    setTtsProvider(config.tools?.tts?.provider ?? '');
    setTtsVoice(config.tools?.tts?.voice ?? '');
  }, [config]);

  const saveTts = async () => {
    await onSave({
      tools: {
        ...config.tools,
        tts: {
          ...config.tools?.tts,
          provider: ttsProvider || undefined,
          voice: ttsVoice || undefined,
        },
      },
    });
  };

  useAutoSave({
    current: JSON.stringify({ ttsProvider, ttsVoice }),
    baseline: JSON.stringify({
      ttsProvider: config.tools?.tts?.provider ?? '',
      ttsVoice: config.tools?.tts?.voice ?? '',
    }),
    save: saveTts,
  });

  return (
    <SectionCard
      id="stt"
      title="Voice"
      description="Dictate into any text field with the microphone button, and let Walnut read replies aloud. Changes save automatically."
    >
      <SttDetectionPanel
        config={config}
        onSave={onSave}
        onConfigured={handleConfigured}
      />

      <div className="settings-divider" />

      <details className="settings-collapsible">
        <summary className="settings-collapsible-title">Text-to-Speech</summary>
        <div className="settings-collapsible-body">
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="tts-provider">Provider</label>
              <input
                id="tts-provider"
                type="text"
                value={ttsProvider}
                onChange={(e) => setTtsProvider(e.target.value)}
                placeholder="e.g., say"
              />
            </div>
            <div className="form-group">
              <label htmlFor="tts-voice">Voice</label>
              <input
                id="tts-voice"
                type="text"
                value={ttsVoice}
                onChange={(e) => setTtsVoice(e.target.value)}
                placeholder="e.g., Samantha"
              />
            </div>
          </div>
        </div>
      </details>
    </SectionCard>
  );
}
