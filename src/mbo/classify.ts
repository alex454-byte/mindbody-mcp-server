/**
 * Client payment classification from Mindbody contracts. The rules below
 * encode contract semantics that are easy to get wrong; change them with
 * care.
 *
 * Buckets: paying > pastDue > onHold > promo > comp > none.
 *
 * CRITICAL: "paying" requires NormalAutoPay > 0 (the recurring amount).
 * FirstAutoPay can be a one-time setup fee on an otherwise $0 comp
 * contract, and UpcomingAutopayEvents can be unrelated one-time charges —
 * using either as "paying" proof produces false positives.
 */
import type { MboClient } from "./client.js";

export interface MboContract {
  Id?: number;
  ContractName?: string;
  AutopayStatus?: string;
  IsMonthToMonth?: boolean;
  AutoRenewing?: boolean;
  StartDate?: string;
  EndDate?: string | null;
  TerminationDate?: string | null;
  NormalAutoPay?: number;
  FirstAutoPay?: number;
  LastAutoPay?: number;
  UpcomingAutopayEvents?: Array<{ ChargeAmount?: number }>;
  SiteId?: number;
}

export type PaymentClassification = "paying" | "promo" | "comp" | "onHold" | "pastDue" | "none";

export interface ClassificationResult {
  classification: PaymentClassification;
  activeContractCount: number;
  rawSignals: {
    contractNames: string[];
    recurringTotals: number[];
    hasEndDate: boolean[];
    autopayStatuses: string[];
  };
  // Lifecycle signals — computed over ALL contracts, live or not: the
  // earliest StartDate is the member's true join date and the latest
  // TerminationDate dates their churn.
  earliestStartDate: string | null;
  latestTerminationDate: string | null;
}

export function classifyContracts(
  all: MboContract[],
  todayMs: number = Date.now(),
): ClassificationResult {
  // Dates arrive as ISO strings ("2023-04-05T00:00:00") — keep the date
  // part; string compare is chronological for that shape.
  let earliestStartDate: string | null = null;
  let latestTerminationDate: string | null = null;
  for (const c of all) {
    const start = typeof c.StartDate === "string" ? c.StartDate.slice(0, 10) : null;
    if (start && (!earliestStartDate || start < earliestStartDate)) earliestStartDate = start;
    const term = typeof c.TerminationDate === "string" ? c.TerminationDate.slice(0, 10) : null;
    if (term && (!latestTerminationDate || term > latestTerminationDate)) latestTerminationDate = term;
  }

  // A contract is "live" if its autopay status is one of
  // {Active, Suspended/On Hold, Failed} AND it isn't terminated yet.
  // "Suspended" = on hold (paused), "Failed" = past due.
  const isLiveContract = (c: MboContract) => {
    const s = c.AutopayStatus;
    if (s !== "Active" && s !== "Suspended" && s !== "Failed" && s !== "On Hold") return false;
    if (c.TerminationDate) {
      const t = new Date(c.TerminationDate).getTime();
      if (!isNaN(t) && t < todayMs) return false;
    }
    return true;
  };

  const live = all.filter(isLiveContract);
  const activeContractCount = live.length;
  if (live.length === 0) {
    return {
      classification: "none",
      activeContractCount: 0,
      rawSignals: { contractNames: [], recurringTotals: [], hasEndDate: [], autopayStatuses: [] },
      earliestStartDate,
      latestTerminationDate,
    };
  }

  const names: string[] = [];
  const totals: number[] = [];
  const endDates: boolean[] = [];
  const statuses: string[] = [];
  let hasRecurringPaid = false;
  let hasSuspended = false;
  let hasFailed = false;
  let hasActiveZero = false;
  for (const c of live) {
    const recurring = typeof c.NormalAutoPay === "number" ? c.NormalAutoPay : 0;
    const status = c.AutopayStatus ?? "";
    names.push(c.ContractName ?? "");
    totals.push(recurring);
    endDates.push(c.EndDate != null);
    statuses.push(status);
    if (status === "Active" && recurring > 0) hasRecurringPaid = true;
    else if (status === "Active" && recurring === 0) hasActiveZero = true;
    else if (status === "Suspended" || status === "On Hold") hasSuspended = true;
    else if (status === "Failed") hasFailed = true;
  }

  const rawSignals = {
    contractNames: names,
    recurringTotals: totals,
    hasEndDate: endDates,
    autopayStatuses: statuses,
  };

  const base = { activeContractCount, rawSignals, earliestStartDate, latestTerminationDate };
  if (hasRecurringPaid) return { classification: "paying", ...base };
  if (hasFailed) return { classification: "pastDue", ...base };
  if (hasSuspended) return { classification: "onHold", ...base };
  if (hasActiveZero) {
    // All active contracts are $0 recurring. Time-limited = promo;
    // open-ended = comp.
    const activeZeroEndDates = live
      .filter((c) => c.AutopayStatus === "Active")
      .map((c) => c.EndDate != null);
    const allOngoing = activeZeroEndDates.every((e) => !e);
    return { classification: allOngoing ? "comp" : "promo", ...base };
  }
  return { classification: "none", ...base };
}

export async function classifyClientPayment(
  client: MboClient,
  siteId: string,
  clientId: string,
): Promise<ClassificationResult> {
  // MBO returns the array under `Contracts` (NOT `ClientContracts`).
  const payload = await client.get<{ Contracts?: MboContract[] }>(
    siteId,
    "/client/clientcontracts",
    { ClientId: clientId, Limit: "100" },
  );
  return classifyContracts(payload.Contracts ?? []);
}
