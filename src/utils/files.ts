import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

/**
 * Read a JSON file and parse it
 */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as T;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

/**
 * Write data to a JSON file with pretty formatting
 */
export async function writeJson<T>(path: string, data: T): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await writeFile(path, content, "utf-8");
}

/**
 * Check if a file exists
 */
export function fileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Atomically update a JSON file
 * Reads, applies transform, then writes
 */
export async function updateJson<T>(
  path: string,
  transform: (data: T) => T,
  defaultValue: T
): Promise<T> {
  const existing = await readJson<T>(path);
  const data = existing ?? defaultValue;
  const updated = transform(data);
  await writeJson(path, updated);
  return updated;
}
