import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyContracts } from "../dist/mbo/classify.js";

const TODAY = new Date("2026-08-04T00:00:00Z").getTime();

test("no contracts → none", () => {
  const r = classifyContracts([], TODAY);
  assert.equal(r.classification, "none");
  assert.equal(r.activeContractCount, 0);
});

test("active recurring contract → paying", () => {
  const r = classifyContracts(
    [{ ContractName: "Unlimited", AutopayStatus: "Active", NormalAutoPay: 179 }],
    TODAY,
  );
  assert.equal(r.classification, "paying");
});

test("FirstAutoPay setup fee on $0 contract is NOT paying (comp)", () => {
  const r = classifyContracts(
    [
      {
        ContractName: "Comp Membership",
        AutopayStatus: "Active",
        NormalAutoPay: 0,
        FirstAutoPay: 49,
        EndDate: null,
      },
    ],
    TODAY,
  );
  assert.equal(r.classification, "comp");
});

test("$0 contract with an end date → promo", () => {
  const r = classifyContracts(
    [
      {
        ContractName: "21-Day Reset",
        AutopayStatus: "Active",
        NormalAutoPay: 0,
        EndDate: "2026-09-01T00:00:00",
      },
    ],
    TODAY,
  );
  assert.equal(r.classification, "promo");
});

test("Failed autopay → pastDue; Suspended → onHold; paying wins over both", () => {
  assert.equal(
    classifyContracts([{ AutopayStatus: "Failed", NormalAutoPay: 179 }], TODAY).classification,
    "pastDue",
  );
  assert.equal(
    classifyContracts([{ AutopayStatus: "Suspended", NormalAutoPay: 179 }], TODAY).classification,
    "onHold",
  );
  assert.equal(
    classifyContracts(
      [
        { AutopayStatus: "Failed", NormalAutoPay: 179 },
        { AutopayStatus: "Active", NormalAutoPay: 99 },
      ],
      TODAY,
    ).classification,
    "paying",
  );
});

test("terminated contracts are dead, but drive lifecycle dates", () => {
  const r = classifyContracts(
    [
      {
        AutopayStatus: "Active",
        NormalAutoPay: 149,
        StartDate: "2022-01-15T00:00:00",
        TerminationDate: "2024-03-01T00:00:00",
      },
    ],
    TODAY,
  );
  assert.equal(r.classification, "none");
  assert.equal(r.earliestStartDate, "2022-01-15");
  assert.equal(r.latestTerminationDate, "2024-03-01");
});
