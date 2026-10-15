#!/usr/bin/env node
/**
 * mindbody-mcp-server — MCP stdio server for the Mindbody Public API v6.
 *
 * IMPORTANT: stdout is the MCP protocol channel; all logging goes to
 * stderr (console.error).
 */
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { MboClient } from "./mbo/client.js";
import { MboPacer } from "./mbo/pacer.js";
import { setPseudonymPepper } from "./pii.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  // A fresh random pepper per process: member pseudonyms are stable for the
  // life of the server and meaningless outside it.
  setPseudonymPepper(randomBytes(32).toString("hex"));

  const client = new MboClient({
    apiKey: cfg.apiKey,
    username: cfg.username,
    password: cfg.password,
    baseUrl: cfg.apiBaseUrl,
    pacer: new MboPacer(),
  });

  const server = new McpServer({ name: "mindbody-mcp-server", version: "0.1.0" });
  const { toolCount } = registerTools(server, cfg, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `mindbody-mcp-server ready: ${toolCount} tools` +
      ` (writes ${cfg.allowWrites ? "ENABLED" : "off"},` +
      ` webhook admin ${cfg.allowWebhookAdmin ? "ENABLED" : "off"},` +
      ` default site ${cfg.defaultSiteId ?? "none"})`,
  );
}

main().catch((err) => {
  console.error(`mindbody-mcp-server failed to start: ${(err as Error).message}`);
  process.exit(1);
});
