/**
 * Big gateway payloads ride a FILE, and the hub pulls it back in batches.
 *
 * `walnut tools call <op> @/tmp/payload.json` on a remote host used to inline the
 * whole payload into the gateway request, which is ONE NDJSON line on a unix
 * socket and then ONE WebSocket frame to the hub. That made the largest thing an
 * agent could send a property of the transport (GATEWAY_MAX_LINE_BYTES, and
 * behind it the 32MB frame `ws` enforces by closing the socket with 1009).
 *
 * A payload over the inline threshold now sends only its PATH. The hub, which
 * already has a bounded byte-range read against every host's daemon
 * (`fs.readRange`, the same primitive whale session files use), pulls the file
 * back HUMAN_INBOX_CHUNK_BYTES at a time and reassembles it here. Nothing on the
 * wire is ever bigger than a chunk, so the payload ceiling stops being a
 * transport question and becomes a plain "how much will we accept" number.
 *
 * Trust: `argsFile` names a file on the CALLER's own host, and gateway requests
 * only ever arrive from that host's daemon socket (a cloud replica refuses the
 * gateway entirely). The caller could read the file itself — it is a process
 * running as that user — so this grants nothing it did not already have. The
 * bridge cannot reach `fs.readRange` at all (see BRIDGE_ALLOWED_COMMANDS).
 */

import { log } from '../../logging/index.js';
import { HUMAN_INBOX_CHUNK_BYTES } from '../human-inbox/types.js';

/**
 * Ceiling on a pulled payload. Above the biggest thing a letter may carry
 * (LETTER_HTML_MAX_BYTES = 100MB) plus room for the JSON that wraps it, so the
 * op's own cap is what a sender hits, with its own explanatory error — not this,
 * which exists only so a bad path can't make the hub read a 40GB file.
 */
export const GATEWAY_ARGS_FILE_MAX_BYTES = 110 * 1024 * 1024;

/** One pull, so a stuck host fails instead of hanging the gateway request. */
const PULL_TIMEOUT_MS = 30_000;

export interface ArgsFilePullDeps {
  /** Bounded read on `host`. Returns null when the file is absent. */
  readRange(
    host: string,
    path: string,
    start: number,
    length: number,
  ): Promise<{ buf: Buffer; fileSize: number; eof: boolean } | null>;
}

async function defaultDeps(): Promise<ArgsFilePullDeps> {
  const { DaemonFileReader } = await import('../daemon-file-reader.js');
  const readers = new Map<string, InstanceType<typeof DaemonFileReader>>();
  return {
    async readRange(host, p, start, length) {
      let reader = readers.get(host);
      if (!reader) { reader = new DaemonFileReader(host); readers.set(host, reader); }
      return await reader.readRangeBytes(p, start, length);
    },
  };
}

export class GatewayArgsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayArgsFileError';
  }
}

/**
 * Pull `argsFile` off `host` in bounded chunks and parse it as the op's args.
 *
 * Bytes are concatenated BEFORE decoding: a chunk boundary can land inside a
 * multi-byte character, and decoding per chunk is exactly how the daemon's old
 * gateway listener corrupted large payloads (replacement chars → broken JSON).
 */
export async function pullArgsFile(
  host: string,
  argsFile: string,
  deps?: ArgsFilePullDeps,
): Promise<Record<string, unknown>> {
  if (typeof argsFile !== 'string' || !argsFile.startsWith('/')) {
    throw new GatewayArgsFileError('argsFile must be an absolute path on the calling host');
  }
  const d = deps ?? (await defaultDeps());
  const chunks: Buffer[] = [];
  let cursor = 0;
  let fileSize = -1;

  for (;;) {
    const slice = await withTimeout(
      d.readRange(host, argsFile, cursor, HUMAN_INBOX_CHUNK_BYTES),
      PULL_TIMEOUT_MS,
      `reading ${argsFile} on ${host}`,
    );
    if (slice === null) {
      throw new GatewayArgsFileError(`argsFile not found on ${host}: ${argsFile}`);
    }
    if (fileSize < 0) {
      fileSize = slice.fileSize;
      if (fileSize > GATEWAY_ARGS_FILE_MAX_BYTES) {
        throw new GatewayArgsFileError(
          `argsFile is ${fileSize} bytes, over the ${GATEWAY_ARGS_FILE_MAX_BYTES}-byte gateway payload ceiling`,
        );
      }
    }
    if (slice.buf.length > 0) {
      chunks.push(slice.buf);
      cursor += slice.buf.length;
    }
    if (slice.eof || slice.buf.length === 0) break;
    if (cursor > GATEWAY_ARGS_FILE_MAX_BYTES) {
      throw new GatewayArgsFileError('argsFile grew past the gateway payload ceiling while being read');
    }
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  chunks.length = 0;
  log.session.info('gateway: pulled argsFile', { host, path: argsFile, bytes: cursor });

  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GatewayArgsFileError(
      `argsFile is not valid JSON (${argsFile} on ${host}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayArgsFileError('argsFile must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GatewayArgsFileError(`timed out after ${ms}ms ${what}`)), ms);
    timer.unref?.();
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
