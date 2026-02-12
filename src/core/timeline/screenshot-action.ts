/**
 * Screenshot action — captures a screenshot, creates a thumbnail,
 * and returns base64 data for AI analysis.
 *
 * Uses macOS native `screencapture` + `sips` (zero external dependencies).
 * Implements file-size-based change detection to skip unchanged screens.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { TIMELINE_DIR } from '../../constants.js';
import { registerAction, type ActionResult } from '../cron/actions.js';

const execFileAsync = promisify(execFile);

/**
 * Register the screenshot-track action with the cron action registry.
 */
export function registerScreenshotAction(): void {
  if (process.platform !== 'darwin') {
    return; // screencapture + sips are macOS-only
  }
  registerAction(
    'screenshot-track',
    screenshotAndAnalyze,
    'Take a screenshot and return base64 thumbnail for AI analysis (macOS only)',
  );
}

async function screenshotAndAnalyze(
  _params: Record<string, unknown>,
): Promise<ActionResult> {
  const today = new Date().toISOString().slice(0, 10);
  const ts = Date.now();
  const dayDir = join(TIMELINE_DIR, today, 'thumbnails');
  await mkdir(dayDir, { recursive: true });

  // Use unique temp filename to prevent race if two captures overlap
  // No dot prefix — macOS screencapture refuses to write hidden files
  const tmpPng = join(TIMELINE_DIR, `tmp-capture-${ts}.png`);
  const thumbPath = join(dayDir, `${ts}.jpg`);

  try {
    // 1. Capture screenshot (macOS native)
    await execFileAsync('screencapture', ['-C', '-x', tmpPng], { timeout: 5000 });

    // Verify the file was actually created — screencapture exits 0 even when
    // Screen Recording permission is denied (file simply doesn't get written)
    let fileStat;
    try {
      fileStat = await stat(tmpPng);
    } catch {
      return {
        status: 'error',
        error: 'screencapture produced no file. Possible causes: (1) Screen Recording permission not granted — System Settings → Privacy & Security → Screen Recording, (2) invalid output path.',
      };
    }
    if (fileStat.size === 0) {
      await unlink(tmpPng).catch(() => {});
      return {
        status: 'error',
        error: 'screencapture produced an empty file. Check Screen Recording permissions in System Settings → Privacy & Security → Screen Recording.',
      };
    }

    // 2. Check if screen changed (file size heuristic)
    const prevSizeFile = join(TIMELINE_DIR, '.prev-size');
    const newSize = fileStat.size;
    let skipped = false;
    try {
      const prevSize = parseInt(await readFile(prevSizeFile, 'utf8'), 10);
      if (prevSize > 0 && Math.abs(newSize - prevSize) / prevSize < 0.02) {
        skipped = true;
      }
    } catch {
      // No previous size file — first capture
    }
    await writeFile(prevSizeFile, String(newSize));

    if (skipped) {
      await unlink(tmpPng).catch(() => {});
      return {
        status: 'ok',
        summary: '(screen unchanged)',
        data: { skipped: true, timestampMs: ts },
      };
    }

    // 3. Create thumbnail (macOS sips)
    await execFileAsync('sips', [
      '--resampleWidth', '640',
      '--setProperty', 'format', 'jpeg',
      tmpPng, '--out', thumbPath,
    ], { timeout: 5000 });
    await unlink(tmpPng).catch(() => {});

    // 4. Read thumbnail as base64
    const thumbBuffer = await readFile(thumbPath);
    const base64 = thumbBuffer.toString('base64');

    return {
      status: 'ok',
      summary: `Screenshot captured at ${new Date(ts).toLocaleTimeString()}`,
      data: {
        timestampMs: ts,
        thumbnailFile: `${today}/thumbnails/${ts}.jpg`,
        thumbnailBase64: base64,
        mediaType: 'image/jpeg',
        skipped: false,
      },
    };
  } catch (err) {
    // Clean up temp file on error
    await unlink(tmpPng).catch(() => {});
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
