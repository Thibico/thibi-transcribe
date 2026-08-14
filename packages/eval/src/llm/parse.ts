/**
 * Reading the model's reply.
 *
 * The contract is `{"segments":[{"idx":<integer>,"text":"<text>"}]}` and the parser is
 * tolerant of exactly one thing beyond it: the code fence models wrap JSON in when they have
 * been told to return JSON only. It is tolerant of nothing else.
 *
 * **A failure to parse is recorded as a failure, never as the input.** Falling back to the
 * input would score the segment identically to the `control` arm, which is the single most
 * flattering thing this harness could do to a broken arm: a model returning prose for every
 * segment would come out level with doing nothing instead of visibly failing.
 */

/** Match on `idx`, never on position — the Phase 6 §6.2 rule, and it applies to a batch of one. */
export function parseSegmentsResponse(text: string): Map<number, string> | null {
  const body = extractJson(text);
  if (body === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const segments = Array.isArray(parsed)
    ? parsed
    : (parsed as { segments?: unknown })?.segments;
  if (!Array.isArray(segments)) return null;

  const out = new Map<number, string>();
  for (const item of segments) {
    if (item === null || typeof item !== 'object') continue;
    const { idx, text: value } = item as { idx?: unknown; text?: unknown };
    if (typeof idx !== 'number' || !Number.isInteger(idx)) continue;
    if (typeof value !== 'string') continue;
    // A duplicate idx in one response updates nothing: the first answer stands, because there
    // is no way to tell which of two answers for the same segment the model meant.
    if (out.has(idx)) continue;
    out.set(idx, value);
  }
  return out.size === 0 ? null : out;
}

/** The outermost JSON object or array in the reply, fences and preamble removed. */
function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.search(/[[{]/u);
  if (start === -1) return null;
  const open = body[start];
  const close = open === '[' ? ']' : '}';
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  return body.slice(start, end + 1);
}
