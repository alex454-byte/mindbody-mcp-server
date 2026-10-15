/**
 * PII masking — applied to every tool result before it reaches the model.
 *
 * Members' contact details never leave the server, while questions about them
 * ("how many sessions has this member attended") still work: identifiers are
 * replaced with stable pseudonyms, person names are reduced to initials, and
 * free text on a person record is withheld by default.
 *
 * Pseudonyms can be reversed only inside this process (see resolvePseudonym),
 * so the model can pass a token back to a tool ("get this member's visits")
 * without ever seeing the real id.
 */

import { createHmac } from "node:crypto";

/** Removed outright — no question the model answers needs these. */
const DROP_FIELDS = new Set(
  [
    "Email",
    "MobilePhone",
    "HomePhone",
    "WorkPhone",
    "AddressLine1",
    "AddressLine2",
    "PostalCode",
    "BirthDate",
    "Notes",
    "City",
    "State",
    "Country",
  ].map((f) => f.toLowerCase()),
);

/**
 * Any field whose name contains one of these is dropped. Substring match,
 * because Mindbody field naming is inconsistent: Note vs Notes, StaffNotes,
 * AppointmentNotes, EmergencyContactInfoPhone, BillingAddress.
 *
 * "alert" (RedAlert/YellowAlert), "custom" (CustomClientFields), "barcode"
 * (gift card ids), "contracttext" (contract bodies) and "comment" are member
 * free text or secret identifiers that can appear on objects without a name
 * field, so they are listed here rather than relying on person-shape detection.
 */
const DROP_SUBSTRINGS = [
  "creditcard",
  "cardnumber",
  "ssn",
  "password",
  "token",
  "email",
  "phone",
  "address",
  "note",
  "photo",
  "birth",
  "emergencycontact",
  "alert",
  "custom",
  "barcode",
  "contracttext",
  "comment",
];

/** Lowercase + strip `_` and `-`, so member_id === memberId === memberid. */
function normalizePiiKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/**
 * Identifier fields, matched by SUFFIX so variants such as PayerClientId and
 * RelatedClientId are caught without listing each one.
 */
function isIdField(lowerKey: string): boolean {
  const k = normalizePiiKey(lowerKey);
  return (
    k.endsWith("clientid") ||
    k.endsWith("uniqueid") ||
    k.endsWith("memberid") ||
    k.endsWith("userid") ||
    k === "maskedid"
  );
}

/**
 * Whole key names for PII that can arrive as a NUMBER — `zip: 12345`,
 * `dob: 19900101`, `phoneNumber: 5550100100`. Exact names only, never stems,
 * so aggregates such as `pctWithUsableZip` survive.
 */
const NUMERIC_PII_EXACT = new Set([
  "zip",
  "zipcode",
  "dob",
  "dateofbirth",
  "phonenumber",
  "phoneno",
  "mobilenumber",
  "cellphone",
  "mobile",
  "fax",
  "faxnumber",
  "ssnnumber",
]);

/**
 * PERSON-name fields only. A generic `Name` is service/class/site metadata;
 * masking it would turn "Intro Trial" into "IT" for no privacy gain.
 */
const NAME_FIELDS = new Set([
  "firstname",
  "lastname",
  "middlename",
  "preferredname",
  "fullname",
  "clientname",
  "clientfirstname",
  "clientlastname",
]);

/**
 * STAFF name fields, shown in full. Instructors and sales staff are named in
 * schedules and reports; members are private. Staff CONTACT detail
 * (email/phone/address) is still dropped by shouldDrop — only the name passes.
 */
const STAFF_NAME_FIELDS = new Set([
  "coach",
  "coachname",
  "staffname",
  "salesleader",
  "salesleadername",
  "salesrep",
  "salesrepname",
  "instructorname",
  "trainername",
]);

/**
 * A staff record carries a StaffId and NO member id. Member records (visits,
 * appointments) routinely carry a staff foreign key alongside the member's own
 * name, so a member id present means this is the member's record.
 */
function isStaffShapedObject(obj: Record<string, unknown>): boolean {
  let hasStaffId = false;
  for (const key of Object.keys(obj)) {
    const k = normalizePiiKey(key);
    if (isIdField(k)) return false;
    if (k.endsWith("staffid")) hasStaffId = true;
  }
  return hasStaffId;
}

/**
 * The whole key IS a PII datum's name — not merely CONTAINS a stem. `phone`,
 * `Email`, `ssn`, `*ClientId` name the datum itself; `pctWithEmail` and
 * `phoneCount` name aggregates ABOUT it.
 */
export function isPiiValueFieldName(key: string): boolean {
  const k = normalizePiiKey(key);
  return DROP_FIELDS.has(k) || DROP_SUBSTRINGS.includes(k) || NUMERIC_PII_EXACT.has(k) || isIdField(k);
}

/**
 * Server-authored caveat text uses the exact lowercase key `note`. Mindbody's
 * API is PascalCase throughout (Notes, StaffNotes), so a case-sensitive exact
 * match separates the two: server text passes, every Mindbody note field still
 * hits the stem rule.
 */
const SERVER_AUTHORED_TEXT_KEYS = new Set(["note"]);

/** Word-safe aggregate markers. */
const AGGREGATE_MARKER = /(pct|percent|count|avg|average|total|rate|share|with|days)/;

/**
 * Type-aware drop rule. A finite number, boolean or null cannot carry a
 * sentence or an address, so stem CONTAINMENT alone does not drop those
 * (`pctWithEmail: 99.4` survives). But when the WHOLE key is the PII field's
 * name (`phone`, `PostalCode`, `BirthDate`), the value is the datum itself
 * whatever its type, and is dropped. A stem-matching number without an
 * aggregate marker (`altPhone: 5550100100`) is also dropped.
 */
function shouldDrop(key: string, value: unknown, trustedNote: boolean): boolean {
  if (trustedNote && SERVER_AUTHORED_TEXT_KEYS.has(key) && typeof value === "string") return false;
  const k = normalizePiiKey(key);
  if (NUMERIC_PII_EXACT.has(k)) return true;
  const nameMatches = DROP_FIELDS.has(k) || DROP_SUBSTRINGS.some((s) => k.includes(s));
  if (!nameMatches) return false;
  if (typeof value === "number") {
    if (isPiiValueFieldName(key)) return true;
    return !AGGREGATE_MARKER.test(k);
  }
  if (typeof value === "boolean" || value === null) {
    return isPiiValueFieldName(key);
  }
  return true;
}

/**
 * A lowercase `note` counts as server text only when nothing else in the
 * record points at a person (an id field, a numeric-PII name, a name field).
 */
function recordVouchesForNote(record: Record<string, unknown>): boolean {
  for (const kk of Object.keys(record)) {
    if (SERVER_AUTHORED_TEXT_KEYS.has(kk)) continue;
    const lk = normalizePiiKey(kk);
    if (isIdField(lk) || lk === "maskedid" || NUMERIC_PII_EXACT.has(lk) || NAME_FIELDS.has(lk)) return false;
  }
  return true;
}

/**
 * Server-held pepper. Without it the pseudonym is decorative: Mindbody client
 * ids are short numeric strings, so a plain hash could be reversed by
 * enumerating the id space. HMAC with a secret the model never sees closes
 * that.
 */
let pepper: string | undefined;

export function setPseudonymPepper(value: string): void {
  if (!value || value.length < 32) {
    throw new Error("Pseudonym pepper must be at least 32 chars — a short key is brute-forceable.");
  }
  pepper = value;
}

/**
 * Token -> real id, so a pseudonym the model passes back to a tool can be
 * resolved. In-process only and bounded; it is never serialised anywhere.
 */
const MAX_REVERSE_ENTRIES = 100_000;
const reverse = new Map<string, string>();

/**
 * Stable pseudonym for a client id. Stable for a given salt so counting and
 * grouping still work; not reversible without the pepper.
 *
 * FAILS CLOSED: with no pepper configured this throws rather than emitting a
 * weak token, because a weak token looks identical to a strong one.
 */
export function pseudonymise(clientId: string | number, callerSalt: string): string {
  if (!pepper) {
    throw new Error("Pseudonym pepper not configured — refusing to emit a reversible token.");
  }
  const token =
    "m_" + createHmac("sha256", pepper).update(`${callerSalt}:${clientId}`).digest("hex").slice(0, 16);
  if (!reverse.has(token)) {
    if (reverse.size >= MAX_REVERSE_ENTRIES) {
      const oldest = reverse.keys().next().value;
      if (oldest !== undefined) reverse.delete(oldest);
    }
    reverse.set(token, String(clientId));
  }
  return token;
}

const PSEUDONYM_SHAPE = /^m_[0-9a-f]{16}$/;

/** True for a string shaped like a pseudonym this module emits. */
export function isPseudonym(value: string): boolean {
  return PSEUDONYM_SHAPE.test(value);
}

/**
 * The real id behind a pseudonym this process issued. Non-pseudonym values pass
 * through unchanged (a caller may supply a real id it already knows). An
 * unknown pseudonym throws: it was issued by a previous process, and guessing
 * would send the request for the wrong member.
 */
export function resolvePseudonym(value: string): string {
  if (!isPseudonym(value)) return value;
  const real = reverse.get(value);
  if (real === undefined) {
    throw new Error(
      `Unknown member token ${value} — tokens are only valid for the server process that issued them. ` +
        "Search for the member again to get a current token.",
    );
  }
  return real;
}

function initials(value: string): string {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/**
 * A NAME field is the one unambiguous person signal. A *ClientId sibling is a
 * foreign key (a sale references its buyer; the sale's own Id is not a person),
 * and Address/Phone also appear on locations, so neither counts.
 */
function isPersonShapedObject(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (NAME_FIELDS.has(normalizePiiKey(key))) return true;
  }
  return false;
}

/**
 * Recursively mask a tool response. Applied to whole payloads, so a nested
 * member record inside a visits array is cleaned the same as a top-level one.
 */
export function maskPii(value: unknown, callerSalt: string, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") {
    // Functions (incl. a smuggled toJSON) must never survive into a response
    // that later gets JSON.stringify'd.
    return typeof value === "function" ? undefined : value;
  }

  // `seen` tracks the current recursion PATH, so a real cycle is caught while
  // the same object referenced twice (a DAG) is masked both times.
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  try {
    return maskObjectLike(value, callerSalt, seen);
  } finally {
    seen.delete(value as object);
  }
}

function maskObjectLike(value: object, callerSalt: string, seen: Set<object>): unknown {
  if (Array.isArray(value)) return value.map((v) => maskPii(v, callerSalt, seen));

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Set) return [...value].map((v) => maskPii(v, callerSalt, seen));
  if (value instanceof Map) {
    // Route through the same field-masking pass as a plain object, so map keys
    // are matched as field names.
    const asObject: Record<string, unknown> = Object.create(null);
    const nonStringPairs: unknown[] = [];
    for (const [k, v] of value) {
      if (typeof k === "string") asObject[k] = v;
      else nonStringPairs.push([k, v]);
    }
    const maskedObject = maskFields(asObject, callerSalt, seen);
    return nonStringPairs.length > 0
      ? { ...maskedObject, __nonStringMapEntries: maskPii(nonStringPairs, callerSalt, seen) }
      : maskedObject;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[binary]";

  return maskFields(value as Record<string, unknown>, callerSalt, seen);
}

/**
 * On a PERSON-shaped record, free text is dropped unless explicitly allowed.
 * Mindbody lets each business define arbitrary custom fields, and alerts and
 * custom fields are where staff record medical and safeguarding detail, so the
 * set of dangerous names is not knowable in advance: default deny.
 *
 * Numbers and booleans stay — they cannot carry a sentence. Strings are
 * withheld unless allow-listed or clearly a date.
 */
const SAFE_PERSON_STRING_FIELDS = new Set([
  "status",
  "type",
  "category",
  "unit",
  "currency",
  "membershiptypename",
  "membershipname",
  "programname",
  "servicename",
  "sessiontypename",
  "classname",
  "locationname",
  "sitename",
  "paymentmethod",
]);

/** Containers whose inner field names are defined per business in Mindbody. */
const OPERATOR_DEFINED_CONTAINERS = new Set([
  "customclientfields",
  "customfields",
  "clientcustomfields",
]);

/** ISO-8601-ish. Visit and sale dates are needed; BirthDate is dropped earlier. */
const ISO_DATEISH = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

function isSafePersonString(key: string, value: string): boolean {
  return SAFE_PERSON_STRING_FIELDS.has(key) || ISO_DATEISH.test(value);
}

function maskFields(
  record: Record<string, unknown>,
  callerSalt: string,
  seen: Set<object>,
): Record<string, unknown> {
  const personShaped = isPersonShapedObject(record);
  const staffShaped = isStaffShapedObject(record);
  const trustedNote = !personShaped && recordVouchesForNote(record);

  // Null-prototype: the output is rebuilt from untrusted keys, so a
  // "__proto__" key must land as a plain own property, not mutate a prototype.
  const out: Record<string, unknown> = Object.create(null);
  /**
   * Names (never values) of fields withheld from a person record, so the model
   * knows the field exists rather than stating that it is empty.
   */
  const withheld: string[] = [];

  for (const [key, raw] of Object.entries(record)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const k = normalizePiiKey(key);
    if (shouldDrop(key, raw, trustedNote)) {
      if (personShaped) withheld.push(key);
      continue;
    }
    if (STAFF_NAME_FIELDS.has(k) && typeof raw === "string") {
      out[key] = raw;
      continue;
    }
    const isPersonsOwnBareId = personShaped && k === "id";
    if ((isIdField(k) || isPersonsOwnBareId) && (typeof raw === "string" || typeof raw === "number")) {
      out[key] = pseudonymise(raw, callerSalt);
    } else if (NAME_FIELDS.has(k) && typeof raw === "string") {
      // Full name on a staff record; initials on a member record.
      out[key] = staffShaped ? raw : initials(raw);
    } else if (personShaped && !staffShaped && typeof raw === "string" && !isSafePersonString(k, raw)) {
      withheld.push(key);
    } else if (personShaped && OPERATOR_DEFINED_CONTAINERS.has(k)) {
      // Withhold the whole custom-field branch and name it. Deliberately
      // narrow: other nested objects (e.g. a HomeLocation) keep their detail.
      withheld.push(key);
    } else {
      out[key] = maskPii(raw, callerSalt, seen);
    }
  }
  if (withheld.length > 0) out._withheld = withheld;
  return out;
}
