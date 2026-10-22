import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ObjectStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export function assertStorageKey(key: string): string {
  if (!KEY.test(key)) throw new Error("invalid_storage_key");
  return key;
}

export class MemoryStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(assertStorageKey(key), data.slice());
  }

  async get(key: string): Promise<Uint8Array> {
    const data = this.objects.get(assertStorageKey(key));
    if (!data) throw new Error("missing_object");
    return data.slice();
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(assertStorageKey(key));
  }
}

export class DiskStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private pathFor(key: string): string {
    const safe = assertStorageKey(key);
    const root = resolve(this.root);
    const full = resolve(root, safe);
    if (full !== root + sep + safe && full !== resolve(root, safe)) {
      throw new Error("invalid_storage_key");
    }
    if (!full.startsWith(root + sep)) throw new Error("invalid_storage_key");
    return full;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(this.root, { recursive: true });
    await writeFile(full, data);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
