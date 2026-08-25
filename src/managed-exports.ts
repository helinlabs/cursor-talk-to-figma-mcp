import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";

export const MANAGED_EXPORT_DIR = resolve(
  process.env.TALK_TO_FIGMA_EXPORT_DIR || join(process.cwd(), ".relay", "exports"),
);
export const EXPORT_RETENTION_DAYS = Math.max(1, Number(process.env.TALK_TO_FIGMA_EXPORT_RETENTION_DAYS) || 30);

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "figma-export";
}

function managedPath(name: string): string {
  const safe = basename(name);
  if (safe !== name || !MIME_TYPES[extname(safe).toLowerCase()]) throw new Error("Invalid managed export name");
  return join(MANAGED_EXPORT_DIR, safe);
}

export function saveManagedExport(bytes: Uint8Array | string, suggestedName: string, extension: string): string {
  mkdirSync(MANAGED_EXPORT_DIR, { recursive: true });
  const ext = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  if (!MIME_TYPES[ext]) throw new Error(`Unsupported managed export type: ${ext}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}--${safeName(suggestedName.replace(/\.[^.]+$/, ""))}--${randomUUID().slice(0, 8)}${ext}`;
  const target = managedPath(name);
  writeFileSync(target, bytes);
  return target;
}

export function listManagedExports(): { directory: string; retentionDays: number; totalBytes: number; files: any[] } {
  mkdirSync(MANAGED_EXPORT_DIR, { recursive: true });
  const files = readdirSync(MANAGED_EXPORT_DIR)
    .filter((name) => MIME_TYPES[extname(name).toLowerCase()])
    .map((name) => {
      const stat = statSync(managedPath(name));
      return { name, bytes: stat.size, createdAt: stat.birthtimeMs || stat.mtimeMs, modifiedAt: stat.mtimeMs, mimeType: MIME_TYPES[extname(name).toLowerCase()] };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return { directory: MANAGED_EXPORT_DIR, retentionDays: EXPORT_RETENTION_DAYS, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}

export function readManagedExport(name: string): { bytes: Buffer; mimeType: string } {
  const target = managedPath(name);
  return { bytes: readFileSync(target), mimeType: MIME_TYPES[extname(target).toLowerCase()] };
}

export function deleteManagedExports(olderThanDays?: number): { deleted: number; freedBytes: number } {
  const snapshot = listManagedExports();
  const cutoff = olderThanDays === undefined ? Infinity : Date.now() - Math.max(0, olderThanDays) * 86_400_000;
  let deleted = 0;
  let freedBytes = 0;
  for (const file of snapshot.files) {
    if (olderThanDays !== undefined && file.modifiedAt >= cutoff) continue;
    unlinkSync(managedPath(file.name));
    deleted++;
    freedBytes += file.bytes;
  }
  return { deleted, freedBytes };
}

export function applyManagedExportRetention(): { deleted: number; freedBytes: number } {
  return deleteManagedExports(EXPORT_RETENTION_DAYS);
}
