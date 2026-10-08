import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Vault } from './vault.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export function createServer(vault: Vault): McpServer {
  const server = new McpServer({
    name: 'futo-notes-mcp',
    version,
  });

  server.tool(
    'list_notes',
    'List note paths in the FUTO Notes vault. A path is folder/Title.md — ' +
      'the path IS the title, there is no separate title field. ' +
      'Optionally restrict to notes under a given folder.',
    { folder: z.string().optional().describe('Only list notes under this folder, e.g. "Work"') },
    async ({ folder }) => {
      const paths = await vault.list(folder);
      return { content: [{ type: 'text', text: paths.length ? paths.join('\n') : '(no notes)' }] };
    },
  );

  server.tool(
    'read_note',
    'Read the decrypted markdown content of one note by its path.',
    { path: z.string().describe('Note path, e.g. "Work/Meeting notes.md"') },
    async ({ path }) => {
      const content = await vault.read(path);
      return { content: [{ type: 'text', text: content }] };
    },
  );

  server.tool(
    'write_note',
    'Create or update a note. If a note already exists at this path it is ' +
      'updated (with an automatic version guard); otherwise a new note is ' +
      'created. Content is markdown; tags are inline #hashtags in the text, ' +
      'there is no separate tags field.',
    {
      path: z.string().describe('Note path, e.g. "Work/Meeting notes.md"'),
      content: z.string().describe('Full markdown content of the note'),
    },
    async ({ path, content }) => {
      const outcome = await vault.write(path, content);
      return { content: [{ type: 'text', text: `${outcome}: ${path}` }] };
    },
  );

  server.tool(
    'delete_note',
    'Delete a note by path.',
    { path: z.string().describe('Note path, e.g. "Work/Meeting notes.md"') },
    async ({ path }) => {
      await vault.delete(path);
      return { content: [{ type: 'text', text: `deleted: ${path}` }] };
    },
  );

  server.tool(
    'search_notes',
    'Full-text search across all note paths and content. Decrypts every ' +
      'note to search it, so this can take a few seconds in a large vault.',
    { query: z.string().describe('Substring to search for, case-insensitive') },
    async ({ query }) => {
      const hits = await vault.search(query);
      if (!hits.length) return { content: [{ type: 'text', text: '(no matches)' }] };
      const text = hits.map((h) => (h.snippet ? `${h.path}: ...${h.snippet}...` : h.path)).join('\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  return server;
}
