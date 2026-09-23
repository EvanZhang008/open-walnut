import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SttDetectionPanel, sttDraftOf, type SttDraft } from './SttDetectionPanel';
import { useSerialSave, type OnSave } from './GeneralSection';
import { invalidateSttStatusCache } from '@/hooks/useSttStatus';

interface Props {
  config: Config;
  onSave: OnSave;
  onReload?: () => void;
}

type VoiceDraft = SttDraft & { ttsProvider: string; ttsVoice: string };

function draftOf(config: Config): VoiceDraft {
  return { ...sttDraftOf(config), ttsProvider: config.tools?.tts?.provider ?? '', ttsVoice: config.tools?.tts?.voice ?? '' };
}

/**
 * Voice, both directions: Dictation (the STT engine, its models, the language)
 * and Read aloud (TTS). The only settings form with an explicit Save: the
 * drafts below are committed together by Save (or Cmd+S); an engine pick, a
 * model activation or a model path save at once. A draft still unsaved when
 * the pane closes or the page hides is saved then, never dropped. The section
 * id stays `stt`: the mic button and the install spec deep-link to it.
 */
export function SttSection({ config, onSave, onReload }: Props) {
  const [draft, setDraft] = useState<VoiceDraft>(() => draftOf(config));
  const dirty = useRef(false);
  const save = useSerialSave(config, onSave);
  // A config refresh (our own save, another window) re-seeds the drafts only
  // while nothing is being edited here.
  useEffect(() => {
    if (!dirty.current) setDraft(draftOf(config));
  }, [config]);
  const onDraft = (patch: Partial<VoiceDraft>) => {
    dirty.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  };

  const handleConfigured = () => {
    invalidateSttStatusCache();
    onReload?.();
  };

  const handleSave = async () => {
    dirty.current = false;
    await save((c) => ({
      stt: {
        ...c.stt,
        language: draft.language || undefined,
        ...(c.stt?.engine === 'openai' ? {
          openai_api_key: draft.openaiApiKey || undefined,
          openai_base_url: draft.openaiBaseUrl || undefined,
          openai_model: draft.openaiModel || undefined,
        } : {}),
      } as Config['stt'],
      tools: {
        ...c.tools,
        tts: { ...c.tools?.tts, provider: draft.ttsProvider || undefined, voice: draft.ttsVoice || undefined },
      },
    }), { rowKey: 'stt.form' });
    invalidateSttStatusCache();
    handleConfigured();
  };

  // Every pane switch unmounts this section, so a pending draft is saved on the
  // way out (and when the page hides), like the autosaving panes.
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  useEffect(() => {
    const flush = () => { if (dirty.current) saveRef.current().catch(() => {}); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, []);

  return (
    <SectionCard id="stt" title="Voice" onSave={handleSave}>
      <SettingsGroup heading="Dictation" data-testid="stt-dictation">
        <SttDetectionPanel config={config} onSave={onSave} onConfigured={handleConfigured} draft={draft} onDraft={onDraft} />
      </SettingsGroup>
      <SettingsGroup heading="Read aloud" data-testid="stt-read-aloud">
        <SettingsRow label="Speech provider" help={<>The program that reads a reply aloud; <code>say</code> is the one built into macOS.</>} htmlFor="tts-provider" control={
          <input id="tts-provider" type="text" className="settings-input settings-input--short" placeholder="say"
            value={draft.ttsProvider} onChange={(e) => onDraft({ ttsProvider: e.target.value })} />
        } />
        <SettingsRow label="Voice" help="A voice name that program accepts; the Mac lists its voices under Spoken Content." htmlFor="tts-voice" control={
          <input id="tts-voice" type="text" className="settings-input settings-input--short" placeholder="Samantha"
            value={draft.ttsVoice} onChange={(e) => onDraft({ ttsVoice: e.target.value })} />
        } />
      </SettingsGroup>
    </SectionCard>
  );
}
