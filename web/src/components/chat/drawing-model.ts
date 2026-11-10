export const DRAWING_WIDTH = 1000;
export const DRAWING_HEIGHT = 650;
export const DRAWING_TEXT_SIZE = 24;
export type DrawingTool = 'pen' | 'eraser' | 'text';
export interface DrawingPoint { x: number; y: number }
export type DrawingItem =
  | { kind: 'pen' | 'eraser'; points: DrawingPoint[] }
  | { kind: 'text'; at: DrawingPoint; text: string }
  | { kind: 'clear' };

export function drawingPoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): DrawingPoint {
  return {
    x: Math.max(0, Math.min(DRAWING_WIDTH, (clientX - rect.left) * DRAWING_WIDTH / rect.width)),
    y: Math.max(0, Math.min(DRAWING_HEIGHT, (clientY - rect.top) * DRAWING_HEIGHT / rect.height)),
  };
}

export function hasDrawing(items: readonly DrawingItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'clear') return false;
    if (items[i].kind === 'pen' || items[i].kind === 'text') return true;
  }
  return false;
}

export function drawingTextLayout(ctx: CanvasRenderingContext2D, text: string, at: DrawingPoint) {
  ctx.font = `${DRAWING_TEXT_SIZE}px sans-serif`;
  const width = 300;
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (line && ctx.measureText(line + word).width > width) { lines.push(line.trimEnd()); line = ''; }
      for (const character of word) {
        if (line && ctx.measureText(line + character).width > width) { lines.push(line); line = ''; }
        line += character;
      }
    }
    lines.push(line);
  }
  const height = Math.max(30, lines.length * 30);
  return { lines, width, height, at: { x: Math.min(at.x, DRAWING_WIDTH - width - 4), y: Math.max(0, Math.min(at.y, DRAWING_HEIGHT - height - 4)) } };
}

export function paintDrawingItem(ctx: CanvasRenderingContext2D, item: DrawingItem): void {
  if (item.kind === 'clear') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, DRAWING_WIDTH, DRAWING_HEIGHT);
    return;
  }
  ctx.fillStyle = '#202124';
  if (item.kind === 'text') {
    const layout = drawingTextLayout(ctx, item.text, item.at);
    ctx.textBaseline = 'top';
    layout.lines.forEach((line, i) => ctx.fillText(line, layout.at.x, layout.at.y + i * 30));
    return;
  }
  ctx.strokeStyle = item.kind === 'eraser' ? '#ffffff' : '#202124';
  ctx.lineWidth = item.kind === 'eraser' ? 24 : 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const [first, ...rest] = item.points;
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  if (!rest.length) {
    ctx.fillStyle = ctx.strokeStyle;
    ctx.arc(first.x, first.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    for (const point of rest) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
}

export function paintDrawing(ctx: CanvasRenderingContext2D, items: readonly DrawingItem[]): void {
  paintDrawingItem(ctx, { kind: 'clear' });
  for (const item of items) paintDrawingItem(ctx, item);
}
