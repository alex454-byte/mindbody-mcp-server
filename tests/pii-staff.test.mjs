/**
 * Staff names are exempt from PII masking. Member names are not.
 *
 * Instructors are named on the public schedule, and a report keyed by initials
 * is useless when two staff share them. The carve-out is deliberately narrow:
 *   - staff NAME shows in full,
 *   - staff CONTACT detail (email, phone, address) is still dropped,
 *   - MEMBER names are still reduced to initials, and member ids still
 *     pseudonymised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { maskPii, setPseudonymPepper } from "../dist/pii.js";

setPseudonymPepper("staff-exempt-pepper-000000000000000000000000");
const mask = (v) => maskPii(v, "salt");

test("an analytics coach field keeps the full coach name", () => {
  const out = mask({ coach: "Sarah Smith", utilization: 82.4, totalSessions: 40 });
  assert.equal(out.coach, "Sarah Smith");
  assert.equal(out.utilization, 82.4);
});

test("a staff record shows the full name but drops contact detail", () => {
  // Detected as staff by StaffId, distinct from a member's ClientId.
  const out = mask({ StaffId: 5, FirstName: "Sarah", LastName: "Smith", Email: "sarah@example.com", MobilePhone: "555-0100" });
  assert.equal(out.FirstName, "Sarah");
  assert.equal(out.LastName, "Smith");
  assert.ok(!JSON.stringify(out).includes("sarah@example.com"), "staff email must still be dropped");
  assert.ok(!JSON.stringify(out).includes("555-0100"), "staff phone must still be dropped");
});

test("a MEMBER record is unchanged — names still become initials", () => {
  // The carve-out must not touch member privacy.
  const out = mask({ ClientId: "999", FirstName: "Jane", LastName: "Doe" });
  assert.ok(!JSON.stringify(out).includes("Jane"), "member first name leaked");
  assert.ok(!JSON.stringify(out).includes("Doe"), "member last name leaked");
  assert.match(String(out.ClientId), /^m_/, "member id must still pseudonymise");
});

test("a coach name on the SAME object as a member id is still the coach's, shown in full", () => {
  // A class visit references the member (ClientId) and names the coach who ran
  // it. The coach field is staff; the member stays masked.
  const out = mask({ ClientId: "999", FirstName: "Jane", LastName: "Doe", coach: "Sarah Smith" });
  assert.equal(out.coach, "Sarah Smith");
  assert.ok(!JSON.stringify(out).includes("Jane"), "member name must still be masked");
});

test("named staff fields (StaffName, CoachName, SalesLeaderName) pass through", () => {
  const out = mask({ StaffName: "Sarah Smith", CoachName: "Sam Stone", SalesLeaderName: "Alex Reed" });
  assert.equal(out.StaffName, "Sarah Smith");
  assert.equal(out.CoachName, "Sam Stone");
  assert.equal(out.SalesLeaderName, "Alex Reed");
});
