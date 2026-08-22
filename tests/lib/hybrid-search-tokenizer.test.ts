import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/lib/hybrid-search/tokenizer.js';

/**
 * Golden fixtures for the tokenizer. These pin BEHAVIOR — any change here is
 * an index-format change and must bump TOKENIZER_VERSION (the db layer then
 * forces a rebuild). All names are invented.
 */
describe('hybrid-search tokenizer golden fixtures', () => {
  const cases: Array<{ input: string; orig: string[]; sub: string[] }> = [
    {
      input: 'AcmeEventOperator',
      orig: ['acmeeventoperator'],
      sub: ['acme', 'event', 'operator'],
    },
    {
      input: 'acme-gateway-dev',
      orig: ['acme-gateway-dev'],
      sub: ['acme', 'gateway', 'dev'],
    },
    {
      input: '修复EventOperator的bug',
      orig: ['修复', 'eventoperator', '的', 'bug'],
      sub: ['修复', 'event', 'operator', '的'],
    },
    {
      input: 'CR-291543784',
      orig: ['cr-291543784'],
      sub: ['cr', '291543784'],
    },
    {
      input: 'getHTTPResponseCode',
      orig: ['gethttpresponsecode'],
      sub: ['get', 'http', 'response', 'code'],
    },
    {
      input: '要重试3次 timeout',
      orig: ['要重试', '3', '次', 'timeout'],
      sub: ['要重', '重试', '次'],
    },
  ];

  for (const c of cases) {
    it(`tokenizes ${JSON.stringify(c.input)}`, () => {
      expect(tokenize(c.input)).toEqual({ orig: c.orig, sub: c.sub });
    });
  }
});

describe('hybrid-search tokenizer properties', () => {
  it('keeps CJK bigrams in document order (phrase positions depend on it)', () => {
    const { sub } = tokenize('自动重试机制');
    expect(sub).toEqual(['自动', '动重', '重试', '试机', '机制']);
  });

  it('does NOT dedupe streams — term frequency feeds bm25', () => {
    const { orig } = tokenize('retry retry retry');
    expect(orig).toEqual(['retry', 'retry', 'retry']);
  });

  it('emits no sub parts for tokens that do not split', () => {
    expect(tokenize('timeout').sub).toEqual([]);
    expect(tokenize('42').sub).toEqual([]);
  });

  it('strips trailing punctuation but keeps interior joiners', () => {
    expect(tokenize('see file.ts.').orig).toEqual(['see', 'file.ts']);
    expect(tokenize('v1.2.3').orig).toEqual(['v1.2.3']);
    expect(tokenize('v1.2.3').sub).toEqual(['v', '1', '2', '3']);
  });

  it('splits letter↔digit boundaries', () => {
    expect(tokenize('py3k8s').sub).toEqual(['py', '3', 'k', '8', 's']);
  });

  it('handles the acronym boundary (UPPER→Upperlower)', () => {
    expect(tokenize('XMLHttpRequest').sub).toEqual(['xml', 'http', 'request']);
  });

  it('treats apostrophes as joiners inside orig tokens', () => {
    const { orig, sub } = tokenize("don't stop");
    expect(orig).toEqual(["don't", 'stop']);
    expect(sub).toEqual(['don', 't']);
  });

  it('drops tokens over 64 chars from orig but keeps their parts', () => {
    const long = 'a'.repeat(70);
    expect(tokenize(long).orig).toEqual([]);
    const camel = `${'a'.repeat(70)}BbbCcc`;
    const { orig, sub } = tokenize(camel);
    expect(orig).toEqual([]); // 76 chars, dropped
    expect(sub).toEqual(['a'.repeat(70), 'bbb', 'ccc'].filter((p) => p.length <= 64));
  });

  it('handles a 1-char CJK run (char itself goes to sub)', () => {
    expect(tokenize('的')).toEqual({ orig: ['的'], sub: ['的'] });
  });

  it('survives adversarial inputs without throwing', () => {
    const inputs = [
      '', '   ', '---', '...', "'''", '__init__', 'a..b', 'mod..old/thing.ts',
      '\u0000\u0001', '🎉🚀', 'ｆｕｌｌｗｉｄｔｈ', '𠀀𠀁', 'a'.repeat(100_000),
      'SELECT * FROM "docs" WHERE x = \'1\'', 'NOT AND OR NEAR', '(paren) -minus +plus',
    ];
    for (const input of inputs) {
      expect(() => tokenize(input)).not.toThrow();
    }
  });

  it('never emits empty tokens', () => {
    for (const input of ['a-b', '--a--', '。中。文。', 'x_.y', "''a''"]) {
      const { orig, sub } = tokenize(input);
      for (const t of [...orig, ...sub]) expect(t.length).toBeGreaterThan(0);
    }
  });

  it('lowercases everything', () => {
    const { orig, sub } = tokenize('MixedCASE Token');
    for (const t of [...orig, ...sub]) expect(t).toBe(t.toLowerCase());
  });
});
