#!/usr/bin/env node
// ============================================================
// wacrm MCP server — entry point.
//
// A stdio Model Context Protocol server that exposes the wacrm
// public API (`/api/v1`) as MCP tools, so an MCP client (Claude
// Desktop, Cursor, etc.) can drive a self-hosted WhatsApp CRM in
// natural language.
//
// Transport is stdio: logs MUST go to stderr, never stdout (stdout
// is the protocol channel). Configuration comes from the environment
// — see .env.example / README.md.
// ============================================================

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { WacrmClient } from './client.js';
import { registerTools } from './tools/index.js';

// Read from the manifest at runtime so the version the server announces
// is always the one that was published. `createRequire` rather than an
// `import … with { type: 'json' }`: `package.json` sits outside
// `rootDir` (./src), and from `dist/index.js` the same relative path
// still lands on it — npm always ships `package.json` in the tarball.
const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new WacrmClient(config);

  const server = new McpServer({ name: 'wacrm-mcp', version: VERSION });
  const groups = registerTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stderr only — stdout is reserved for the MCP protocol.
  console.error(
    `wacrm MCP server v${VERSION} ready — instance ${config.baseUrl}, ` +
      `tool groups: ${groups.join(', ')}` +
      (config.enableWrites ? '' : ' (read-only; set WACRM_ENABLE_WRITES to allow changes)'),
  );
}

main().catch((err) => {
  console.error(`Failed to start wacrm MCP server: ${(err as Error).message}`);
  process.exit(1);
});
