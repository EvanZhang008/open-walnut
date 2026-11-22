import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { SttDetectionPanel, sttDraftOf, type SttDraft } from './SttDetectionPanel';
import { useSerialSave, type OnSave } from './GeneralSection';
import { invalidateSttStatusCache } from '@/hooks/useSttStatus';
import { VoiceHistoryList } from '@/components/common/VoiceHistoryList';
import { useExperimental } from '@/hooks/useExperimental';
import { SecretInput } from '../inputs/SecretInput';

interface Props {
  config: Config;
  onSave: OnSave;
  onReload?: () => void;
}

/** Dictation's drafts plus the key of the voice that reads answers aloud (tts, src/core/tts/). */
type VoiceDraft = SttDraft & { elevenlabsKey: string };

const draftOf = (config: Config): VoiceDraft => ({ ...sttDraftOf(config), elevenlabsKey: config.tts?.elevenlabs_api_key ?? '' });

const SPOKEN_HELP = 'Voice conversation reads answers aloud with ElevenLabs when a key is set here (elevenlabs.io > Developers > API keys; the free plan covers about 20,000 characters a month with the default model). Without a key, this device\'s own voice reads them.';

/** stt.pause_media: on unless turned off (src/core/stt/media-hold.ts). Saves at once. */
function PauseMusicRow({ config, onSave }: { config: Config; onSave: OnSave }) {
  const save = useSerialSave(config, onSave);
  const setting = useOptimisticSetting(config.stt?.pause_media !== false,
    (on: boolean) => save((c) => ({ stt: { ...c.stt, pause_media: on } as Config['stt'] }), { rowKey: 'stt.pause_media' }),
    { rowKey: 'stt.pause_media' });
  return <SettingsRow label="Pause music while you dictate" htmlFor="stt-pause-media" error={setting.error}
    help="Pauses music and video on this Mac while you dictate, then plays again only what Walnut paused."
    control={<ToggleSwitch id="stt-pause-media" data-testid="stt-pause-media" checked={setting.value} busy={setting.busy} onChange={setting.set} />} />;
}

/**
 * Voice: the recent recordings (every take, to copy or redo) and Dictation
 * (the STT engine, its models, the language). The only settings form with an explicit Save: the
 * drafts below are committed together by Save (or Cmd+S); an engine pick, a
 * model activation or a model path save at once. A draft still unsaved when
 * the pane closes or the page hides is saved then, never dropped. The section
 * id stays `stt`: the mic button and the install spec deep-link to it.
 */
export function SttSection({ config, onSave, onReload }: Props) {
  const [draft, setDraft] = useState<VoiceDraft>(() => draftOf(config));
  const voiceConversation = useExperimental('voice_conversation');
  const dirty = useRef(false);
  // Mirrors `dirty` for the render: Save is the page's main action only while a draft is unsaved,
  // so it never competes with "Set up" for the one blue key.
  const [unsaved, setUnsaved] = useState(false);
  const save = useSerialSave(config, onSave);
  // A config refresh (our own save, another window) re-seeds the drafts only
  // while nothing is being edited here.
  useEffect(() => {
    if (!dirty.current) setDraft(draftOf(config));
  }, [config]);
  const onDraft = (patch: Partial<VoiceDraft>) => {
    dirty.current = true;
    setUnsaved(true);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const handleConfigured = () => {
    invalidateSttStatusCache();
    onReload?.();
  };

  const handleSave = async () => {
    dirty.current = false;
    setUnsaved(false);
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
      // Only a changed key is written: the field holds the masked value read back otherwise.
      ...(draft.elevenlabsKey !== (c.tts?.elevenlabs_api_key ?? '')
        ? { tts: { ...c.tts, elevenlabs_api_key: draft.elevenlabsKey || undefined } as Config['tts'] }
        : {}),
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
    <SectionCard id="stt" title="Voice" onSave={handleSave} saveIsMain={unsaved}>
      {/* Every take is kept on the server, so a lost reply is never lost words. */}
      <SettingsGroup heading="Recent recordings" id="voice-history" data-testid="stt-recordings">
        <VoiceHistoryList />
      </SettingsGroup>
      <SettingsGroup heading="Dictation" data-testid="stt-dictation">
        <SttDetectionPanel config={config} onSave={onSave} onConfigured={handleConfigured} draft={draft} onDraft={onDraft} />
      </SettingsGroup>
      <SettingsGroup heading="While you dictate" data-testid="stt-while-dictating">
        <PauseMusicRow config={config} onSave={onSave} />
      </SettingsGroup>
      {voiceConversation && (
        <SettingsGroup heading="Spoken answers" data-testid="voice-spoken-answers">
          <SettingsRow label="ElevenLabs API key" htmlFor="tts-elevenlabs-key" help={SPOKEN_HELP} control={
            <SecretInput id="tts-elevenlabs-key" data-testid="tts-elevenlabs-key" value={draft.elevenlabsKey} onChange={(v) => onDraft({ elevenlabsKey: v })} placeholder="sk_..." />
          } />
        </SettingsGroup>
      )}
    </SectionCard>
  );
}
