/**
 * MCP tool registrations. Read tools are always on; write tools and
 * webhook-admin tools only register when explicitly enabled via env
 * (MBO_ALLOW_WRITES / MBO_ALLOW_WEBHOOK_ADMIN), so a default install
 * can answer questions but can't change a live site.
 *
 * Every result passes through maskPii (src/pii.ts) before it is returned, so
 * member contact details, real ids and full names never reach the model.
 * Member ids come back as pseudonyms (m_...); tools accept those pseudonyms
 * as input and resolve them in-process.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { MboMcpConfig } from "./config.js";
import type { MboClient } from "./mbo/client.js";
import { dropEmpty, serializeToolData } from "./slim.js";
import { MboError } from "./mbo/errors.js";
import { classifyClientPayment } from "./mbo/classify.js";
import { MboWebhooksClient, VERIFIED_WEBHOOK_EVENTS } from "./mbo/webhooks.js";
import { fetchServiceCatalog } from "./mbo/catalog-cache.js";
import { maskPii, resolvePseudonym } from "./pii.js";
import { progressReporter } from "./progress.js";

const CONTACT_METHODS = ["Email", "InPerson", "Mail", "Note", "Phone", "SMS"] as const;

/** One local user per stdio server, so one fixed pseudonym salt. */
const PSEUDONYM_SALT = "local";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function registerTools(
  server: McpServer,
  cfg: MboMcpConfig,
  client: MboClient,
): { toolCount: number } {
  let toolCount = 0;

  const siteIdParam = z
    .string()
    .optional()
    .describe(
      `Mindbody SiteId (each business is a separate site${
        cfg.defaultSiteId ? `; defaults to ${cfg.defaultSiteId}` : ""
      }). Public sandbox is "-99".`,
    );

  const resolveSite = (siteId?: string): string => {
    const resolved = siteId ?? cfg.defaultSiteId;
    if (!resolved) {
      throw new MboError(
        "No siteId given and no MBO_SITE_ID default is configured — pass siteId " +
          "(the public sandbox is \"-99\").",
      );
    }
    return resolved;
  };

  // Single choke point for every tool result. Empty fields are dropped first
  // (src/slim.ts), so `_withheld` only names fields that actually had a value;
  // then PII is masked (src/pii.ts) before anything is serialised.
  const ok = (data: unknown): ToolResult => ({
    content: [
      { type: "text", text: serializeToolData(maskPii(dropEmpty(data), PSEUDONYM_SALT)) },
    ],
  });

  /** Accepts a real id or a pseudonym this server issued. */
  const realId = (id: string): string => resolvePseudonym(id);

  // The SDK passes a request context as the second argument; it carries the
  // client's progress token when one was sent (see src/progress.ts).
  const guard = <A>(fn: (args: A, ctx?: unknown) => Promise<ToolResult>) => {
    return async (args: A, ctx?: unknown): Promise<ToolResult> => {
      try {
        return await fn(args, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    };
  };

  const register = (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodType;
      annotations?: Record<string, boolean>;
    },
    cb: (args: never) => Promise<ToolResult>,
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.registerTool(name, config as any, cb as any);
    toolCount += 1;
  };

  // ------------------------------------------------------------------
  // Client tools
  // ------------------------------------------------------------------
  register(
    "mbo_search_clients",
    {
      title: "Search members",
      description:
        "Search Mindbody members by name/email/phone text, or fetch specific ClientIds. " +
        "Returns raw MBO client records (contact info, MembershipIcon, status). " +
        "For bulk member scans set includeProspects=false and raise maxPages.",
      inputSchema: z.object({
        siteId: siteIdParam,
        searchText: z
          .string()
          .optional()
          .describe("Free-text search (name, email, or phone). Omit to list all."),
        clientIds: z.array(z.string()).optional().describe("Fetch these ClientIds or m_... tokens."),
        includeProspects: z
          .boolean()
          .optional()
          .describe("false adds IsProspect=false (members/past-members only)."),
        offset: z.number().int().min(0).optional(),
        maxPages: z.number().int().min(1).max(50).optional().describe("200 records/page. Default 1."),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: {
      siteId?: string;
      searchText?: string;
      clientIds?: string[];
      includeProspects?: boolean;
      offset?: number;
      maxPages?: number;
    }) => {
      const params: Record<string, string> = {};
      if (args.searchText) params.SearchText = args.searchText;
      if (args.clientIds?.length) params.ClientIds = args.clientIds.map(realId).join(",");
      if (args.includeProspects === false) params.IsProspect = "false";
      const result = await client.getPaginated(resolveSite(args.siteId), "/client/clients", params, {
        maxPages: args.maxPages ?? 1,
        offset: args.offset,
      });
      return ok(result);
    }),
  );

  register(
    "mbo_get_client",
    {
      title: "Get member (complete info)",
      description:
        "GET /client/clientcompleteinfo — one client's full record: profile, membership icon, " +
        "client services, contracts, and account balances in a single call.",
      inputSchema: z.object({
        siteId: siteIdParam,
        clientId: z.string().describe("ClientId or the m_... member token from a previous result."),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { siteId?: string; clientId: string }) =>
      ok(
        await client.get(resolveSite(args.siteId), "/client/clientcompleteinfo", {
          ClientId: realId(args.clientId),
        }),
      ),
    ),
  );

  register(
    "mbo_get_client_services",
    {
      title: "Get member services",
      description:
        "GET /client/clientservices — a client's purchased services (memberships, class packs, " +
        "intro offers) with Current flags, remaining counts, and expiration dates.",
      inputSchema: z.object({
        siteId: siteIdParam,
        clientId: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { siteId?: string; clientId: string }) =>
      ok(
        await client.get(resolveSite(args.siteId), "/client/clientservices", {
          ClientId: realId(args.clientId),
        }),
      ),
    ),
  );

  register(
    "mbo_get_client_contracts",
    {
      title: "Get member contracts",
      description:
        "GET /client/clientcontracts — a client's contracts (array is under `Contracts`). " +
        "Includes AutopayStatus, NormalAutoPay, Start/End/TerminationDate. " +
        "Use mbo_classify_client_payment for the derived paying/promo/comp verdict.",
      inputSchema: z.object({
        siteId: siteIdParam,
        clientId: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { siteId?: string; clientId: string }) =>
      ok(
        await client.get(resolveSite(args.siteId), "/client/clientcontracts", {
          ClientId: realId(args.clientId),
          Limit: "100",
        }),
      ),
    ),
  );

  register(
    "mbo_classify_client_payment",
    {
      title: "Classify member payment status",
      description:
        "Derived tool: buckets a client into " +
        "paying | pastDue | onHold | promo | comp | none from their contracts, plus " +
        "join/churn lifecycle dates. 'paying' requires a recurring NormalAutoPay > 0 — " +
        "one-time setup fees never count as proof of payment.",
      inputSchema: z.object({
        siteId: siteIdParam,
        clientId: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { siteId?: string; clientId: string }) =>
      ok(await classifyClientPayment(client, resolveSite(args.siteId), realId(args.clientId))),
    ),
  );

  register(
    "mbo_get_client_visits",
    {
      title: "Get member attendance",
      description:
        "GET /client/clientvisits — a client's visit history (class check-ins) in a date range.",
      inputSchema: z.object({
        siteId: siteIdParam,
        clientId: z.string(),
        startDate: z.string().optional().describe("YYYY-MM-DD"),
        endDate: z.string().optional().describe("YYYY-MM-DD"),
        maxPages: z.number().int().min(1).max(50).optional().describe("200 visits/page. Default 3."),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: {
      siteId?: string;
      clientId: string;
      startDate?: string;
      endDate?: string;
      maxPages?: number;
    }) => {
      const params: Record<string, string> = { ClientId: realId(args.clientId) };
      if (args.startDate) params.StartDate = args.startDate;
      if (args.endDate) params.EndDate = args.endDate;
      return ok(
        await client.getPaginated(resolveSite(args.siteId), "/client/clientvisits", params, {
          maxPages: args.maxPages ?? 3,
        }),
      );
    }),
  );

  // ------------------------------------------------------------------
  // Class / staff tools
  // ------------------------------------------------------------------
  register(
    "mbo_get_classes",
    {
      title: "Get sessions (schedule)",
      description:
        "GET /class/classes — the session schedule for a date range: staff, description, " +
        "TotalBooked, TotalSignedIn (actual attendance — use this for show-rate math), " +
        "waitlist, capacity, cancellation status.",
      inputSchema: z.object({
        siteId: siteIdParam,
        startDate: z.string().describe("YYYY-MM-DD (inclusive)"),
        endDate: z.string().describe("YYYY-MM-DD (inclusive)"),
        staffIds: z
          .array(z.union([z.number(), z.string()]))
          .optional()
          .describe("Filter to these StaffIds (numbers or m_... tokens)."),
        locationIds: z.array(z.number()).optional(),
        maxPages: z.number().int().min(1).max(50).optional().describe("200 classes/page. Default 5."),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: {
      siteId?: string;
      startDate: string;
      endDate: string;
      staffIds?: Array<number | string>;
      locationIds?: number[];
      maxPages?: number;
    }) => {
      const params: Record<string, string> = {
        StartDateTime: `${args.startDate}T00:00:00`,
        EndDateTime: `${args.endDate}T23:59:59`,
      };
      if (args.staffIds?.length) {
        params.StaffIds = args.staffIds.map((id) => realId(String(id))).join(",");
      }
      if (args.locationIds?.length) params.LocationIds = args.locationIds.join(",");
      return ok(
        await client.getPaginated(resolveSite(args.siteId), "/class/classes", params, {
          maxPages: args.maxPages ?? 5,
        }),
      );
    }),
  );

  register(
    "mbo_get_class_visits",
    {
      title: "Get session rosters (attendance per session)",
      description:
        "Session roster rows (who was booked/signed in, late cancels, and the service they used) for " +
        "specific sessions. The v6 endpoint only accepts a SINGULAR ClassId, so this tool " +
        "issues one request per session with bounded concurrency (5). Service.Name reveals " +
        "intro-offer/first-timer members. Member ids come back as m_... tokens.",
      inputSchema: z.object({
        siteId: siteIdParam,
        classIds: z.array(z.number()).min(1).max(50).describe("Session Ids from mbo_get_classes."),
        lastModifiedDate: z.string().optional().describe("Only visits modified after this date."),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { siteId?: string; classIds: number[]; lastModifiedDate?: string }, ctx) => {
      const siteId = resolveSite(args.siteId);
      const report = progressReporter(ctx);
      const total = args.classIds.length;
      let done = 0;
      const CONCURRENCY = 5;
      const results: unknown[] = [];
      let cursor = 0;
      const inFlight: Array<Promise<void>> = [];
      const startOne = (classId: number) => {
        const params: Record<string, string> = { ClassId: String(classId), Limit: "200" };
        if (args.lastModifiedDate) params.LastModifiedDate = args.lastModifiedDate;
        const p = client
          .get(siteId, "/class/classvisits", params)
          .then((payload) => {
            results.push(payload);
            done += 1;
            report(done, `Fetched session rosters (${done}/${total})`, total);
          })
          .finally(() => {
            inFlight.splice(inFlight.indexOf(p), 1);
          });
        inFlight.push(p);
      };
      while (cursor < args.classIds.length) {
        while (inFlight.length < CONCURRENCY && cursor < args.classIds.length) {
          startOne(args.classIds[cursor++]);
        }
        if (inFlight.length > 0) await Promise.race(inFlight);
      }
      await Promise.all(inFlight);
      return ok(results);
    }),
  );

  register(
    "mbo_get_staff",
    {
      title: "Get staff",
      description:
        "GET /staff/staff — staff at a site. Contact details are removed and names are " +
        "reduced to initials by the PII mask.",
      inputSchema: z.object({
        siteId: siteIdParam,
        maxPages: z.number().int().min(1).max(10).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { siteId?: string; maxPages?: number }) =>
      ok(
        await client.getPaginated(resolveSite(args.siteId), "/staff/staff", {}, {
          maxPages: args.maxPages ?? 2,
        }),
      ),
    ),
  );

  // ------------------------------------------------------------------
  // Sales / catalog tools
  // ------------------------------------------------------------------
  register(
    "mbo_get_sales",
    {
      title: "Get sales",
      description:
        "GET /sale/sales — sales transactions in a datetime range (the refund/purchase source " +
        "of truth). Dates are site-local.",
      inputSchema: z.object({
        siteId: siteIdParam,
        startDate: z.string().describe("YYYY-MM-DD (inclusive)"),
        endDate: z.string().describe("YYYY-MM-DD (inclusive)"),
        maxPages: z.number().int().min(1).max(50).optional().describe("Default 3."),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { siteId?: string; startDate: string; endDate: string; maxPages?: number }) =>
      ok(
        await client.getPaginated(
          resolveSite(args.siteId),
          "/sale/sales",
          {
            StartSaleDateTime: `${args.startDate}T00:00:00`,
            EndSaleDateTime: `${args.endDate}T23:59:59`,
          },
          { maxPages: args.maxPages ?? 3 },
        ),
      ),
    ),
  );

  register(
    "mbo_get_services",
    {
      title: "Get services (price list)",
      description:
        "GET /sale/services — purchasable services/pricing options (memberships, packs, " +
        "intro offers) with ProductId, Price, and program linkage. Cached per site for 12h; " +
        "`complete: false` means the page cap was hit before every row returned.",
      inputSchema: z.object({
        siteId: siteIdParam,
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { siteId?: string }) =>
      ok(await fetchServiceCatalog(client, resolveSite(args.siteId))),
    ),
  );

  // ------------------------------------------------------------------
  // Site tools + generic escape hatch
  // ------------------------------------------------------------------
  register(
    "mbo_get_site_info",
    {
      title: "Get site info",
      description:
        "Site-level reference data: sites (name/timezone), locations, programs, sessiontypes, " +
        "memberships, or resources.",
      inputSchema: z.object({
        siteId: siteIdParam,
        resource: z.enum(["sites", "locations", "programs", "sessiontypes", "memberships", "resources"]),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { siteId?: string; resource: string }) => {
      const site = resolveSite(args.siteId);
      // /site/sites can return every site the API account can see, regardless
      // of the SiteIds filter. Narrow the call AND filter the response to the
      // requested site, so a caller only ever receives the site it asked for.
      if (args.resource === "sites" && site) {
        const raw = (await client.get(site, "/site/sites", { Limit: "200", SiteIds: site })) as {
          Sites?: Array<{ Id?: unknown }>;
        } | null;
        if (raw && Array.isArray(raw.Sites)) {
          return ok({ ...raw, Sites: raw.Sites.filter((s) => String(s?.Id) === site) });
        }
        return ok(raw);
      }
      return ok(await client.get(site, `/site/${args.resource}`, { Limit: "200" }));
    }),
  );

  register(
    "mbo_api_get",
    {
      title: "Raw Mindbody GET (any endpoint)",
      description:
        "Escape hatch: GET any Mindbody Public API v6 path with query params — covers all " +
        "~150 read operations (appointment/*, enrollment/*, payroll/*, pricingoption/*, " +
        "site/*, staff/*, ...). Paths are like /appointment/staffappointments. " +
        "Query param names are PascalCase (StartDate, ClientId, Limit...); m_... member " +
          "tokens are accepted as values. " +
        "Set paginate=true for list endpoints to follow Limit/Offset pages.",
      inputSchema: z.object({
        siteId: siteIdParam,
        path: z
          .string()
          .regex(/^\/[A-Za-z0-9/]+$/, "v6 path like /appointment/staffappointments")
          .describe("Path under /public/v6"),
        params: z.record(z.string(), z.string()).optional(),
        paginate: z.boolean().optional(),
        maxPages: z.number().int().min(1).max(50).optional().describe("Only with paginate=true."),
      }),
      annotations: { readOnlyHint: true },
    },
    guard(async (args: {
      siteId?: string;
      path: string;
      params?: Record<string, string>;
      paginate?: boolean;
      maxPages?: number;
    }) => {
      const siteId = resolveSite(args.siteId);
      // Member tokens may appear in any param, alone or comma-separated.
      const params = Object.fromEntries(
        Object.entries(args.params ?? {}).map(([k, v]) => [k, v.split(",").map(realId).join(",")]),
      );
      if (args.paginate) {
        return ok(
          await client.getPaginated(siteId, args.path, params, {
            maxPages: args.maxPages ?? 3,
          }),
        );
      }
      return ok(await client.get(siteId, args.path, params));
    }),
  );

  // ------------------------------------------------------------------
  // Write tools (opt-in via MBO_ALLOW_WRITES)
  // ------------------------------------------------------------------
  if (cfg.allowWrites) {
    register(
      "mbo_add_contact_log",
      {
        title: "Add member contact log",
        description:
          "POST /client/addcontactlog — write a CRM contact-log entry on a client. " +
          "ContactMethod MUST be one of Email|InPerson|Mail|Note|Phone|SMS — " +
          "anything else (e.g. \"Other\") is rejected by MBO with a 400.",
        inputSchema: z.object({
          siteId: siteIdParam,
          clientId: z.string(),
          text: z.string().min(1),
          contactMethod: z.enum(CONTACT_METHODS),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      guard(async (args: {
        siteId?: string;
        clientId: string;
        text: string;
        contactMethod: (typeof CONTACT_METHODS)[number];
      }) =>
        ok(
          await client.post(resolveSite(args.siteId), "/client/addcontactlog", {
            ClientId: realId(args.clientId),
            Text: args.text,
            ContactMethod: args.contactMethod,
          }),
        ),
      ),
    );

    register(
      "mbo_update_client",
      {
        title: "Update member profile",
        description:
          "POST /client/updateclient — update profile fields on an existing client. Only the " +
          "fields you pass are changed.",
        inputSchema: z.object({
          siteId: siteIdParam,
          clientId: z.string(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          email: z.string().optional(),
          mobilePhone: z.string().optional(),
          birthDate: z.string().optional().describe("YYYY-MM-DD"),
          addressLine1: z.string().optional(),
          addressLine2: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postalCode: z.string().optional(),
          gender: z.string().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      guard(async (args: Record<string, string | undefined> & { clientId: string }) => {
        const fieldMap: Record<string, string> = {
          firstName: "FirstName",
          lastName: "LastName",
          email: "Email",
          mobilePhone: "MobilePhone",
          birthDate: "BirthDate",
          addressLine1: "AddressLine1",
          addressLine2: "AddressLine2",
          city: "City",
          state: "State",
          postalCode: "PostalCode",
          gender: "Gender",
        };
        const clientBody: Record<string, string> = { Id: realId(args.clientId) };
        for (const [camel, pascal] of Object.entries(fieldMap)) {
          const value = args[camel];
          if (value !== undefined) clientBody[pascal] = value;
        }
        return ok(
          await client.post(resolveSite(args.siteId), "/client/updateclient", {
            Client: clientBody,
            CrossRegionalUpdate: false,
          }),
        );
      }),
    );
  }

  // ------------------------------------------------------------------
  // Webhook admin tools (opt-in via MBO_ALLOW_WEBHOOK_ADMIN)
  // ------------------------------------------------------------------
  if (cfg.allowWebhookAdmin) {
    const webhooks = new MboWebhooksClient(client, cfg.webhooksBaseUrl);

    register(
      "mbo_list_webhook_subscriptions",
      {
        title: "List webhook subscriptions",
        description:
          "GET mindbody.io/platform/webhooks/v1/subscriptions — current webhook subscriptions " +
          "(these are account-wide, not per-site).",
        inputSchema: z.object({ siteId: siteIdParam }),
        annotations: { readOnlyHint: true },
      },
      guard(async (args: { siteId?: string }) => ok(await webhooks.list(resolveSite(args.siteId)))),
    );

    register(
      "mbo_create_webhook_subscription",
      {
        title: "Create webhook subscription",
        description:
          "POST a webhook subscription. Verified-working eventIds: " +
          `${VERIFIED_WEBHOOK_EVENTS.join(", ")}. ` +
          "WARNING: clientVisit.* and clientMembership.* look plausible but do NOT exist — " +
          "subscriptions to them are never delivered.",
        inputSchema: z.object({
          siteId: siteIdParam,
          eventIds: z.array(z.string()).min(1),
          webhookUrl: z.string().url().describe("HTTPS receiver URL."),
          signatureKey: z.string().min(16).describe("HMAC signing key (min 16 chars)."),
          referenceId: z.string().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      guard(async (args: {
        siteId?: string;
        eventIds: string[];
        webhookUrl: string;
        signatureKey: string;
        referenceId?: string;
      }) =>
        ok(
          await webhooks.create(resolveSite(args.siteId), {
            eventIds: args.eventIds,
            webhookUrl: args.webhookUrl,
            signatureKey: args.signatureKey,
            referenceId: args.referenceId,
          }),
        ),
      ),
    );

    register(
      "mbo_delete_webhook_subscription",
      {
        title: "Delete webhook subscription",
        description: "DELETE a webhook subscription by its subscriptionId.",
        inputSchema: z.object({
          siteId: siteIdParam,
          subscriptionId: z.string(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      guard(async (args: { siteId?: string; subscriptionId: string }) =>
        ok(await webhooks.remove(resolveSite(args.siteId), args.subscriptionId)),
      ),
    );
  }

  return { toolCount };
}
