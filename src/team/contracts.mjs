import { createHash } from "node:crypto";

export const roles = ["technical_director", "product_manager", "project_manager", "developer", "qa_engineer"];
export const categories = ["requirement", "architecture", "api-contract", "implementation", "bugfix", "testing", "workflow"];
export class ApiError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export function ensure(condition, status = 400, code = "invalid_request") {
  if (!condition) throw new ApiError(status, code);
}
export function str(value, max = 200) {
  ensure(typeof value === "string" && value.trim().length > 0 && value.length <= max);
  return value.trim();
}
export function uuid(value) {
  ensure(typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value));
  return value;
}
export const digest = value => createHash("sha256").update(value).digest("hex");
export function redact(text) {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{20,})\b/g, "[redacted token]")
    .replace(/\b(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[^\s,"';]+/gi, "$1=[redacted]");
}

export async function member(db, user, projectId, management = false, lock = false) {
  uuid(projectId);
  // Project row lock serializes membership mutations with ingestion and publication.
  if (lock) await db.query("SELECT id FROM team_projects WHERE id=$1 FOR UPDATE", [projectId]);
  const { rows: [row] } = await db.query(`SELECT m.role,p.owner_id FROM team_members m
    JOIN team_projects p ON p.id=m.project_id JOIN team_users u ON u.id=m.user_id
    WHERE m.project_id=$1 AND m.user_id=$2 AND u.active`, [projectId, user.id]);
  ensure(row, 403, "project_access_revoked");
  if (management) ensure(["project_manager", "technical_director"].includes(row.role), 403, "permission_denied");
  return row;
}

export async function audit(db, user, project, action) {
  await db.query("INSERT INTO team_audit(user_id,project_id,action) VALUES($1,$2,$3)", [user?.id ?? null, project ?? null, action]);
}
