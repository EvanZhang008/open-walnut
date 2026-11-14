/**
 * The git-sync secret letters (integrations/git-sync-secrets.ts): files kept out of sync because
 * they look like they hold a credential, and a local copy set aside so a merge could run. File
 * paths and the scanner's finding names (`described`) are inserted as given.
 */
import type { ByLang } from './languages.js';
import { letterKind } from './kind.js';

export interface SecretHeldParams {
  files: Array<{ file: string; described: string; walnutWritten: boolean }>;
}

export interface SecretAsideParams {
  file: string;
  described: string;
  aside: string;
}

interface Words {
  heldOne: string;
  heldMany: (n: number) => string;
  walnutRecord: string;
  didNotSync: (one: boolean) => string;
  nothingChanged: string;
  whatToDo: string;
  asideSubject: string;
  asideChanged: (file: string, described: string) => string;
  asideMoved: (aside: string, file: string) => string;
}

const WORDS: ByLang<Words> = {
  en: {
    heldOne: 'A file was kept out of sync: it holds a secret',
    heldMany: (n) => `${n} files were kept out of sync: they hold secrets`,
    walnutRecord: ' (a record Walnut writes; it stays on this machine)',
    didNotSync: (one) => `Walnut did not sync ${one ? 'this file' : 'these files'} from its data folder, because each looks like it holds a credential:`,
    nothingChanged: 'Nothing was changed on this machine, and nothing was sent anywhere. A file stays out of the synced history while it holds the credential and syncs again by itself once it does not; a file the sync already had keeps its last version without it on your other machines.',
    whatToDo: 'If it is a real credential, take it out of the file (keep credentials in Settings or in the `secrets/` folder, which never syncs) and consider replacing it. If it is not a secret, rewording those lines lets the file sync.',
    asideSubject: 'A file kept out of sync was set aside',
    asideChanged: (file, described) => `The other machine changed \`${file}\` in the Walnut data folder while this machine kept its copy out of sync for a secret (${described}).`,
    asideMoved: (aside, file) => `So the sync could take that change, this machine's copy was moved to \`${aside}\`, which never syncs, and \`${file}\` now has the synced version. Copy over anything you still need from it, without the secret, then delete it.`,
  },
  zh: {
    heldOne: '有一个文件没有同步：它含有密钥',
    heldMany: (n) => `有 ${n} 个文件没有同步：它们含有密钥`,
    walnutRecord: '（这是 Walnut 自己写的记录，只留在这台机器上）',
    didNotSync: (one) => `Walnut 没有同步数据文件夹里的${one ? '这个文件' : '这些文件'}，因为看起来都含有凭据：`,
    nothingChanged: '这台机器上什么都没改，也没有发到任何地方。文件含有凭据期间不会进入同步历史，去掉后会自动恢复同步；同步里原本就有的文件，在你的其他机器上保留不含凭据的上一个版本。',
    whatToDo: '如果是真的凭据，请把它从文件里拿掉（凭据放在"设置"里，或放在永不同步的 `secrets/` 文件夹里），并考虑更换它。如果不是密钥，改写那几行文字，文件就能同步。',
    asideSubject: '一个没有同步的文件被移到了一边',
    asideChanged: (file, described) => `另一台机器改了 Walnut 数据文件夹里的 \`${file}\`，而这台机器因为密钥（${described}）没有同步自己的副本。`,
    asideMoved: (aside, file) => `为了让同步能接收那次改动，这台机器的副本已移到永不同步的 \`${aside}\`，\`${file}\` 现在是同步来的版本。把里面还需要的内容（不含密钥）拷过来，然后删掉它。`,
  },
};

export const GIT_SYNC_SECRET_HOLD = letterKind<SecretHeldParams>({
  id: 'git-sync-secret-hold',
  type: 'review',
  callers: ['src/integrations/git-sync-secrets.ts'],
  marked: true,
  render: (lang, { files }) => {
    const w = WORDS[lang];
    const one = files.length === 1;
    return {
      subject: one ? w.heldOne : w.heldMany(files.length),
      markdown: [
        w.didNotSync(one),
        '',
        ...files.map((f) => `- \`${f.file}\`: ${f.described}${f.walnutWritten ? w.walnutRecord : ''}`),
        '',
        w.nothingChanged,
        '',
        w.whatToDo,
      ].join('\n'),
    };
  },
  samples: [
    { files: [{ file: 'notes/keys.md', described: 'aws-access-key (line 3)', walnutWritten: false }] },
    { files: [{ file: 'notes/keys.md', described: 'github-token', walnutWritten: false }, { file: 'sessions/x.json', described: 'private-key', walnutWritten: true }] },
  ],
  stillNeeded: { none: 'git-sync-secrets.ts archives it itself once no file of it holds the credential (the `released` notice)' },
});

export const GIT_SYNC_SECRET_ASIDE = letterKind<SecretAsideParams>({
  id: 'git-sync-secret-aside',
  type: 'review',
  callers: ['src/integrations/git-sync-secrets.ts'],
  marked: true,
  render: (lang, p) => {
    const w = WORDS[lang];
    return { subject: w.asideSubject, markdown: [w.asideChanged(p.file, p.described), '', w.asideMoved(p.aside, p.file)].join('\n') };
  },
  samples: [{ file: 'notes/keys.md', described: 'aws-access-key (line 3)', aside: 'local/set-aside/keys.md' }],
  stillNeeded: { none: 'a report of a move already made: the set-aside copy is the user\'s to look at, nothing waits on an answer' },
});
