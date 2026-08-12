#!/usr/bin/env python3
"""Regenerate `src/metrics/__fixtures__/parity.json`.

Run by hand on a dev machine, never in CI. Python is not installed in CI and must not become
a prerequisite for `pnpm test` — the committed fixture is what CI asserts against.

    cd packages/core/scripts
    python3 -m venv .venv
    .venv/bin/pip install -r requirements-dev.txt
    .venv/bin/python gen-parity.py

Why this file exists at all
---------------------------
`packages/core/src/metrics` reimplements CER, WER and chrF2 in TypeScript rather than shelling
out to `jiwer`/`sacrebleu`. Phase 5 §5.5 gives three reasons, the load-bearing one being that
jiwer's WER tokenizer splits on spaces — precisely wrong for Burmese, Khmer, Lao and Thai,
where it yields a per-sentence WER of 0 or 1 and a corpus WER that means nothing. We return
`null` for those scripts instead; jiwer cannot.

The price of not using the reference libraries is exactly one cross-check, done once and
frozen. That is this file. `parity.test.ts` asserts our numbers against these, so a refactor
of the DP, of the n-gram extraction or of the corpus aggregation cannot quietly change what a
CER means.

**The fixture holds raw, un-normalized strings.** `normalizeForScoring` is deliberately not in
the loop: it is tested separately by snapshot. Mixing the two would let a normalizer bug hide
inside a metric assertion and vice versa.

Documented divergences
----------------------
Three cases below record places where our implementation deliberately differs from jiwer.
They are in the fixture *because* they differ — a divergence nobody wrote down is a bug
waiting to be discovered by a wrong number in a report.

1. ``empty-ref``  — jiwer's ``process_words`` special-cases an empty reference and returns the
   raw *insertion count* rather than a rate (``jiwer/process.py``: ``if num_rf_words == 0:
   wer = num_insertions``). So ``jiwer.wer("", "a b c") == 3.0``, which is not an error rate at
   all. We return ``null``: an error rate against nothing is undefined, not 300%.
2. ``padded-whitespace`` — jiwer applies ``Strip()`` before measuring, so leading and trailing
   whitespace never reaches the DP. Our ``cer()`` measures exactly the string it is handed and
   leaves stripping to ``normalizeForScoring``. One normalizer, one place.
3. ``tab-separated`` — jiwer's word tokenizer is ``RemoveMultipleSpaces`` (``\\s\\s+`` -> one
   space) followed by ``split(" ")``: a *single* tab between two words is never converted and
   never split on, so "a\\tb" is one token to jiwer and two to us. This is the small, concrete
   version of the reason we do not use jiwer for WER.

chrF
----
sacrebleu's ``CHRF`` defaults are ``char_order=6, word_order=0, beta=2, whitespace=False,
eps_smoothing=False`` — i.e. plain chrF2, which is what the research doc's numbers are. One
``chrf++`` column is emitted as well (``word_order=2``) purely to keep the word-n-gram and
punctuation-splitting half of our port honest; nothing in the product reports chrF++ today,
and an untested code path is how a port rots.
"""

from __future__ import annotations

import json
import platform
import sys
from datetime import date, timezone, datetime
from importlib.metadata import version
from pathlib import Path

import jiwer
import sacrebleu
from sacrebleu.metrics import CHRF

OUT = Path(__file__).resolve().parent.parent / "src" / "metrics" / "__fixtures__" / "parity.json"

CHRF2 = CHRF()  # char_order=6, word_order=0, beta=2, whitespace=False, eps_smoothing=False
CHRFPP = CHRF(word_order=2)

# (id, hypothesis, reference, divergence, why)
#
# `divergence` names a documented difference from jiwer for that case, or None. The TS test
# branches on it, so adding a case with an unknown divergence tag fails loudly.
CASES: list[tuple[str, str, str, str | None, str]] = [
    (
        "ascii-basic",
        "the cat sat",
        "the cat sit",
        None,
        "Sanity. One substitution at character and word level.",
    ),
    (
        "identical",
        "the quick brown fox",
        "the quick brown fox",
        None,
        "0.0 CER, 0.0 WER, chrF2 exactly 100.",
    ),
    (
        "empty-hyp",
        "",
        "the cat sat",
        None,
        "CER 1.0, WER 1.0, chrF2 0.0. A provider that returns nothing must not score well.",
    ),
    (
        "empty-ref",
        "the cat sat",
        "",
        "empty-reference",
        "jiwer returns the insertion COUNT, not a rate. We return null.",
    ),
    (
        "hyp-longer",
        "the big black cat sat down",
        "the cat sat",
        None,
        "Insertions dominate; CER and WER both exceed nothing but stay finite.",
    ),
    (
        "single-char",
        "a",
        "b",
        None,
        "Off-by-one in the DP seed row shows up here and nowhere else.",
    ),
    (
        "burmese-spaced",
        "အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက် ကို နေပြည်တော် က တုန့်ပြန် ခဲ့ ပါ တယ်",
        "အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက် ကို နေပြည်တော် က တုံ့ပြန်ခဲ့ ပါ တယ်",
        None,
        "Google emits syllable-spaced Burmese; the spacing differs from the reference and the "
        "words do not. This is the pair that makes cer_nospace the tiering metric.",
    ),
    (
        "burmese-unspaced",
        "အာဆီယံရဲ့ဆုံးဖြတ်ချက်ကိုနေပြည်တော်ကတုန့်ပြန်ခဲ့ပါတယ်",
        "အာဆီယံရဲ့ဆုံးဖြတ်ချက်ကိုနေပြည်တော်ကတုံ့ပြန်ခဲ့ပါတယ်",
        None,
        "The same sentence with whitespace already stripped. Its CER is the number that means "
        "something; jiwer's WER on it is 1.0 from a single character edit, which is why we "
        "report null instead.",
    ),
    (
        "burmese-mangled",
        "လာက္းကေက် ရိုရ်းသဲ့ထါတ် နို့ရ်းတို့အ်းတ်",
        "အာဆီယံ ရဲ့ ဆုံးဖြတ်ချက် ကို နေပြည်တော် က တုံ့ပြန်ခဲ့ ပါ တယ်",
        None,
        "Groq whisper-large-v3 on `language=my`, 2026-07-30, HTTP 200. Myanmar script, not "
        "Burmese words: script integrity scores it 1.00 and only CER can call it wrong. This "
        "case is the whole argument for the metrics layer, so its number is frozen.",
    ),
    (
        "amharic",
        "ኢትዮጵያ በአፍሪካ ቀንድ ውስጥ ትገኛለች፣ አዲስ አበባ ዋና ከተማዋ ናት።",
        "ኢትዮጵያ በአፍሪካ ቀንድ ውስጥ ትገኛለች፣ አዲስ አበባ ዋና ከተማዋ ናት፡፡",
        None,
        "Ethiopic: BMP, space-delimited, its own punctuation (። ፣).",
    ),
    (
        "pashto-with-latin-acronym",
        "د ملگرو ملتونو UN رپوټ وايي چې د نړیوالې تودوخې اغیزې زیاتې دي",
        "د ملگرو ملتونو UN راپور وايي چې د نړیوالې تودوخې اغېزې زیاتې دي",
        None,
        "RTL with an embedded LTR run. Logical order is what is measured; visual order is a "
        "rendering concern and must not leak into a metric.",
    ),
    (
        "combining-marks",
        "ọ̀rọ̀ ẹlẹ́rìí náà ṣe pàtàkì",
        "ọ̀rọ̀ ẹlẹ́rí náà ṣe pàtàkì",
        None,
        "Yoruba. Codepoint CER and grapheme CER MUST differ here — jiwer counts code points, "
        "so its number is the codepoint one.",
    ),
    (
        "astral-emoji",
        "the score was 3-2 🇧🇷 and the crowd cheered 🎉",
        "the score was 3-1 🇧🇷 and the crowd cheered 🎊",
        None,
        "Astral plane. Any accidental `.length`, `charAt` or `[i]` in the port fails here and "
        "passes everywhere else.",
    ),
    (
        "chrf-short",
        "cat",
        "cot",
        None,
        "Hypothesis shorter than char_order=6, so orders 4-6 have no n-grams at all. This is "
        "the effective-order branch of sacrebleu's _compute_f_score.",
    ),
    (
        "chrf-asymmetric-short",
        "a",
        "the quick brown fox jumps",
        None,
        "Reference has n-grams at every order and the hypothesis has one. sacrebleu reports "
        "n_hyp as 0 for any order where the reference Counter is empty — the detail the "
        "obvious port gets wrong.",
    ),
    (
        "chrf-long",
        "the united nations report says the effects of global warming are increasing rapidly",
        "the united nations report said that effects of global warming are increasing rapidly",
        None,
        "A full sentence at every order, which is where chrF2 actually operates.",
    ),
    (
        "punct-heavy",
        'he said, "it is over" — and left; she did not.',
        'he said "it is over", and left; she did not!',
        None,
        "Exercises chrF++'s punctuation-splitting word tokenizer, which is unlike every other "
        "tokenizer in this repo.",
    ),
    (
        "padded-whitespace",
        "  the cat sat  ",
        "the cat sit",
        "jiwer-strips",
        "jiwer applies Strip() before measuring; we measure the string we were handed.",
    ),
    (
        "tab-separated",
        "the\tcat sat",
        "the cat sit",
        "jiwer-space-tokenizer",
        "jiwer splits words on ' ' only, so 'the\\tcat' is one token to it and two to us.",
    ),
]

# The corpus block. Both libraries aggregate statistics and score once — CER is the ratio of
# summed edits to summed reference length, chrF2 sums per-order n-gram counts — and NEITHER is
# the mean of the sentence scores. Clip lengths in FLEURS vary by 4x, so the two differ
# materially and the wrong one over-weights short clips. Frozen here so the aggregation cannot
# regress to a mean without a red test.
CORPUS: list[tuple[str, str]] = [
    ("the cat sat", "the cat sit"),
    ("a", "the quick brown fox jumps over the lazy dog near the river bank at dawn"),
    ("the united nations report says warming is increasing", "the united nations report said warming is increasing"),
    ("hello", "hello"),
]


def case_row(cid: str, hyp: str, ref: str, divergence: str | None, why: str) -> dict:
    row: dict = {
        "id": cid,
        "hyp": hyp,
        "ref": ref,
        "why": why,
        "divergence": divergence,
        "sacrebleu": {
            "chrf2": CHRF2.sentence_score(hyp, [ref]).score,
            "chrfPlusPlus": CHRFPP.sentence_score(hyp, [ref]).score,
        },
    }

    chars = jiwer.process_characters(ref, hyp)
    words = jiwer.process_words(ref, hyp)
    row["jiwer"] = {
        "cer": chars.cer,
        "wer": words.wer,
        # Counts, not just rates: a rate that matches for the wrong reason (compensating
        # errors in the numerator and denominator) is exactly what a parity fixture is for.
        "refChars": chars.hits + chars.substitutions + chars.deletions,
        "refWords": words.hits + words.substitutions + words.deletions,
        "charEdits": chars.substitutions + chars.deletions + chars.insertions,
        "wordEdits": words.substitutions + words.deletions + words.insertions,
    }
    return row


def main() -> None:
    hyps = [h for h, _ in CORPUS]
    refs = [r for _, r in CORPUS]
    corpus_chars = jiwer.process_characters(refs, hyps)
    corpus_words = jiwer.process_words(refs, hyps)
    corpus_chrf2 = CHRF2.corpus_score(hyps, [refs])
    corpus_chrfpp = CHRFPP.corpus_score(hyps, [refs])

    doc = {
        "$comment": (
            "GENERATED by packages/core/scripts/gen-parity.py. Do not hand-edit — a "
            "hand-written expectation is worth nothing here, because the entire point is "
            "that our CER/WER/chrF2 agree with the reference implementations. Regenerate "
            "with the pinned requirements-dev.txt and commit the diff."
        ),
        "generatedAt": date.today().isoformat(),
        "generatedAtUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "python": platform.python_version(),
        # jiwer exports no __version__, so ask the installed distribution rather than
        # recording "unknown" in a file whose whole job is provenance.
        "jiwer": version("jiwer"),
        "sacrebleu": sacrebleu.__version__,
        # sacrebleu refuses to produce a signature until the metric has scored something,
        # which is why the corpus scores are computed above rather than inline below.
        "chrfSignature": str(CHRF2.get_signature()),
        "chrfPlusPlusSignature": str(CHRFPP.get_signature()),
        "cases": [case_row(*c) for c in CASES],
        "corpus": {
            "why": (
                "Corpus CER is the ratio of sums and corpus chrF2 aggregates per-order "
                "n-gram statistics before scoring. Neither is the mean of the sentence "
                "values, and the difference is large on a skewed length distribution."
            ),
            "pairs": [{"hyp": h, "ref": r} for h, r in CORPUS],
            "jiwer": {
                "cer": corpus_chars.cer,
                "wer": corpus_words.wer,
                "refChars": corpus_chars.hits + corpus_chars.substitutions + corpus_chars.deletions,
                "refWords": corpus_words.hits + corpus_words.substitutions + corpus_words.deletions,
                "charEdits": corpus_chars.substitutions + corpus_chars.deletions + corpus_chars.insertions,
                "wordEdits": corpus_words.substitutions + corpus_words.deletions + corpus_words.insertions,
            },
            "sacrebleu": {
                "chrf2": corpus_chrf2.score,
                "chrfPlusPlus": corpus_chrfpp.score,
            },
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"wrote {OUT} — {len(CASES)} cases, jiwer {doc['jiwer']}, sacrebleu {doc['sacrebleu']}", file=sys.stderr)


if __name__ == "__main__":
    main()
