import { describe, it, expect, vi } from 'vitest';
import { drawingPoint, drawingTextLayout, hasDrawing, paintDrawing, DRAWING_WIDTH, DRAWING_HEIGHT, type DrawingItem } from '../../web/src/components/chat/drawing-model';

const pen: DrawingItem = { kind: 'pen', points: [{ x: 10, y: 20 }, { x: 50, y: 80 }] };

describe('drawing model', () => {
  it('maps resized canvas input to the same image coordinates and clamps edges', () => {
    const rect = { left: 20, top: 40, width: 500, height: 325 };
    expect(drawingPoint(270, 202.5, rect)).toEqual({ x: 500, y: 325 });
    expect(drawingPoint(-5, 1000, rect)).toEqual({ x: 0, y: DRAWING_HEIGHT });
    expect(drawingPoint(900, 0, rect)).toEqual({ x: DRAWING_WIDTH, y: 0 });
  });

  it('clear leaves nothing to attach and undo restores the drawing', () => {
    expect(hasDrawing([])).toBe(false);
    expect(hasDrawing([{ kind: 'eraser', points: [{ x: 0, y: 0 }] }])).toBe(false);
    const items: DrawingItem[] = [pen, { kind: 'clear' }];
    expect(hasDrawing(items)).toBe(false);
    expect(hasDrawing(items.slice(0, -1))).toBe(true);
    expect(hasDrawing([...items, { kind: 'text', at: { x: 50, y: 80 }, text: 'Client' }])).toBe(true);
  });

  it('wraps labels and moves them inside the right and bottom edges without dropping words', () => {
    const ctx = { measureText: (text: string) => ({ width: text.length * 12 }) } as CanvasRenderingContext2D;
    const layout = drawingTextLayout(ctx, 'A long label near the edge\nSecond line', { x: 990, y: 640 });
    expect(layout.lines).toEqual(['A long label near the', 'edge', 'Second line']);
    expect(layout.at.x + layout.width).toBeLessThan(DRAWING_WIDTH);
    expect(layout.at.y + layout.height).toBeLessThan(DRAWING_HEIGHT);
    expect(layout.lines.join(' ')).toContain('the edge');
  });

  it('renders pen dots, eraser, multiline text and clear on an opaque white image', () => {
    const ctx = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: (text: string) => ({ width: text.length * 12 }) } as unknown as CanvasRenderingContext2D;
    paintDrawing(ctx, [pen, { kind: 'eraser', points: [{ x: 20, y: 30 }] }, { kind: 'text', at: { x: 70, y: 90 }, text: `Client\n${String.fromCodePoint(0x753b, 0x56fe)}` }, { kind: 'clear' }]);
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, DRAWING_WIDTH, DRAWING_HEIGHT);
    expect(ctx.arc).toHaveBeenCalledWith(20, 30, 12, 0, Math.PI * 2);
    expect(ctx.fillText).toHaveBeenNthCalledWith(1, 'Client', 70, 90);
    expect(ctx.fillText).toHaveBeenNthCalledWith(2, String.fromCodePoint(0x753b, 0x56fe), 70, 120);
    expect(ctx.fillStyle).toBe('#ffffff');
  });
});
