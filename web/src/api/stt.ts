/**
 * STT (Speech-to-Text) API client.
 */

import { apiGet, apiPost, apiDelete } from './client';

export interface TranscribeResult {
  text: string;
  durationMs: number;
  debugAudioPath?: string;
  /** Server-side stored recording id — audio survives even if this response is lost */
  recordingId?: string;
}

export interface VoiceRecording {
  id: string;
  timestamp: string;
  format: string;
  language: string;
  audioSizeBytes: number;
  /** Engine that produced `result` (e.g. "mlx", "whisper-server") */
  engine?: string;
  result?: { text: string; durationMs: number };
  error?: string;
  /** Shadow engine's take on the same audio (stt.secondary_engine A/B) */
  secondary?: { engine: string; text?: string; durationMs?: number; error?: string };
}

export interface SttStatus {
  engine: string | null;
  available: boolean;
  error?: string;
}

export interface DetectionItem {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface GgmlModel {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface Recommendation {
  engine: 'whisper-cpp' | 'sherpa-onnx' | 'openai';
  reason: string;
  modelPath?: string;
  missingSteps: string[];
}

export interface DetectionResult {
  ffmpeg: DetectionItem;
  whisperCli: DetectionItem;
  whisperServer: DetectionItem;
  sherpaOnnxNode: DetectionItem;
  homebrew: DetectionItem;
  models: GgmlModel[];
  recommendation: Recommendation | null;
}

export interface SetupEvent {
  type: 'progress' | 'log' | 'done' | 'error';
  message?: string;
  percent?: number;
  path?: string;
}

export interface ModelCatalogEntry {
  name: string;
  displayName: string;
  label: string;
  filename: string;
  sizeBytes: number;
  description: string;
  languageNote: string;
}

export interface AutoConfigResult {
  success: boolean;
  engine: string;
  config: Record<string, string>;
  status: { available: boolean; error?: string };
}

/**
 * Transcribe audio via server STT engine.
 * Uses a 120s timeout (longer than the default 15s) because
 * local engines may need time for first-load model init.
 */
export async function transcribeAudio(
  audioBase64: string,
  format: string,
  language?: string,
  /** Optional model override — retry with a specific ggml model via whisper-cli */
  model?: string,
): Promise<TranscribeResult> {
  const res = await fetch('/api/stt/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: audioBase64, format, language, model }),
    signal: AbortSignal.timeout(120_000), // longer timeout for retry with slower models
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch { /* use statusText */ }
    throw new Error(message);
  }
  return res.json();
}

// ── Vocabulary ──

export function fetchVocab(): Promise<{ words: string[]; path: string }> {
  return apiGet<{ words: string[]; path: string }>('/api/stt/vocab');
}

export function addVocabWord(word: string): Promise<{ added: boolean; word: string; reason?: string }> {
  return apiPost<{ added: boolean; word: string; reason?: string }>('/api/stt/vocab', { word });
}

export function fetchSttStatus(): Promise<SttStatus> {
  return apiGet<SttStatus>('/api/stt/status');
}

// ── Voice recording history (server-side, survives lost responses) ──

export function fetchRecordings(limit = 20): Promise<{ recordings: VoiceRecording[] }> {
  return apiGet<{ recordings: VoiceRecording[] }>(`/api/stt/recordings?limit=${limit}`);
}

/** Re-transcribe a stored recording server-side (audio read from disk). */
export function retranscribeRecording(id: string, language?: string): Promise<TranscribeResult> {
  return apiPost<TranscribeResult>(`/api/stt/recordings/${encodeURIComponent(id)}/transcribe`, { language });
}

export function fetchSttDetection(): Promise<DetectionResult> {
  return apiGet<DetectionResult>('/api/stt/detect');
}

/**
 * Start a setup action (brew install or model download) via SSE.
 * Returns an EventSource-like reader that yields SetupEvents.
 */
export async function startSetup(
  action: string,
  params: Record<string, string>,
  onEvent: (event: SetupEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/stt/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
    signal: signal ?? AbortSignal.timeout(1800_000), // 30 min for large downloads
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch { /* use statusText */ }
    onEvent({ type: 'error', message });
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    onEvent({ type: 'error', message: 'No response body' });
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep incomplete last line

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const event = JSON.parse(line.slice(6)) as SetupEvent;
          onEvent(event);
        } catch { /* skip malformed */ }
      }
    }
  }

  // Process any remaining buffer
  if (buffer.startsWith('data: ')) {
    try {
      const event = JSON.parse(buffer.slice(6)) as SetupEvent;
      onEvent(event);
    } catch { /* skip */ }
  }
}

export function autoConfigStt(): Promise<AutoConfigResult> {
  return apiPost<AutoConfigResult>('/api/stt/auto-config');
}

export function deleteModel(name: string): Promise<void> {
  return apiDelete(`/api/stt/models/${encodeURIComponent(name)}`);
}

export function activateModel(model: string, engine?: 'whisper-cpp' | 'whisper-server'): Promise<{ activated: string; path: string }> {
  return apiPost<{ activated: string; path: string }>('/api/stt/activate-model', { model, engine });
}

// ── Sherpa-onnx model catalog ──────────────────────────

export interface SherpaModelCatalogEntry {
  name: string;
  displayName: string;
  modelType: 'sense_voice' | 'whisper' | 'paraformer';
  description: string;
  languageNote: string;
  sizeBytes: number;
}

export const SHERPA_MODEL_CATALOG: SherpaModelCatalogEntry[] = [
  { name: 'sense-voice-zh-en', displayName: 'SenseVoice (zh/en/ja/ko)', modelType: 'sense_voice', description: 'Best multilingual, fast & accurate', languageNote: 'zh, en, ja, ko, yue', sizeBytes: 84_000_000 },
  { name: 'paraformer-zh', displayName: 'Paraformer (Chinese)', modelType: 'paraformer', description: 'Fast Chinese transcription', languageNote: 'Chinese', sizeBytes: 232_000_000 },
  { name: 'whisper-tiny.en', displayName: 'Whisper Tiny (English)', modelType: 'whisper', description: 'Tiny English-only, very fast', languageNote: 'English only', sizeBytes: 60_000_000 },
  { name: 'whisper-base.en', displayName: 'Whisper Base (English)', modelType: 'whisper', description: 'Good English accuracy', languageNote: 'English only', sizeBytes: 120_000_000 },
];

export function activateSherpaModel(model: string): Promise<{ activated: string; path: string; modelType: string }> {
  return apiPost<{ activated: string; path: string; modelType: string }>('/api/stt/activate-sherpa', { model });
}

export function deleteSherpaModel(name: string): Promise<void> {
  return apiDelete(`/api/stt/sherpa-models/${encodeURIComponent(name)}`);
}

export function fetchSherpaModels(): Promise<{ models: { name: string; dirName: string; path: string }[] }> {
  return apiGet<{ models: { name: string; dirName: string; path: string }[] }>('/api/stt/sherpa-models');
}

/** Known model catalog — mirrored from server for UI display */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  { name: 'ggml-tiny', displayName: 'Tiny', label: 'Tiny (75 MB)', filename: 'ggml-tiny.bin', sizeBytes: 75_000_000, description: 'Fastest, basic accuracy', languageNote: 'Multilingual' },
  { name: 'ggml-tiny.en', displayName: 'Tiny (English)', label: 'Tiny English (75 MB)', filename: 'ggml-tiny.en.bin', sizeBytes: 75_000_000, description: 'Fastest, English optimized', languageNote: 'English only' },
  { name: 'ggml-base', displayName: 'Base', label: 'Base (142 MB)', filename: 'ggml-base.bin', sizeBytes: 142_000_000, description: 'Fast, good for general use', languageNote: 'Multilingual' },
  { name: 'ggml-base.en', displayName: 'Base (English)', label: 'Base English (148 MB)', filename: 'ggml-base.en.bin', sizeBytes: 148_000_000, description: 'Fast, English optimized', languageNote: 'English only' },
  { name: 'ggml-small', displayName: 'Small', label: 'Small (466 MB)', filename: 'ggml-small.bin', sizeBytes: 466_000_000, description: 'Good accuracy, balanced speed', languageNote: 'Multilingual' },
  { name: 'ggml-small.en', displayName: 'Small (English)', label: 'Small English (466 MB)', filename: 'ggml-small.en.bin', sizeBytes: 466_000_000, description: 'Good accuracy, English optimized', languageNote: 'English only' },
  { name: 'ggml-medium', displayName: 'Medium', label: 'Medium (1.5 GB)', filename: 'ggml-medium.bin', sizeBytes: 1_500_000_000, description: 'Balanced speed and accuracy', languageNote: 'Multilingual' },
  { name: 'ggml-medium.en', displayName: 'Medium (English)', label: 'Medium English (1.5 GB)', filename: 'ggml-medium.en.bin', sizeBytes: 1_500_000_000, description: 'Balanced speed and accuracy, English optimized', languageNote: 'English only' },
  { name: 'ggml-large-v2', displayName: 'Large v2', label: 'Large v2 (3 GB)', filename: 'ggml-large-v2.bin', sizeBytes: 3_000_000_000, description: 'High accuracy, slower', languageNote: 'Multilingual' },
  { name: 'ggml-large-v3-turbo', displayName: 'Large v3 Turbo', label: 'Large v3 Turbo (1.6 GB)', filename: 'ggml-large-v3-turbo.bin', sizeBytes: 1_600_000_000, description: 'Best accuracy, distilled for speed', languageNote: 'Multilingual' },
];
