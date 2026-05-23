import { db } from "./db.ts";
import { ArchDoc } from "../schemas/index.ts";

export function saveArchDoc(doc: ArchDoc) {
  db().run(
    `INSERT INTO arch_docs(target_id,json,built_at) VALUES(?,?,?)
     ON CONFLICT(target_id) DO UPDATE SET json=excluded.json, built_at=excluded.built_at`,
    [doc.targetId, JSON.stringify(doc), doc.builtAt],
  );
}

export function loadArchDoc(targetId: string): ArchDoc | null {
  const row = db()
    .query("SELECT json FROM arch_docs WHERE target_id=?")
    .get(targetId) as { json: string } | undefined;
  if (!row) return null;
  return ArchDoc.parse(JSON.parse(row.json));
}
