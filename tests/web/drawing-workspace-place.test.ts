/**
 * Each place a drawing opens keeps its own view choices (web/src/components/drawing/workspace-place.ts).
 * Pinned: a note's attachment preview shares no usePageView key with the App page (opening a
 * note's drawing used to put the App page in full screen and hide its list, and the next preview
 * started in full screen), never remembers full screen, and never changes which file the App page
 * opens next. The Notes preview passes `preview`, and DrawingWorkspace reads every key from here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspacePlace, workspaceViewKeys, type WorkspacePlace } from '../../web/src/components/drawing/workspace-place';

const ROOT = join(__dirname, '../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const PLACES: WorkspacePlace[] = ['app', 'beside', 'composer', 'preview'];

describe('drawing workspace places', () => {
  it('tells the places apart', () => {
    expect(workspacePlace({})).toBe('app');
    expect(workspacePlace({ sessionId: 's1' })).toBe('app');
    expect(workspacePlace({ sessionId: 's1', hasClose: true })).toBe('beside');
    expect(workspacePlace({ draftId: 'd1', sessionId: 's1', hasClose: true })).toBe('composer');
    expect(workspacePlace({ preview: true })).toBe('preview');
  });

  it('gives every place its own keys', () => {
    const files = PLACES.map((p) => workspaceViewKeys(p).filesKey);
    const full = PLACES.map((p) => workspaceViewKeys(p).fullScreenKey).filter((k): k is string => k !== null);
    expect(new Set(files).size).toBe(PLACES.length);
    expect(new Set(full).size).toBe(full.length);
    expect(files.filter((k) => full.includes(k))).toEqual([]);
  });

  it('shows the assistant in the App page only, under a key of its own', () => {
    expect(PLACES.filter((p) => workspaceViewKeys(p).assistantKey !== null)).toEqual(['app']);
    const app = workspaceViewKeys('app');
    expect([app.filesKey, app.fullScreenKey]).not.toContain(app.assistantKey);
  });

  it('never starts the preview in full screen and never moves the App page from it', () => {
    const preview = workspaceViewKeys('preview');
    const app = workspaceViewKeys('app');
    expect(preview.fullScreenKey).toBeNull();
    expect(preview.filesKey).not.toBe(app.filesKey);
    expect(preview.keepsLastDocument).toBe(false);
    expect(app.keepsLastDocument).toBe(true);
  });

  it('is what the Notes preview and the workspace use', () => {
    const preview = read('web/src/components/notes/AttachmentPreview.tsx');
    expect(preview).toMatch(/<DrawingWorkspace\b[^>]*\bpreview\b[^>]*\/>/);
    const ws = read('web/src/components/drawing/DrawingWorkspace.tsx');
    expect(ws).toContain('workspaceViewKeys(workspacePlace(');
    // Every usePageView key in the workspace comes from the place, none is a literal of its own.
    const literalKeys = [...ws.matchAll(/usePageView<[^>]*>\('drawing',\s*'([^']+)'/g)].map((m) => m[1]);
    expect(literalKeys).toEqual([]);
    expect(ws).toContain('if (view.keepsLastDocument) setLastDocument(');
  });
});
