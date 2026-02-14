/**
 * web_fetch tool — fetch and extract readable content from a URL.
 *
 * Simplified port from moltbot: direct fetch with readability extraction,
 * no Firecrawl fallback, no SSRF guard (personal use).
 */
import type { ToolDefinition } from '../tools.js';
import { getConfig } from '../../core/config-manager.js';
import { log } from '../../logging/index.js';
import {
  extractReadableContent,
  htmlToMarkdown,
  markdownToText,
  truncateText,
  type ExtractMode,
} from './web-fetch-utils.js';
import {
  type CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from './web-shared.js';

const DEFAULT_FETCH_MAX_CHARS = 50_000;
const DEFAULT_FETCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

function looksLikeHtml(value: string): boolean {
  const head = value.trimStart().slice(0, 256).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

function normalizeContentType(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const [raw] = value.split(';');
  return raw?.trim() || undefined;
}

async function runWebFetch(params: {
  url: string;
  extractMode: ExtractMode;
  maxChars: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `fetch:${params.url}:${params.extractMode}:${params.maxChars}`,
  );
  const cached = readCache(FETCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error('Invalid URL: must be http or https');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Invalid URL: must be http or https');
  }

  const start = Date.now();
  const res = await fetch(params.url, {
    headers: {
      Accept: '*/*',
      'User-Agent': DEFAULT_FETCH_USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const rawDetail = await readResponseText(res);
    let detail = rawDetail;
    const contentType = res.headers.get('content-type');
    if (contentType?.includes('text/html') || looksLikeHtml(rawDetail)) {
      const rendered = htmlToMarkdown(rawDetail);
      detail = markdownToText(rendered.title ? `${rendered.title}\n${rendered.text}` : rendered.text);
    }
    const truncated = truncateText(detail.trim(), 4000);
    throw new Error(`Web fetch failed (${res.status}): ${truncated.text || res.statusText}`);
  }

  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const normalizedCT = normalizeContentType(contentType) ?? 'application/octet-stream';
  const body = await readResponseText(res);

  let title: string | undefined;
  let extractor = 'raw';
  let text = body;

  if (contentType.includes('text/html') || looksLikeHtml(body)) {
    const readable = await extractReadableContent({
      html: body,
      url: params.url,
      extractMode: params.extractMode,
    });
    if (readable?.text) {
      text = readable.text;
      title = readable.title;
      extractor = 'readability';
    }
  } else if (contentType.includes('application/json')) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
      extractor = 'json';
    } catch {
      // keep raw text
    }
  }

  const truncated = truncateText(text, params.maxChars);
  const payload: Record<string, unknown> = {
    url: params.url,
    status: res.status,
    contentType: normalizedCT,
    title: title || undefined,
    extractMode: params.extractMode,
    extractor,
    content: truncated.text,
    content_length: truncated.text.length,
    truncated: truncated.truncated,
    tookMs: Date.now() - start,
  };
  writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch and extract readable content from a URL (HTML -> markdown/text). Useful for reading web pages, documentation, articles, or API responses.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to fetch.' },
      extract_mode: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: 'Extraction mode: "markdown" (default) or "text" (plain text).',
      },
      max_chars: {
        type: 'number',
        description: 'Maximum characters to return (default 50000). Truncates when exceeded.',
      },
    },
    required: ['url'],
  },
  async execute(params) {
    try {
      const url = params.url as string;
      const extractMode = (params.extract_mode as ExtractMode) || 'markdown';
      const maxCharsParam = params.max_chars as number | undefined;

      const config = await getConfig();
      const fetchConfig = config.tools?.web_fetch;

      const maxChars = maxCharsParam
        ?? (fetchConfig?.max_chars as number | undefined)
        ?? DEFAULT_FETCH_MAX_CHARS;
      const timeoutSeconds = resolveTimeoutSeconds(
        fetchConfig?.timeout,
        DEFAULT_TIMEOUT_SECONDS,
      );
      const cacheTtlMs = resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES);

      const result = await runWebFetch({
        url,
        extractMode,
        maxChars: Math.max(100, Math.floor(maxChars)),
        timeoutSeconds,
        cacheTtlMs,
      });
      return JSON.stringify(result, null, 2);
    } catch (err) {
      log.agent.error('web_fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** Exported for testing */
export const __testing = { FETCH_CACHE, runWebFetch } as const;
