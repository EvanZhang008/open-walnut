import { describe, expect, it } from 'vitest';
import { codexAccount, directoryLabel, taskIdOfCwd } from '../../../src/core/usage/codex-account.js';

describe('codex account', () => {
  it('flags a provider that bills the signed-in account as direct and every proxy as not', () => {
    expect(codexAccount('amazon-bedrock')).toEqual({ key: 'amazon-bedrock', label: 'Bedrock account', direct: true });
    expect(codexAccount('openai')).toMatchObject({ direct: true });
    for (const proxy of ['local-proxy', 'bp', 'bedrock_proxy', 'bedrock-proxy']) expect(codexAccount(proxy)).toMatchObject({ key: proxy, direct: false });
    expect(codexAccount('')).toEqual({ key: 'unknown', label: 'Not recorded', direct: false });
    expect(codexAccount(undefined).direct).toBe(false);
  });

  it('reads a task from a Walnut task directory only', () => {
    expect(taskIdOfCwd('/home/u/.local/state/open-walnut/tasks/cfab9e60-eec0-59f6-af8b-c971916cf846/work')).toBe('cfab9e60-eec0-59f6-af8b-c971916cf846');
    expect(taskIdOfCwd('/Users/u/.local/state/open-walnut/tasks/mv96n5cs-5181')).toBe('mv96n5cs-5181');
    expect(taskIdOfCwd('/home/u/projects/tasks/abc12345')).toBeUndefined();
    expect(taskIdOfCwd('/home/u/open-walnut/tasks/x')).toBeUndefined();
    expect(taskIdOfCwd('C:\\Users\\u\\open-walnut\\tasks\\abc12345-def6\\x')).toBe('abc12345-def6');
  });

  it('names a folder by its last two parts', () => {
    expect(directoryLabel('/work/marina/src')).toBe('marina/src');
    expect(directoryLabel('/')).toBe('Unknown folder');
  });
});
