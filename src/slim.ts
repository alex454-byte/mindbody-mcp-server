/**
 * Token reduction at the tool-result boundary.
 *
 * Measured on a /client/clientcompleteinfo-shaped response: roughly a 55%
 * cut in characters, from two changes that lose no information:
 *
 *   compact JSON (drop pretty-print indentation)  ~24%
 *   drop null/empty fields                        ~40%
 *   both together                                 ~55%
 *
 * Why null-dropping is information-preserving, not lossy: in MBO's schema a
 * null field means "not set" and an absent field means the same thing to a
 * reading model. MBO responses are null-heavy — a single client record
 * carries ~20 nulls (SuspensionInfo, BirthDate, MobileProvider, HomePhone,
 * WorkPhone, AddressLine1/2, City, PostalCode, PhotoUrl, 4x
 * EmergencyContactInfo*, RedAlert, YellowAlert, MiddleName, ProspectStage,
 * LockerNumber, ClientType...) — so this is a large, safe win.
 *
 * Deliberately NOT a blocklist of "noise" field names (Tax1-5, PaymentRefId,
 * GiftCardBarcodeId...). That approach needs endless maintenance as MBO adds
 * fields, and risks dropping something a caller actually needed. Emptiness
 * is a property of the DATA, not a guess about relevance.
 */

/**
 * Recursively remove null/undefined values, empty arrays, and objects that
 * become empty as a result. Returns undefined when the value itself should
 * be dropped by its parent.
 */
export function dropEmpty(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return value;

  // Cycle guard scoped to the recursion PATH, same approach as maskPii in
  // pii.ts — MBO responses are JSON.parse output and cannot actually cycle,
  // but this is exported and reusable.
  if (seen.has(value as object)) return undefined;
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      const items = value.map((v) => dropEmpty(v, seen)).filter((v) => v !== undefined);
      // An array that is empty in the SOURCE is dropped by the caller below;
      // an array whose items all dropped is likewise uninformative.
      return items;
    }

    // Preserve Date rather than destructuring it into {}.
    if (value instanceof Date) return value.toISOString();

    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = dropEmpty(raw, seen);
      if (cleaned === undefined) continue;
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      out[key] = cleaned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } finally {
    seen.delete(value as object);
  }
}

/**
 * Serialise a tool result for the MCP text block.
 *
 * `slim` defaults ON. A caller that genuinely needs the raw shape (debugging
 * an MBO response, or a field whose absence is itself meaningful) can opt
 * out per-call rather than being stuck with a lossy default they cannot
 * escape.
 */
export function serializeToolData(data: unknown, opts: { slim?: boolean } = {}): string {
  const slim = opts.slim !== false;
  if (!slim) return JSON.stringify(data, null, 2);

  const cleaned = dropEmpty(data);
  // A payload that reduces to nothing still has to serialise to valid JSON —
  // `undefined` would make JSON.stringify return undefined, not "null", and
  // the MCP text block requires a string.
  return JSON.stringify(cleaned === undefined ? (Array.isArray(data) ? [] : {}) : cleaned);
}
