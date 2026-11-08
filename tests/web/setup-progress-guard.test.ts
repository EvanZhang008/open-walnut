import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../..');
const sources = [
  'web/src/components/common/SetupBanner.tsx',
  'web/src/components/common/HostProblemRows.tsx',
  'web/src/components/settings/sections/RemoteHostReadiness.tsx',
  'web/src/components/settings/sections/useLinkedHostRow.tsx',
  'web/src/components/common/FoundHostPrompts.tsx',
  'web/src/components/sessions/path-selector/HostConnectSteps.tsx',
  'web/src/components/settings/sections/SttSetupProgress.tsx',
  'web/src/components/settings/sections/SttModelRows.tsx',
  // The waiting message under a send that met "Claude Code is not installed" (review round 3:
  // it said only "Installing Claude Code" while the install ran for minutes).
  'web/src/components/sessions/AgentWaitNote.tsx',
];

function hasJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => { found ||= hasJsx(child); });
  return found;
}

function ownerOf(node: ts.Node): string {
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
  }
  return '<unnamed>';
}

function runningMembers(file: string): { owner: string; node: ts.Node }[] {
  const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { owner: string; node: ts.Node }[] = [];
  const running = (condition: ts.Node) => /\brunning\b|\bserverRunning\b|\bfixRunning\b|\bclaudeFix\b|\bisDownloading\b|\bisRunning\b/.test(condition.getText(source));
  const add = (node: ts.Node) => { if (hasJsx(node)) found.push({ owner: ownerOf(node), node }); };
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && running(node.expression)) add(node.thenStatement);
    if (ts.isConditionalExpression(node) && running(node.condition)) add(node.whenTrue);
    // `running && <jsx>`: the branch drawn while the fix runs (a `!running` test is the other branch).
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && running(node.left) && !/!\s*[\w?.]*\b(running|serverRunning|fixRunning|isDownloading|isRunning)\b/.test(node.left.getText(source))
      && (ts.isJsxElement(node.right) || ts.isJsxSelfClosingElement(node.right) || ts.isParenthesizedExpression(node.right))) add(node.right);
    // These two members render only progress, rather than branching to it.
    if (ts.isFunctionDeclaration(node) && ['FixProgress', 'HostConnectSteps'].includes(node.name?.text ?? '') && node.body) add(node.body);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('every running member of the setup progress surfaces', () => {
  it('enumerates the rendered running branches and requires a bar in each, including unclaimed host fixes', () => {
    const members = sources.flatMap((file) => runningMembers(file).map((member) => ({ file, ...member })));
    expect(members.map((m) => m.owner).sort()).toEqual([
      'FixRow', 'FixProgress', 'ProblemLine', 'ProblemLine', 'useLinkedHostRow', 'FoundHostReadiness',
      'HostConnectSteps', 'SttSetupProgress', 'ModelCatalogRows', 'QwenModelRow', 'AgentWaitNote',
    ].sort());
    // The one branch whose bar is on its host's row (useLinkedHostRow, FoundHostReadiness, both
    // listed above): Details then add only Check again, so the progress never shows twice.
    const rowShowsBar = (m: (typeof members)[number]) => m.file.endsWith('RemoteHostReadiness.tsx') && m.owner === 'ProblemLine'
      && /autofixProgressText/.test(m.node.getText()) && /<CheckAgainButton\b/.test(m.node.getText()) && !/\{p\.text\}|\$\{p\.text\}/.test(m.node.getText());
    expect(members.filter(rowShowsBar)).toHaveLength(1);
    for (const member of members.filter((m) => !rowShowsBar(m))) {
      expect(member.node.getText(), `${member.file}: ${member.owner} must show setup progress`).toMatch(/<SetupProgress\b/);
    }
  });

  it('lists every web file that draws the local Claude Code fix state (a new one must show the bar too)', () => {
    const drawsFix = (readdirSync(resolve(root, 'web/src'), { recursive: true }) as string[])
      .map((f) => `web/src/${f.split(sep).join('/')}`)
      .filter((f) => /\.tsx?$/.test(f) && !f.startsWith('web/src/utils/'))
      .filter((f) => readFileSync(resolve(root, f), 'utf8').includes('claudeBannerView('));
    expect(drawsFix.length).toBeGreaterThan(0);
    for (const file of drawsFix) expect(sources, `${file} draws a Claude Code fix: list it above`).toContain(file);
  });

  it('does not seed voice installs or downloads with a fabricated zero percentage', () => {
    const job = readFileSync(resolve(root, 'web/src/components/settings/sections/stt-setup-job.ts'), 'utf8');
    const models = readFileSync(resolve(root, 'web/src/components/settings/sections/SttModelRows.tsx'), 'utf8');
    expect(job).toMatch(/status: 'running', percent: null/);
    expect(job).not.toMatch(/status: 'running', percent: 0/);
    expect(models).toContain('setPercent(null)');
    expect(models).not.toContain('setPercent(0)');
    for (const file of sources.slice(4)) {
      expect(readFileSync(resolve(root, file), 'utf8')).not.toMatch(/percent\s*\?\?\s*0/);
    }
  });

  it('unknown progress animates normally and keeps a visible, static unknown bar with reduced motion', () => {
    const css = readFileSync(resolve(root, 'web/src/styles/setup-progress.css'), 'utf8');
    const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(css).toMatch(/data-progress='unknown'[\s\S]*?width:\s*35%;[\s\S]*?animation:\s*setup-progress-sweep/);
    expect(reduced).toMatch(/\.setup-progress-fill\s*\{\s*transition:\s*none;/);
    expect(reduced).toMatch(/data-progress='unknown'[\s\S]*?animation:\s*none;\s*transform:\s*translateX\(90%\)/);
    expect(css).toContain('overflow-wrap: anywhere');
  });
});
