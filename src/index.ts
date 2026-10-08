#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { Vault } from './vault.js';

async function main() {
  const serverUrl = process.env.FUTO_NOTES_SERVER_URL;
  const password = process.env.FUTO_NOTES_PASSWORD;

  if (!serverUrl || !password) {
    console.error(
      'Missing config: set FUTO_NOTES_SERVER_URL and FUTO_NOTES_PASSWORD ' +
        'in the environment (e.g. in your MCP client\'s server config).',
    );
    process.exit(1);
  }

  const vault = new Vault({ serverUrl, password });
  await vault.connect();

  const server = createServer(vault);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('futo-notes-mcp failed to start:', err);
  process.exit(1);
});
