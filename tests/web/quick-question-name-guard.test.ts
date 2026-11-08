import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');

function files(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(rel) : /\.(ts|tsx|swift)$/.test(entry.name) ? [rel] : [];
  });
}

const storedProjectOwners = new Set([
  'web/src/components/chat/ask-walnut-slot-model.ts',
  'web/src/components/sessions/draft-column.ts',
]);

const otherMainWords = new Map([
  ['web/src/utils/task-title-absorb.ts|Main', 'Legacy task title recognition'],
  ['web/src/components/chat/AskWalnutDrawer.tsx|Main', 'Legacy CEO search alias'],
  ['web/src/components/chat/ChatMessage.tsx|**Main AI Notification:**', 'Legacy transcript marker'],
  ['web/src/utils/tree-split-state.ts|Main', 'Root conversation, not the CEO'],
  ['web/src/components/sessions/ThreadStackCrumbs.tsx|Main', 'Root conversation, not the CEO'],
  ['web/src/components/sessions/ThreadStackHeader.tsx|Main', 'Root conversation, not the CEO'],
]);

describe('quick question and CEO display names', () => {
  it('no web source introduces the retired feature name outside stored project keys', () => {
    const found: string[] = [];
    for (const file of ['web/src', 'packages/browser-extension/src'].flatMap(files)) {
      const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const retiredQuestion = /\bAsk Walnut\b/i.test(node.text);
          const internalMain = ts.isStringLiteralLike(node) && node.text === 'main';
          const otherMain = otherMainWords.has(`${file}|${node.text}`);
          const retiredMain = !internalMain && !otherMain && /(?:^Main$|\b(?:Tell|Open) Main\b|\bMain (?:[Aa]gent|AI|is waiting|did not|and|or)\b|\bto Main\b)/.test(node.text.trim());
          if (retiredQuestion || retiredMain) {
            const stored = node.text === 'Ask Walnut' && storedProjectOwners.has(file);
            if (!stored) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(found, 'Use Quick question and CEO in visible copy, including Quick Input and the browser extension. Keep stored Ask projects and internal main ids unchanged.').toEqual([]);
  });

  it('the extension build keeps the retired feature name out of its store description', () => {
    const build = readFileSync(path.join(root, 'scripts/build-extension.mjs'), 'utf8');
    expect(build).not.toMatch(/\bAsk Walnut\b/i);
  });

  it('no native UI label reintroduces Ask Walnut or Main', () => {
    const found: string[] = [];
    for (const file of files('ios-native/Walnut')) {
      const source = readFileSync(path.join(root, file), 'utf8');
      source.split('\n').forEach((line, index) => {
        const text = line.trim();
        if (text.startsWith('//')) return;
        if (/(?:Text|Label|Button|navigationTitle)\(\s*"[^"\n]*(?:Ask Walnut|\bMain\b)/.test(text)) {
          found.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(found, 'Native labels use Quick question and CEO; stored projects and main ids stay unchanged.').toEqual([]);
  });

  it('native detail edits keep the raw title and session rows know the owning project', () => {
    const detail = readFileSync(path.join(root, 'ios-native/Walnut/Views/Tasks/TaskDetailSheet.swift'), 'utf8');
    expect(detail).toContain('titleDraft = current.title');
    expect(detail).toContain('next != current.title');
    expect(detail).toContain('SessionRowView(session: session, project: current.project, orgRole: current.orgRole)');
    const rows = readFileSync(path.join(root, 'ios-native/Walnut/Views/Tasks/SessionRows.swift'), 'utf8');
    expect(rows).toContain('AskProjectName.displayTitle(session.rowTitle, project: session.project ?? project, orgRole: orgRole)');
    const search = readFileSync(path.join(root, 'ios-native/Walnut/Views/Tasks/GlobalSearchSection.swift'), 'utf8');
    expect(search).toContain('result.type == "task" ? task?.title ?? result.title : result.title');
    const picker = readFileSync(path.join(root, 'ios-native/Walnut/Views/Tasks/TaskProjectPicker.swift'), 'utf8');
    expect(picker).toContain('TextField("Search or new project name", text: $query)');
    expect(picker).not.toContain('.searchable(');
    expect(picker).toContain('VStack(spacing: 0)');
    expect(picker.indexOf('TextField("Search or new project name"')).toBeLessThan(picker.indexOf('ScrollViewReader'));
    expect(picker).not.toContain('.safeAreaInset(');
    expect(picker).not.toContain('searchFocused');
    expect(picker).not.toContain('.simultaneousGesture(');
    const flow = readFileSync(path.join(root, 'ios-native/WalnutUITests/QuickQuestionRenameUITests.swift'), 'utf8');
    expect(flow).toContain('the project search did not focus after one tap');
    expect(flow).toContain('the reopened project search did not focus after one tap');
    expect(flow).not.toContain('search.coordinate(');
    expect(flow).not.toContain('rawSearch.coordinate(');
    expect(flow).toContain('the project search keyboard disappeared before typing');
    expect(flow).toContain('XCTAssertEqual(search.value as? String, "Quick question")');
    expect(flow).toContain('XCTAssertEqual(rawSearch.value as? String, "Ask Walnut")');
  });

  it('the native task page raises every sheet from its root, never from inside its scroll content', () => {
    // 2026-11-08, lane B simulator logs: the project picker, raised from the properties card inside
    // the task page's ScrollView, was torn down and rebuilt the moment its search field took focus,
    // so the first tap never kept the keyboard and the list jumped to the top. Raised from the
    // page's root it kept its state. Every view the scroll content holds is checked, so a new one
    // that raises its own sheet fails here.
    const sheetFile = 'ios-native/Walnut/Views/Tasks/TaskDetailSheet.swift';
    const detail = readFileSync(path.join(root, sheetFile), 'utf8');
    const scrollStart = detail.indexOf('ScrollView {');
    const scrollEnd = detail.indexOf('            .task {', scrollStart);
    expect(scrollStart).toBeGreaterThan(0);
    expect(scrollEnd).toBeGreaterThan(scrollStart);
    const raises = /\.(?:sheet|fullScreenCover)\(/g;
    for (const m of detail.matchAll(raises)) {
      expect(m.index! > scrollEnd, `${sheetFile} raises a sheet inside its scroll content`).toBe(true);
    }
    for (const raise of ['$showProjectPicker', '$fieldEdit', '$openedTask']) expect(detail).toContain(raise);
    const content = detail.slice(scrollStart, scrollEnd);
    const viewNames = [...new Set([...content.matchAll(/^\s+([A-Z][A-Za-z]+)\(/gm)].map((m) => m[1]))]
      .filter((name) => !['Label', 'Text', 'VStack', 'HStack', 'Button', 'Image', 'Spacer'].includes(name));
    expect(viewNames).toEqual(expect.arrayContaining(['TaskStatusCard', 'TeamStatusSection', 'TaskMetaCaptions', 'TaskDetailExtras']));
    const swiftFiles = files('ios-native/Walnut').filter((f) => f.endsWith('.swift'));
    const structSource = (name: string): string => {
      for (const file of swiftFiles) {
        const text = readFileSync(path.join(root, file), 'utf8');
        const at = text.search(new RegExp(`^struct ${name}\\b`, 'm'));
        if (at < 0) continue;
        const next = text.slice(at + 1).search(/^(?:struct|final class|class|enum|extension) /m);
        return next < 0 ? text.slice(at) : text.slice(at, at + 1 + next);
      }
      throw new Error(`no struct ${name} in ios-native/Walnut`);
    };
    // The properties card is drawn through the page's own builder; its view is checked too.
    for (const name of [...viewNames, 'TaskPropertiesList', 'TaskPropertyCard']) {
      expect(structSource(name), `${name} sits in the task page's scroll content and raises its own sheet`).not.toMatch(/\.(?:sheet|fullScreenCover)\(/);
    }
  });

  it('native task title views do not render stored task or session titles directly', () => {
    const found: string[] = [];
    for (const file of files('ios-native/Walnut/Views')) {
      readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, index) => {
        if (line.trim().startsWith('//')) return;
        if (/Text\(\s*(?:verbatim:\s*)?(?:current\.title|(?:[\w.]+\.)?task\.title|session\.rowTitle|relative\.title|taskTitle)\s*\)/.test(line)) {
          found.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(found, 'Task title text uses AskProjectName.displayTitle; edit buffers and stored values stay raw.').toEqual([]);
  });

  it('creates the main task as CEO and keeps its automated title stable', () => {
    const store = readFileSync(path.join(root, 'src/core/org/org-store.ts'), 'utf8');
    expect(store).toMatch(/MAIN_TASK_TITLE\s*=\s*'CEO'/);
    const titles = readFileSync(path.join(root, 'src/core/session-hooks/builtins.ts'), 'utf8');
    expect(titles).toMatch(/fresh\.org_role === 'main'\) return/);
  });
});
