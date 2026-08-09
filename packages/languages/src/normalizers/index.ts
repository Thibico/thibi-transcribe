import type { NormalizerId, ResolvedLanguage, ScriptEntry } from '../types.js';

/**
 * Registry-driven text normalization: the chain applied to provider output to produce
 * `segments.text`. `segments.text_raw` keeps the exact provider bytes, which is the audit
 * trail the old app lost by normalizing in place at `lib/queue.ts:126`.
 */

export interface NormalizerContext {
  zeroWidth: ScriptEntry['zeroWidth'];
  digits: ScriptEntry['digits'];
  digitPolicy: 'latin' | 'native' | 'preserve';
}

export type Normalizer = (text: string, ctx: NormalizerContext) => string;

/** Unicode NFC. Always first — every downstream comparison assumes a single normal form. */
export const nfc: Normalizer = (text) => text.normalize('NFC');

const ZWSP = '​';
const ZWNJ = '‌';
const ZWJ = '‍';
const BOM = '﻿';

/**
 * ZWSP is always noise and is always stripped. ZWNJ and ZWJ are *semantic* in Sinhala and
 * Devanagari and must survive there, so they are policy-driven per script rather than
 * swept up with it. Getting this wrong silently changes what a word means.
 */
export const zeroWidth: Normalizer = (text, ctx) => {
  let out = text.replaceAll(ZWSP, '').replaceAll(BOM, '');
  if (ctx.zeroWidth.zwnj === 'strip') out = out.replaceAll(ZWNJ, '');
  if (ctx.zeroWidth.zwj === 'strip') out = out.replaceAll(ZWJ, '');
  return out;
};

/**
 * Collapse runs of whitespace and trim. Safe for scriptio-continua scripts: Google emits
 * syllable-spaced Burmese and we preserve that, we only refuse to preserve *runs*.
 */
export const collapseWs: Normalizer = (text) => text.replace(/\s+/gu, ' ').trim();

const LATIN_DIGITS = '0123456789';

/** Fold native digit shapes to ASCII, or the reverse, per the language's policy. */
export const digits: Normalizer = (text, ctx) => {
  const sets = ctx.digits.native.filter((s) => [...s].length === 10);
  if (sets.length === 0) return text;

  if (ctx.digitPolicy === 'latin') {
    // Every set folds, not just the preferred one: an Arabic-script language can receive
    // either Arabic-Indic or Extended Arabic-Indic digits from a provider.
    return sets.reduce((acc, set) => replaceByIndex(acc, set, LATIN_DIGITS), text);
  }
  if (ctx.digitPolicy === 'native') {
    return replaceByIndex(text, LATIN_DIGITS, sets[0]!);
  }
  return text;
};

function replaceByIndex(text: string, from: string, to: string): string {
  const fromChars = [...from];
  const toChars = [...to];
  let out = '';
  for (const ch of text) {
    const i = fromChars.indexOf(ch);
    out += i === -1 ? ch : (toChars[i] ?? ch);
  }
  return out;
}

const NORMALIZERS: Record<Exclude<NormalizerId, 'zawgyi'>, Normalizer> = {
  nfc,
  'zero-width': zeroWidth,
  'collapse-ws': collapseWs,
  digits,
};

/** Build the context a normalizer chain needs from a resolved language. */
export function normalizerContext(language: ResolvedLanguage): NormalizerContext {
  return {
    zeroWidth: { ...language.scriptEntry.zeroWidth, ...language.text.zeroWidthPolicy },
    digits: language.scriptEntry.digits,
    // A language may override; otherwise the script's own default decides.
    digitPolicy:
      language.text.digits ?? (language.scriptEntry.digits.foldToLatin ? 'latin' : 'preserve'),
  };
}

/**
 * Apply a language's normalizer chain, in order.
 *
 * `zawgyi` is rejected rather than silently skipped. It is not length-preserving, so it
 * cannot run in a string -> string chain over segment text without desynchronising word
 * alignment; Phase 1 applies it per word and re-derives the segment. A language listing it
 * here is a configuration mistake, and a mistake that would corrupt timings deserves to
 * fail loudly.
 */
export function applyNormalizers(
  text: string,
  ids: readonly NormalizerId[],
  ctx: NormalizerContext,
): string {
  let out = text;
  for (const id of ids) {
    if (id === 'zawgyi') {
      throw new Error(
        'The zawgyi normalizer cannot run in the segment-text chain: it is not ' +
          'length-preserving and would desynchronise word alignment. Apply it per word ' +
          '(Phase 1) and set text.zawgyiApplies instead of listing it in text.normalizers.',
      );
    }
    out = NORMALIZERS[id](out, ctx);
  }
  return out;
}

/** Convenience: normalize `text` as `language` says it should be normalized. */
export function normalizeText(text: string, language: ResolvedLanguage): string {
  return applyNormalizers(text, language.text.normalizers, normalizerContext(language));
}
