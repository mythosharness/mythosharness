import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function dedupHash(parts: { file: string; symbol: string | null; attackClass: string; rootCause: string }): string {
  const normalizedCause = parts.rootCause
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return sha256(`${parts.file}|${parts.symbol ?? ""}|${parts.attackClass}|${normalizedCause}`).slice(0, 16);
}
