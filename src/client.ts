/**
 * HTTP client for the FUTO Notes sync server REST API. Routes and payload
 * shapes verified directly against the futo-notes-server source
 * (src/collections/routes.ts, src/objects/routes.ts, src/blobs/routes.ts) —
 * not guessed from docs alone.
 */
import type { KeyMaterial } from './crypto.js';

export interface FutoObject {
  id: string;
  version: string; // bigint-as-string per server convention
  change_seq: string;
  deleted: boolean;
  blob_key: string | null;
  size_bytes: string | null;
  updated_at: string;
}

export class FutoApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'FutoApiError';
  }
}

export class FutoClient {
  private base: string;
  private token: string | null = null;

  constructor(serverUrl: string) {
    this.base = serverUrl.replace(/\/+$/, '');
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    return res;
  }

  async login(password: string): Promise<void> {
    const res = await this.request('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.status === 401) {
      throw new FutoApiError(401, 'Login rejected: wrong password.');
    }
    if (!res.ok) throw new FutoApiError(res.status, `Login failed: ${await res.text()}`);
    const data = (await res.json()) as { token: string };
    this.token = data.token;
  }

  async getOrCreateCollection(): Promise<string> {
    const res = await this.request('/api/collections', { method: 'POST' });
    if (!res.ok) throw new FutoApiError(res.status, `Could not get/create collection: ${await res.text()}`);
    const data = (await res.json()) as { collection: { id: string } };
    return data.collection.id;
  }

  async getKeyMaterial(cid: string): Promise<KeyMaterial | null> {
    const res = await this.request(`/api/collections/${cid}/key`);
    if (!res.ok) throw new FutoApiError(res.status, `Could not fetch key material: ${await res.text()}`);
    const data = (await res.json()) as { key: KeyMaterial | null };
    return data.key;
  }

  async putKeyMaterial(cid: string, material: KeyMaterial): Promise<KeyMaterial> {
    const res = await this.request(`/api/collections/${cid}/key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(material),
    });
    if (!res.ok) throw new FutoApiError(res.status, `Could not set key material: ${await res.text()}`);
    const data = (await res.json()) as { key: KeyMaterial };
    return data.key;
  }

  async listObjects(cid: string, sinceVersion = 0): Promise<FutoObject[]> {
    const res = await this.request(`/api/collections/${cid}/objects?sinceVersion=${sinceVersion}`);
    if (!res.ok) throw new FutoApiError(res.status, `Could not list objects: ${await res.text()}`);
    const data = (await res.json()) as { objects: FutoObject[] };
    return data.objects;
  }

  async getBlob(blobKey: string): Promise<Buffer> {
    const res = await this.request(`/api/blobs/${blobKey}`);
    if (!res.ok) throw new FutoApiError(res.status, `Could not fetch blob ${blobKey}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async createNoteObject(cid: string, ciphertext: Buffer): Promise<FutoObject> {
    const res = await this.request(`/api/collections/${cid}/blob-objects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Mutation-Id': crypto.randomUUID(),
      },
      body: new Uint8Array(ciphertext),
    });
    if (!res.ok) throw new FutoApiError(res.status, `Could not create note: ${await res.text()}`);
    const data = (await res.json()) as { object: FutoObject };
    return data.object;
  }

  async updateNoteObject(cid: string, oid: string, version: number, ciphertext: Buffer): Promise<FutoObject> {
    const res = await this.request(`/api/collections/${cid}/blob-objects/${oid}?version=${version}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Mutation-Id': crypto.randomUUID(),
      },
      body: new Uint8Array(ciphertext),
    });
    if (res.status === 409) {
      throw new FutoApiError(409, 'Version conflict: the note changed elsewhere since last sync. Re-list and retry.');
    }
    if (!res.ok) throw new FutoApiError(res.status, `Could not update note: ${await res.text()}`);
    const data = (await res.json()) as { object: FutoObject };
    return data.object;
  }

  async deleteObject(cid: string, oid: string, version: number): Promise<FutoObject> {
    const res = await this.request(`/api/collections/${cid}/objects/${oid}?version=${version}`, {
      method: 'DELETE',
    });
    if (res.status === 409) {
      throw new FutoApiError(409, 'Version conflict on delete: re-list and retry.');
    }
    if (!res.ok) throw new FutoApiError(res.status, `Could not delete note: ${await res.text()}`);
    const data = (await res.json()) as { object: FutoObject };
    return data.object;
  }
}
