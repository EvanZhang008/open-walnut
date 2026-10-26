/**
 * The composer's mic for a rich (TipTap) editor: the same MicButton and recording
 * bar, with the words written the composer's way (useEditorDictation). Everything
 * the mic writes goes through editor transactions, so the editor's own save path
 * (autosave, dirty state, undo) treats it exactly like typed text.
 *
 * The owner may call `handleRef.current.clear()` when it saves and closes or
 * switches documents without remounting, so a transcription still on its way
 * never lands in the wrong place. Unmounting discards a live recording.
 */
import { useEffect, useImperativeHandle, useRef, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import { MicButton } from '@/components/common/MicButton';
import { useEditorDictation } from '@/hooks/useEditorDictation';

export interface EditorMicHandle {
  /** Stop and throw away a live recording, and forget the dictation spans. */
  clear: () => void;
}

export interface EditorMicProps {
  editor: Editor | null;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  handleRef?: RefObject<EditorMicHandle | null>;
}

export function EditorMic({ editor, disabled, size = 'sm', className, handleRef }: EditorMicProps) {
  const dictation = useEditorDictation(editor);
  const micControl = useRef<{ discard: () => void } | null>(null);
  useImperativeHandle(handleRef, () => ({
    clear: () => { micControl.current?.discard(); dictation.reset(); },
  }), [dictation]);
  // An editor that goes away takes its recording with it.
  useEffect(() => () => micControl.current?.discard(), []);
  // Only the mic itself starts a recording: its chevron and menu sit in the same wrapper.
  const onPress = (target: EventTarget) => {
    const mic = target instanceof Element ? target.closest('.mic-btn') : null;
    if (mic && !mic.classList.contains('mic-recording')) dictation.started();
  };
  return (
    <span
      className={className ? `editor-mic ${className}` : 'editor-mic'}
      onPointerDownCapture={(e) => { if (e.button === 0) onPress(e.target); }}
      onKeyDownCapture={(e) => { if (e.key === 'Enter' || e.key === ' ') onPress(e.target); }}
    >
      <MicButton
        size={size}
        onTranscribe={dictation.onTranscribe}
        onDraft={dictation.onDraft}
        onRefine={dictation.onRefine}
        controlRef={micControl}
        onSettled={dictation.settled}
        disabled={disabled || !editor}
        insertBox={() => (editor && !editor.isDestroyed ? editor.view.dom : null)}
      />
    </span>
  );
}
