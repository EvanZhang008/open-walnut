/**
 * Guard for the model-title rule (src/core/title-answer.ts). Every source file that reads a model's
 * answer AND writes a title must pass the answer through the rule (cleanTitleAnswer / screenTitle,
 * or a helper that does: titleViaBackendModel, cleanThreadTitle), or be listed below with why it
 * writes no title of a model's. A new title path fails here until it is one or the other.
 * 2026-11-11 review: a CLI error and a mock's first reply became task titles because only some
 * paths screened answers.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** A model's answer reaches this file. */
const MODEL_ANSWER = /\bsendMessage\(|titleViaBackendModel\(|askSideQuestion\(|generateSessionTitle\(|requestTurnCompleteSelfReport\(|callThreadAi\(/;
/** The file writes or returns a title. */
const TITLE_WRITE = /\btitle\s*[:=]|\{ title \}|\{ title,/;
/** The rule, or a helper that applies it. */
const RULE = /\bcleanTitleAnswer\(|\bscreenTitle\(|\btitleViaBackendModel\(|\bcleanThreadTitle\(/;

/** Files with both markers that write no model title, and why. */
const NOT_A_MODEL_TITLE: Record<string, string> = {
  'src/core/overview-maintainer.ts': 'a fixed "New skill: <name>" title; the model writes the overview body',
  'src/core/project-summary.ts': 'reads task titles into a project summary prompt; writes the summary',
  'src/core/task-ledger-desc.ts': 'reads the task title into a prompt; writes a description',
  'src/core/session-commit.ts': 'a commit or pull request title the session wrote for git, not a task title',
  'src/core/plugins/server-api.ts': 'lists op and task titles for plugins',
  'src/core/transfer/brief.ts': 'carries the task title into a transfer brief',
  'src/core/sessions/status-question.ts': 'shows the title in the status question; its answer sets no title',
  'src/core/sessions/session-extras.ts': 'a side thread row named by the question the person typed',
  'src/core/private-tasks/privacy-judge.ts': 'reads a title to judge privacy',
  'src/web/routes/chat.ts': 'a title field of a response type',
  'src/providers/claude-code-session.ts': 'the CLI channels themselves; their callers in builtins.ts apply the rule',
  'src/providers/acp-session.ts': 'the ACP channel itself; its caller in builtins.ts applies the rule',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('every model title goes through the title rule', () => {
  const candidates = sourceFiles(SRC)
    .map((file) => ({ rel: path.relative(ROOT, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') }))
    .filter(({ text }) => MODEL_ANSWER.test(text) && TITLE_WRITE.test(text));

  it('finds the known title paths (the scan still works)', () => {
    const rels = candidates.map((c) => c.rel);
    for (const known of ['src/core/session-hooks/builtins.ts', 'src/core/session-title-backend.ts',
      'src/core/sessions/thread-title.ts', 'src/core/conversation-title.ts', 'src/core/fork-title.ts']) {
      expect(rels).toContain(known);
    }
  });

  it('each one applies the rule or is listed with why it writes no model title', () => {
    const offenders = candidates
      .filter(({ rel, text }) => !RULE.test(text) && !(rel in NOT_A_MODEL_TITLE))
      .map((c) => c.rel);
    expect(offenders, 'apply cleanTitleAnswer/screenTitle from src/core/title-answer.ts, or list the file').toEqual([]);
  });

  it('the exemption list holds no file that is gone or now applies the rule', () => {
    for (const rel of Object.keys(NOT_A_MODEL_TITLE)) {
      const full = path.join(ROOT, rel);
      expect(fs.existsSync(full), rel).toBe(true);
      expect(RULE.test(fs.readFileSync(full, 'utf8')), `${rel} applies the rule: drop it from the list`).toBe(false);
    }
  });

  it('every session title channel screens its answer against the words it names', () => {
    const builtins = fs.readFileSync(path.join(SRC, 'core/session-hooks/builtins.ts'), 'utf8');
    for (const fn of ['titleViaSideQuestion', 'titleViaAcpSelfReport', 'titleViaCliTitler']) {
      const body = builtins.slice(builtins.indexOf(`async function ${fn}(`));
      const end = body.indexOf('\n}\n');
      expect(body.slice(0, end), fn).toMatch(/cleanTitleAnswer\([^)]*\{ words: message \}\)/);
    }
    const directive = builtins.slice(builtins.indexOf('export async function applyTitleDirective('));
    expect(directive.slice(0, directive.indexOf('\n}\n'))).toMatch(/screenTitle\(/);
    const backend = fs.readFileSync(path.join(SRC, 'core/session-title-backend.ts'), 'utf8');
    expect(backend).toMatch(/cleanTitleAnswer\(text, \{ words: message \}\)/);
  });
});
