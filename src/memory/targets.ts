import { db } from "./db.ts";
import { newId } from "../util/ids.ts";
import type { Target } from "../schemas/index.ts";

interface Row {
  id: string;
  url: string;
  local_path: string;
  language: string | null;
  build_system: string | null;
  focus_areas: string;
  status: string;
  added_at: string;
  arch_doc_path: string | null;
}

function toTarget(r: Row): Target {
  return {
    id: r.id,
    url: r.url,
    localPath: r.local_path,
    language: r.language,
    buildSystem: r.build_system,
    focusAreas: JSON.parse(r.focus_areas),
    status: r.status as Target["status"],
    addedAt: r.added_at,
    archDocPath: r.arch_doc_path,
  };
}

export function addTarget(args: { url: string; localPath: string; focusAreas?: string[] }): Target {
  const id = newId("tgt");
  const now = new Date().toISOString();
  db().run(
    `INSERT INTO targets(id,url,local_path,focus_areas,status,added_at) VALUES(?,?,?,?,?,?)`,
    [id, args.url, args.localPath, JSON.stringify(args.focusAreas ?? []), "active", now],
  );
  return {
    id,
    url: args.url,
    localPath: args.localPath,
    language: null,
    buildSystem: null,
    focusAreas: args.focusAreas ?? [],
    status: "active",
    addedAt: now,
    archDocPath: null,
  };
}

export function listTargets(status?: Target["status"]): Target[] {
  const rows = status
    ? (db().query("SELECT * FROM targets WHERE status=?").all(status) as Row[])
    : (db().query("SELECT * FROM targets").all() as Row[]);
  return rows.map(toTarget);
}

export function getTarget(id: string): Target | null {
  const r = db().query("SELECT * FROM targets WHERE id=?").get(id) as Row | undefined;
  return r ? toTarget(r) : null;
}

export function getTargetByUrl(url: string): Target | null {
  const r = db().query("SELECT * FROM targets WHERE url=?").get(url) as Row | undefined;
  return r ? toTarget(r) : null;
}

export function setTargetStatus(id: string, status: Target["status"]) {
  db().run("UPDATE targets SET status=? WHERE id=?", [status, id]);
}

export function setTargetMeta(id: string, meta: { language?: string; buildSystem?: string; archDocPath?: string }) {
  const t = getTarget(id);
  if (!t) return;
  db().run(
    `UPDATE targets SET language=?, build_system=?, arch_doc_path=? WHERE id=?`,
    [
      meta.language ?? t.language,
      meta.buildSystem ?? t.buildSystem,
      meta.archDocPath ?? t.archDocPath,
      id,
    ],
  );
}

export function addFocusAreas(id: string, areas: string[]) {
  const t = getTarget(id);
  if (!t) return;
  const next = Array.from(new Set([...t.focusAreas, ...areas]));
  db().run("UPDATE targets SET focus_areas=? WHERE id=?", [JSON.stringify(next), id]);
}
