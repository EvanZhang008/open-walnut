import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = path.join(repoRoot, 'src');

function typescriptFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFiles(filePath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [filePath] : [];
  });
}

describe('centralized session status event contract', () => {
  it('has no direct SESSION_STATUS_CHANGED emitter outside session-tracker', () => {
    const centralEmitter = path.join(sourceRoot, 'core/session-tracker.ts');
    const offenders = typescriptFiles(sourceRoot)
      .filter((filePath) => filePath !== centralEmitter)
      .filter((filePath) =>
        /bus\.emit\(\s*EventNames\.SESSION_STATUS_CHANGED/.test(
          fs.readFileSync(filePath, 'utf-8'),
        ))
      .map((filePath) => path.relative(repoRoot, filePath));

    expect(offenders).toEqual([]);
    expect(fs.readFileSync(centralEmitter, 'utf-8')).toMatch(
      /bus\.emit\(EventNames\.SESSION_STATUS_CHANGED, data, \['\*'\], options\)/,
    );
  });

  it('routes session-server status frames through a committed-record path', () => {
    const source = fs.readFileSync(
      path.join(sourceRoot, 'providers/session-server-client.ts'),
      'utf-8',
    );

    expect(source).toContain("'session:status': null");
    expect(source).toMatch(
      /if \(frame\.name === 'session:status'\) \{\s*this\.commitStatusEvent\(frame\)/,
    );
    expect(source).not.toContain("case 'session:status':");
  });
});
