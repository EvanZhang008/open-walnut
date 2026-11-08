import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('first-use defaults', () => {
  it('browser specs read file-tree disclosure state rather than an icon glyph', () => {
    const glyphReads = (file: string, text: string): string[] => {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const aliases = new Set<string>();
      const offenders: string[] = [];
      const refersToArrow = (node: ts.Node): boolean => node.getText(source).includes('.sfe-arrow')
        || (ts.isIdentifier(node) && aliases.has(node.text))
        || node.getChildren(source).some(refersToArrow);
      const bind = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && refersToArrow(node.initializer)) aliases.add(node.name.text);
        ts.forEachChild(node, bind);
      };
      bind(source);
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node)
          && ['toHaveText', 'toContainText', 'textContent', 'allTextContents', 'innerText'].includes(node.name.text)
          && refersToArrow(node.expression)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          offenders.push(`${file}:${line}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return offenders;
    };
    expect(glyphReads('probe.ts', "expect(row.locator('.sfe-arrow')).toHaveText('old');")).toHaveLength(1);
    expect(glyphReads('probe.ts', "const arrow = row.locator('.sfe-arrow'); expect(arrow).toContainText('old');")).toHaveLength(1);
    expect(glyphReads('probe.ts', "document.querySelector('.sfe-arrow').textContent;")).toHaveLength(1);
    expect(glyphReads('probe.ts', "expect(row.locator('.sfe-arrow')).toHaveAttribute('data-state', 'open');")).toEqual([]);
    const offenders: string[] = [];
    let scanned = 0;
    const scan = (dir: string) => {
      for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
        const file = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { scan(file); continue; }
        if (!/\.(?:ts|mts)$/.test(file)) continue;
        scanned++;
        offenders.push(...glyphReads(file, read(file)));
      }
    };
    scan('tests/e2e/browser');
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
  it('cancelled text uses the stored event text before a stale optimistic bubble', () => {
    const source = read('web/src/components/sessions/SessionPanel.tsx');
    const start = source.indexOf("useEvent('session:queued-cancelled'");
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf('setPrefillNonce', start));
    expect(handler).toContain("d.messages?.[i] !== undefined ? stripSendPrefixes(d.messages[i]) : bubble?.text ?? ''");
    expect(handler).not.toContain('bubble?.text ?? stripSendPrefixes');
  });
  it('Files opens the host home, while explicit file targets keep their path', () => {
    expect(read('web/src/components/sessions/SessionPanel.tsx')).toContain("cwd={fileViewTarget?.path ?? '~'}");
  });
  it('every first-visit board region starts folded once the board is known to hold work', () => {
    // The rule itself (and why an empty board keeps its regions open) is pinned in first-visit-folds.test.ts.
    const panel = read('web/src/components/tasks/TodoPanel.tsx');
    expect(panel).toContain('firstVisitFoldAll(');
    expect(panel).toContain('firstVisitFolds(tasks.length,');
  });
  it('native first-run setup keeps a bar visible with unknown progress and while starting the server', () => {
    const source = read('desktop/main.swift');
    const progress = source.slice(source.indexOf('    func showSetupProgress('), source.indexOf('    func showBootstrapScreen('));
    expect(progress).toContain('setupProgressBar?.isIndeterminate = true');
    expect(progress).toContain('setupProgressBar?.isIndeterminate = false');
    expect(progress).not.toContain('setupProgressBar?.isHidden = true');
    const starting = source.slice(source.indexOf('    func showLoadingScreen('), source.indexOf('    // MARK: - Server Management'));
    expect(starting).toContain('bar.style = .bar');
    expect(starting).toContain('bar.isIndeterminate = true');
  });
  it('every full top-level plan disclosure starts folded on first open', () => {
    const text = read('web/src/components/sessions/SessionMessage.tsx');
    const source = ts.createSourceFile('SessionMessage.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const plans: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && /PlanCard$/.test(node.name?.text ?? '')) plans.push(node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(plan).toContain('useRowDisclosure(disclosureId, false)');
  });
  it('the native sign-in bridge is main-frame loopback only and accepts no command from the page', () => {
    const source = read('desktop/ClaudeSignInBridge.swift');
    expect(source).toContain('message.frameInfo.isMainFrame');
    expect(source).toContain('origin.port == (page.port ?? 0)');
    expect(source).toContain('origin.host == consoleURL.host, origin.port == (consoleURL.port ?? 0)');
    expect(source).toContain('origin.host == "localhost" || origin.host == "127.0.0.1"');
    expect(source).toContain('message.body as? String == "sign-in"');
    expect(source).not.toContain('as? [String: Any]');
    for (const file of ['desktop/build.sh', 'desktop/build-release.sh']) expect(read(file)).toContain('ClaudeSignInBridge.swift');
    // The window tests compile every desktop/*.swift the app list gives, which never leaves it out.
    for (const file of ['scripts/test-desktop-popout.sh', 'scripts/test-desktop-update-windows.sh']) expect(read(file)).toContain('scripts/lib/desktop-app-sources.sh');
    const list = read('scripts/lib/desktop-app-sources.sh');
    expect(list).toContain('"$ROOT"/desktop/*.swift');
    expect(list).not.toContain('ClaudeSignInBridge');
  });
});
