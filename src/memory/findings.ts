import { db } from "./db.ts";
import { Finding } from "../schemas/index.ts";

interface Row {
  id: string;
  target_id: string;
  attack_class: string;
  severity: string;
  title: string;
  summary: string;
  root_cause: string;
  trust_boundary: string | null;
  attacker_input: string | null;
  primary_location: string;
  related_locations: string;
  poc: string | null;
  validated: number;
  validator_rationale: string | null;
  reachable: number | null;
  dedup_hash: string;
  created_at: string;
  reported_at: string | null;
}

function toFinding(r: Row): Finding {
  return Finding.parse({
    id: r.id,
    targetId: r.target_id,
    attackClass: r.attack_class,
    severity: r.severity,
    title: r.title,
    summary: r.summary,
    rootCause: r.root_cause,
    trustBoundary: r.trust_boundary,
    attackerControlledInput: r.attacker_input,
    primaryLocation: JSON.parse(r.primary_location),
    relatedLocations: JSON.parse(r.related_locations),
    poc: r.poc ? JSON.parse(r.poc) : null,
    validated: r.validated === 1,
    validatorRationale: r.validator_rationale,
    reachable: r.reachable === null ? null : r.reachable === 1,
    dedupHash: r.dedup_hash,
    createdAt: r.created_at,
    reportedAt: r.reported_at,
  });
}

export function upsertFinding(f: Finding): { inserted: boolean } {
  const existing = db()
    .query("SELECT id FROM findings WHERE target_id=? AND dedup_hash=?")
    .get(f.targetId, f.dedupHash) as { id: string } | undefined;
  if (existing) return { inserted: false };
  db().run(
    `INSERT INTO findings(
      id,target_id,attack_class,severity,title,summary,root_cause,
      trust_boundary,attacker_input,primary_location,related_locations,
      poc,validated,validator_rationale,reachable,dedup_hash,created_at,reported_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      f.id,
      f.targetId,
      f.attackClass,
      f.severity,
      f.title,
      f.summary,
      f.rootCause,
      f.trustBoundary,
      f.attackerControlledInput,
      JSON.stringify(f.primaryLocation),
      JSON.stringify(f.relatedLocations),
      f.poc ? JSON.stringify(f.poc) : null,
      f.validated ? 1 : 0,
      f.validatorRationale,
      f.reachable === null ? null : f.reachable ? 1 : 0,
      f.dedupHash,
      f.createdAt,
      f.reportedAt,
    ],
  );
  return { inserted: true };
}

export function updateValidatorVerdict(
  id: string,
  validated: boolean,
  rationale: string,
  reachable: boolean | null,
) {
  db().run(
    `UPDATE findings SET validated=?, validator_rationale=?, reachable=? WHERE id=?`,
    [validated ? 1 : 0, rationale, reachable === null ? null : reachable ? 1 : 0, id],
  );
}

export function markReported(ids: string[]) {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(",");
  db().run(`UPDATE findings SET reported_at=? WHERE id IN (${placeholders})`, [now, ...ids]);
}

export function unreportedFindings(): Finding[] {
  const rows = db()
    .query("SELECT * FROM findings WHERE reported_at IS NULL AND validated=1 ORDER BY datetime(created_at) ASC")
    .all() as Row[];
  return rows.map(toFinding);
}

export function findingsForTarget(targetId: string): Finding[] {
  const rows = db()
    .query("SELECT * FROM findings WHERE target_id=? ORDER BY datetime(created_at) DESC")
    .all(targetId) as Row[];
  return rows.map(toFinding);
}

export function pendingValidation(): Finding[] {
  const rows = db()
    .query("SELECT * FROM findings WHERE validated=0 ORDER BY datetime(created_at) ASC")
    .all() as Row[];
  return rows.map(toFinding);
}

export function countFindings(): { total: number; validated: number; reported: number } {
  const r = db()
    .query(
      `SELECT
         COUNT(*) AS total,
         SUM(validated) AS validated,
         SUM(CASE WHEN reported_at IS NOT NULL THEN 1 ELSE 0 END) AS reported
       FROM findings`,
    )
    .get() as { total: number; validated: number; reported: number };
  return { total: r.total ?? 0, validated: r.validated ?? 0, reported: r.reported ?? 0 };
}
