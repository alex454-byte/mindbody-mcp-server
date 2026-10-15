/**
 * Person-shaped records are masked by ALLOW-list, not deny-list.
 *
 * Mindbody lets each business define arbitrary custom fields, so the set of
 * dangerous field names is not knowable in advance. Alerts and custom fields
 * are where staff record the most sensitive things about a member: medical
 * conditions, safeguarding notes, emergency contacts. On a person-shaped
 * record we keep what is known safe and drop everything else.
 *
 * Some of these fields also ride on objects that carry only a ClientId (a
 * sale, a contract line), so shouldDrop() drops those families regardless of
 * whether a name is present. All data below is synthetic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { maskPii, setPseudonymPepper } from "../dist/pii.js";

setPseudonymPepper("mask-test-pepper-000000000000000000000000000000");
const SALT = "salt";
const mask = (v) => maskPii(v, SALT);
const flat = (v) => JSON.stringify(v);

test("a RedAlert safeguarding note never survives masking", () => {
  const out = mask({ Id: 123, FirstName: "Jane", LastName: "Doe",
    RedAlert: "Domestic violence safety plan - call only after 5pm" });
  assert.ok(!flat(out).includes("Domestic violence"), `leaked: ${flat(out)}`);
  assert.ok(!flat(out).includes("safety plan"));
});

test("a YellowAlert never survives masking", () => {
  const out = mask({ Id: 1, FirstName: "A", LastName: "B", YellowAlert: "Owes money, chase at desk" });
  assert.ok(!flat(out).includes("Owes money"), `leaked: ${flat(out)}`);
});

test("CustomClientFields values never survive masking", () => {
  // Business-defined, so the field NAMES are unknowable in advance — the
  // precise reason a deny-list cannot work here.
  const out = mask({
    Id: 7, FirstName: "Jane", LastName: "Doe",
    CustomClientFields: [{ Id: 7, Name: "Emergency contact", Value: "Jane Smith, 555-0100; diabetic" }],
  });
  assert.ok(!flat(out).includes("555-0100"), `leaked phone: ${flat(out)}`);
  assert.ok(!flat(out).includes("diabetic"), `leaked medical detail: ${flat(out)}`);
});

test("an UNKNOWN free-text field on a person is dropped by default", () => {
  // The whole point of moving to an allow-list: a field nobody anticipated
  // must be withheld, not preserved.
  const out = mask({ Id: 1, FirstName: "A", LastName: "B",
    SomeFieldMindbodyAddedLater: "medical: severe nut allergy, epipen in bag" });
  assert.ok(!flat(out).includes("nut allergy"), `unknown field leaked: ${flat(out)}`);
});

test("useful non-identifying data still comes through", () => {
  // Masking must not make the server useless — derived and operational
  const out = mask({ Id: 1, FirstName: "A", LastName: "B",
    Status: "Active", MembershipTypeName: "Unlimited", VisitCount: 42, TotalSpent: 129.5 });
  assert.equal(out.Status, "Active");
  assert.equal(out.VisitCount, 42);
  assert.equal(out.TotalSpent, 129.5);
});

test("identity is still pseudonymised and names still reduced to initials", () => {
  const out = mask({ Id: 123, FirstName: "Jane", LastName: "Doe" });
  assert.ok(!flat(out).includes("Jane"));
  assert.ok(!flat(out).includes("123"), "raw client id survived");
});

test("withheld fields are NAMED so the answer is not silently incomplete", () => {
  // A model that cannot see a field should know it exists, or it will state
  // confidently that there is no alert on the account.
  const out = mask({ Id: 1, FirstName: "A", LastName: "B", RedAlert: "x", CustomClientFields: [] });
  assert.ok(Array.isArray(out._withheld), "expected a _withheld list naming dropped fields");
  assert.ok(out._withheld.includes("RedAlert"));
});

test("non-person objects are NOT allow-listed — locations keep their detail", () => {
  // A location is not a person; over-masking it would destroy useful data.
  const out = mask({ Id: 1, Address: "100 Main St", Phone: "555-1000", Name: "Example Location" });
  assert.equal(out.Name, "Example Location");
});


test("RedAlert leaks even when the object has only a ClientId", () => {
  const out = mask({ ClientId: "12345", RedAlert: "Restraining order; do not admit" });
  assert.ok(!flat(out).includes("Restraining"), `leaked: ${flat(out)}`);
});

test("YellowAlert is dropped too", () => {
  const out = mask({ ClientId: "1", YellowAlert: "Owes money, chase at desk" });
  assert.ok(!flat(out).includes("Owes money"));
});

test("CustomClientFields values are dropped without a name field present", () => {
  const out = mask({ ClientId: "1", CustomClientFields: [{ Id: 1, Name: "Medical", Value: "nut allergy, epipen in bag" }] });
  assert.ok(!flat(out).includes("epipen"), `leaked: ${flat(out)}`);
});

test("ContractText with personal detail is dropped, but ContractName survives", () => {
  const out = mask({ Contracts: [{ PayerClientId: 42, ContractText: "Member Jane Doe, 14 Oak Lane, diabetes", ContractName: "Unlimited" }] });
  assert.ok(!flat(out).includes("Jane Doe"), `ContractText leaked: ${flat(out)}`);
  assert.ok(!flat(out).includes("Oak Lane"));
  // The useful catalogue field must remain, or reporting breaks.
  assert.equal(out.Contracts[0].ContractName, "Unlimited");
});

test("a secret barcode id is dropped, but the product description survives", () => {
  const out = mask({ Sales: [{ ClientId: "42", PurchasedItems: [{ GiftCardBarcodeId: "GIFT-4400-SECRET", Description: "Lemon-Lime Pre-Workout" }] }] });
  assert.ok(!flat(out).includes("GIFT-4400-SECRET"), `barcode leaked: ${flat(out)}`);
  assert.equal(out.Sales[0].PurchasedItems[0].Description, "Lemon-Lime Pre-Workout");
});

test("the referencing ClientId is still pseudonymised, not dropped, so counts still work", () => {
  const out = mask({ ClientId: "12345", RedAlert: "x" });
  assert.match(String(out.ClientId), /^m_/, "ClientId should pseudonymise, not vanish");
});

