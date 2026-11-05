/**
 * Guard: the label of a switch or checkbox holds only that toggle's own words.
 *
 * 2026-11-02: in Settings › Task providers the card head's provider name and icon were the
 * <label> of the sync check's switch, so a click on "Microsoft To-Do" turned its check on, and
 * Walnut then kept nine of the user's tasks out of To Do. Settings › Remote Hosts had the same
 * trap: a click on a host's name started or stopped a Walnut server on it. A click meant for a
 * name, an icon, a badge or a summary must never flip a setting.
 *
 * The class: every <label> that wraps a toggle (ToggleSwitch, a checkbox, a role=switch or
 * role=checkbox control), every row whose `label` names a toggle through `htmlFor` (SettingsRow
 * and the rest), and every SettingsCheckbox (a checklist row whose whole row is its label). This
 * test finds every member in web/src and reads what its label holds. Text is fine: words written
 * there, or fixed text from an UPPER_CASE table. Anything else fails: a component (an icon, a
 * badge), an image, a link or button, or words read from data, unless listed below with why they
 * are the toggle's own words (a field's own title, an option in a picker whose ticks take effect
 * only through a button). A new member fails here until someone decides which it is; the fix is
 * to take the label off (the toggle keeps an aria-label) or to keep the name outside it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const WEB_SRC = join(__dirname, '../../web/src');

/** Elements that only carry text. */
const TEXT_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'small', 'code', 'kbd', 'br', 'abbr']);

/** Words read from data that are the toggle's own words, by `file#expression`, and why. */
const OWN_WORDS: Record<string, string> = {
  'components/settings/sections/PluginConfigCards.tsx#label': 'a plugin settings field: the field\'s own title from its schema',
  'components/settings/sections/HooksSection.tsx#s.label': 'a hook\'s boolean setting: the setting\'s own title from the hook',
  'components/settings/sections/ReplicaCopyRows.tsx#row.label': 'what the companion keeps a copy of ("Notes"): the switch\'s own words',
  'components/settings/sections/CalendarSection.tsx#display.name': 'a checklist of calendars to show: the calendar\'s name is the option, and showing it is all the tick does',
  'components/settings/sections/SecretsGroup.tsx#tickLabel(h)': 'a picker of hosts to give a secret to (This Mac\'s own sessions, or a host to copy it to): taken only by Save',
  'components/agents/AgentForm.tsx#def.label': 'a picker of context sources in the agent form: taken only by Save',
  'components/tasks/TasksColumnsMenu.tsx#def.label': 'a column picker: the column\'s name is the option',
  'components/org/OrgInlineAnswer.tsx#o.label': 'an answer option the user picks: its text is the option',
  'components/passwords/GeneratorPanel.tsx#label': 'a character class the password generator uses (A-Z, 0-9): the option\'s own name',
  'components/sessions/SessionRewindDialog.tsx#fileStats': 'how many files the option restores, part of its sentence; taken only by Rewind',
  'components/sessions/SessionRewindDialog.tsx#filesReason': 'why the option is off, part of its sentence',
  'components/sessions/SessionCommitRepo.tsx#hunk.newStart + 1': 'a picker of changes to commit: where the change is; taken only by Commit',
  'components/sessions/SessionCommitRepo.tsx#hunk.newLines.length': 'a picker of changes to commit: its size',
  'components/sessions/SessionCommitRepo.tsx#hunk.oldLines.length': 'a picker of changes to commit: its size',
  'apps/mail/MailGroupCard.tsx#filterMoveNowLabel(request.unread)': 'the checkbox\'s own sentence ("Also move the 3 unread now"); taken only by the card\'s button',
  'apps/mail/MailUnsubscribePlanRow.tsx#item.label': 'a picker of senders to unsubscribe from: taken only by the plan\'s button',
  'apps/mail/MailUnsubscribePlanRow.tsx#methodText(item)': 'a picker of senders: how the unsubscribe goes',
  'apps/mail/MailUnsubscribePlanRow.tsx#formatCount(item.mails)': 'a picker of senders: how many mails',
  // The shared components: their callers' props are checked at each caller.
  'components/settings/inputs/SettingsCheckbox.tsx#label': 'checked at each caller',
  'components/settings/inputs/SettingsCheckbox.tsx#leading': 'checked at each caller',
  'components/settings/inputs/SettingsCheckbox.tsx#trailing': 'checked at each caller',
};

/** Elements, beyond text, a toggle's label may hold, by `file#tag`, and why. */
const OWN_PARTS: Record<string, string> = {
  'components/settings/inputs/SettingsCheckbox.tsx#CheckGlyph': 'the checkbox\'s own drawn box',
  'components/sessions/SessionCommitRepo.tsx#OwnerBadge': 'a picker of changes to commit: whose change it is; taken only by Commit',
  'components/settings/sections/CalendarSection.tsx#SettingsTag': 'a calendar the checklist shows: its Read only tag',
};

/** A SettingsCheckbox prop that is part of its label (the whole row is a <label>). */
const CHECKBOX_LABEL_PROPS = ['label', 'leading', 'trailing'];
/** Elements a SettingsCheckbox caller may pass in leading/trailing: a colour dot, or a field of its own. */
const CHECKBOX_SLOT_TAGS = new Set(['input']);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
const tag = (n: Opening) => n.tagName.getText();
const attr = (n: Opening, name: string) =>
  n.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
const textOf = (a: ts.JsxAttribute | undefined) => a?.initializer?.getText() ?? '';

/** The toggle itself: a switch or checkbox element. */
function isToggleElement(n: Opening): boolean {
  const t = tag(n);
  if (/^(?:ToggleSwitch|SwitchRow|\w*Checkbox|\w*Switch)$/.test(t)) return true;
  if (t === 'input' && /checkbox/.test(textOf(attr(n, 'type')))) return true;
  return /^["'{`]*(?:switch|checkbox)/.test(textOf(attr(n, 'role')));
}

function holdsToggle(node: ts.Node): boolean {
  let hit = false;
  const visit = (x: ts.Node) => {
    if (hit) return;
    if ((ts.isJsxOpeningElement(x) || ts.isJsxSelfClosingElement(x)) && isToggleElement(x)) { hit = true; return; }
    ts.forEachChild(x, visit);
  };
  visit(node);
  return hit;
}

/** Fixed text: a string, or a lookup in an UPPER_CASE table (`SOURCE_LABELS[source]`, `MODE_COPY[m].help`). */
function fixedText(e: ts.Expression): boolean {
  let root: ts.Expression = e;
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
  return ts.isIdentifier(root) && /^[A-Z][A-Z0-9_]+$/.test(root.text);
}

/** What a label holds beyond its own words: one line per part. */
function extras(node: ts.Node, rel: string, slotTags: Set<string> = new Set()): string[] {
  const out: string[] = [];
  const expr = (e: ts.Expression) => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) return;
    if (e.kind === ts.SyntaxKind.UndefinedKeyword || e.kind === ts.SyntaxKind.NullKeyword) return;
    if (ts.isIdentifier(e) && e.text === 'undefined') return;
    if (ts.isParenthesizedExpression(e)) return expr(e.expression);
    if (ts.isConditionalExpression(e)) { expr(e.whenTrue); expr(e.whenFalse); return; }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) { expr(e.right); return; }
    if (ts.isTemplateExpression(e)) { for (const s of e.templateSpans) expr(s.expression); return; }
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) { visit(e); return; }
    if (fixedText(e)) return;
    const text = e.getText();
    if (!OWN_WORDS[`${rel}#${text}`]) out.push(`words from data: {${text}}`);
  };
  const visit = (x: ts.Node) => {
    if (ts.isJsxText(x)) return;
    if (ts.isJsxExpression(x)) { if (x.expression) expr(x.expression); return; }
    if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x)) {
      const open = ts.isJsxElement(x) ? x.openingElement : x;
      if (isToggleElement(open)) return;
      const t = tag(open);
      if (slotTags.has(t)) return;
      if (!TEXT_TAGS.has(t) && !OWN_PARTS[`${rel}#${t}`]) { out.push(`<${t}>`); return; }
      if (ts.isJsxElement(x)) x.children.forEach(visit);
      return;
    }
    if (ts.isJsxFragment(x)) { x.children.forEach(visit); return; }
    if (ts.isExpression(x)) expr(x);
  };
  visit(node);
  return out;
}

interface Member { where: string; extras: string[] }

/** Every toggle label in one source file, and what each holds beyond its own words. */
function scan(rel: string, text: string): Member[] {
  const out: Member[] = [];
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const at = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    // A <label> wrapping a toggle: everything in it but the toggle is its label.
    if (ts.isJsxElement(n) && tag(n.openingElement) === 'label' && holdsToggle(n)) {
      out.push({ where: at(n), extras: n.children.flatMap((c) => extras(c, rel)) });
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const label = attr(n, 'label');
      const control = attr(n, 'control');
      if (tag(n) === 'SettingsCheckbox') {
        // The whole row is the checkbox's label: its label, leading and trailing are.
        const parts = CHECKBOX_LABEL_PROPS.map((p) => attr(n, p)?.initializer).filter((v): v is ts.JsxAttributeValue => !!v);
        out.push({ where: at(n), extras: parts.flatMap((v) => (ts.isStringLiteral(v) ? [] : extras(v, rel, CHECKBOX_SLOT_TAGS))) });
      } else if (label?.initializer && attr(n, 'htmlFor') && control && holdsToggle(control)) {
        // A row naming its toggle control through htmlFor: its label prop is the label.
        out.push({ where: at(n), extras: extras(label.initializer, rel) });
      } else if (isToggleElement(n) && label?.initializer && !ts.isStringLiteral(label.initializer)) {
        // A toggle with its own inline label.
        out.push({ where: at(n), extras: extras(label.initializer, rel) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

describe('a toggle\'s label holds only its own words', () => {
  const all = files(WEB_SRC).flatMap((f) => scan(relative(WEB_SRC, f), readFileSync(f, 'utf8')));

  it('finds the toggles (the scan still reads the source)', () => {
    expect(all.length).toBeGreaterThan(40);
  });

  it('no label of a switch or checkbox holds a name, icon, badge or summary', () => {
    const bad = all.filter((m) => m.extras.length).map((m) => `${m.where}: ${m.extras.join(', ')}`);
    expect(bad.join('\n')).toBe('');
  });

  it('catches the two traps it was written for', () => {
    // Settings › Task providers before the fix: the provider's icon and name labelled the check.
    const providers = scan('components/settings/sections/TaskProvidersSection.tsx', `
      const x = <SettingsRow
        label={<span className="tp-name"><PluginIcon name={p.name} />{p.name}</span>}
        htmlFor={id('check')}
        control={<ToggleSwitch id={id('check')} checked={on} onChange={check.set} />} />`);
    expect(providers.map((m) => m.extras)).toEqual([['<PluginIcon>', 'words from data: {p.name}']]);
    // Settings › Remote Hosts before the fix: the host's name labelled its server's switch.
    const hosts = scan('components/settings/sections/HostServersGroup.tsx', `
      const x = <SettingsRow label={host.label} htmlFor={\`host-server-enabled-\${host.hostKey}\`}
        control={<span><ToggleSwitch id={\`host-server-enabled-\${host.hostKey}\`} checked={on} onChange={set} /></span>} />`);
    expect(hosts.map((m) => m.extras)).toEqual([['words from data: {host.label}']]);
    // A checklist row passing an icon beside its words fails too; plain words pass.
    expect(scan('x.tsx', 'const a = <SettingsCheckbox label={<span><BellIcon />Mentions</span>} checked onChange={f} />')[0].extras).toEqual(['<BellIcon>']);
    expect(scan('x.tsx', 'const a = <SettingsRow label="Focus bar" htmlFor="f" control={<ToggleSwitch id="f" checked onChange={f} />} />')[0].extras).toEqual([]);
  });

  it('every listed exception still exists', () => {
    const src = new Map<string, string>();
    for (const key of [...Object.keys(OWN_WORDS), ...Object.keys(OWN_PARTS)]) {
      const [file, what] = key.split('#');
      if (!src.has(file)) src.set(file, readFileSync(join(WEB_SRC, file), 'utf8'));
      expect(src.get(file)!.includes(what), key).toBe(true);
    }
  });
});
