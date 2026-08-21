/**
 * compactPermissionInput / summarizePermissionRequest — pure functions, no I/O.
 *
 * Contract under test:
 *   - the fields the notification UI renders survive per tool (AskUserQuestion's
 *     question structure especially — the feed builds an answer form from it, and
 *     its question text / option labels are the answer-map identity, so they must
 *     survive VERBATIM);
 *   - everything unbounded is truncated with a visible marker;
 *   - secrets never reach the durable store (notifications.json is git-synced);
 *   - nothing here can THROW (a dropped notification parks a session on an
 *     approval nobody can see) — circular / absurdly deep input included;
 *   - a pathological input can never bloat notifications.json (8KB guard).
 */
import { describe, it, expect } from 'vitest';
import {
  compactPermissionInput,
  summarizePermissionRequest,
} from '../../../src/core/notifications/permission-detail.js';

describe('compactPermissionInput', () => {
  it('returns undefined for absent / empty input', () => {
    expect(compactPermissionInput('Bash', undefined)).toBeUndefined();
    expect(compactPermissionInput('Bash', {})).toBeUndefined();
    expect(compactPermissionInput(undefined, undefined)).toBeUndefined();
  });

  describe('Bash', () => {
    it('keeps command + description, omitting absent keys', () => {
      expect(compactPermissionInput('Bash', { command: 'ls -la', description: 'list' }))
        .toEqual({ command: 'ls -la', description: 'list' });
      expect(compactPermissionInput('Bash', { command: 'ls' })).toEqual({ command: 'ls' });
    });

    it('drops keys the UI does not render', () => {
      const out = compactPermissionInput('Bash', { command: 'ls', timeout: 5000, run_in_background: true });
      expect(out).toEqual({ command: 'ls' });
    });

    it('truncates command at 2000 and description at 200, with a marker', () => {
      const out = compactPermissionInput('Bash', {
        command: 'x'.repeat(5000),
        description: 'y'.repeat(500),
      })!;
      expect(out.command).toHaveLength(2001);
      expect(out.command as string).toMatch(/…$/);
      expect(out.description).toHaveLength(201);
      expect(out.description as string).toMatch(/…$/);
    });

    it('leaves a short command unmarked', () => {
      const out = compactPermissionInput('Bash', { command: 'ls' })!;
      expect(out.command).toBe('ls');
    });

    it('does not stack a second ellipsis when the cut already ends in one', () => {
      // A value that came through an earlier truncate (or just happens to have
      // '…' at the boundary) must not render as '……'.
      const command = `${'x'.repeat(1999)}…${'y'.repeat(500)}`;
      const out = compactPermissionInput('Bash', { command })!;
      expect(out.command).toHaveLength(2000);
      expect(out.command as string).toMatch(/[^…]…$/);
    });
  });

  describe('ExitPlanMode', () => {
    it('keeps only the plan, truncated at 4000', () => {
      const out = compactPermissionInput('ExitPlanMode', { plan: 'z'.repeat(9000), extra: 'noise' })!;
      expect(Object.keys(out)).toEqual(['plan']);
      expect(out.plan).toHaveLength(4001);
      expect(out.plan as string).toMatch(/…$/);
    });
  });

  describe('secret redaction', () => {
    // notifications.json is durable AND rides the git-synced data repo, so a
    // token a model happened to paste into a Bash command must never land there.
    it('redacts an AWS secret out of a Bash command and its summary', () => {
      const command = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY aws s3 ls';
      const out = compactPermissionInput('Bash', { command })!;
      expect(out.command).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED] aws s3 ls');
      expect(out.command).not.toContain('wJalrXUtnFEMI');

      const summary = summarizePermissionRequest('Bash', { command });
      expect(summary).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED] aws s3 ls');
      expect(summary).not.toContain('wJalrXUtnFEMI');
    });

    it('redacts a bearer token out of a Bash command and its summary', () => {
      const command = 'curl -H Authorization: Bearer sk-live-abcdefghijklmnop https://api.example.com';
      const out = compactPermissionInput('Bash', { command })!;
      expect(out.command).toContain('Bearer [REDACTED]');
      expect(out.command).not.toContain('sk-live-abcdefghijklmnop');

      const summary = summarizePermissionRequest('Bash', { command });
      expect(summary).toContain('Bearer [REDACTED]');
      expect(summary).not.toContain('sk-live-abcdefghijklmnop');
    });

    it('redacts strings on the AskUserQuestion, default-tool, and preview paths too', () => {
      const ask = compactPermissionInput('AskUserQuestion', {
        questions: [{
          question: 'Use token=hunter2supersecret?',
          options: [{ label: 'password=letmein1234', description: 'secret=alsobad' }],
        }],
      })!;
      const q = (ask.questions as Array<Record<string, unknown>>)[0];
      expect(q.question).toBe('Use token=[REDACTED]');
      const opt = (q.options as Array<Record<string, unknown>>)[0];
      expect(opt.label).toBe('password=[REDACTED]');
      expect(opt.description).toBe('secret=[REDACTED]');

      const other = compactPermissionInput('WebFetch', { url: 'https://x/?api_key=abcdefg12345' })!;
      expect(other.url).toBe('https://x/?api_key=[REDACTED]');

      // The 8KB fallback preview is a serialized copy of the RAW input — redact it too.
      const big: Record<string, unknown> = { command: 'token=abcdefghijklmnop' };
      for (let i = 0; i < 40; i++) big[`k${i}`] = 'v'.repeat(3000);
      const preview = compactPermissionInput('SomeTool', big)!;
      expect(Object.keys(preview)).toEqual(['preview']);
      expect(preview.preview).toContain('token=[REDACTED]');
    });

    it('redacts a token embedded in a file path', () => {
      const out = compactPermissionInput('Write', { file_path: '/tmp/dl?token=abcdefghij/x.ts' })!;
      expect(out.file_path).toBe('/tmp/dl?token=[REDACTED]');
    });
  });

  describe('never throws (a dropped notification is worse than lost detail)', () => {
    it('survives a circular input', () => {
      const input: Record<string, unknown> = { name: 'loop' };
      input.self = input;
      expect(() => compactPermissionInput('SomeTool', input)).not.toThrow();
      const out = compactPermissionInput('SomeTool', input)!;
      expect(out).toBeTruthy();
      expect(out.name).toBe('loop');
      expect(out.self).toBe('[…]');
    });

    it('survives a 5000-deep input (used to RangeError before the size guard ran)', () => {
      const root: Record<string, unknown> = {};
      let cursor = root;
      for (let i = 0; i < 5000; i++) {
        const next: Record<string, unknown> = {};
        cursor.next = next;
        cursor = next;
      }
      expect(() => compactPermissionInput('SomeTool', root)).not.toThrow();
      expect(compactPermissionInput('SomeTool', root)).toBeTruthy();
    });

    it('survives a circular value nested under AskUserQuestion questions', () => {
      const question: Record<string, unknown> = { question: 'Which?', options: [] };
      question.parent = question;
      expect(() => compactPermissionInput('AskUserQuestion', { questions: [question] })).not.toThrow();
      const out = compactPermissionInput('AskUserQuestion', { questions: [question] })!;
      const q = (out.questions as Array<Record<string, unknown>>)[0];
      expect(q.question).toBe('Which?');
    });

    it('survives a getter that throws', () => {
      const input = {};
      Object.defineProperty(input, 'boom', {
        enumerable: true,
        get() { throw new Error('nope'); },
      });
      expect(() => compactPermissionInput('SomeTool', input)).not.toThrow();
      expect(compactPermissionInput('SomeTool', input)).toEqual({ preview: '[unserializable input]' });
    });
  });

  describe('AskUserQuestion', () => {
    it('preserves the question structure the answer form needs', () => {
      const input = {
        questions: [
          {
            question: 'Which database?',
            header: 'DB',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'relational' },
              { label: 'SQLite', description: 'embedded' },
            ],
          },
        ],
      };
      const out = compactPermissionInput('AskUserQuestion', input)!;
      const q = (out.questions as Array<Record<string, unknown>>)[0];
      expect(q.question).toBe('Which database?');
      expect(q.header).toBe('DB');
      expect(q.multiSelect).toBe(false);
      const options = q.options as Array<Record<string, unknown>>;
      expect(options).toHaveLength(2);
      expect(options[1]).toEqual({ label: 'SQLite', description: 'embedded' });
    });

    it('keeps question text + option labels VERBATIM (they are the answer-map identity)', () => {
      // buildAskUserAnswers keys the submitted answers map by q.question and uses
      // option.label as the value, and the server shallow-merges that map over
      // the CLI's ORIGINAL input — a truncated key/value silently mismatches and
      // the request reads as "the user answered nothing".
      const question = 'q'.repeat(900);
      const label = 'l'.repeat(900);
      const out = compactPermissionInput('AskUserQuestion', {
        questions: [{
          question,
          header: 'h'.repeat(900),
          options: [{ label, description: 'd'.repeat(900) }],
        }],
      })!;
      const q = (out.questions as Array<Record<string, unknown>>)[0];
      expect(q.question).toBe(question);
      // Non-identity strings still get cut.
      expect(q.header).toHaveLength(501);
      expect(q.header as string).toMatch(/…$/);
      const opt = (q.options as Array<Record<string, unknown>>)[0];
      expect(opt.label).toBe(label);
      expect(opt.description).toHaveLength(501);
      expect(opt.description as string).toMatch(/…$/);
    });

    it('bounds a huge verbatim question via the 8KB guard, not truncation', () => {
      // The identity strings are never cut, so the SIZE ceiling is the only
      // bound — it degrades the record to a preview, and the UI then offers
      // "Go to Session" (correct: the request isn't answerable in place).
      const out = compactPermissionInput('AskUserQuestion', {
        questions: [{ question: 'q'.repeat(9000), options: [] }],
      })!;
      expect(Object.keys(out)).toEqual(['preview']);
    });
  });

  describe('Write / Edit / NotebookEdit', () => {
    it('keeps file_path whole and previews the content at 400', () => {
      const out = compactPermissionInput('Write', {
        file_path: '/Users/me/repo/src/very/deep/path/to/file.ts',
        content: 'c'.repeat(5000),
      })!;
      expect(out.file_path).toBe('/Users/me/repo/src/very/deep/path/to/file.ts');
      expect(out.content).toHaveLength(401);
      expect(out.content as string).toMatch(/…$/);
    });

    it('previews old_string / new_string under the same keys', () => {
      const out = compactPermissionInput('Edit', {
        file_path: 'src/a.ts',
        old_string: 'o'.repeat(1000),
        new_string: 'n'.repeat(1000),
      })!;
      expect(Object.keys(out).sort()).toEqual(['file_path', 'new_string', 'old_string']);
      expect(out.old_string).toHaveLength(401);
      expect(out.new_string).toHaveLength(401);
    });

    it('handles NotebookEdit the same way', () => {
      const out = compactPermissionInput('NotebookEdit', {
        file_path: 'nb.ipynb', new_string: 'n'.repeat(600), cell_id: 'c1',
      })!;
      expect(out.file_path).toBe('nb.ipynb');
      expect(out.new_string).toHaveLength(401);
      expect(out.cell_id).toBeUndefined();
    });
  });

  describe('default tool', () => {
    it('keeps top-level entries, truncating strings at 1000', () => {
      const out = compactPermissionInput('WebFetch', {
        url: 'https://example.com',
        prompt: 'p'.repeat(4000),
        depth: 3,
        flag: true,
      })!;
      expect(out.url).toBe('https://example.com');
      expect(out.prompt).toHaveLength(1001);
      expect(out.depth).toBe(3);
      expect(out.flag).toBe(true);
    });
  });

  describe('8KB guard', () => {
    it('falls back to a 2000-char preview when the compacted result is still too big', () => {
      // 40 keys × 1000 chars each ≈ 40KB after default truncation.
      const input: Record<string, unknown> = {};
      for (let i = 0; i < 40; i++) input[`k${i}`] = 'v'.repeat(3000);

      const out = compactPermissionInput('SomeTool', input)!;
      expect(Object.keys(out)).toEqual(['preview']);
      expect(out.preview).toHaveLength(2000);
    });

    it('a normal input stays structured (guard does not fire)', () => {
      const out = compactPermissionInput('Bash', { command: 'echo hi' })!;
      expect(out.preview).toBeUndefined();
      expect(out.command).toBe('echo hi');
    });

    it('an oversized AskUserQuestion also degrades to a preview', () => {
      const questions = Array.from({ length: 40 }, () => ({
        question: 'q'.repeat(400),
        options: Array.from({ length: 6 }, () => ({ label: 'l'.repeat(200), description: 'd'.repeat(200) })),
      }));
      const out = compactPermissionInput('AskUserQuestion', { questions })!;
      expect(Object.keys(out)).toEqual(['preview']);
    });
  });
});

describe('summarizePermissionRequest', () => {
  it('Bash → the command, capped at 120', () => {
    expect(summarizePermissionRequest('Bash', { command: 'rm -rf /tmp/x' })).toBe('rm -rf /tmp/x');
    const long = summarizePermissionRequest('Bash', { command: 'a'.repeat(400) });
    expect(long).toHaveLength(121);
    expect(long).toMatch(/…$/);
  });

  it('AskUserQuestion → the first question text', () => {
    expect(summarizePermissionRequest('AskUserQuestion', {
      questions: [{ question: 'Which database?' }, { question: 'Second?' }],
    })).toBe('Which database?');
  });

  it('ExitPlanMode → a fixed label', () => {
    expect(summarizePermissionRequest('ExitPlanMode', { plan: 'do things' })).toBe('Plan ready for review');
  });

  it('Write / Edit / NotebookEdit → the file path (same set the compaction switch uses)', () => {
    expect(summarizePermissionRequest('Write', { file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(summarizePermissionRequest('Edit', { file_path: 'src/b.ts' })).toBe('src/b.ts');
    expect(summarizePermissionRequest('NotebookEdit', { file_path: 'nb.ipynb' })).toBe('nb.ipynb');
  });

  it('falls back to a generic line for anything else or a missing field', () => {
    expect(summarizePermissionRequest('WebFetch', { url: 'x' })).toBe('Needs permission approval');
    expect(summarizePermissionRequest('Bash', {})).toBe('Needs permission approval');
    expect(summarizePermissionRequest('Bash', undefined)).toBe('Needs permission approval');
    expect(summarizePermissionRequest('AskUserQuestion', { questions: [] })).toBe('Needs permission approval');
  });
});
