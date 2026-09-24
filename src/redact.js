// Redaction helpers.
//
// The one rule this whole package answers to: a credential value must never
// appear in a log line, an error message, a tool result, a commit, or a
// published file. A sibling MCP plugin once shipped a leak where a single-line
// credential payload was classed as a path and printed verbatim. We never
// classify by shape, and we never pass
// a raw OS or upstream buffer through to output; everything user-visible is
// built from fixed strings and values we have deliberately allowed.

/**
 * Active-call secrets to scrub from any diagnostic string. Reference-counted so
 * concurrent calls with different (or identical) credential files each register
 * and release their own token without one call clearing another's — the registry
 * is process-wide but the lifetime is per-call.
 * @type {Map<string, number>}
 */
const activeSecrets = new Map();

/** Register a secret value to be scrubbed from diagnostics during a call. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length > 0) {
    activeSecrets.set(value, (activeSecrets.get(value) || 0) + 1);
  }
}

/** Release one registration of a secret. Call in a finally after each call. */
export function unregisterSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return;
  const n = activeSecrets.get(value);
  if (n === undefined) return;
  if (n <= 1) activeSecrets.delete(value);
  else activeSecrets.set(value, n - 1);
}

/** Clear all registered secrets (defensive; used by tests). */
export function clearSecrets() {
  activeSecrets.clear();
}

/**
 * Scrub any registered secret substring, plus anything that looks like a bearer
 * header, from a string. Belt and suspenders: we already avoid putting secrets
 * into strings, but a defensive scrub means an accidental interpolation degrades
 * to `<redacted>` rather than leaking.
 *
 * Known limitations, deliberately not "fixed" (see PR discussion, Refs #12):
 *   - Unicode normalization: a secret registered in one form (e.g. NFC) will not
 *     match the same glyphs supplied in another (NFD). Nothing in the pipeline
 *     re-normalizes a credential between registration and output, so the mismatch
 *     is not reachable in practice; normalizing both sides would rewrite the bytes
 *     of legitimate non-ASCII diagnostic text, which is a worse trade.
 *   - Minimum secret length: a very short registered secret over-redacts
 *     surrounding text. That fails safe (never a leak); a length guard would risk
 *     skipping a genuinely short credential, which would be a real leak. Not worth
 *     it, so there is no guard.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function scrub(text) {
  let out;
  if (typeof text === 'string') {
    out = text;
  } else {
    // `String(text ?? '')` throws on a value that cannot be coerced to a
    // primitive — e.g. a null-prototype object, which has no reachable
    // toString/valueOf. A backstop that throws stops scrubbing, so on any
    // coercion failure degrade to a fixed sentinel. The sentinel is chosen
    // over a second coercion attempt (e.g. `Object.prototype.toString.call`,
    // which reads `Symbol.toStringTag` and so still throws for a Proxy with a
    // throwing `get` trap or an object with a throwing `toStringTag` getter):
    // a constant cannot throw and, being fixed text, cannot echo any part of
    // the input — so no registered secret can leak through this path.
    //
    // The sentinel is `<unrenderable>` rather than an empty string so an
    // operator reading a log or error message still sees that a value was
    // present but could not be rendered, instead of silence. It is a literal
    // constant, so it carries no input-derived text and keeps every
    // leak-safety property of the empty-string fallback.
    try {
      out = String(text ?? '');
    } catch {
      out = '<unrenderable>';
    }
  }
  // Secrets are the Map keys; iterate keys(), not the Map itself (which yields
  // [key, count] entry pairs and would never match the secret string).
  //
  // Resolve every match span for every registered secret against the ORIGINAL
  // text, merge spans that overlap, then replace each merged span with a single
  // marker in one left-to-right pass. This is done instead of a sequential
  // split/join per secret because sequential replacement mutates the text
  // between secrets: once `abcdef` becomes `<redacted>`, a later `split('cdefgh')`
  // can no longer see the `cdef` the two secrets shared, so a partially
  // overlapping neighbour leaves a fragment behind and the result depends on
  // registration order. Matching spans against the untouched original and
  // merging overlaps closes both the containment case and the partial-overlap
  // case, order-independently.
  if (activeSecrets.size > 0) {
    /** @type {Array<[number, number]>} half-open [start, end) match spans */
    const spans = [];
    for (const secret of activeSecrets.keys()) {
      if (!secret) continue;
      // Non-overlapping matches of a single secret: advance past each hit so a
      // repeated secret yields one span per occurrence.
      let from = 0;
      let idx;
      while ((idx = out.indexOf(secret, from)) !== -1) {
        spans.push([idx, idx + secret.length]);
        from = idx + secret.length;
      }
    }
    if (spans.length > 0) {
      spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let result = '';
      let cursor = 0; // end of the last span already emitted
      let [start, end] = spans[0];
      for (let i = 1; i <= spans.length; i++) {
        // Merge only spans that truly overlap (the next starts before the
        // current ends). Merely adjacent spans (next start === current end) are
        // left separate so two back-to-back distinct secrets still redact to two
        // markers, matching the prior behaviour.
        if (i < spans.length && spans[i][0] < end) {
          if (spans[i][1] > end) end = spans[i][1];
          continue;
        }
        result += out.slice(cursor, start) + '<redacted>';
        cursor = end;
        if (i < spans.length) [start, end] = spans[i];
      }
      result += out.slice(cursor);
      out = result;
    }
  }
  // A defensive catch for an Authorization header that reached a string despite
  // us never intentionally formatting one.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
  return out;
}

/**
 * Render a filesystem path safely for an error message. Paths are not secret,
 * but control characters in a crafted path could corrupt a terminal or a log,
 * so they are escaped. The path itself is preserved so the operator can act on
 * the error.
 *
 * @param {string} p
 * @returns {string}
 */
export function safePath(p) {
  const s = String(p ?? '');
  // Escape ASCII control characters (including newline/tab) as \xNN so a crafted
  // path cannot inject log lines or terminal escapes.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, (c) =>
    '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'),
  );
}
