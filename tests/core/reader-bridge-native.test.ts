/**
 * The reader, compiled for real in both shapes it ships in, run on files this test
 * made itself.
 *
 * src/data/walnut-reader.swift is ONE implementation compiled two ways: on its own as
 * the helper (with -parse-as-library, because its entry point is `@main`), and into
 * Walnut.app next to desktop/ReaderBridge.swift with -D WALNUT_APP. Whether both
 * build, and whether both still give the exit codes TypeScript maps (0 ok, 2 bad
 * input or missing, 3 no permission), is a question only the compiler can answer.
 *
 * Every path here is inside a fresh temp directory, which no privacy wall covers,
 * so nothing can reach TCC: Full Disk Access never prompts anyway, and nothing here
 * touches a protected file. Nothing is signed, installed, or granted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED = path.join(REPO, 'src', 'data', 'walnut-reader.swift');
const BRIDGE = path.join(REPO, 'desktop', 'ReaderBridge.swift');
/** Status the test app's main exits with when the bridge was NOT entered. */
const NORMAL_LAUNCH = 64;

const hasSwift = process.platform === 'darwin'
  && spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0;

/** Stands in for desktop/main.swift: the bridge first, then "the GUI". */
const TEST_MAIN = `
import Darwin
runReaderBridgeIfRequested()
exit(${NORMAL_LAUNCH})
`;

let dir: string;
let appExe: string;
let helperExe: string;

function compile(out: string, args: string[]): void {
  const r = spawnSync('xcrun', ['swiftc', '-O', '-o', out, ...args], { encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`swiftc failed:\n${r.stderr}`);
}

function run(exe: string, args: string[]): { status: number | null; stdout: Buffer } {
  const r = spawnSync(exe, args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout };
}

/** Both shapes, as `[label, argv prefix]`. */
const shapes = (): Array<[string, string, string[]]> => [
  ['app', appExe, ['--reader-bridge']],
  ['helper', helperExe, []],
];

describe.skipIf(!hasSwift)('walnut-reader, both shipped shapes', () => {
  let text: string;
  let binary: string;
  let big: string;
  let empty: string;
  let link: string;
  let bytes: Buffer;
  let bigBytes: Buffer;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-reader-bridge-native-'));
    const main = path.join(dir, 'main.swift');
    fs.writeFileSync(main, TEST_MAIN);
    appExe = path.join(dir, 'app');
    helperExe = path.join(dir, 'helper');
    compile(appExe, ['-D', 'WALNUT_APP', main, BRIDGE, SHARED]);
    compile(helperExe, ['-parse-as-library', SHARED]);

    // A Focus-style JSON file with a Chinese mode name ("sleep"), a file with every
    // byte value, a 3 MB file (bigger than the reader's 1 MB write chunk), an empty
    // one, and a symlink to the text file.
    text = path.join(dir, 'Assertions.json');
    fs.writeFileSync(text, '{"data":[{"name":"\u7761\u7720"}]}\n');
    binary = path.join(dir, 'store.sqlite');
    bytes = Buffer.from(Array.from({ length: 256 * 4 }, (_, i) => i % 256));
    fs.writeFileSync(binary, bytes);
    big = path.join(dir, 'big.sqlite-wal');
    bigBytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
    fs.writeFileSync(big, bigBytes);
    empty = path.join(dir, 'empty.sqlite-shm');
    fs.writeFileSync(empty, '');
    link = path.join(dir, 'link.json');
    fs.symlinkSync(text, link);
  }, 600_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('both shapes read every byte exactly, and probe moves none', () => {
    for (const [label, exe, prefix] of shapes()) {
      expect(run(exe, [...prefix, 'read', text]).stdout.toString('utf8'), label).toBe(fs.readFileSync(text, 'utf8'));
      expect(run(exe, [...prefix, 'read', binary]).stdout.equals(bytes), label).toBe(true);
      expect(run(exe, [...prefix, 'read', big]).stdout.equals(bigBytes), label).toBe(true);
      const none = run(exe, [...prefix, 'read', empty]);
      expect([none.status, none.stdout.length], label).toEqual([0, 0]);
      // A symlink is resolved first, then read: the target's bytes, not a refusal.
      expect(run(exe, [...prefix, 'read', link]).stdout.toString('utf8'), label).toBe(fs.readFileSync(text, 'utf8'));
      const probe = run(exe, [...prefix, 'probe', big]);
      expect([probe.status, probe.stdout.length], label).toEqual([0, 0]);
    }
  });

  it('both shapes refuse bad input with exit 2, the code TypeScript maps to ENOENT', () => {
    for (const [label, exe, prefix] of shapes()) {
      expect(run(exe, [...prefix, 'read', path.join(dir, 'missing.json')]).status, label).toBe(2);
      expect(run(exe, [...prefix, 'read', 'relative.json']).status, label).toBe(2);
      expect(run(exe, [...prefix, 'read', dir]).status, label).toBe(2); // a directory
      expect(run(exe, [...prefix, 'write', text]).status, label).toBe(2); // no such subcommand
      expect(run(exe, [...prefix]).status, label).toBe(2);
      expect(run(exe, [...prefix, 'read']).status, label).toBe(2);
      expect(run(exe, [...prefix, '--version']).stdout.toString().trim(), label).toBe('v1');
    }
  });

  it('the app shape falls through to a normal launch without the flag', () => {
    // A bridge that swallowed an ordinary launch would leave Walnut unable to open.
    expect(run(appExe, []).status).toBe(NORMAL_LAUNCH);
    expect(run(appExe, ['read', text]).status).toBe(NORMAL_LAUNCH);
    // The flag has to be argv[1]; anywhere later it is an ordinary argument.
    expect(run(appExe, ['--other', '--reader-bridge', 'read', text]).status).toBe(NORMAL_LAUNCH);
  });

  it('never writes: the file it read is unchanged, byte for byte and in mtime', () => {
    const before = fs.statSync(binary);
    for (const [, exe, prefix] of shapes()) run(exe, [...prefix, 'read', binary]);
    const after = fs.statSync(binary);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(binary).equals(bytes)).toBe(true);
  });
});
