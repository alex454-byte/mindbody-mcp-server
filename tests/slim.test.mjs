import test from "node:test";
import assert from "node:assert/strict";
import { dropEmpty, serializeToolData } from "../dist/slim.js";

test("nulls are dropped but falsy-but-real values are KEPT", () => {
  // 0 and false and "" are DATA, not absence — dropping them would corrupt
  // AccountBalance: 0, IsProspect: false, etc. This is the line between
  // information-preserving and lossy.
  const out = dropEmpty({ a: null, b: undefined, zero: 0, no: false, empty: "" });
  assert.deepEqual(out, { zero: 0, no: false, empty: "" });
});

test("empty arrays and objects that become empty are dropped", () => {
  assert.deepEqual(dropEmpty({ keep: 1, arr: [], obj: { onlyNull: null } }), { keep: 1 });
});

test("nested structures are cleaned recursively", () => {
  const out = dropEmpty({
    Client: { FirstName: "Test", MiddleName: null, Home: { City: null, Name: "Example Location" } },
  });
  assert.deepEqual(out, { Client: { FirstName: "Test", Home: { Name: "Example Location" } } });
});

test("MBO-shaped payload: substantial reduction, no information lost", () => {
  // Field names and null-density follow a /client/clientcompleteinfo
  // response; values synthetic.
  const real = {
    Client: {
      FirstName: "Test",
      LastName: "User",
      Id: "100002484",
      AccountBalance: 0,
      IsProspect: false,
      BirthDate: null,
      MobileProvider: null,
      HomePhone: null,
      WorkPhone: null,
      AddressLine1: null,
      City: null,
      PostalCode: null,
      PhotoUrl: null,
      EmergencyContactInfoName: null,
      EmergencyContactInfoEmail: null,
      RedAlert: null,
      YellowAlert: null,
      MiddleName: null,
      LockerNumber: null,
      ClientType: null,
      CustomClientFields: [],
      ClientIndexes: [],
    },
    ClientServices: [],
    ClientContracts: [],
  };

  const before = JSON.stringify(real, null, 2);
  const after = serializeToolData(real);
  assert.ok(after.length < before.length * 0.6, `expected >40% smaller, got ${after.length}/${before.length}`);

  // Everything that carried information survives — including the falsy ones.
  const parsed = JSON.parse(after);
  assert.equal(parsed.Client.FirstName, "Test");
  assert.equal(parsed.Client.Id, "100002484");
  assert.equal(parsed.Client.AccountBalance, 0);
  assert.equal(parsed.Client.IsProspect, false);
  // ...and everything that carried none is gone.
  assert.equal("BirthDate" in parsed.Client, false);
  assert.equal("ClientServices" in parsed, false);
});

test("output is always valid JSON, even when everything drops out", () => {
  assert.equal(serializeToolData({ a: null }), "{}");
  assert.equal(serializeToolData([]), "[]");
  assert.doesNotThrow(() => JSON.parse(serializeToolData({ a: null })));
});

test("slim can be opted out of, for when the raw shape matters", () => {
  const raw = serializeToolData({ a: null, b: 1 }, { slim: false });
  assert.match(raw, /"a": null/);
  assert.match(raw, /\n/); // still pretty-printed
});

test("a cyclic payload does not hang", () => {
  const a = { keep: 1 };
  a.self = a;
  assert.doesNotThrow(() => serializeToolData(a));
  assert.equal(JSON.parse(serializeToolData(a)).keep, 1);
});
