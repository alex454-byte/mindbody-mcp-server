/**
 * Mindbody Webhooks subscription API client.
 *
 * Lives on a DIFFERENT host than the Public API:
 *   https://mindbody.io/platform/webhooks/v1
 * but authenticates with the same Api-Key + SiteId + staff Bearer token.
 * Subscriptions are account-wide, not per-site.
 *
 * Event IDs observed delivering in practice:
 *   classRosterBooking.created / .cancelled
 *   classRosterBookingStatus.updated
 *   clientSale.created
 *   clientContract.created / .updated
 *   clientMembershipAssignment.created / .cancelled
 *
 * KNOWN TRAP: `clientVisit.*` and `clientMembership.*` do NOT exist in
 * Mindbody and are never delivered, even though they look plausible.
 */
import type { MboClient } from "./client.js";

export const VERIFIED_WEBHOOK_EVENTS = [
  "classRosterBooking.created",
  "classRosterBooking.cancelled",
  "classRosterBookingStatus.updated",
  "clientSale.created",
  "clientContract.created",
  "clientContract.updated",
  "clientMembershipAssignment.created",
  "clientMembershipAssignment.cancelled",
] as const;

export class MboWebhooksClient {
  constructor(
    private readonly client: MboClient,
    private readonly baseUrl: string,
  ) {}

  list(siteId: string): Promise<unknown> {
    return this.client.authedJson(siteId, `${this.baseUrl}/subscriptions`, {
      method: "GET",
    });
  }

  create(
    siteId: string,
    sub: {
      eventIds: string[];
      webhookUrl: string;
      signatureKey: string;
      referenceId?: string;
      status?: string;
    },
  ): Promise<unknown> {
    return this.client.authedJson(siteId, `${this.baseUrl}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Active", ...sub }),
    });
  }

  remove(siteId: string, subscriptionId: string): Promise<unknown> {
    return this.client.authedJson(
      siteId,
      `${this.baseUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: "DELETE" },
    );
  }
}
