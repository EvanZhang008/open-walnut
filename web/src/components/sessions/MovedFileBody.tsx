/**
 * The body of a file the change only moved: "Moved, content unchanged.", then what a reader opens it
 * for, the file's text numbered and read-only, and a way to open it in Files. The text is the change's
 * own when it carries it (a git comparison); a move the session made with a shell command carries
 * none, so the file is read where it is now (one GET, a lookup like the diff's). The header above
 * already names the old path, so the body never repeats it (2026-11-22 audit: the pane was left
 * empty under that one line).
 */
import { useEffect, useState } from 'react';
import { fetchFileContent } from '@/api/files';
import '@/styles/moved-file-body.css';

/** Lines drawn at most: a moved file is read for orientation, not reviewed line by line. */
export const MOVED_BODY_MAX_LINES = 400;

/** The lines a moved file's text shows, and how many more it holds. Pure. */
export function movedFileLines(text: string, max = MOVED_BODY_MAX_LINES): { lines: string[]; rest: number } {
  if (!text) return { lines: [], rest: 0 };
  const all = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  return { lines: all.slice(0, max), rest: Math.max(0, all.length - max) };
}

export function MovedFileBody({ text, filePath, host, onOpen }: {
  text: string;
  /** Read when `text` is empty: the file where it is now. */
  filePath?: string;
  host?: string;
  onOpen?: () => void;
}) {
  const [read, setRead] = useState<{ path: string; text: string } | null>(null);
  useEffect(() => {
    if (text || !filePath) return;
    let live = true;
    fetchFileContent(filePath, host)
      .then((res) => { if (live && !res.binary && !res.error && typeof res.content === 'string') setRead({ path: filePath, text: res.content }); })
      .catch(() => { /* the Open in Files button still reaches it */ });
    return () => { live = false; };
  }, [text, filePath, host]);
  const shownText = text || (read && read.path === filePath ? read.text : '');
  const { lines, rest } = movedFileLines(shownText);
  return (
    <div className="session-diff-moved" data-testid="moved-file">
      <div className="session-diff-file-empty session-diff-moved-note">
        Moved, content unchanged.
        {onOpen && (
          <button type="button" className="btn btn-sm" onClick={onOpen} title="Open the file where it is now in the Files tab" data-testid="moved-file-open">
            Open in Files
          </button>
        )}
      </div>
      {lines.length > 0 && (
        <ol className="session-diff-moved-lines" data-testid="moved-file-body" aria-label="File content, unchanged">
          {lines.map((line, i) => (
            <li key={i} className="session-diff-moved-line">
              <span className="session-diff-moved-num" aria-hidden>{i + 1}</span>
              <span className="session-diff-moved-code">{line || ' '}</span>
            </li>
          ))}
        </ol>
      )}
      {rest > 0 && <div className="session-diff-moved-rest">{rest} more {rest === 1 ? 'line' : 'lines'}, unchanged</div>}
    </div>
  );
}
