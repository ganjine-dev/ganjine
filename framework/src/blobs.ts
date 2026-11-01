import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GanjineError } from './db.ts';

export interface BlobStore {
  put(bytes: Buffer): Promise<string>;
  get(ref: string): Promise<Buffer>;
  exists(ref: string): Promise<boolean>;
}

export const blobHash = (ref: string) => key(ref).slice('sha256/'.length);

const key = (ref: string) => {
  const hex = /^blob:sha256:([0-9a-f]{64})$/.exec(ref)?.[1];
  if (!hex) throw new GanjineError(`invalid blob ref: ${ref}`);
  return `sha256/${hex}`;
};

export class LocalDiskBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async put(bytes: Buffer) {
    const ref = `blob:sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const path = join(this.root, key(ref));
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, path);
    return ref;
  }

  async get(ref: string) {
    if (!(await this.exists(ref))) throw new GanjineError(`blob not found: ${ref}`);
    const bytes = await readFile(join(this.root, key(ref)));
    if (createHash('sha256').update(bytes).digest('hex') !== blobHash(ref)) throw new GanjineError(`blob failed verification, refused: ${ref}`);
    return bytes;
  }

  async exists(ref: string) {
    return access(join(this.root, key(ref))).then(() => true, () => false);
  }
}

export const blobStore = (): BlobStore =>
  new LocalDiskBlobStore(process.env.GANJINE_BLOB_DIR ?? new URL('../../.ganjine/blobs', import.meta.url).pathname);
