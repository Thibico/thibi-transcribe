# Recorded Whisper responses

**Every file here is what the API actually returned**, captured on **2026-08-11** by sending a
real clip and writing the response down. None of it is hand-written. That is the point: a
parser test over invented JSON only ever tests that the parser matches somebody's memory of
the shape, and the two most valuable fixtures in this directory are the two where the memory
would have been wrong.

Each file is `{ status, ms, headers, body }` — the envelope matters as much as the body,
because `x-ratelimit-*` is where Groq's real limits live and `retry-after` is what the retry
policy honours.

## Clips

| Clip | What |
|---|---|
| `packages/languages/fixtures/probe-2s.flac` | 2 s of Burmese news speech. The clip every probe sends. |
| a 10.4 s English TTS clip | Generated for these recordings, not committed. 215,058 bytes at 16 kHz mono FLAC — **20.8 KB/s**, an independent corroboration of the corrected 18.9 KB/s and nowhere near the 110 KB/s the Phase 4 plan originally assumed. |

## The files

| File | Call | What it pins |
|---|---|---|
| `openai-verbose-json-en.json` | `whisper-1`, `language=en`, `verbose_json` | The shape the whole adapter is built on: `words` is a **flat top-level array of 28**, `segments` is 4, and no segment contains a `words` key. Word objects are `{word,start,end}` — **no probability field**, which is the measurement behind `wordConfidence: false`. |
| `openai-prompt-echo-en.json` | as above, plus an 8-term glossary `prompt` | The prompt was accepted and **not** echoed. Recorded because "Whisper sometimes echoes the prompt" is the claim `stripPromptEcho` exists for, and this is the evidence that it does not always — so the guard must be a no-op on the normal case. |
| `openai-my-rejected.json` | `whisper-1`, `language=my` | HTTP 400, `Language 'my' is not supported.`, `code: unsupported_language`. The 44-language exclusive set is built out of exactly this string. |
| `openai-gpt4o-json-en.json` | `gpt-4o-transcribe`, `response_format=json` | Text only. No `segments`, no `words`, no `duration`. |
| `openai-gpt4o-verbose-refused.json` | `gpt-4o-transcribe`, `verbose_json` | HTTP 400: *"response_format 'verbose_json' is not compatible with model 'gpt-4o-transcribe-api-ev3'"*. The `jsonOnlyModels` list is this response, not a documentation footnote. It also leaks the real model id behind the alias. |
| `groq-my-mangled.json` | `whisper-large-v3`, `language=my` | **HTTP 200 with Khmer script for Burmese audio.** `avg_logprob` −0.603, `no_speech_prob` 0.051 — indistinguishable from a healthy result. |
| `groq-my-autodetect.json` | `whisper-large-v3`, no language | **HTTP 200 with Vietnamese** — `Cô Nga dễ cô giáp cho khỏe mặt bê bồ.` — and `language: "Vietnamese"` in the body. This is why autodetect is disabled outright for Groq rather than discouraged. |
| `groq-en-verbose.json` | `whisper-large-v3`, `language=en` | The control. Groq is correct and fast on English, which is exactly what makes the two rows above dangerous: nothing in the response distinguishes them. |

## The finding these were recorded to check

The 2026-07-30 research measured Groq returning **Myanmar-script non-words** for `language=my`
and **romanised Latin** on autodetect. Re-running on 2026-08-11 with a different clip produced
**Khmer** and **Vietnamese** instead. Two clips, two dates, three distinct failure modes, all
HTTP 200, all with healthy-looking `avg_logprob` and `no_speech_prob`.

Note what that does to script integrity as a screen. On the 2026-07-30 sample it caught the
autodetect case and missed the `language=my` case, because Myanmar-script non-words are still
Myanmar script. On these samples it catches **both**, because Khmer is not Myanmar either.
Script integrity is a cheap screen that catches wrong-alphabet output; it is not a guarantee,
and CER against a reference is still what Phase 5 needs.

## Re-recording

`packages/engine/src/providers/whisper/__tests__/record-fixtures.mjs` regenerates these
against the live APIs. Re-record when a provider changes shape — and when you do, **update the
dates in this file and read the diff**, because a changed fixture is a finding.
