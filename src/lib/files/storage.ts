/**
 * File storage (doc 18): driver local default; R2 opsional via flag.
 * Binari file TIDAK disimpan di kolom DB — hanya key/path-nya.
 * Key/URL R2 mentah tidak pernah diekspos ke klien.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { getConfig } from "../config";
import { apiError } from "../../modules/_shared/api-error";

export type StoredObjectRef = {
  driver: "local" | "r2";
  key: string;
};

const SAFE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY_PATTERN.test(key) || key.includes("..")) {
    throw apiError("VALIDATION_ERROR", "Object key tidak valid.");
  }
}

function localPathFor(key: string): string {
  const basePath = resolve(getConfig().storage.localPath);
  const target = normalize(join(basePath, key));
  if (target !== basePath && !target.startsWith(basePath + sep)) {
    throw apiError("VALIDATION_ERROR", "Object key tidak valid.");
  }
  return target;
}

export async function putObject(key: string, data: Uint8Array): Promise<StoredObjectRef> {
  assertSafeKey(key);
  const config = getConfig();
  if (config.storage.driver === "r2") {
    // TODO(sync-storage): implement R2 client di modul sync-storage;
    // provider tidak boleh dipanggil di dalam DB transaction.
    throw apiError("PROVIDER_ERROR", "Driver R2 belum diimplementasikan.");
  }
  const path = localPathFor(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return { driver: "local", key };
}

export async function getObject(key: string): Promise<Uint8Array> {
  assertSafeKey(key);
  const config = getConfig();
  if (config.storage.driver === "r2") {
    throw apiError("PROVIDER_ERROR", "Driver R2 belum diimplementasikan.");
  }
  try {
    return await readFile(localPathFor(key));
  } catch {
    throw apiError("RESOURCE_NOT_FOUND", "Object tidak ditemukan.");
  }
}
