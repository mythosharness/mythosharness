import { describe, expect, test } from "bun:test";
import { Finding, HuntTaskPayload, ArchDoc } from "../src/schemas/index.ts";
import { dedupHash } from "../src/util/ids.ts";

describe("schemas", () => {
  test("HuntTaskPayload defaults budget", () => {
    const p = HuntTaskPayload.parse({
      targetId: "tgt_abc",
      attackClass: "sql_injection",
      scopeHint: "src/handlers/user.py",
    });
    expect(p.budgetTokens).toBe(80_000);
  });

  test("Finding rejects missing primary location", () => {
    expect(() =>
      Finding.parse({
        id: "find_1",
        targetId: "tgt_a",
        attackClass: "sql_injection",
        severity: "high",
        title: "x",
        summary: "y",
        rootCause: "z",
        trustBoundary: null,
        attackerControlledInput: null,
        // primaryLocation missing
        dedupHash: "abc",
        createdAt: new Date().toISOString(),
      } as unknown),
    ).toThrow();
  });

  test("ArchDoc round-trips", () => {
    const doc = ArchDoc.parse({
      targetId: "t1",
      summary: "x",
      language: "py",
      buildSystem: "none",
      buildCommands: [],
      testCommands: [],
      entryPoints: [],
      trustBoundaries: [],
      attackSurface: [],
      subsystems: [],
      dependencies: [],
      builtAt: new Date().toISOString(),
    });
    expect(doc.targetId).toBe("t1");
  });
});

describe("dedupHash", () => {
  test("stable across whitespace variations", () => {
    const a = dedupHash({
      file: "a.py",
      symbol: "f",
      attackClass: "sqli",
      rootCause: "  string  concat ",
    });
    const b = dedupHash({
      file: "a.py",
      symbol: "f",
      attackClass: "sqli",
      rootCause: "string concat",
    });
    expect(a).toBe(b);
  });
});
