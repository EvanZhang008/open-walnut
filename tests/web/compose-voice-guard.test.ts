/**
 * Every box where a person writes words to Walnut has the composer's mic (2026-11-14: "every
 * meaningful compose/text entry ... uses the existing shared voice component"; the Org Threads
 * follow-up was the reported case, the class is every such box).
 *
 * The members are read from source, field by field (tests/web/compose-voice-scan.ts): every
 * <textarea>, text <input>, editable element, rich editor and MicInput in web/src and the Board
 * frames. A field passes when the scan sees the mic write into it (MicInput, MicField, a BoxMic or
 * AnswerBox on its ref, an EditorMic on its editor). Otherwise it must be named here, by its exact
 * key, as one of:
 *  - EXACT: a value typed character by character (a secret, a path, code, an exact machine value,
 *    text shown to copy, a box whose words go through another box's mic, a wrapper whose uses are
 *    fields of their own, a search that matches exact characters), with the reason of its kind;
 *  - DELEGATED: a box whose mic the scan cannot link (a MicButton that writes through the owner's
 *    own handler), checked by markers in its file.
 * Names, titles, searches over words and every other box a person writes in take the mic; only
 * exact values stay out. A new field, a second box beside one with a mic, or a stale entry fails.
 * Search boxes that are exclusions say what exact thing they match.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WEB_SRC, fieldsOf, scanComposeFields } from './compose-voice-scan';

type Exact = { kind: string; why: string };
const SECRET: Exact = { kind: 'secret', why: 'a password, key, token, recovery or pairing code, or a vault item: never sent to a speech engine' };
const PATH: Exact = { kind: 'path', why: 'a file or folder path, typed or picked exactly as the file system spells it' };
const CODE: Exact = { kind: 'code', why: 'code or syntax (shell, cron, a credential command, Markdown source in a code editor) whose every character matters' };
const MACHINE: Exact = { kind: 'machine', why: 'an exact machine value (URL, host, port, number, time, id or slug, model id, branch, address, a pattern matched literally)' };
const READONLY: Exact = { kind: 'readonly', why: 'text shown to copy, not typed' };
const DOCKED: Exact = { kind: 'docked', why: 'the sandboxed Board frame has no microphone: its Dictate docks the host composer (with the mic) over the note' };
const WRAPPER: Exact = { kind: 'wrapper', why: 'a shared box whose uses are listed as fields of their own (WRAPPED_BOXES in the scan)' };

/** Exact values a person types character by character, never dictated: each field by its key. */
const EXACT: Record<string, Exact> = {
  'components/common/PdfPreview.tsx|input aria-label="PDF password"': SECRET,
  'components/common/UnpairedCodeField.tsx|input data-testid="unpaired-code-input"': SECRET,
  'components/passwords/HintField.tsx|input data-testid=id': SECRET,
  'components/passwords/HintSettings.tsx|input id="pw-hint-edit"': SECRET,
  'components/passwords/HintSettings.tsx|input id="pw-hint-pw"': SECRET,
  'components/passwords/ItemEditor.tsx|input aria-label="Password"': SECRET,
  'components/passwords/ItemEditor.tsx|input className="pw-input pw-mono"': SECRET,
  'components/passwords/ItemEditor.tsx|input className="pw-input pw-mono"#2': SECRET,
  'components/passwords/ItemEditor.tsx|input className="pw-input"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder="GITHUB_TOKEN"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder="MM"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder="Name"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder="Setup key or otpauth:// link"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder="Value"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder="YYYY"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder="example.com"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder="name@example.com"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder="work, family"': SECRET,
  'components/passwords/ItemEditor.tsx|input placeholder=`${typeLabel(f.type)} name`': SECRET,
  'components/passwords/ItemEditor.tsx|textarea className="pw-input pw-textarea"': SECRET,
  'components/passwords/LockScreens.tsx|input id="pw-rc"': SECRET,
  'components/passwords/LockScreens.tsx|input id="pw-rsk"': SECRET,
  'components/passwords/LockScreens.tsx|input id="pw-sk"': SECRET,
  'components/passwords/LockScreens.tsx|input id=`${idPrefix}-1`': SECRET,
  'components/passwords/LockScreens.tsx|input id=`${idPrefix}-2`': SECRET,
  'components/passwords/LockScreens.tsx|input placeholder="Master password"': SECRET,
  'components/passwords/VaultBrowser.tsx|input placeholder="Search"': SECRET,
  'components/settings/inputs/SecretInput.tsx|input data-testid=testId': SECRET,
  // An OAuth client id, and the exact address a provider's sign-in page landed on.
  'components/settings/sections/CalendarSignInClient.tsx|input data-testid=`calendar-client-id-${accountId}`': MACHINE,
  'components/settings/sections/CalendarSignInRow.tsx|input data-testid=`calendar-mail-sign-in-paste-${id}`': MACHINE,
  'components/settings/sections/PasswordsSection.tsx|input id="pw-confirm"': SECRET,
  'components/settings/sections/PasswordsSection.tsx|input id="pw-forever-pw"': SECRET,
  'components/settings/sections/PasswordsSection.tsx|input id="pw-new"': SECRET,
  'components/settings/sections/PasswordsSection.tsx|input id="pw-new-hint"': SECRET,
  'components/settings/sections/PasswordsSection.tsx|input id="pw-new2"': SECRET,
  'components/settings/sections/PasswordsSection.tsx|input id="pw-old"': SECRET,
  'components/settings/sections/ProvidersSection.tsx|input id="bedrock-access-key"': SECRET,
  'components/settings/sections/backup/BucketFields.tsx|input id="backup-s3-access-key"': SECRET,
  'components/settings/sections/backup/DriveConnect.tsx|input id="backup-gdrive-client-id"': SECRET,
  'components/settings/sections/backup/DriveConnect.tsx|input id="backup-gdrive-paste"': SECRET,
  'components/settings/sections/backup/LegacyS3Fields.tsx|input id="backup-access-key"': SECRET,
  'components/settings/sections/backup/RecoveryKeyGroup.tsx|input id="backup-key-input"': SECRET,
  'components/settings/sections/cloud/CloudConfigureForm.tsx|input id="cloud-api-token"': SECRET,
  'components/settings/sections/cloud/CloudSetupSteps.tsx|input placeholder="Provider API token"': SECRET,
  'components/chat/FileMentionPopup.tsx|input className="fmp-breadcrumb-input"': PATH,
  'components/repositories/RepoForm.tsx|input placeholder="/absolute/path/to/repo"': PATH,
  'components/routines/RoutineForm.tsx|input id="routine-check-cwd"': PATH,
  'components/sessions/FileTreeEditRow.tsx|input aria-label=ARIA_LABEL[kind]': PATH,
  'components/sessions/SessionFileExplorer.tsx|input placeholder="Absolute path, or type to fuzzy-match recent folders"': PATH,
  'components/sessions/path-selector/GhostTextInput.tsx|input placeholder=placeholder': PATH,
  'components/settings/sections/ReplicaKeepRows.tsx|input data-testid=idOf(\'exclude\')': PATH,
  'components/settings/sections/SearchSection.tsx|input data-testid="search-excluded-folders-input"': PATH,
  'components/settings/sections/SttModelRows.tsx|input id="stt-manual-model"': PATH,
  'components/settings/sections/SttModelRows.tsx|input id="stt-sherpa-manual-dir"': PATH,
  'components/transfer/TransferDialog.tsx|input data-testid="xfer-dir-input"': PATH,
  'components/common/FileSourceEditor.tsx|new EditorView': CODE,
  'components/settings/sections/PickerEnginesGroup.tsx|input data-testid="custom-acp-engine-command"': CODE,
  'components/notes/RawMarkdownView.tsx|new EditorView': CODE,
  'components/repositories/RepoForm.tsx|textarea id="repo-cmds"': CODE,
  'components/routines/RoutineForm.tsx|input id="routine-check-run"': CODE,
  'components/routines/RoutineForm.tsx|input placeholder="0 9 * * 1-5"': CODE,
  'components/settings/sections/ProvidersSection.tsx|input id="bedrock-credential-export"': CODE,
  'components/settings/sections/RemoteHostSshRow.tsx|textarea id=`rh-shell-${idx}`': CODE,
  'components/settings/sections/cloud/CloudManualPaste.tsx|textarea aria-label="First-boot script"': CODE,
  'components/workspaces/ProjectScriptsDialog.tsx|textarea data-testid="project-script-command"': CODE,
  'apps/mail/AddAccountDialog.tsx|input data-testid=`mail-setup-${field.name}`': MACHINE,
  'apps/mail/MailFilterCard.tsx|input data-testid=testId': MACHINE,
  'apps/mail/compose/AddressChipsField.tsx|input data-testid=`mail-compose-${name}`': MACHINE,
  'components/agents/AgentForm.tsx|input id="agent-id"': MACHINE,
  'components/topics/MemberPicker.tsx|input data-testid="topic-person-email"': MACHINE,
  'components/apps-page/PluginStoreGrid.tsx|input id="plugin-source-url"': MACHINE,
  'components/commands/CommandForm.tsx|input id="cmd-name"': MACHINE,
  'components/common/DatePicker.tsx|input placeholder="3:30 PM"': MACHINE,
  'components/common/MicButton.tsx|input placeholder="Add word..."': MACHINE,
  'components/repositories/RepoForm.tsx|input id="repo-slug"': MACHINE,
  'components/repositories/RepoForm.tsx|input placeholder="local"': MACHINE,
  'components/repositories/RepoForm.tsx|input placeholder="ssh host (optional)"': MACHINE,
  'components/routines/RoutineForm.tsx|input id=`routine-f-${f.name}`': { kind: 'machine', why: 'only path fields and the exact tools or target identifiers use the raw text branch; prose text fields use MicInput' },
  'components/routines/RoutineForm.tsx|input placeholder="America/Los_Angeles"': MACHINE,
  'components/sessions/DiffComparePicker.tsx|input placeholder="Filter branches and commits"': MACHINE,
  'components/sessions/IdleCompactLine.tsx|input data-testid="idle-compact-percent"': MACHINE,
  'components/sessions/ModelPicker.tsx|input data-testid="acp-model-filter"': MACHINE,
  'components/sessions/SessionUsageDialog.tsx|input id=`${labelId}-limit`': MACHINE,
  'components/sessions/SessionWebView.tsx|input placeholder="localhost:3000 or http://host:8080/"': MACHINE,
  'components/sessions/TriggerPickerPopover.tsx|input id=`tp-${template}-${param.key}`': MACHINE,
  'components/settings/sections/AudioCaptureSection.tsx|input id="audio-add-app"': MACHINE,
  'components/settings/sections/EngineSettingRows.tsx|input id=id': MACHINE,
  'components/settings/sections/EngineSettingRows.tsx|input placeholder=item.placeholder ?? \'custom value\'': MACHINE,
  'components/settings/sections/EngineSplitRow.tsx|input data-testid="engine-split-add-model"': MACHINE,
  'components/settings/sections/HistoryRemoteGroup.tsx|input id="history-remote-bucket"': MACHINE,
  'components/settings/sections/HistoryRemoteGroup.tsx|input id="history-remote-endpoint"': MACHINE,
  'components/settings/sections/HistoryRemoteGroup.tsx|input id="history-remote-profile"': MACHINE,
  'components/settings/sections/HistoryRemoteGroup.tsx|input id="history-remote-region"': MACHINE,
  'components/settings/sections/HostServersGroup.tsx|input data-testid=`host-server-option-${host.hostKey}-${option.key}`': MACHINE,
  'components/settings/sections/JevSettings.tsx|input id="jev-endpoint"': MACHINE,
  'components/settings/sections/JevSettings.tsx|input id="jev-model"': MACHINE,
  'components/settings/sections/MailRuleEditor.tsx|input data-testid="mail-rule-move-to"': MACHINE,
  'components/settings/sections/MailRuleEditor.tsx|input data-testid="mail-rule-value"': MACHINE,
  'components/settings/sections/MessageHintsGroup.tsx|input data-testid="hint-new-kind"': MACHINE,
  'components/settings/sections/PluginConfigCards.tsx|input id=fieldId': MACHINE,
  'components/settings/sections/PluginConfigCards.tsx|textarea id=fieldId': MACHINE,
  'components/settings/sections/ProvidersSection.tsx|input id="bedrock-profile"': MACHINE,
  'components/settings/sections/ProvidersSection.tsx|input id="main-model"': MACHINE,
  'components/settings/sections/ProvidersSection.tsx|input id="provider-add-model"': MACHINE,
  'components/settings/sections/RemoteHostSshRow.tsx|input id=`rh-${field}-${idx}`': MACHINE,
  'components/settings/sections/SecretsGroup.tsx|input data-testid="secret-env"': MACHINE,
  'components/settings/sections/SecretsGroup.tsx|input data-testid="secret-name"': MACHINE,
  'components/settings/sections/SttDetectionPanel.tsx|input id="stt-openai-model"': MACHINE,
  'components/settings/sections/SttDetectionPanel.tsx|input id="stt-openai-url"': MACHINE,
  'components/settings/sections/TagLinkEditor.tsx|input data-testid="tag-link-input"': MACHINE,
  'components/settings/sections/TriageRoutingRules.tsx|input data-testid="triage-rule-from"': MACHINE,
  'components/settings/sections/TriageRoutingRules.tsx|input data-testid="triage-rule-subject"': MACHINE,
  'components/settings/sections/TriageSection.tsx|input id="inbox-triage-every"': MACHINE,
  'components/settings/sections/TriageSection.tsx|input id="inbox-triage-hours"': MACHINE,
  'components/settings/sections/backup/BucketFields.tsx|input id="backup-s3-profile"': MACHINE,
  'components/settings/sections/backup/BucketFields.tsx|input id=id': MACHINE,
  'components/settings/sections/backup/LegacyS3Fields.tsx|input id=id': MACHINE,
  'components/settings/sections/backup/RestorePanel.tsx|input id="backup-restore-target"': MACHINE,
  'components/settings/sections/cloud/BrowserAccessGroup.tsx|input data-testid=`browser-access-option-${option.key}`': MACHINE,
  'components/settings/sections/cloud/CloudConfigureForm.tsx|input id="cloud-domain"': MACHINE,
  'components/settings/sections/cloud/CloudConfigureForm.tsx|input id="cloud-instance-size"': MACHINE,
  'components/settings/sections/cloud/CloudConfigureForm.tsx|input id="cloud-region"': MACHINE,
  'components/settings/sections/cloud/CloudSetupSteps.tsx|input placeholder="203.0.113.10"': MACHINE,
  'components/tasks/ProjectDetailPane.tsx|input className="detail-setting-input is-sm"': MACHINE,
  'components/tasks/ProjectDetailPane.tsx|input className="detail-setting-input is-sm"#2': MACHINE,
  'components/tasks/TagEditor.tsx|input placeholder=visible.length === 0 ? placeholder : \'+\'': MACHINE,
  'components/workspaces/DraftWorkspaceRow.tsx|input data-testid=`draft-workspace-input-${key}`': MACHINE,
  'components/common/AppErrorBoundary.tsx|textarea ref=this.reportRef': READONLY,
  'components/settings/CopyDiagnostics.tsx|textarea aria-label="Diagnostics text"': READONLY,
  'components/board/board-items.frame.js|textarea class="wn-mark-note"': DOCKED,
  'components/common/CollapsibleUrlEditor.tsx|div aria-label=placeholder': WRAPPER,
  'components/settings/sections/task-provider-parts.tsx|input data-testid=id': WRAPPER,
  'components/settings/sections/task-provider-parts.tsx|textarea ref=ref': WRAPPER,
  'components/sessions/DraftSourcePackages.tsx|input data-testid="draft-source-add-input"': MACHINE,
  'components/tasks/ProjectCodeSource.tsx|input data-testid="project-code-source-anchor"': PATH,
  'components/tasks/ProjectCodeSource.tsx|input data-testid=`project-code-source-add-${name}`': MACHINE,
  "components/tasks/ProjectCodeSource.tsx|input placeholder=field.placeholder ?? ''": MACHINE,
  'apps/mail/MailAccountFolders.tsx|input data-testid="mail-tail-filter"': { kind: 'search', why: 'finds a mail folder by its exact server name' },
  'components/common/FileSearchBar.tsx|input placeholder=placeholder': { kind: 'search', why: 'finds the exact characters in a file (code, logs), matched literally' },
  'components/common/PdfFind.tsx|input placeholder="Find in PDF"': { kind: 'search', why: 'finds the exact characters on a PDF page, matched literally' },
  'components/sessions/WorkflowGraph.tsx|input placeholder="Find agents in this workflow…"': { kind: 'search', why: 'finds a workflow\'s agents by their generated names and ids' },
  'components/settings/sections/ReposSection.tsx|input placeholder="Search repositories..."': { kind: 'search', why: 'finds repositories by their exact folder name and slug' },
  'components/settings/sections/TagsSection.tsx|input id="tags-filter"': { kind: 'search', why: 'finds tags by their exact key:value tokens' },
};

/** A mic the scan cannot link to its box: markers in the file show the owner writes the words in. */
const DELEGATED: Record<string, { markers: string[]; why: string }> = {
  'components/quickbar/QuickBar.tsx|textarea placeholder=placeholder': {
    markers: ['useBoxDictation(boxRef, text, setText)', 'onTranscribe: dictation.onTranscribe', 'ref={boxRef}'],
    why: "the quick bar listens as it opens: its own speech hook writes the words into boxRef through useBoxDictation",
  },
  'components/common/BoxMic.tsx|input ref=setRefs': {
    markers: ['box.current = el;', 'return away.current ? null : box.current;', 'boxRef={dictationBox}', 'handleRef={mic}', 'onTranscribe={dictation.onTranscribe}'],
    why: 'MicInput uses a focus-aware view of the same input ref, so dictation does not refocus a field left while its words arrive',
  },
  "components/chat/ChatInput.tsx|textarea placeholder=placeholder ?? (focusedTaskTitle ? `Ask about '${focusedTaskTitle}'...` : 'Type a message... (/ for commands)')": {
    markers: ['<MicButton', 'onTranscribe={(text) => writeDictation(text, false)}', 'ref={textareaRef}'],
    why: "the chat composer's MicButton writes through writeDictation into textareaRef",
  },
  'apps/mail/compose/ComposerPanel.tsx|textarea data-testid="mail-compose-body"': {
    markers: ['<BodyArea', 'boxRef={bodyRef}', '<BoxMic'],
    why: 'the mail body lives in BodyArea; the panel hands it bodyRef, the ref its BoxMic writes into',
  },
  'components/sessions/SessionNotes.tsx|CollapsibleUrlEditor placeholder="Write a note for this session…"': {
    markers: ['<MicButton', 'onTranscribe={(text) => handleChange('],
    why: "the session note's MicButton appends the words to the note it autosaves",
  },
};

const fields = scanComposeFields();
const byKey = new Map(fields.map((f) => [f.key, f] as const));
const read = (rel: string) => fs.readFileSync(path.join(WEB_SRC, rel), 'utf8');

describe('every box where a person writes words has the mic', () => {
  it('scans the app, and the reported Org Threads follow-up has the mic', () => {
    expect(fields.length).toBeGreaterThan(200);
    // The follow-up is the chat's own composer (ReplyComposer, a light ChatInput with its MicButton).
    expect(read('components/org/thread-card-answer.tsx')).toMatch(/function FollowUp[\s\S]*?<ReplyComposer\b/);
    expect(read('components/chat/ReplyComposer.tsx')).toMatch(/<ChatInput\b/);
    expect(byKey.get('components/common/AnswerBox.tsx|textarea data-testid=testId')?.mic).toBe(true);
    for (const key of [
      'components/org/OrgNodeEditor.tsx|textarea data-testid="org-node-instructions"',
      'components/org/OrgNodeEditor.tsx|MicInput data-testid="org-node-name"',
      'components/org/AgentMemoryPanel.tsx|textarea data-testid="am-instructions"',
      'components/settings/sections/MessageHintsGroup.tsx|input data-testid="hint-new-text"',
      'components/settings/sections/TriageRoutingRules.tsx|textarea data-testid="triage-rule-note"',
    ]) expect(byKey.get(key)?.mic, key).toBe(true);
    // Every rich editor (TipTap) is one NotesEditor, its EditorMic on the same editor.
    expect(fields.filter((f) => f.signature.startsWith('EditorContent')).map((f) => [f.file, f.mic])).toEqual([['components/notes/NotesEditor.tsx', true]]);
  });

  it('has no box without the mic that is not an exact value or delegated', () => {
    const missing = fields.filter((f) => !f.mic && !EXACT[f.key] && !DELEGATED[f.key]);
    expect(
      missing.map((f) => `${f.key} (line ${f.line})`),
      'a box where a person writes words: give it the mic (MicInput, MicField, AnswerBox), or, for an exact value only, list it in EXACT',
    ).toEqual([]);
  });

  it('excludes only exact values: no name, title or prose kind exists', () => {
    const kinds = new Set(Object.values(EXACT).map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['code', 'docked', 'machine', 'path', 'readonly', 'search', 'secret', 'wrapper']);
    for (const [key, e] of Object.entries(EXACT)) if (e.kind === 'search') expect(e.why, key).toMatch(/exact|literal|identifier|generated/);
  });

  it('keeps every entry exact: it names a field that exists and still has no mic', () => {
    const stale = [...Object.keys(EXACT), ...Object.keys(DELEGATED)].filter((k) => !byKey.has(k) || byKey.get(k)!.mic);
    expect(stale, 'an entry for a field that moved, changed or got the mic: update or remove it').toEqual([]);
    for (const [key, d] of Object.entries(DELEGATED)) {
      const src = read(key.split('|')[0]);
      for (const m of d.markers) expect(src, `${key}: marker ${m}`).toContain(m);
    }
  });

  it('routine prose fields cannot be hidden behind the dynamic machine-value exemption', () => {
    const src = read('components/routines/RoutineForm.tsx');
    expect(src).toContain("f.kind === 'text' && !['tools', 'target'].includes(f.name)");
    expect(src).toMatch(/return <MicInput[\s\S]*?micRef=\{fieldMicOf\(f\.name\)\}/);
    for (const key of ['components/routines/RoutineForm.tsx|MicInput id=`routine-f-${f.name}`', 'components/settings/sections/SecretsGroup.tsx|MicInput data-testid="secret-description"']) {
      expect(byKey.get(key)?.mic, key).toBe(true);
    }
  });

  it('rejects a second box or a wrong ref inside a mic wrapper', () => {
    const src = `<>
      <MicField boxRef={a} text={x} setText={setX}>
        <textarea ref={a} data-testid="first" /><textarea ref={b} data-testid="second" />
      </MicField>
      <MicField boxRef={a} text={x} setText={setX}><input ref={b} data-testid="wrong" /></MicField>
    </>`;
    expect(fieldsOf('New.tsx', src).map((f) => f.mic)).toEqual([false, false, false]);
  });

  it('reads per field: a new box beside one with the mic fails', () => {
    const src = `
      function Box() {
        const a = useRef(null);
        return <>
          <MicField boxRef={a} text={x} setText={setX}><textarea ref={a} data-testid="a" /></MicField>
          <textarea data-testid="b" />
          <MicInput data-testid="c" value={y} setText={setY} />
          <input type="search" data-testid="d" />
          <input type="checkbox" data-testid="e" />
          <textarea ref={c} data-testid="f" /><BoxMic boxRef={c} text={z} setText={setZ} />
        </>;
      }`;
    expect(fieldsOf('New.tsx', src).map((f) => [f.signature, f.mic])).toEqual([
      ['textarea data-testid="a"', true],
      ['textarea data-testid="b"', false],
      ['MicInput data-testid="c"', true],
      ['input data-testid="d"', false],
      ['textarea data-testid="f"', true],
    ]);
  });
});
