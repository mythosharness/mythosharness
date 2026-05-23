import { db } from "./db.ts";
import { newId } from "../util/ids.ts";
import type { Task, TaskKind, TaskStatus } from "../schemas/index.ts";

interface Row {
  id: string;
  kind: string;
  status: string;
  payload: string;
  created_at: string;
  updated_at: string;
  attempt: number;
  parent_id: string | null;
  target_id: string | null;
  result: string | null;
}

function toTask(r: Row): Task & { result: unknown } {
  return {
    id: r.id,
    kind: r.kind as TaskKind,
    status: r.status as TaskStatus,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    attempt: r.attempt,
    parentId: r.parent_id,
    targetId: r.target_id,
    result: r.result ? JSON.parse(r.result) : null,
  };
}

export interface EnqueueArgs {
  kind: TaskKind;
  payload: unknown;
  parentId?: string | null;
  targetId?: string | null;
}

export function enqueue(args: EnqueueArgs): string {
  const id = newId("task");
  const now = new Date().toISOString();
  db().run(
    `INSERT INTO tasks(id,kind,status,payload,created_at,updated_at,attempt,parent_id,target_id)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      id,
      args.kind,
      "pending",
      JSON.stringify(args.payload),
      now,
      now,
      0,
      args.parentId ?? null,
      args.targetId ?? null,
    ],
  );
  return id;
}

export function claimNext(kinds: TaskKind[]): (Task & { result: unknown }) | null {
  if (kinds.length === 0) return null;
  const placeholders = kinds.map(() => "?").join(",");
  const row = db()
    .query(
      `SELECT * FROM tasks WHERE status='pending' AND kind IN (${placeholders})
       ORDER BY datetime(created_at) ASC LIMIT 1`,
    )
    .get(...kinds) as Row | undefined;
  if (!row) return null;
  const now = new Date().toISOString();
  db().run(
    "UPDATE tasks SET status='running', updated_at=?, attempt=attempt+1 WHERE id=? AND status='pending'",
    [now, row.id],
  );
  return toTask({ ...row, status: "running", updated_at: now, attempt: row.attempt + 1 });
}

export function finishTask(id: string, status: "succeeded" | "failed", result: unknown) {
  db().run(
    "UPDATE tasks SET status=?, updated_at=?, result=? WHERE id=?",
    [status, new Date().toISOString(), JSON.stringify(result ?? null), id],
  );
}

export function listPending(kind?: TaskKind): Task[] {
  const rows = kind
    ? (db().query("SELECT * FROM tasks WHERE status='pending' AND kind=?").all(kind) as Row[])
    : (db().query("SELECT * FROM tasks WHERE status='pending'").all() as Row[]);
  return rows.map((r) => {
    const { result: _result, ...rest } = toTask(r);
    return rest;
  });
}

export function countByStatus(): Record<string, number> {
  const rows = db()
    .query("SELECT status, COUNT(*) as n FROM tasks GROUP BY status")
    .all() as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function cancelAllForTarget(targetId: string) {
  db().run(
    "UPDATE tasks SET status='cancelled', updated_at=? WHERE target_id=? AND status IN ('pending','running')",
    [new Date().toISOString(), targetId],
  );
}
