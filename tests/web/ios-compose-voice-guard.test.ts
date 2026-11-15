import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '../../ios-native/Walnut');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.swift') ? [path] : [];
  });
}

/** Keep positions while masking Swift strings/comments for brace matching. */
function mask(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g, (s) => s.replace(/[^\n]/g, ' '));
}

function closeAt(code: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    if (code[i] === open) depth++;
    if (code[i] === close && --depth === 0) return i;
  }
  return code.length;
}

const nativeTypes = new Set(['UITextField', 'UITextView']);
const appSources = sources(ROOT).map((path) => readFileSync(path, 'utf8'));
for (let changed = true; changed;) {
  changed = false;
  for (const source of appSources) {
    for (const match of mask(source).matchAll(/\bclass\s+(\w+)\s*:\s*(\w+)/g)) {
      if (nativeTypes.has(match[2]) && !nativeTypes.has(match[1])) { nativeTypes.add(match[1]); changed = true; }
    }
  }
}
const inputCall = new RegExp(`\\b(?:TextField|TextEditor|${[...nativeTypes].join('|')})\\s*\\(`, 'g');

interface Field { file: string; call: string; line: number; covered: boolean }
function fields(source: string, file: string): Field[] {
  const code = mask(source);
  const inputs = [...code.matchAll(inputCall)];
  const wrappers: Array<{ start: number; end: number; binding: string }> = [];
  for (const match of code.matchAll(/\bVoiceDictationField\s*\(/g)) {
    const paren = code.indexOf('(', match.index);
    const after = closeAt(code, paren, '(', ')');
    const brace = code.indexOf('{', after);
    const binding = code.slice(paren, after).match(/\btext:\s*([^,\n]+)/)?.[1]?.replace(/\s/g, '') ?? '';
    wrappers.push({ start: match.index!, end: closeAt(code, brace, '{', '}'), binding });
  }
  return inputs.map((match) => {
    const at = match.index!;
    const start = code.indexOf('(', at);
    const end = closeAt(code, start, '(', ')');
    return {
      file, line: source.slice(0, at).split('\n').length,
      call: source.slice(at, end + 1).replace(/\s+/g, ' ').trim(),
      covered: wrappers.some(({ start: a, end: b, binding }) => {
        if (!(at > a && at < b) || inputs.filter((m) => m.index! > a && m.index! < b).length !== 1) return false;
        const actual = code.slice(start, end).match(/\btext:\s*([^,\n]+)/)?.[1]?.replace(/\s/g, '') ?? '';
        // Calendar's display binding maps the underlying project string.
        return binding !== '' && (binding === actual || (actual.startsWith('Binding(') && /\bproject\s*=/.test(code.slice(start, end)) && binding === '$project'));
      }),
    };
  });
}

/** Exact fields, not whole files: adding another input alongside one still fails. */
const EXCLUSIONS: Record<string, string> = {
  'Views/SetupView.swift|TextField(text: $serverURL, prompt: Text(verbatim: "https://wn.example.com"))': 'The server origin is an exact URL, not dictated prose.',
  'Views/SetupView.swift|TextField("e.g. iPhone", text: $deviceName)': 'A device identifier is entered during pairing, not a request to Walnut.',
  'Views/Passwords/PasswordsSetupView.swift|TextField("Secret Key (W1-…)", text: $secretKey)': 'Credential material must never be sent to speech transcription.',
  'Views/Sessions/NewSessionSheet.swift|TextField("/path/to/project", text: $path)': 'An exact filesystem path is selected by the path picker.',
  'Views/Sessions/SessionPathPicker.swift|TextField("/path/to/project, or a name to search", text: $text)': 'An exact working-directory path, not a natural language request.',
  'Views/Settings/RoutineEditor.swift|TextField("sh ~/check.sh", text: $draft.checkRun, axis: .vertical)': 'This is executable shell code whose spelling must stay exact.',
  'Views/Settings/RoutineEditor.swift|TextField("30", text: intervalText)': 'A numeric interval is not speech prose.',
  'Views/Settings/RoutineEditor.swift|TextField("minute hour day month weekday", text: $draft.cronExpr)': 'A cron expression is exact scheduling syntax.',
};

/** Custom input implementations already owned by the shared recorder/editor. */
const DELEGATED: Record<string, { count: number; marker: string; owner?: string; why: string }> = {
  'Views/Chat/ComposerView.swift': { count: 1, marker: 'VoiceRecorder()', why: 'The chat composer owns the shared recorder and recording controls.' },
  'Views/Inbox/LetterReplyField.swift': { count: 1, owner: 'Views/Inbox/LetterReaderView.swift', marker: 'VoiceMicButton(voice: voice', why: 'The UIKit reply field is hosted by LetterReaderView with the shared mic.' },
  'Views/Chat/LongDraftEditor.swift': { count: 1, owner: 'Views/Chat/ComposerView.swift', marker: 'VoiceRecorder()', why: 'The expanded chat draft retains ComposerView and its shared recorder controls.' },
  'Markdown/WysiwygEditor.swift': { count: 1, marker: 'dictation?.attach(textView)', why: 'The rich editor attaches the shared EditorDictationBridge at the caret.' },
  'Markdown/TableInlineEditor.swift': { count: 1, marker: 'dictation?.micTapped(in:', why: 'The table cell uses the rich editor shared dictation bridge, not another recorder.' },
  'Timeline/TimelineTextCells.swift': { count: 3, marker: 'isEditable = false', why: 'Transcript cells are read-only text views, not compose inputs.' },
};

const files = sources(ROOT).map((path) => ({ file: relative(ROOT, path), source: readFileSync(path, 'utf8') }));
const inventory = files.flatMap(({ file, source }) => fields(source, file));

const SEARCH_EXCLUSIONS: Record<string, string> = {
  'Views/Passwords/PasswordsHomeView.swift': 'Password searches can contain secrets or account identifiers and must stay outside speech transcription.',
  'Views/Sessions/Changes/DiffReviewViews.swift': 'This filter matches exact branch names and commit identifiers, not a request to Walnut.',
};

describe('every iOS compose field uses the shared voice input', () => {
  it('scans the app and the originally missed thread follow-up', () => {
    expect(inventory.length).toBeGreaterThan(30);
    const followUp = inventory.find((f) => f.file === 'Views/Org/OrgThreadsView.swift' && f.call === 'TextEditor(text: text)');
    expect(followUp?.covered).toBe(true);
  });

  it('has no uncovered field, including new fields in an already covered file', () => {
    const missing = inventory.filter((f) => !f.covered && !EXCLUSIONS[`${f.file}|${f.call}`] && !DELEGATED[f.file]);
    expect(missing.map((f) => `${f.file}:${f.line}: ${f.call}`)).toEqual([]);
  });

  it('keeps exclusions exact and custom delegates counted', () => {
    const keys = new Set(inventory.map((f) => `${f.file}|${f.call}`));
    for (const [key, reason] of Object.entries(EXCLUSIONS)) {
      expect(keys.has(key), `obsolete exclusion: ${key}`).toBe(true);
      expect(reason.length).toBeGreaterThan(30);
    }
    for (const [file, entry] of Object.entries(DELEGATED)) {
      expect(inventory.filter((f) => f.file === file && !f.covered)).toHaveLength(entry.count);
      expect(files.find((f) => f.file === (entry.owner ?? file))?.source).toContain(entry.marker);
      expect(entry.why.length).toBeGreaterThan(30);
    }
  });

  it('verifies custom fields are still connected to their owners mic', () => {
    const source = (file: string) => files.find((f) => f.file === file)!.source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    const chat = source('Views/Chat/ComposerView.swift');
    expect(chat).toContain('LongDraftEditor(text: draft');
    expect(chat).toContain('private var micButton: some View');
    expect(chat).toContain('await voice.start()');
    expect(chat).toContain('.joinsSendGate(');
    const letter = source('Views/Inbox/LetterReaderView.swift');
    expect(letter).toContain('LetterReplyField(');
    expect(letter).toContain('VoiceMicButton(voice: voice');
    expect(letter).toContain('.joinsSendGate(');
    const note = source('Views/Notes/NoteEditorView.swift');
    expect(note).toContain('dictation: dictation');
    expect(note).toContain('dictation.onMicTap =');
    expect(note).toContain('await voice.start()');
    expect(note).toContain('VoiceRecordingBar(');
    expect(source('Markdown/AccessoryBar.swift')).toContain('dictation?.micTapped()');
  });

  it('makes an explicit choice for every native search field', () => {
    const searches = files.filter(({ source }) => /\.searchable\s*\(/.test(mask(source)));
    const missing = searches.filter(({ file, source }) => !SEARCH_EXCLUSIONS[file] && !/\.voiceSearch\s*\(/.test(mask(source)));
    expect(missing.map((f) => f.file)).toEqual([]);
    for (const { file, source } of searches) {
      // A second native field in a covered file still needs a coverage choice.
      const expected = file === 'Views/Passwords/PasswordsHomeView.swift' ? 2 : 1;
      expect([...mask(source).matchAll(/\.searchable\s*\(/g)], `${file}: a new native search needs shared dictation`).toHaveLength(expected);
    }
    for (const [file, why] of Object.entries(SEARCH_EXCLUSIONS)) {
      expect(searches.some((f) => f.file === file), `stale search exclusion: ${file}`).toBe(true);
      expect(why.length).toBeGreaterThan(40);
    }
  });

  it('detects a new unwrapped field beside a shared field', () => {
    const found = fields('VoiceDictationField(text: $a, surface: "a", box: "a") { TextEditor(text: $a) }\nTextField("New request", text: $b)', 'New.swift');
    expect(found.map((f) => f.covered)).toEqual([true, false]);
    expect(fields('VoiceDictationField(text: $a, surface: "a", box: "a") { TextEditor(text: $b) }', 'Wrong.swift')[0].covered).toBe(false);
    expect(fields('VoiceDictationField(text: $a, surface: "a", box: "a") { TextEditor(text: $a); TextField("Second", text: $b) }', 'Two.swift').every((f) => !f.covered)).toBe(true);
  });
});
