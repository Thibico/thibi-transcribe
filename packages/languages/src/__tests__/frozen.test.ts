import { describe, expect, it } from 'vitest';
import { LANGUAGES, PROVIDER_MATRIX, SCRIPTS } from '../generated/registry.gen.js';

/**
 * The registry is a shared table imported by the engine, the CLI, the worker and React
 * client components alike. If any one of them can mutate it, all the others silently
 * inherit the mutation. Freezing is the cheap structural guarantee that they cannot.
 *
 * Note that this only throws in strict mode — which ESM always is. A sloppy-mode
 * `node -e "…"` one-liner will silently no-op the assignment and look like a failure when
 * it is not; use `node --input-type=module -e`.
 */
describe('the generated registry is deeply frozen', () => {
  it('freezes the top-level tables', () => {
    expect(Object.isFrozen(LANGUAGES)).toBe(true);
    expect(Object.isFrozen(SCRIPTS)).toBe(true);
    expect(Object.isFrozen(PROVIDER_MATRIX)).toBe(true);
  });

  it('freezes entries, nested objects and arrays', () => {
    const my = LANGUAGES['my-MM']!;
    expect(Object.isFrozen(my)).toBe(true);
    expect(Object.isFrozen(my.text)).toBe(true);
    expect(Object.isFrozen(my.text.punctuation)).toBe(true);
    expect(Object.isFrozen(my.text.normalizers)).toBe(true);
    expect(Object.isFrozen(my.subtitle)).toBe(true);
    expect(Object.isFrozen(SCRIPTS['Mymr']!.unicodeRanges)).toBe(true);
    expect(Object.isFrozen(SCRIPTS['Mymr']!.unicodeRanges[0])).toBe(true);
    expect(Object.isFrozen(SCRIPTS['Mymr']!.typography)).toBe(true);
  });

  it('throws on assignment', () => {
    expect(() => {
      (LANGUAGES['my-MM'] as { nameEn: string }).nameEn = 'x';
    }).toThrow(TypeError);
    expect(() => {
      (LANGUAGES as Record<string, unknown>)['zz-ZZ'] = {};
    }).toThrow(TypeError);
    expect(() => {
      (LANGUAGES['my-MM']!.text.normalizers as string[]).push('digits');
    }).toThrow(TypeError);
  });
});
