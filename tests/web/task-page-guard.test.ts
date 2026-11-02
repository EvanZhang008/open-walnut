/**
 * Guard: there is no task page. A click on a task, from anywhere, opens it on Home.
 *
 * 2026-11-02, the user: "why I click task it open this page, nonono it should always,
 * anywhere, go to home page ... don't have this stupid page ... for ever". The separate
 * `/tasks/:id` page (TaskDetailPage) was reached from 30-odd places that each built the
 * path by hand (`navigate(\`/tasks/${id}\`)`, `window.open('/tasks/…', '_self')`, an
 * `href`), and every one of them dropped the user out of Home.
 *
 * The class: code in web/src that names a task by building `/tasks/<id>` itself. Every
 * member now goes through web/src/utils/task-path.ts (`taskPath` for an href or a deep link,
 * `openTaskOnHome` for a click), and `/tasks/:id` is a redirect shim that opens the task on
 * Home, so old links, notifications and outside deep links keep working. This test lists
 * every quoted `/tasks/` literal in web/src code and fails on one outside task-path.ts, and
 * pins the route to the shim and the page file to gone.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { taskIdOfPath, taskPath } from '../../web/src/utils/task-path';

const ROOT = join(__dirname, '../..');
const WEB_SRC = join(ROOT, 'web/src');
/** The one file that may spell the path. */
const OWNER = 'utils/task-path.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * The text of every string and template part in a file, read by the TypeScript parser, so
 * comments (prose about `/tasks/:id`) are not members and nothing in a string is mistaken for one
 * (a regex that strips comments also strips `accept="image/*"` and what follows it).
 */
function literals(file: string, text: string): Array<{ line: number; text: string; after?: string }> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; text: string; after?: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      out.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.text });
    }
    // A template literal's head, middles and tail are not reached through forEachChild alone.
    // A template's middle or tail is read with the expression before it (`${origin}/tasks/`).
    if (ts.isTemplateExpression(node)) {
      visit(node.head);
      for (const span of node.templateSpans) {
        visit(span.expression);
        out.push({ line: source.getLineAndCharacterOfPosition(span.literal.getStart(source)).line + 1, text: span.literal.text, after: span.expression.getText(source) });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * A literal that names a task by path: `/tasks/` at its start (`'/tasks/' + id`, `\`/tasks/${id}\``),
 * or right after a host (`'https://x/tasks/1'`). `/api/tasks/…` and `/api/v1/tasks/…` are the API,
 * not a link; so is `${itemRoute(...)}/tasks/${id}`: a template part after an expression counts only
 * when that expression is an origin or a base URL (`${location.origin}/tasks/${id}`).
 */
const PATH_START = /^\/tasks\/|:\/\/[^/\s]+\/tasks\//;
const ORIGIN_EXPR = /origin|baseUrl|baseURL|BASE_URL|appUrl|host/;
const handBuilt = (lit: { text: string; after?: string }): boolean =>
  PATH_START.test(lit.text) && (lit.after === undefined || ORIGIN_EXPR.test(lit.after) || /:\/\//.test(lit.text));
/** The shim's own route, the one other place the path is spelled (pinned by the last test). */
const SHIM_ROUTE = { file: 'App.tsx', text: '/tasks/:id' };

describe('no task page', () => {
  it('builds `/tasks/<id>` only in utils/task-path.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const rel = relative(WEB_SRC, file);
      if (rel === OWNER) continue;
      for (const lit of literals(file, readFileSync(file, 'utf8'))) {
        if (!handBuilt(lit)) continue;
        if (rel === SHIM_ROUTE.file && lit.text === SHIM_ROUTE.text) continue;
        offenders.push(`web/src/${rel}:${lit.line}: ${JSON.stringify(lit.text)}`);
      }
    }
    // A link's href uses taskPath(id); a click calls openTaskOnHome(id, navigate)
    // (utils/open-session.ts), which selects the task on Home and opens its session.
    expect(offenders).toEqual([]);
  });

  it('finds a hand-built path when one appears, and only then', () => {
    const hits = (code: string) => literals('x.tsx', code).filter(handBuilt).length;
    expect(hits('navigate(`/tasks/${task.id}`);')).toBe(1);
    expect(hits("window.open('/tasks/' + id, '_self')")).toBe(1);
    expect(hits('const a = <a href="/tasks/abc">x</a>;')).toBe(1);
    expect(hits('const u = `${location.origin}/tasks/${id}`;')).toBe(1);
    expect(hits("const u = 'https://walnut.example/tasks/1';")).toBe(1);
    expect(hits('// see `/tasks/:id`\nconst x = 1;')).toBe(0);
    expect(hits('fetch(`/api/tasks/${id}`); fetch(`/api/v1/tasks/${id}/board`);')).toBe(0);
    expect(hits('apiGet(`${itemRoute(letterId, itemId)}/tasks/${encodeURIComponent(id)}`);')).toBe(0);
    // A string with a glob in it hides nothing after it.
    expect(hits('const i = <input accept="image/*" />;\nnavigate(`/tasks/${id}`);')).toBe(1);
  });

  it('routes /tasks/:id to the shim that opens the task on Home, and the page is gone', () => {
    const app = readFileSync(join(WEB_SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/<Route path="\/tasks\/:id" element={<TaskRedirect \/>} \/>/);
    expect(app).toMatch(/function TaskRedirect\(\)[\s\S]*?openTaskOnHome\(id,/);
    expect(existsSync(join(WEB_SRC, 'pages/TaskDetailPage.tsx'))).toBe(false);
    const importers = sourceFiles(WEB_SRC).filter((f) => /from ['"][^'"]*TaskDetailPage['"]|PopoutTaskDetail/.test(readFileSync(f, 'utf8')));
    expect(importers.map((f) => relative(WEB_SRC, f))).toEqual([]);
  });

  it('names a task path one way and reads it back', () => {
    expect(taskPath('mvm0n3bu-6910')).toBe('/tasks/mvm0n3bu-6910');
    expect(taskPath('a b/c')).toBe('/tasks/a%20b%2Fc');
    expect(taskIdOfPath(taskPath('a b/c'))).toBe('a b/c');
    expect(taskIdOfPath('/tasks/x1?from=inbox')).toBe('x1');
    expect(taskIdOfPath('/tasks')).toBeNull();
    expect(taskIdOfPath('/tasks/x1/board')).toBeNull();
  });
});
