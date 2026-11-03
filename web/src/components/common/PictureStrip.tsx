/**
 * The pieces a text box needs to take pictures the way the chat does (image-attachments.ts holds the
 * rules): the thumbnails of what will be sent, the attach button with its hidden file picker, and the
 * paste and drop handlers. AnswerBox uses them; so does every composer that keeps its own textarea.
 */
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { IMAGE_ACCEPT, pastedImageFiles, type ImageAttachments } from './image-attachments';
import '@/styles/picture-strip.css';

/** The pictures waiting to be sent, each with its ×; nothing when there are none. */
export function PictureStrip({ pictures, className, testId, readOnly }: {
  pictures: ImageAttachments;
  className?: string;
  testId?: string;
  readOnly?: boolean;
}) {
  if (pictures.images.length === 0) return null;
  return (
    <div className={`chat-image-previews picture-strip${className ? ` ${className}` : ''}`} data-testid={testId ?? 'picture-strip'}>
      {pictures.images.map((img, i) => (
        <div key={i} className="chat-image-preview">
          <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
          {!readOnly && (
            <button type="button" className="chat-image-remove" aria-label="Remove image" onClick={() => pictures.remove(i)}>&times;</button>
          )}
        </div>
      ))}
    </div>
  );
}

/** A paper-clip button that opens the file picker for pictures. */
export function AttachPictureButton({ pictures, disabled, className, testId }: {
  pictures: ImageAttachments;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const label = pictures.full ? 'Image limit reached' : 'Attach image';
  return (
    <>
      <button
        type="button"
        className={`picture-attach${className ? ` ${className}` : ''}`}
        data-testid={testId ?? 'picture-attach'}
        aria-label={label}
        title={pictures.full ? label : 'Attach image (or paste one)'}
        disabled={disabled || pictures.full}
        onClick={() => input.current?.click()}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        data-testid={`${testId ?? 'picture-attach'}-file`}
        onChange={(e) => {
          if (e.target.files?.length) pictures.add(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/**
 * Paste on the textarea, drop on the box around it. A paste with no picture is left to the
 * textarea (text pastes as before); `dragOver` is for the box's outline while a file is held over it.
 */
export function usePictureInput(pictures: ImageAttachments | undefined, enabled = true) {
  const [dragOver, setDragOver] = useState(false);
  const on = !!pictures && enabled;
  return {
    dragOver: on && dragOver,
    onPaste: on ? (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = pastedImageFiles(e);
      if (files.length === 0) return;
      e.preventDefault();
      pictures.add(files);
    } : undefined,
    dropProps: on ? {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      },
      onDragLeave: () => setDragOver(false),
      onDrop: (e: DragEvent<HTMLElement>) => {
        setDragOver(false);
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        pictures.add(e.dataTransfer.files);
      },
    } : {},
  };
}
