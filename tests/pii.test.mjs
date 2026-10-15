/**
 * PII masking (src/pii.ts): contact details dropped, ids pseudonymised, names
 * reduced to initials, aggregates preserved. All data below is synthetic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { maskPii, pseudonymise, setPseudonymPepper } from "../dist/pii.js";

// The pepper is required — pseudonymise() refuses to emit a token without it.
setPseudonymPepper("test-pepper-cccccccccccccccccccccccccccccccc");

const SALT = "caller-a";

test("contact details never survive masking", () => {
  const masked = maskPii(
    {
      Id: 5,
      FirstName: "Jane",
      LastName: "Doe",
      Email: "jane.doe@example.com",
      MobilePhone: "555-0100",
      AddressLine1: "1 Main St",
      BirthDate: "1990-04-02",
      CreditCardLast4: "4242",
    },
    SALT,
  );
  const json = JSON.stringify(masked);
  for (const leak of ["jane.doe@example.com", "555-0100", "1 Main St", "1990-04-02", "4242"]) {
    assert.ok(!json.includes(leak), `leaked: ${leak}`);
  }
});

test("names are reduced to initials, not removed entirely", () => {
  const m = maskPii({ FirstName: "Jane", LastName: "Doe" }, SALT);
  assert.equal(m.FirstName, "J");
  assert.equal(m.LastName, "D");
});

test("ClientId is pseudonymised but STABLE, so counting still works", () => {
  // "How many sessions has xx attended" must survive masking — that requires
  // the same member mapping to the same token across records.
  const a = maskPii({ ClientId: "100002484" }, SALT);
  const b = maskPii({ ClientId: "100002484" }, SALT);
  assert.equal(a.ClientId, b.ClientId);
  assert.notEqual(a.ClientId, "100002484");
  // 16 hex chars of HMAC.
  assert.match(a.ClientId, /^m_[0-9a-f]{16}$/);
});

test("two different callers get DIFFERENT tokens for the same member", () => {
  // Different salts must not be linkable.
  assert.notEqual(pseudonymise("100002484", "caller-a"), pseudonymise("100002484", "caller-b"));
});

test("masking recurses into nested arrays and objects", () => {
  // A member record nested inside a visits array is the usual way a shallow
  // filter gets defeated.
  const masked = maskPii(
    { Visits: [{ Client: { Email: "deep@example.com", ClientId: 7 } }] },
    SALT,
  );
  const json = JSON.stringify(masked);
  assert.ok(!json.includes("deep@example.com"));
  assert.match(masked.Visits[0].Client.ClientId, /^m_/);
});

test("non-identifying analytics fields are preserved exactly", () => {
  const m = maskPii(
    { TotalBooked: 23, TotalSignedIn: 21, MaxCapacity: 30, Revenue: 1187.24, Date: "2026-08-16" },
    SALT,
  );
  // Compared through JSON because maskPii rebuilds onto a NULL-prototype
  // object (so a "__proto__" key cannot mutate Object.prototype), and
  // deepEqual compares prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(m)), {
    TotalBooked: 23,
    TotalSignedIn: 21,
    MaxCapacity: 30,
    Revenue: 1187.24,
    Date: "2026-08-16",
  });
});


test("pseudonym is NOT reversible by a caller who knows their own salt", async () => {
  // A plain hash of (salt + clientId) with no server secret could be reversed
  // by enumerating the short numeric id space offline.
  const { createHash } = await import("node:crypto");
  const token = pseudonymise("100002484", "caller-a");
  let cracked = null;
  for (let i = 100002480; i <= 100002490; i++) {
    if ("m_" + createHash("sha256").update(`caller-a:${i}`).digest("hex").slice(0, 12) === token) {
      cracked = i;
    }
  }
  assert.equal(cracked, null, "token was reproducible without the server pepper");
});

test("generic Name is metadata and must NOT be initialised", () => {
  // Masking it would turn "Intro Trial" into "IT" for no privacy gain.
  const m = maskPii({ Service: { Name: "Intro Trial", Price: 99 } }, SALT);
  assert.equal(m.Service.Name, "Intro Trial");
  assert.equal(m.Service.Price, 99);
});

test("person-name variants ARE masked", () => {
  const m = maskPii({ FirstName: "Jane", MiddleName: "Marie", ClientName: "Jane Doe" }, SALT);
  assert.equal(m.FirstName, "J");
  assert.equal(m.MiddleName, "M");
  assert.equal(m.ClientName, "JD");
});

test("PII hiding under near-miss field names is dropped", () => {
  const m = maskPii(
    {
      Note: "VIP member, allergic to latex",
      StaffNotes: "called twice",
      PhotoUrl: "https://x/y.jpg",
      BillingAddress: "1 Main St",
      EmergencyContactInfoPhone: "555-0100",
      City: "Springfield",
    },
    SALT,
  );
  assert.deepEqual(Object.keys(m), []);
});

test("alternative identifier fields are pseudonymised too", () => {
  const m = maskPii({ ClientUniqueId: "100002484", UniqueId: 7 }, SALT);
  assert.match(m.ClientUniqueId, /^m_/);
  assert.match(m.UniqueId, /^m_/);
});

test("Date survives as an ISO string instead of collapsing to {}", () => {
  const m = maskPii({ timestamp: new Date("2026-08-16T23:00:00Z") }, SALT);
  assert.equal(m.timestamp, "2026-08-16T23:00:00.000Z");
});

test("a circular payload does not hang", () => {
  const a = { TotalBooked: 3 };
  a.self = a;
  const m = maskPii(a, SALT);
  assert.equal(m.TotalBooked, 3);
  assert.equal(m.self, "[circular]");
});

test("a __proto__ key cannot pollute the prototype", () => {
  const m = maskPii(JSON.parse('{"__proto__":{"polluted":true},"TotalBooked":1}'), SALT);
  assert.equal({}.polluted, undefined);
  assert.equal(m.TotalBooked, 1);
});

test("PayerClientId and RelatedClientId are pseudonymised", () => {
  const m = maskPii({ PayerClientId: "100002484", RelatedClientId: "100009999" }, SALT);
  assert.match(m.PayerClientId, /^m_/);
  assert.match(m.RelatedClientId, /^m_/);
});

test("a sale's own Id survives untouched despite a sibling ClientId", () => {
  // A ClientId sibling is a foreign key to the buyer; it does not make the
  // sale itself a person record.
  const m = maskPii({ Id: 9001, ClientId: "100002484", TotalAmount: 55.64 }, SALT);
  assert.equal(m.Id, 9001);
  assert.match(m.ClientId, /^m_/);
  assert.equal(m.TotalAmount, 55.64);
});

test("a nested purchased item's own Id (a product/service id) also survives", () => {
  const m = maskPii(
    { Id: 9001, ClientId: "100002484", PurchasedItems: [{ Id: 100119, Description: "Membership" }] },
    SALT,
  );
  assert.equal(m.PurchasedItems[0].Id, 100119);
});

test("a genuine person record's bare Id IS still masked when NAME/contact fields are present", () => {
  // Name evidence still marks a real client record.
  const m = maskPii({ Id: "100002484", FirstName: "Jane", Email: "jane@example.com" }, SALT);
  assert.match(m.Id, /^m_/);
});

test("the SAME object referenced from two different places masks correctly both times (a DAG, not a cycle)", () => {
  const shared = { ClientId: "100002484" };
  const payload = { first: shared, second: shared };
  const m = maskPii(payload, SALT);
  assert.match(m.first.ClientId, /^m_/);
  assert.match(m.second.ClientId, /^m_/);
  assert.notEqual(m.second, "[circular]");
});

test("a REAL cycle is still caught", () => {
  const a = { TotalBooked: 3 };
  a.self = a;
  const m = maskPii(a, SALT);
  assert.equal(m.self, "[circular]");
});

test("HomeLocation's own Id is NOT pseudonymised despite Address/Phone siblings", () => {
  // Client.HomeLocation is { Id: 1, Address: "...", Phone: "..." } — a
  // location, not a person. Address/Phone are not unique to people.
  const m = maskPii(
    {
      Id: "100002484",
      FirstName: "Jane",
      LastName: "Doe",
      Email: "jane@example.com",
      HomeLocation: { Id: 1, Address: "1 Main St", Phone: "555-0100", Name: "Example Location" },
    },
    SALT,
  );
  // The client's OWN id, sitting next to genuine name evidence, IS masked.
  assert.match(m.Id, /^m_/);
  // The nested LOCATION's id, sitting next to only address/phone (no name
  // evidence), is NOT — it is a facility reference, not a person.
  assert.equal(m.HomeLocation.Id, 1);
  // The location's own Address/Phone are dropped regardless (facility
  // contact info still shouldn't leak, independent of the Id decision).
  assert.equal(m.HomeLocation.Address, undefined);
  assert.equal(m.HomeLocation.Phone, undefined);
  // Its Name is genuine facility metadata, like a service Name — preserved.
  assert.equal(m.HomeLocation.Name, "Example Location");
});

test("aggregate columns survive under their real names — a percentage cannot be an email address", () => {
  const m = maskPii(
    {
      location: "Example Location",
      pctWithEmail: 99.4,
      pctPromoEmailOptIn: 44.1,
      pctWithEmergencyContact: 71.9,
      pctPromoTextOptIn: 38.2,
      phoneCount: 12,
      emailOptIn: true, // boolean under a stem — a flag, not an address
      pctWithAddress: null, // null under a stem — an absent metric
    },
    SALT,
  );
  assert.equal(m.pctWithEmail, 99.4);
  assert.equal(m.pctPromoEmailOptIn, 44.1);
  assert.equal(m.pctWithEmergencyContact, 71.9);
  assert.equal(m.pctPromoTextOptIn, 38.2);
  assert.equal(m.phoneCount, 12);
  assert.equal(m.emailOptIn, true);
  assert.equal(m.pctWithAddress, null);
});

test("an actual member email/phone/note STRING still cannot pass, in any stem-named field", () => {
  const m = maskPii(
    {
      Email: "jane@example.com",
      MobilePhone: "555-0100",
      Notes: "diabetic — call emergency contact",
      StaffNotes: "safeguarding detail",
      pctWithEmail: "jane@example.com", // string smuggled under an aggregate-looking name
      Note: "PascalCase MBO note", // NOT the server's lowercase note key
    },
    SALT,
  );
  const flat = JSON.stringify(m);
  assert.ok(!flat.includes("jane@example.com"), `leaked: ${flat}`);
  assert.ok(!flat.includes("555-0100"), `leaked: ${flat}`);
  assert.ok(!flat.includes("diabetic"), `leaked: ${flat}`);
  assert.ok(!flat.includes("safeguarding"), `leaked: ${flat}`);
  assert.ok(!flat.includes("PascalCase"), `leaked: ${flat}`);
});

test("a NUMBER under the exact NAME of a PII field is still dropped — it IS the datum", () => {
  const m = maskPii(
    { MobilePhone: 5550100100, phone: 5550100, ssn: 123456789, PostalCode: 29708, BirthDate: 19880115 },
    SALT,
  );
  const flat = JSON.stringify(m);
  assert.ok(!flat.includes("5550100"), `numeric phone leaked: ${flat}`);
  assert.ok(!flat.includes("123456789"), `numeric ssn leaked: ${flat}`);
  assert.ok(!flat.includes("29708"), `numeric postal code leaked: ${flat}`);
  assert.ok(!flat.includes("19880115"), `numeric birth date leaked: ${flat}`);
});

test("note-family objects and arrays are still dropped — only scalars are type-exempt", () => {
  const m = maskPii({ Notes: [{ Text: "member medical detail" }], EmailSettings: { forward: "jane@example.com" } }, SALT);
  const flat = JSON.stringify(m);
  assert.ok(!flat.includes("medical"), `leaked: ${flat}`);
  assert.ok(!flat.includes("jane@example.com"), `leaked: ${flat}`);
});

test("server-authored `note` text reaches the caller", () => {
  // Server caveats use the exact lowercase key `note`; Mindbody's own fields
  // are PascalCase, so the case-sensitive allowlist frees only server text.
  const summary = maskPii(
    {
      site: { siteId: "-99", name: "Example Location" },
      source: "live",
      note: "Computed over a bounded member set.",
      cancelRatePct: 3.1,
    },
    SALT,
  );
  assert.match(summary.note, /bounded member set/, "the note must reach the caller");
  const nested = maskPii(
    { sitesOmitted: { count: 3, note: "Showing the 10 largest of 13 sites by member count" } },
    SALT,
  );
  assert.match(nested.sitesOmitted.note, /10 largest/, "the nested note must reach the caller");
});

test("a `note` on a PERSON-shaped record is still withheld — the envelope exemption stops there", () => {
  const m = maskPii({ FirstName: "Jane", LastName: "Doe", note: "prefers evening calls" }, SALT);
  assert.ok(!JSON.stringify(m).includes("prefers evening"), "person free text must stay default-deny");
});


test("lowercase note is DROPPED when the record carries an ID-ish sibling", () => {
  const m = maskPii({ ClientId: 100002484, note: "member medical detail" }, SALT);
  assert.equal(m.note, undefined, "a note beside a ClientId is member data, not envelope text");
  assert.notEqual(m.ClientId, 100002484, "the id is still pseudonymised, not dropped");
});

test("lowercase note is DROPPED beside a masked/member/user id or a name field", () => {
  assert.equal(maskPii({ maskedId: "m_abc123", note: "injury detail" }, SALT).note, undefined);
  assert.equal(maskPii({ memberId: 100002484, note: "injury detail" }, SALT).note, undefined);
  assert.equal(maskPii({ FirstName: "Jane", note: "injury detail" }, SALT).note, undefined);
});

test("server-authored note still passes on an aggregate envelope", () => {
  const m = maskPii({ cancelled: 12, pctWithEmail: 99.4, note: "Computed over the last 90 days" }, SALT);
  assert.equal(m.note, "Computed over the last 90 days");
  assert.equal(m.pctWithEmail, 99.4);
});

test("numeric PII aliases are refused as whole key names", () => {
  const m = maskPii({ zip: 29708, dob: 19880115, phoneNumber: 5550100100, ssnNumber: 123456789 }, SALT);
  assert.equal(m.zip, undefined);
  assert.equal(m.dob, undefined);
  assert.equal(m.phoneNumber, undefined);
  assert.equal(m.ssnNumber, undefined);
});

test("memberId and userId pseudonymise like ClientId instead of surviving raw", () => {
  const m = maskPii({ memberId: 100002484, userId: 100002484 }, SALT);
  assert.notEqual(m.memberId, 100002484);
  assert.notEqual(m.userId, 100002484);
  assert.ok(m.memberId, "pseudonym present, not dropped");
});

test("aggregate percentage names near the new exact list still survive", () => {
  const m = maskPii({ pctWithUsableZip: 59.1, pctWithDob: 72.0, zipCount: 41 }, SALT);
  assert.equal(m.pctWithUsableZip, 59.1);
  assert.equal(m.pctWithDob, 72.0);
  assert.equal(m.zipCount, 41);
});


test("snake_case ID aliases vouch against the note and still pseudonymise", () => {
  for (const key of ["member_id", "client_id", "user_id", "masked_id"]) {
    const m = maskPii({ [key]: 100002484, note: "medical detail" }, SALT);
    assert.equal(m.note, undefined, `${key} must mark the record as entity data`);
    assert.ok(!JSON.stringify(m).includes("100002484"), `${key} must never pass raw`);
  }
});

test("separator variants of numeric PII names are refused", () => {
  const m = maskPii(
    { phoneNo: 5550100100, mobileNumber: 5550100100, faxNumber: 5550100100, zip_code: 29708, date_of_birth: 19880115 },
    SALT,
  );
  for (const k of ["phoneNo", "mobileNumber", "faxNumber", "zip_code", "date_of_birth"]) {
    assert.equal(m[k], undefined, `${k} must drop`);
  }
});

test("every NUMERIC_PII_EXACT entry bites, not just the tested three", () => {
  const m = maskPii(
    { zipcode: 29708, dateOfBirth: 19880115, cellphone: 5550100100, mobile: 5550100100, fax: 5550100100 },
    SALT,
  );
  for (const k of ["zipcode", "dateOfBirth", "cellphone", "mobile", "fax"]) {
    assert.equal(m[k], undefined, `${k} must drop`);
  }
});


test("a snake_case person record is person-shaped — names initialised, id pseudonymised, free text denied", () => {
  const m = maskPii(
    { first_name: "Jane", last_name: "Doe", id: 100002484, safeguarding_note: "member medical detail" },
    SALT,
  );
  const dump = JSON.stringify(m);
  assert.ok(!dump.includes("Jane") || m.first_name === "JD" || (m.first_name ?? "").length <= 2,
    "full first name must not pass in the clear");
  assert.ok(!dump.includes("Doe"), "full last name must not pass in the clear");
  assert.ok(!dump.includes("100002484"), "the person's own bare id must be pseudonymised");
  assert.ok(!dump.includes("medical detail"), "person free text stays default-deny");
});

test("numeric phone-stem names without an aggregate marker are refused", () => {
  const m = maskPii({ altPhone: 5550100100, altPhoneNumber: 5550100100, phone2: 5550100100 }, SALT);
  assert.equal(m.altPhone, undefined);
  assert.equal(m.altPhoneNumber, undefined);
  assert.equal(m.phone2, undefined);
});

test("aggregate-marker numerics keep surviving the stem rule", () => {
  const m = maskPii({ pctWithEmail: 99.4, phoneCount: 41, emailTotal: 120, pctWithDob: 72.0 }, SALT);
  assert.equal(m.pctWithEmail, 99.4);
  assert.equal(m.phoneCount, 41);
  assert.equal(m.emailTotal, 120);
  assert.equal(m.pctWithDob, 72.0);
});
