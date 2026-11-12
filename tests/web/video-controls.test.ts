import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { installVideoControls, VIDEO_CONTROLS_JS } from '../../src/lib/video-controls';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('every video surface has a seek control', () => {
  it('every web video is covered by the document-wide enhancer, not a fixed component list', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const name = dir + '/' + entry.name;
        if (entry.isDirectory()) walk(name);
        else if (/\.[jt]sx?$/.test(name) && /<video\b|createElement\(['"]video['"]/.test(read(name))) files.push(name);
      }
    };
    walk('web/src');
    expect(files.length).toBeGreaterThan(0);
    expect(read('web/src/main.tsx')).toContain('installVideoControls();');
    expect(installVideoControls.toString()).toMatch(/querySelectorAll[^;]*['"]video['"]/);
    expect(installVideoControls.toString()).toContain('MutationObserver');
    // Scrubbing is driven by input while held, with at most one pending paint.
    expect(installVideoControls.toString()).toMatch(/seek\.addEventListener\(["']input["']/);
    expect(installVideoControls.toString()).toContain('requestAnimationFrame(flushSeek)');
    // While the thumb is held, media events never write the slider back (a slow
    // seek finishing mid-drag pulled the thumb away and ended the drag).
    expect(installVideoControls.toString()).toMatch(/if \(!scrubbing \|\| !ready\) seek\.value/);
    // Linux WebKit asked for the seekable range before metadata keeps a duration
    // of 0 and nothing seekable for good, so the range waits for metadata.
    expect(installVideoControls.toString()).toContain('video.readyState < 1 ? video.duration');
    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toMatch(/attachShadow\(/);
      // New authored JSX video surfaces opt into the shared seek player. A
      // background clip must explicitly document its non-player role instead.
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      if (file.endsWith('.tsx')) for (const match of code.matchAll(/<video\b[\s\S]*?(?:\/>|>)/g)) {
        expect(match[0], file).toMatch(/\bcontrols\b/);
      }
    }
    expect(read('src/web/preview-bridge.ts')).toContain('VIDEO_CONTROLS_JS');
    // Board and rich islands deliberately allow no media under their CSP.
    // Do not widen those policies just to add controls to a non-playable video.
    for (const file of ['web/src/components/board/board-model.ts', 'web/src/components/chat/RichBlocks.tsx']) {
      expect(read(file), file).toContain("default-src 'none'");
      expect(read(file), file).not.toContain('media-src');
    }
    // Script-free inbox documents retain native video controls and cannot run the enhancer.
    expect(read('src/core/human-inbox/letter-frame.ts')).toContain('height: auto');
    expect(read('src/core/human-inbox/letter-frame.ts')).not.toContain('allow-scripts');
    // The phone uses a separate native player with Apple's seek controls enabled by default.
    const phone = read('ios-native/Walnut/Views/Sessions/SessionMediaView.swift');
    expect(phone).toContain('AVPlayerViewController()');
    expect(phone).not.toContain('showsPlaybackControls = false');
  });

  it('keeps the file timeline inside a flex pane rather than a 100%-high overflow', () => {
    expect(read('web/src/components/common/FileContentView.tsx')).toContain("media === 'video' ? ' fv-video-view'");
    expect(read('web/src/styles/globals.css')).toContain('.fv-video-view .wn-video-controls { flex: 0 0 auto; }');
  });

  it('the shipped frame script has no module dependencies and tolerates a DOM-less runtime', () => {
    expect(VIDEO_CONTROLS_JS).not.toContain('import ');
    expect(() => vm.runInNewContext(VIDEO_CONTROLS_JS, { window: { document: {} } })).not.toThrow();
  });
});
