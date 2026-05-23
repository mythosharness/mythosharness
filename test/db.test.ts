import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point DATA_DIR at a tmp dir BEFORE importing anything that uses bun:sqlite.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mythos-test-"));
process.env.DATA_DIR = TMP;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test";

const { addTarget, listTargets } = await import("../src/memory/targets.ts");
const { enqueue, claimNext, finishTask } = await import("../src/memory/tasks.ts");
const { upsertFinding } = await import("../src/memory/findings.ts");
const { Finding } = await import("../src/schemas/index.ts");

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("targets", () => {
  test("add + list", () => {
    const t = addTarget({ url: "https://example.com/repo", localPath: "/tmp/x" });
    expect(t.id.startsWith("tgt_")).toBeTrue();
    const all = listTargets();
    expect(all.find((x) => x.id === t.id)).toBeDefined();
  });
});

describe("task queue", () => {
  let targetId: string;
  beforeAll(() => {
    targetId = addTarget({ url: "https://q.example/repo", localPath: "/tmp/q" }).id;
  });
  test("claim returns FIFO", () => {
    const a = enqueue({
      kind: "hunt",
      payload: { a: 1 },
      targetId,
    });
    const b = enqueue({
      kind: "hunt",
      payload: { a: 2 },
      targetId,
    });
    const c1 = claimNext(["hunt"]);
    expect(c1?.id).toBe(a);
    finishTask(a, "succeeded", { ok: true });
    const c2 = claimNext(["hunt"]);
    expect(c2?.id).toBe(b);
    finishTask(b, "succeeded", { ok: true });
    expect(claimNext(["hunt"])).toBeNull();
  });
});

describe("findings dedup", () => {
  test("second upsert with same dedup hash is no-op", () => {
    const t = addTarget({ url: "https://d.example/repo", localPath: "/tmp/d" });
    const f = Finding.parse({
      id: "find_1",
      targetId: t.id,
      attackClass: "sql_injection",
      severity: "high",
      title: "Test SQLi",
      summary: "s",
      rootCause: "string concat",
      trustBoundary: "http_to_db",
      attackerControlledInput: "name param",
      primaryLocation: { file: "x.py", startLine: 1, endLine: 5, symbol: null },
      relatedLocations: [],
      poc: null,
      validated: false,
      validatorRationale: null,
      reachable: null,
      dedupHash: "abc123",
      createdAt: new Date().toISOString(),
      reportedAt: null,
    });
    expect(upsertFinding(f).inserted).toBeTrue();
    const f2 = { ...f, id: "find_2" };
    expect(upsertFinding(f2).inserted).toBeFalse();
  });
});
