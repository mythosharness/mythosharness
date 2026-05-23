import { db } from "../memory/db.ts";

type Level = "debug" | "info" | "warn" | "error";

export interface LogCtx {
  stage?: string;
  taskId?: string;
  targetId?: string;
  meta?: unknown;
}

function emit(level: Level, msg: string, ctx: LogCtx = {}) {
  const ts = new Date().toISOString();
  const prefix = ctx.stage ? `[${ctx.stage}]` : "";
  // eslint-disable-next-line no-console
  console.log(`${ts} ${level.toUpperCase()} ${prefix} ${msg}`);
  try {
    db().run(
      `INSERT INTO runlog(ts,level,stage,task_id,target_id,message,meta)
       VALUES(?,?,?,?,?,?,?)`,
      [
        ts,
        level,
        ctx.stage ?? null,
        ctx.taskId ?? null,
        ctx.targetId ?? null,
        msg,
        ctx.meta ? JSON.stringify(ctx.meta) : null,
      ],
    );
  } catch {
    // DB may not exist yet during very early bootstrap.
  }
}

export const log = {
  debug: (m: string, c?: LogCtx) => emit("debug", m, c),
  info: (m: string, c?: LogCtx) => emit("info", m, c),
  warn: (m: string, c?: LogCtx) => emit("warn", m, c),
  error: (m: string, c?: LogCtx) => emit("error", m, c),
};
