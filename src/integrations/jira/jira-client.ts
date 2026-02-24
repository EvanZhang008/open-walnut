/**
 * Jira REST API v3 client.
 *
 * Supports Jira Cloud (API token + email → Basic auth) and
 * Jira Data Center (PAT → Bearer auth). No external dependencies.
 */

import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { createSubsystemLogger } from '../../logging/index.js';
import type {
  JiraIssue,
  JiraSearchResponse,
  JiraCreateIssueInput,
  JiraCreateIssueResponse,
  JiraUpdateIssueInput,
  JiraTransitionsResponse,
  JiraComment,
} from './types.js';
import type { AdfDocument } from './adf.js';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

/** Jira plugin config — accessed via config.plugins?.jira */
export interface JiraConfig {
  base_url: string;
  project_key: string;
  category: string;
  issue_type?: string;
  assignee_filter?: string;
  jql_filter?: string;
  project_mapping?: Record<string, string>;
  auth: {
    type: 'api-token' | 'pat';
    email?: string;
    token: string;
  };
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly logger = createSubsystemLogger('jira');

  constructor(config: JiraConfig) {
    // Normalize base URL — strip trailing slash
    this.baseUrl = config.base_url.replace(/\/+$/, '');

    if (config.auth.type === 'api-token') {
      if (!config.auth.email) throw new Error('Jira API token auth requires email');
      const credentials = Buffer.from(`${config.auth.email}:${config.auth.token}`).toString('base64');
      this.authHeader = `Basic ${credentials}`;
    } else {
      // PAT — Bearer token
      this.authHeader = `Bearer ${config.auth.token}`;
    }
  }

  // ── Issue CRUD ──

  async getIssue(issueIdOrKey: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`,
    );
  }

  async searchIssues(
    jql: string,
    opts?: { maxResults?: number; startAt?: number; fields?: string[] },
  ): Promise<JiraSearchResponse> {
    const params = new URLSearchParams({
      jql,
      maxResults: String(opts?.maxResults ?? 100),
      startAt: String(opts?.startAt ?? 0),
    });
    if (opts?.fields) params.set('fields', opts.fields.join(','));
    return this.request<JiraSearchResponse>('GET', `/rest/api/3/search?${params}`);
  }

  async createIssue(input: JiraCreateIssueInput): Promise<JiraCreateIssueResponse> {
    return this.request<JiraCreateIssueResponse>('POST', '/rest/api/3/issue', input);
  }

  async updateIssue(issueIdOrKey: string, input: JiraUpdateIssueInput): Promise<void> {
    await this.request<void>(
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`,
      input,
    );
  }

  // ── Comments ──

  async addComment(issueIdOrKey: string, body: AdfDocument): Promise<JiraComment> {
    return this.request<JiraComment>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`,
      { body },
    );
  }

  async updateComment(
    issueIdOrKey: string,
    commentId: string,
    body: AdfDocument,
  ): Promise<JiraComment> {
    return this.request<JiraComment>(
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment/${commentId}`,
      { body },
    );
  }

  // ── Transitions (workflow) ──

  async getTransitions(issueIdOrKey: string): Promise<JiraTransitionsResponse> {
    return this.request<JiraTransitionsResponse>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`,
    );
  }

  async doTransition(issueIdOrKey: string, transitionId: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`,
      { transition: { id: transitionId } },
    );
  }

  // ── Discovery ──

  async getMyself(): Promise<{ accountId: string; displayName: string; emailAddress?: string }> {
    return this.request('GET', '/rest/api/3/myself');
  }

  // ── HTTP transport ──

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.doRequest<T>(method, path, body);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Only retry on 429 and 5xx
        const status = (err as { statusCode?: number }).statusCode;
        if (status !== 429 && (!status || status < 500)) {
          throw lastError;
        }

        if (attempt < MAX_RETRIES) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          this.logger.debug('Jira API retrying', { method, path, attempt: attempt + 1, backoff });
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    throw lastError ?? new Error('Jira request failed');
  }

  private doRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const bodyStr = body ? JSON.stringify(body) : undefined;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': this.authHeader,
          'Accept': 'application/json',
          ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;

          if (status >= 200 && status < 300) {
            // 204 No Content — return void
            if (!raw.trim()) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(raw) as T);
            } catch {
              resolve(raw as unknown as T);
            }
            return;
          }

          // Error response
          const err = new Error(`Jira API ${method} ${path} → ${status}: ${raw.slice(0, 500)}`);
          (err as Error & { statusCode: number }).statusCode = status;
          reject(err);
        });
      });

      req.on('error', reject);
      req.setTimeout(30_000, () => {
        req.destroy(new Error(`Jira API ${method} ${path} timed out after 30s`));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}
