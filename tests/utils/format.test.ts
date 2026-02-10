import { describe, it, expect } from 'vitest';
import { parseGroupFromCategory, generateId, prioritySymbol, statusSymbol, shortDate } from '../../src/utils/format.js';

describe('parseGroupFromCategory', () => {
  it('parses "Group / ListName" format', () => {
    expect(parseGroupFromCategory('Work / VPA')).toEqual({ group: 'Work', listName: 'VPA' });
  });

  it('title-cases lowercase group and list', () => {
    expect(parseGroupFromCategory('us / ca')).toEqual({ group: 'Us', listName: 'Ca' });
  });

  it('title-cases when no separator', () => {
    expect(parseGroupFromCategory('personal')).toEqual({ group: 'Personal', listName: 'Personal' });
  });

  it('handles empty string', () => {
    expect(parseGroupFromCategory('')).toEqual({ group: '', listName: '' });
  });

  it('handles multiple separators — splits on first only', () => {
    expect(parseGroupFromCategory('A / B / C')).toEqual({ group: 'A', listName: 'B / C' });
  });

  it('title-cases when no proper separator (slash without spaces)', () => {
    expect(parseGroupFromCategory('work/vpa')).toEqual({ group: 'Work/vpa', listName: 'Work/vpa' });
  });

  it('title-cases when no proper separator (just slash-space)', () => {
    expect(parseGroupFromCategory('work/ vpa')).toEqual({ group: 'Work/ vpa', listName: 'Work/ vpa' });
  });

  it('handles Chinese characters', () => {
    expect(parseGroupFromCategory('任务')).toEqual({ group: '任务', listName: '任务' });
  });

  it('handles group with Chinese and separator', () => {
    expect(parseGroupFromCategory('工作 / 项目A')).toEqual({ group: '工作', listName: '项目A' });
  });
});
