/**
 * E2E: web_fetch and web_search agent tools.
 *
 * Real server, real tool pipeline, real cache logic, real HTML extraction.
 * Only the network boundary (global fetch) is mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { executeTool } from '../../src/agent/tools.js';
import { __testing as fetchTesting } from '../../src/agent/tools/web-fetch-tool.js';
import { __testing as searchTesting } from '../../src/agent/tools/web-search-tool.js';

// ── Helpers ──

let server: HttpServer;
let originalFetch: typeof globalThis.fetch;

function makeHtmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function makeJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeTextResponse(text: string, status = 200, statusText = 'OK'): Response {
  return new Response(text, {
    status,
    statusText,
    headers: { 'Content-Type': 'text/plain' },
  });
}

function parseResult(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear caches between tests
  fetchTesting.FETCH_CACHE.clear();
  searchTesting.SEARCH_CACHE.clear();
  // Restore original fetch before each test (tests override as needed)
  globalThis.fetch = originalFetch;
});

// ── web_fetch tests ──

describe('web_fetch E2E', () => {
  it('fetches and extracts content from an HTML page', async () => {
    const html = '<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeHtmlResponse(html)));

    const result = await executeTool('web_fetch', { url: 'https://example.com/page' });
    const parsed = parseResult(result);

    expect(parsed.status).toBe(200);
    expect(parsed.url).toBe('https://example.com/page');
    expect(parsed.title).toBe('Test Page');
    expect(parsed.content).toBeDefined();
    expect(parsed.content as string).toContain('Hello');
    expect(parsed.content as string).toContain('World');
    expect(parsed.contentType).toBe('text/html');
  });

  it('fetches a JSON response', async () => {
    const data = { key: 'value', nested: { a: 1 } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(data)));

    const result = await executeTool('web_fetch', { url: 'https://api.example.com/data' });
    const parsed = parseResult(result);

    expect(parsed.status).toBe(200);
    expect(parsed.extractor).toBe('json');
    expect(parsed.contentType).toBe('application/json');
    const content = parsed.content as string;
    expect(content).toContain('"key": "value"');
    expect(content).toContain('"a": 1');
  });

  it('returns error info on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeTextResponse('Not Found', 404, 'Not Found'),
    ));

    const result = await executeTool('web_fetch', { url: 'https://example.com/missing' });

    expect(result).toContain('Error');
    expect(result).toContain('404');
  });

  it('returns error gracefully on fetch timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('The operation was aborted')));

    const result = await executeTool('web_fetch', { url: 'https://example.com/slow' });

    expect(result).toContain('Error');
    expect(result.toLowerCase()).toContain('aborted');
  });

  it('truncates content when max_chars is specified', async () => {
    const longBody = '<html><body>' + 'A'.repeat(100_000) + '</body></html>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeHtmlResponse(longBody)));

    const result = await executeTool('web_fetch', {
      url: 'https://example.com/long',
      max_chars: 500,
    });
    const parsed = parseResult(result);

    expect(parsed.truncated).toBe(true);
    expect((parsed.content as string).length).toBeLessThanOrEqual(500);
  });

  it('serves cached result on second fetch with same URL', async () => {
    const html = '<html><body><p>Cached content</p></body></html>';
    const mockFn = vi.fn().mockResolvedValue(makeHtmlResponse(html));
    vi.stubGlobal('fetch', mockFn);

    // First call — hits network
    const result1 = await executeTool('web_fetch', { url: 'https://example.com/cache-test' });
    const parsed1 = parseResult(result1);
    expect(parsed1.cached).toBeUndefined();

    // Second call — served from cache
    const result2 = await executeTool('web_fetch', { url: 'https://example.com/cache-test' });
    const parsed2 = parseResult(result2);
    expect(parsed2.cached).toBe(true);

    // fetch was only called once
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('returns error for invalid URL', async () => {
    const result = await executeTool('web_fetch', { url: 'not-a-url' });

    expect(result).toContain('Error');
    expect(result.toLowerCase()).toContain('invalid url');
  });

  it('returns error for non-http protocol', async () => {
    const result = await executeTool('web_fetch', { url: 'ftp://example.com/file' });

    expect(result).toContain('Error');
    expect(result.toLowerCase()).toContain('http');
  });

  it('extracts content in text mode', async () => {
    const html = '<html><head><title>Text Mode</title></head><body><h1>Heading</h1><p>Some <b>bold</b> text.</p></body></html>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeHtmlResponse(html)));

    const result = await executeTool('web_fetch', {
      url: 'https://example.com/text-mode',
      extract_mode: 'text',
    });
    const parsed = parseResult(result);

    expect(parsed.extractMode).toBe('text');
    expect(parsed.content).toBeDefined();
    // Text mode should not contain markdown formatting like # or **
    const content = parsed.content as string;
    expect(content).toContain('Heading');
    expect(content).toContain('text');
  });
});

// ── web_search tests ──

describe('web_search E2E', () => {
  it('returns results from Brave Search API', async () => {
    const braveResponse = {
      web: {
        results: [
          { title: 'Result One', url: 'https://one.com', description: 'First result', age: '2d' },
          { title: 'Result Two', url: 'https://two.com', description: 'Second result' },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(braveResponse)));

    // Set env var for API key
    const origKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'test-brave-key';

    try {
      const result = await executeTool('web_search', { query: 'test query' });
      const parsed = parseResult(result);

      expect(parsed.provider).toBe('brave');
      expect(parsed.query).toBe('test query');
      expect(parsed.count).toBe(2);
      const results = parsed.results as Array<Record<string, unknown>>;
      expect(results[0].title).toBe('Result One');
      expect(results[0].url).toBe('https://one.com');
      expect(results[0].description).toBe('First result');
      expect(results[0].siteName).toBe('one.com');
      expect(results[1].title).toBe('Result Two');
    } finally {
      if (origKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = origKey;
      }
    }
  });

  it('returns error about missing API key when BRAVE_API_KEY not set', async () => {
    const origKey = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;

    try {
      const result = await executeTool('web_search', { query: 'test' });
      const parsed = parseResult(result);

      expect(parsed.error).toBe('missing_brave_api_key');
      expect(parsed.message).toBeDefined();
      expect((parsed.message as string).toLowerCase()).toContain('api key');
    } finally {
      if (origKey !== undefined) {
        process.env.BRAVE_API_KEY = origKey;
      }
    }
  });

  it('serves cached result on second search with same query', async () => {
    const braveResponse = {
      web: { results: [{ title: 'Cached', url: 'https://cached.com', description: 'cached' }] },
    };
    const mockFn = vi.fn().mockResolvedValue(makeJsonResponse(braveResponse));
    vi.stubGlobal('fetch', mockFn);

    const origKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'test-brave-key';

    try {
      // First call — hits API
      const result1 = await executeTool('web_search', { query: 'cache query' });
      const parsed1 = parseResult(result1);
      expect(parsed1.cached).toBeUndefined();

      // Second call — cached
      const result2 = await executeTool('web_search', { query: 'cache query' });
      const parsed2 = parseResult(result2);
      expect(parsed2.cached).toBe(true);

      expect(mockFn).toHaveBeenCalledTimes(1);
    } finally {
      if (origKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = origKey;
      }
    }
  });

  it('passes count parameter to Brave API URL', async () => {
    const braveResponse = {
      web: { results: [{ title: 'A', url: 'https://a.com', description: 'a' }] },
    };
    const mockFn = vi.fn().mockResolvedValue(makeJsonResponse(braveResponse));
    vi.stubGlobal('fetch', mockFn);

    const origKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'test-brave-key';

    try {
      await executeTool('web_search', { query: 'count test', count: 3 });

      expect(mockFn).toHaveBeenCalledTimes(1);
      const calledUrl = mockFn.mock.calls[0][0] as string;
      expect(calledUrl).toContain('count=3');
    } finally {
      if (origKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = origKey;
      }
    }
  });

  it('handles Brave API error responses gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeTextResponse('Rate limit exceeded', 429, 'Too Many Requests'),
    ));

    const origKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'test-brave-key';

    try {
      const result = await executeTool('web_search', { query: 'error test' });
      expect(result).toContain('Error');
      expect(result).toContain('429');
    } finally {
      if (origKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = origKey;
      }
    }
  });

  it('returns error for empty query', async () => {
    const result = await executeTool('web_search', { query: '' });
    expect(result).toContain('Error');
    expect(result.toLowerCase()).toContain('required');
  });

  it('clamps count to valid range (1-10)', async () => {
    const braveResponse = {
      web: { results: [] },
    };
    const mockFn = vi.fn().mockResolvedValue(makeJsonResponse(braveResponse));
    vi.stubGlobal('fetch', mockFn);

    const origKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'test-brave-key';

    try {
      // Count > 10 should be clamped to 10
      await executeTool('web_search', { query: 'clamp test', count: 50 });
      const calledUrl = mockFn.mock.calls[0][0] as string;
      expect(calledUrl).toContain('count=10');
    } finally {
      if (origKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = origKey;
      }
    }
  });
});

// ── Cross-tool round-trip ──

describe('Cross-tool round-trip', () => {
  it('web_fetch produces parseable output consumed by other logic', async () => {
    const html = `
      <html>
        <head><title>Integration Test</title></head>
        <body>
          <h1>Main Heading</h1>
          <p>Paragraph one with some content.</p>
          <ul>
            <li>Item A</li>
            <li>Item B</li>
          </ul>
        </body>
      </html>
    `;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeHtmlResponse(html)));

    const result = await executeTool('web_fetch', { url: 'https://example.com/integration' });

    // Result is valid JSON
    const parsed = parseResult(result);
    expect(typeof parsed.content).toBe('string');
    expect(typeof parsed.content_length).toBe('number');
    expect(parsed.status).toBe(200);

    // Content captures the semantic structure
    const content = parsed.content as string;
    expect(content).toContain('Main Heading');
    expect(content).toContain('Item A');
    expect(content).toContain('Item B');
  });

  it('web_search result structure matches expected schema', async () => {
    const braveResponse = {
      web: {
        results: [
          { title: 'Schema Test', url: 'https://schema.example.com/page', description: 'Testing schema' },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(braveResponse)));

    const origKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'test-brave-key';

    try {
      const result = await executeTool('web_search', { query: 'schema test' });
      const parsed = parseResult(result);

      // Verify schema structure
      expect(parsed).toHaveProperty('query');
      expect(parsed).toHaveProperty('provider');
      expect(parsed).toHaveProperty('count');
      expect(parsed).toHaveProperty('tookMs');
      expect(parsed).toHaveProperty('results');
      expect(typeof parsed.tookMs).toBe('number');

      const results = parsed.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('title');
      expect(results[0]).toHaveProperty('url');
      expect(results[0]).toHaveProperty('description');
      expect(results[0]).toHaveProperty('siteName');
      expect(results[0].siteName).toBe('schema.example.com');
    } finally {
      if (origKey === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = origKey;
      }
    }
  });
});
