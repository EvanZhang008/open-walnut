/**
 * The one line the Voice pane keeps for its scan of this Mac (N3-05): the
 * loading line is replaced IN PLACE by what the scan found, so the rows
 * below never move and the scan never ends in silence. Pure, unit tested.
 */
import type { DetectionResult } from '@/api/stt';

export function sttScanSummary(d: DetectionResult): string {
  const engines: string[] = [];
  if (d.whisperCli.found) engines.push('whisper-cli');
  if (d.whisperServer?.found) engines.push('whisper-server');
  if (d.sherpaOnnxNode?.found) engines.push('Sherpa-ONNX');
  if (engines.length === 0) return 'No dictation engine found on this Mac.';
  const models = d.models.length;
  const tail = models > 0 ? `, ${models} Whisper model${models === 1 ? '' : 's'}` : '';
  return `Found ${engines.join(', ')}${tail}.`;
}
