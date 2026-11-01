/**
 * The picture on the clipboard, ready to send: a screenshot copied with Ctrl+Shift+Cmd+4 (image
 * data on the pasteboard) or an image file copied in Finder. It is shrunk to a JPEG of at most
 * 2000 px on its long side, so a 5K screenshot rides one request (the server takes 15 MB).
 */
import { Clipboard } from "@raycast/api";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;
const MAX_SIDE = 2000;

export interface ClipboardImage {
  /** Raw base64 of the JPEG to send. */
  data: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
}

/** True when the clipboard holds a picture (fast: no file is written). */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    const content = await Clipboard.read();
    if (content.file && IMAGE_FILE.test(content.file)) return true;
    const { stdout } = await run("osascript", ["-e", "clipboard info"], { timeout: 5000 });
    return /«class PNGf»|TIFF picture|«class TIFF»|JPEG picture/.test(stdout);
  } catch {
    return false;
  }
}

/** The clipboard's picture as a JPEG to send, or null when it holds none. */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const dir = await mkdtemp(join(tmpdir(), "walnut-raycast-"));
  try {
    let source: string | null = null;
    const content = await Clipboard.read();
    if (content.file && IMAGE_FILE.test(content.file)) {
      source = content.file;
    } else {
      // Pasteboard image data: AppleScript writes it out as PNG (no permission needed).
      source = join(dir, "clipboard.png");
      const script = [
        `set out to open for access (POSIX file ${JSON.stringify(source)}) with write permission`,
        "try",
        "write (the clipboard as «class PNGf») to out",
        "end try",
        "close access out",
      ];
      await run("osascript", script.flatMap((line) => ["-e", line]), { timeout: 15000 });
      const written = await stat(source).catch(() => null);
      if (!written?.size) return null;
    }
    const jpeg = join(dir, "shot.jpg");
    // `-Z` enlarges a smaller picture too, so it is passed only when the picture is larger.
    const before = await pixelSize(source);
    const shrink = Math.max(before.width, before.height) > MAX_SIDE ? ["-Z", String(MAX_SIDE)] : [];
    await run("sips", [...shrink, "-s", "format", "jpeg", "-s", "formatOptions", "80", source, "--out", jpeg], { timeout: 15000 });
    const { width, height } = await pixelSize(jpeg);
    const data = (await readFile(jpeg)).toString("base64");
    return data ? { data, mediaType: "image/jpeg", width, height } : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function pixelSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { timeout: 5000 });
  return {
    width: Number(/pixelWidth: (\d+)/.exec(stdout)?.[1] ?? 0),
    height: Number(/pixelHeight: (\d+)/.exec(stdout)?.[1] ?? 0),
  };
}
