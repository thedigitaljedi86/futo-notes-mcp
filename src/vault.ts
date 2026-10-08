/**
 * High-level vault operations: connect, list/read/write/delete/search notes.
 * Caches only path/version/blob_key locally, never plaintext note content
 * (paths are stored in plaintext, though — they double as note titles).
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import { FutoClient, type FutoObject } from './client.js';
import {
  wrapVaultKey,
  unwrapVaultKey,
  generateVaultKey,
  encryptNote,
  decryptNote,
} from './crypto.js';

const paths = envPaths('futo-notes-mcp', { suffix: '' });
const CACHE_PATH = path.join(paths.cache, 'cache.json');

interface CachedObject {
  version: number;
  blob_key: string;
  path: string | null;
}

interface CollectionCache {
  cursor: number;
  objects: Record<string, CachedObject>;
}

type Cache = Record<string, CollectionCache>;

async function loadCache(): Promise<Cache> {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveCache(cache: Cache): Promise<void> {
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  const tmp = `${CACHE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  await rename(tmp, CACHE_PATH);
}

export interface VaultConfig {
  serverUrl: string;
  password: string;
}

export class Vault {
  private client: FutoClient;
  private cid: string | null = null;
  private vaultKey: Buffer | null = null;
  private cache: Cache = {};

  constructor(private config: VaultConfig) {
    this.client = new FutoClient(config.serverUrl);
  }

  /** Log in, resolve/create the collection, unwrap (or initialize) the vault key. */
  async connect(): Promise<void> {
    await this.client.login(this.config.password);
    this.cid = await this.client.getOrCreateCollection();

    const material = await this.client.getKeyMaterial(this.cid);
    if (material === null) {
      const vaultKey = generateVaultKey();
      const wrapped = wrapVaultKey(this.config.password, vaultKey);
      const authoritative = await this.client.putKeyMaterial(this.cid, wrapped);
      // Someone else may have won the race to set the first key; always
      // trust whatever the server reports as authoritative.
      this.vaultKey = unwrapVaultKey(this.config.password, authoritative);
    } else {
      this.vaultKey = unwrapVaultKey(this.config.password, material);
    }

    this.cache = await loadCache();
  }

  private get collCache(): CollectionCache {
    const cid = this.cid!;
    if (!this.cache[cid]) this.cache[cid] = { cursor: 0, objects: {} };
    return this.cache[cid];
  }

  private async refresh(): Promise<void> {
    const cc = this.collCache;
    const objects = await this.client.listObjects(this.cid!, cc.cursor);
    let maxSeq = cc.cursor;
    for (const o of objects as FutoObject[]) {
      const seq = Number(o.change_seq);
      maxSeq = Math.max(maxSeq, seq);
      if (o.deleted) {
        delete cc.objects[o.id];
        continue;
      }
      if (!o.blob_key) continue;
      const prev = cc.objects[o.id];
      cc.objects[o.id] = {
        version: Number(o.version),
        blob_key: o.blob_key,
        // The path lives inside the encrypted blob, so a new blob (e.g. the
        // note was renamed in the app) means the cached path may be stale.
        path: prev?.blob_key === o.blob_key ? prev.path : null,
      };
    }
    cc.cursor = maxSeq;
  }

  private async ensurePaths(): Promise<void> {
    const cc = this.collCache;
    for (const [, meta] of Object.entries(cc.objects)) {
      if (meta.path !== null) continue;
      const blob = await this.client.getBlob(meta.blob_key);
      const { path: p } = decryptNote(this.vaultKey!, blob);
      meta.path = p;
    }
  }

  private findByPath(notePath: string): [string, CachedObject] | [null, null] {
    for (const [oid, meta] of Object.entries(this.collCache.objects)) {
      if (meta.path === notePath) return [oid, meta];
    }
    return [null, null];
  }

  private async sync(): Promise<void> {
    await this.refresh();
    await this.ensurePaths();
    await saveCache(this.cache);
  }

  async list(folder?: string): Promise<string[]> {
    await this.sync();
    let entries = Object.values(this.collCache.objects)
      .map((m) => m.path!)
      .sort();
    if (folder) {
      const prefix = folder.replace(/\/+$/, '') + '/';
      entries = entries.filter((p) => p.startsWith(prefix));
    }
    return entries;
  }

  async read(notePath: string): Promise<string> {
    await this.sync();
    const [, meta] = this.findByPath(notePath);
    if (!meta) throw new Error(`Note not found: ${notePath}`);
    const blob = await this.client.getBlob(meta.blob_key);
    return decryptNote(this.vaultKey!, blob).content;
  }

  async write(notePath: string, content: string): Promise<'created' | 'updated'> {
    await this.sync();
    const ciphertext = encryptNote(this.vaultKey!, notePath, content);
    const [oid, meta] = this.findByPath(notePath);
    const cc = this.collCache;
    if (oid && meta) {
      const obj = await this.client.updateNoteObject(this.cid!, oid, meta.version, ciphertext);
      cc.objects[oid] = { version: Number(obj.version), blob_key: obj.blob_key!, path: notePath };
      await saveCache(this.cache);
      return 'updated';
    }
    const obj = await this.client.createNoteObject(this.cid!, ciphertext);
    cc.objects[obj.id] = { version: Number(obj.version), blob_key: obj.blob_key!, path: notePath };
    await saveCache(this.cache);
    return 'created';
  }

  async delete(notePath: string): Promise<void> {
    await this.sync();
    const [oid, meta] = this.findByPath(notePath);
    if (!oid || !meta) throw new Error(`Note not found: ${notePath}`);
    await this.client.deleteObject(this.cid!, oid, meta.version);
    delete this.collCache.objects[oid];
    await saveCache(this.cache);
  }

  async search(query: string): Promise<Array<{ path: string; snippet: string }>> {
    await this.sync();
    const needle = query.toLowerCase();
    const hits: Array<{ path: string; snippet: string }> = [];
    for (const meta of Object.values(this.collCache.objects)) {
      const blob = await this.client.getBlob(meta.blob_key);
      const { path: p, content } = decryptNote(this.vaultKey!, blob);
      const lc = content.toLowerCase();
      if (lc.includes(needle) || p.toLowerCase().includes(needle)) {
        const idx = lc.indexOf(needle);
        const snippet = idx >= 0
          ? content.slice(Math.max(0, idx - 40), idx + 60).replace(/\n/g, ' ')
          : '';
        hits.push({ path: p, snippet });
      }
    }
    hits.sort((a, b) => a.path.localeCompare(b.path));
    return hits;
  }
}
