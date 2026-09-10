import pg from "pg";
import fs from "node:fs/promises";

export function database(url = process.env.TEAM_DATABASE_URL) {
  if (!url && !process.env.PGHOST) throw new Error("Set TEAM_DATABASE_URL or PostgreSQL PGHOST/PGUSER/PGPASSWORD/PGDATABASE");
  return new pg.Pool({ connectionString: url, max: 8 });
}

export async function migrate(db) {
  const sql = await fs.readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await transaction(db, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(784412)");
    await tx.query(sql);
  });
}

export async function transaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function change(tx, projectId, kind, id, payload) {
  const { rows: [project] } = await tx.query("UPDATE team_projects SET seq=seq+1 WHERE id=$1 RETURNING seq", [projectId]);
  await tx.query("INSERT INTO team_changes VALUES($1,$2,$3,$4,$5)", [projectId, project.seq, kind, id, JSON.stringify(payload)]);
}
