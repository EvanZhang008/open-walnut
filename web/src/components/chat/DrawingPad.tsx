import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { DRAWING_WIDTH, DRAWING_HEIGHT, DRAWING_TEXT_SIZE, drawingPoint, drawingTextLayout, hasDrawing, paintDrawing, paintDrawingItem, type DrawingItem, type DrawingPoint, type DrawingTool } from './drawing-model';
import './drawing-pad.css';

const undoKeyLabel = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';

interface Props {
  open: boolean;
  draftId: string;
  onClose: () => void;
  onAttach: (file: File) => Promise<string | null>;
  canAttach: boolean;
}

export function DrawingPad({ open, draftId, onClose, onAttach, canAttach }: Props) {
  const [drafts, setDrafts] = useState<Record<string, DrawingItem[]>>({});
  const items = drafts[draftId] ?? [];
  const change = (next: DrawingItem[]) => setDrafts(previous => ({ ...previous, [draftId]: next }));
  return <>
    {Object.values(drafts).some(hasDrawing) && <span hidden data-walnut-unsaved="A drawing that is not attached" />}
    {open && <DrawingDialog key={draftId} items={items} onChange={change} onClose={onClose} onAttach={onAttach} canAttach={canAttach} />}
  </>;
}

interface DialogProps extends Omit<Props, 'open' | 'draftId'> {
  items: DrawingItem[];
  onChange: (items: DrawingItem[]) => void;
}

function DrawingDialog({ items, onChange, onClose, onAttach, canAttach }: DialogProps) {
  const [tool, setTool] = useState<DrawingTool>('pen');
  const [text, setText] = useState<{ at: DrawingPoint; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const stroke = useRef<{ id: number; item: Extract<DrawingItem, { points: DrawingPoint[] }> } | null>(null);
  const previousFocus = useRef(document.activeElement);
  const currentItems = useRef(items);
  const mounted = useRef(true);
  currentItems.current = items;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const textLayout = text && canvas.current ? drawingTextLayout(canvas.current.getContext('2d')!, text.value, text.at) : null;
  const textFits = !textLayout || textLayout.height <= DRAWING_HEIGHT - 4;
  const commitText = () => {
    if (!textFits) return currentItems.current;
    const next = text?.value.trim() && textLayout ? [...currentItems.current, { kind: 'text' as const, at: textLayout.at, text: textLayout.lines.join('\n') }] : currentItems.current;
    currentItems.current = next;
    onChange(next);
    setText(null);
    return next;
  };
  const finishStroke = () => {
    const active = stroke.current;
    if (!active) return;
    stroke.current = null;
    const next = [...currentItems.current, active.item];
    currentItems.current = next;
    onChange(next);
    if (canvas.current?.hasPointerCapture(active.id)) canvas.current.releasePointerCapture(active.id);
  };
  const close = () => {
    if (busy || !textFits) return;
    finishStroke();
    commitText();
    onClose();
  };
  useModalOverlay(close);
  useLayoutEffect(() => {
    dialog.current?.focus();
    return () => {
      const before = previousFocus.current;
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (ctx) paintDrawing(ctx, items);
  }, [items]);
  useLayoutEffect(() => { if (text) textArea.current?.focus(); }, [text?.at]);
  useLayoutEffect(() => {
    const paper = canvas.current!.parentElement!;
    const resize = () => paper.style.setProperty('--drawing-scale', String(canvas.current!.clientWidth / DRAWING_WIDTH));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(paper);
    return () => observer.disconnect();
  }, []);

  const chooseTool = (next: DrawingTool) => {
    if (!textFits) return;
    finishStroke();
    commitText();
    setTool(next);
    dialog.current?.focus();
  };
  const undo = () => {
    if (text && !textFits) { setText(null); dialog.current?.focus(); return; }
    finishStroke();
    const next = commitText().slice(0, -1);
    currentItems.current = next;
    onChange(next);
    dialog.current?.focus();
  };
  const clear = () => {
    if (!textFits) setText(null);
    finishStroke();
    const next = commitText();
    if (hasDrawing(next)) {
      currentItems.current = [...next, { kind: 'clear' }];
      onChange(currentItems.current);
    }
    dialog.current?.focus();
  };
  const pointAt = (e: PointerEvent<HTMLCanvasElement>) => drawingPoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
  const pointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (busy || !textFits || e.button !== 0 || stroke.current) return;
    e.preventDefault();
    commitText();
    const at = pointAt(e);
    if (tool === 'text') {
      // Leave room to type at the right and bottom edges.
      setText({ at: { x: Math.min(at.x, DRAWING_WIDTH - 180), y: Math.min(at.y, DRAWING_HEIGHT - 60) }, value: '' });
      return;
    }
    dialog.current?.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const item = { kind: tool, points: [at] };
    stroke.current = { id: e.pointerId, item };
    const ctx = e.currentTarget.getContext('2d');
    if (ctx) paintDrawingItem(ctx, item);
  };
  const pointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const active = stroke.current;
    if (!active || active.id !== e.pointerId) return;
    const point = pointAt(e);
    const previous = active.item.points.at(-1)!;
    active.item.points.push(point);
    const ctx = e.currentTarget.getContext('2d');
    if (ctx) paintDrawingItem(ctx, { kind: active.item.kind, points: [previous, point] });
  };
  const pointerEnd = (e: PointerEvent<HTMLCanvasElement>) => {
    if (stroke.current?.id === e.pointerId) finishStroke();
  };

  const attach = async () => {
    if (busy || !textFits || !canAttach || !canvas.current) return;
    finishStroke();
    const next = commitText();
    if (!hasDrawing(next)) return;
    const ctx = canvas.current.getContext('2d');
    if (!ctx) { setError('The drawing could not be exported. Try again.'); return; }
    paintDrawing(ctx, next);
    setBusy(true);
    setError(null);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.current!.toBlob(resolve, 'image/png'));
      if (!mounted.current) return;
      if (!blob) throw new Error('The drawing could not be exported. Try again.');
      const notice = await onAttach(new File([blob], `drawing-${Date.now()}.png`, { type: 'image/png' }));
      if (!mounted.current) return;
      if (notice) { setError(notice); return; }
      onChange([]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The drawing could not be attached. Try again.');
    } finally {
      if (mounted.current) { setBusy(false); dialog.current?.focus(); }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Tab') {
      const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), textarea')];
      const first = controls[0];
      const last = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first?.focus(); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (text) { setText(null); dialog.current?.focus(); }
      else close();
      return;
    }
    if (busy) return;
    if (e.target instanceof HTMLTextAreaElement) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (textFits) { commitText(); dialog.current?.focus(); } }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      const key = e.key.toLowerCase();
      if (!e.shiftKey && (key === 'p' || key === 'e' || key === 't')) { e.preventDefault(); chooseTool(key === 'p' ? 'pen' : key === 'e' ? 'eraser' : 'text'); }
      else if (e.shiftKey && e.key === 'Backspace') { e.preventDefault(); clear(); }
    }
  };
  const nonempty = hasDrawing(items) || !!text?.value.trim();
  return createPortal(
    <div className="drawing-pad-overlay" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) { e.preventDefault(); dialog.current?.focus(); } }} onKeyDownCapture={onKeyDown}>
      <div ref={dialog} className="drawing-pad" role="dialog" aria-modal="true" aria-label="Drawing" tabIndex={-1}>
        <header className="drawing-pad-header">
          <h2>Drawing</h2>
          <button type="button" onClick={close} disabled={busy} aria-label="Close drawing">×</button>
        </header>
        <div className="drawing-pad-tools" role="toolbar" aria-label="Drawing tools">
          {(['pen', 'eraser', 'text'] as const).map((name) => (
            <button key={name} type="button" aria-pressed={tool === name} aria-label={name === 'text' ? 'Text' : name === 'pen' ? 'Pen' : 'Eraser'} disabled={busy} onClick={() => chooseTool(name)}>
              {name === 'pen' ? 'Pen' : name === 'eraser' ? 'Eraser' : 'Text'} <kbd>{name === 'pen' ? 'P' : name === 'eraser' ? 'E' : 'T'}</kbd>
            </button>
          ))}
          <span className="drawing-pad-tools-gap" />
          <button type="button" disabled={busy || (!items.length && !text?.value.trim())} onClick={undo} aria-label="Undo" title="Undo (⌘Z / Ctrl+Z)">Undo <kbd>{undoKeyLabel}</kbd></button>
          <button type="button" disabled={busy || !nonempty} onClick={clear} aria-label="Clear" title="Clear (Shift+Backspace)">Clear <kbd>⇧⌫</kbd></button>
        </div>
        <div className="drawing-pad-paper" data-tool={tool}>
          <canvas ref={canvas} width={DRAWING_WIDTH} height={DRAWING_HEIGHT} aria-label="Drawing canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} />
          {text && textLayout && <textarea ref={textArea} className="drawing-pad-text" aria-label="Canvas text" data-no-draft="document" disabled={busy} value={text.value} onChange={(e) => setText({ ...text, value: e.target.value })} style={{ left: `${textLayout.at.x / DRAWING_WIDTH * 100}%`, top: `${textLayout.at.y / DRAWING_HEIGHT * 100}%`, width: `${textLayout.width / DRAWING_WIDTH * 100}%`, height: `calc(var(--drawing-scale) * ${Math.min(DRAWING_HEIGHT - 4, textLayout.height)}px)`, fontSize: `calc(var(--drawing-scale) * ${DRAWING_TEXT_SIZE}px)` }} rows={1} wrap="soft" spellCheck={false} />}
        </div>
        <footer className="drawing-pad-footer">
          <span role={error || !textFits ? 'alert' : undefined}>{!textFits ? 'This label is taller than the canvas. Shorten it or press Esc to cancel.' : error ?? (text ? 'Click the canvas or press ⌘Enter / Ctrl+Enter to keep text. Esc cancels text.' : 'Close keeps your sketch in this composer.')}</span>
          <button type="button" className="drawing-pad-attach" onClick={() => void attach()} disabled={busy || !textFits || !nonempty || !canAttach} title={!canAttach ? 'Attachment limit reached' : 'Add this picture to your message'}>{busy ? 'Attaching…' : 'Attach drawing'}</button>
        </footer>
      </div>
    </div>, document.body,
  );
}
