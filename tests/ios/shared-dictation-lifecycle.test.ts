import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = join(import.meta.dirname, '../../ios-native/Walnut');
const read = (file: string) => readFileSync(join(app, file), 'utf8');

describe('shared iOS dictation lifecycle', () => {
  it('keys recorder state and gate membership to the destination object', () => {
    const source = read('Views/Shared/VoiceDictation.swift');
    expect(source).toContain('private struct VoiceDictationBody');
    expect(source).toContain('.id(surface)');
    expect(source).toContain('.joinsSendGate(sendGate, voice: voice, key: surface)');
    expect(source).toContain('voice.restrictRecoveryToSurface = true');
    expect(source).toContain('voice.preserveAndStop(reason: "view-dismissed")');
  });

  it('allows the thread Send to wait even when the draft is empty', () => {
    // The thread's Follow up is the shared reply box on its card, with Walnut's mic.
    expect(read('Views/Org/OrgThreadsView.swift')).toContain('voiceBox: "thread-follow-up"');
    const box = read('Views/Shared/ReplyBox.swift');
    expect(box).toContain('surface: draftKey, box: voiceBox');
    expect(box).toContain('gate.send { waited in send(waited: waited) }');
    expect(box).toContain('gate.isDictating || gate.isWaiting');
    expect(box).toContain('.dictationSendGate(gate)');
  });

  it('marks newly dictated roots covered without covering their pushed destinations', () => {
    const task = read('Views/Tasks/TaskDetailSheet.swift');
    const selector = read('Views/Inbox/InboxItemTaskSelector.swift');
    for (const source of [task, selector]) expect(source).toContain('@Environment(\\.composerCovered) private var coveredByHost');
    expect(task).toContain('.environment(\\.composerCovered, coveredByHost || !navPath.isEmpty)');
    expect(selector).toContain('.environment(\\.composerCovered, coveredByHost || preview != nil)');
    for (const source of [task, selector]) {
      const cover = source.indexOf('.environment(\\.composerCovered,');
      const push = source.indexOf('.navigationDestination(');
      expect(cover).toBeGreaterThan(0);
      expect(cover).toBeLessThan(push);
    }
    // Root-only coverage must not flow into the active destination's composer.
    expect(task).toMatch(/SessionConversationView\(session: session\)\s*\}/);
    expect(selector).toMatch(/InboxItemTaskPreview\([^\n]+\)\s*\}/);
  });

  it('keeps the UI-test capture silent and unavailable to phone/release builds', () => {
    const source = read('Core/DebugDictationCapture.swift');
    expect(source).toMatch(/^#if DEBUG && targetEnvironment\(simulator\)/);
    expect(source).toContain('arguments.contains("-walnut.uiTestKeychain")');
    expect(source).toContain('bool(forKey: "walnut.silentAudio")');
    expect(source).toContain('uploadOverride =');
    expect(source).toContain('_testBeginTake(');
    const code = source.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/AVAudioSession|AVAudioRecorder|AVAudioPlayer|activateSession|\.play\(/);
    expect(read('Core/VoiceRecorder.swift')).toContain('#if DEBUG && targetEnvironment(simulator)\n        if let started = beginSilentUITestTake()');
    expect(read('Core/VoiceRecorder.swift')).toContain('if isSilentUITestDictation { return }\n        #endif\n        AudioSessionHandoff.deactivateOffMain()');
  });
});
