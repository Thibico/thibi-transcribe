import { describe, expect, it } from 'vitest';
import { normalizeCode } from '../registry.js';

describe('normalizeCode', () => {
  it.each([
    // The canonical form and the obvious spellings of it.
    ['my-MM', 'my-MM'],
    ['my', 'my-MM'],
    ['mya', 'my-MM'],
    ['MY-mm', 'my-MM'],
    ['my_MM', 'my-MM'],
    ['  my-MM  ', 'my-MM'],
    ['Burmese', 'my-MM'],
    ['burmese', 'my-MM'],
    ['Myanmar', 'my-MM'],

    // The traps a `lang-REGION` regex falls into. Both put a script subtag in the middle,
    // and naive splitting produces `pa-IN` and `cmn-CN`, neither of which exists.
    ['pa', 'pa-Guru-IN'],
    ['pa-IN', 'pa-Guru-IN'],
    ['pa-Guru-IN', 'pa-Guru-IN'],
    ['pan', 'pa-Guru-IN'],
    ['zh', 'cmn-Hans-CN'],
    ['zh-CN', 'cmn-Hans-CN'],
    ['zh-TW', 'cmn-Hant-TW'],
    ['cmn-Hans-CN', 'cmn-Hans-CN'],

    // A bare subtag claimed by several locales resolves to the FLEURS one, which is the
    // variant the registry was seeded from and the harness measures.
    ['en', 'en-US'],
    ['pt', 'pt-BR'],
    ['fr', 'fr-FR'],
    ['bn', 'bn-IN'],

    // Legacy ISO codes that still turn up in imported metadata.
    ['iw', 'he-IL'],
    ['in', 'id-ID'],

    ['xx', null],
    ['', null],
    ['   ', null],
    ['../etc/passwd', null],
    ['my-MM; DROP TABLE runs', null],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeCode(input)).toBe(expected);
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['', '-', '---', 'a'.repeat(500), '🙂', 'en-US-x-private', 'i-navajo']) {
      expect(() => normalizeCode(input)).not.toThrow();
    }
  });

  it('only ever returns a code the registry actually has', () => {
    for (const input of ['my', 'zh', 'pa-IN', 'en', 'iw']) {
      const code = normalizeCode(input);
      expect(code).not.toBeNull();
      expect(normalizeCode(code!)).toBe(code);
    }
  });
});
