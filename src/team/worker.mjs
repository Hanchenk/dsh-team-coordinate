import { randomUUID } from "node:crypto";
import { transaction, change } from "./db.mjs";
import { digest } from "./contracts.mjs";
import { organize } from "./model.mjs";
import { readModel } from "./settings.mjs";

export function startWorker(db, config, { intervalMs = 2000, generate = organize } = {}) {
  const abort = new AbortController(); let pending = null;
  async function tick() {
    if (pending || abort.signal.aborted) return;
    pending = (async () => { const current = await readModel(db, config); if (current.baseUrl && current.name) await run(current); })().catch(error => { console.error("Team worker failed",error.code ?? error.name); }).finally(() => { pending = null; });
    await pending;
  }
  async function run(config) {
    const lease = randomUUID(), now = Date.now();
    await db.query("UPDATE team_jobs SET state='failed',error='worker_lease_expired' WHERE state='running' AND lease_until<$1 AND attempts>=4", [now]);
    const { rows: [job] } = await db.query(`UPDATE team_jobs SET state='running',attempts=attempts+1,lease_id=$1,lease_until=$2
      WHERE id=(SELECT id FROM team_jobs WHERE attempts<4 AND
      ((state IN ('queued','retry_wait') AND available_at<=$3) OR (state='running' AND lease_until<$3))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [lease, now + config.timeoutMs + 30000, now]);
    if (!job) return;
    const { rows: [batch] } = await db.query("SELECT * FROM team_batches WHERE id=$1", [job.batch_id]);
    try {
      const allowed = await db.query("SELECT m.user_id FROM team_members m JOIN team_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND u.active", [batch.project_id, batch.user_id]);
      if (!allowed.rowCount) { await db.query("UPDATE team_jobs SET state='cancelled' WHERE id=$1 AND lease_id=$2", [job.id, lease]); return; }
      const entries = await conversationContext(db,batch,job.through_seq);
      const result = await generate(entries, config, abort.signal);
      await transaction(db, async tx => {
        await tx.query("SELECT id FROM team_projects WHERE id=$1 FOR UPDATE", [batch.project_id]);
        const { rows: [current] } = await tx.query("SELECT state,lease_id FROM team_jobs WHERE id=$1 FOR UPDATE", [job.id]);
        if (current.state !== "running" || current.lease_id !== lease) return;
        const membership = await tx.query("SELECT m.user_id FROM team_members m JOIN team_users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.user_id=$2 AND u.active", [batch.project_id, batch.user_id]);
        if (!membership.rowCount) { await tx.query("UPDATE team_jobs SET state='cancelled' WHERE id=$1", [job.id]); return; }
        await tx.query("INSERT INTO team_summaries(batch_id,project_id,content) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [batch.id, batch.project_id, result.summary]);
        for (const m of result.memories) {
          const { rows: [memory] } = await tx.query(`INSERT INTO team_memories(id,project_id,batch_id,title,content,category,evidence,source_ids,content_hash)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(project_id,content_hash) DO NOTHING RETURNING *`,
          [randomUUID(), batch.project_id, batch.id, m.title, m.content, m.category, m.evidence, JSON.stringify(m.sourceIds), digest(JSON.stringify([m.title, m.content, m.category, m.evidence]))]);
          if (memory) await change(tx, batch.project_id, "memory.upsert", memory.id, memory);
        }
        await tx.query("UPDATE team_jobs SET state='succeeded',error=NULL,model=$2 WHERE id=$1", [job.id, config.name]);
        await change(tx,batch.project_id,"session.organized",batch.id,{});
      });
    } catch (error) {
      await db.query(`UPDATE team_jobs SET state=$2,error=$3,available_at=$4,attempts=attempts-$6 WHERE id=$1 AND state='running' AND lease_id=$5`,
      [job.id, abort.signal.aborted ? "retry_wait" : job.attempts >= 4 ? "failed" : "retry_wait",
        error.code?.startsWith?.("model_") ? error.code : "model_generation_failed", Date.now() + Math.min(60000, 2000 * 2 ** job.attempts), lease, abort.signal.aborted ? 1 : 0]);
    }
  }
  const timer = setInterval(tick, intervalMs); timer.unref(); void tick();
  return { tick, async close() { clearInterval(timer); abort.abort(); await pending; } };
}

export async function conversationContext(db,batch,throughSeq) {
  const {rows:[session]}=await db.query("SELECT id FROM team_shared_sessions WHERE project_id=$1 AND device=$2 AND profile=$3 AND session=$4 AND merged_into IS NULL",[batch.project_id,batch.device,batch.profile,batch.session]);
  if(!session)return batch.entries;
  const cutoff=throughSeq ?? (await db.query("SELECT max(seq) AS seq FROM team_session_messages WHERE session_id=$1 AND source_id=ANY($2::text[])",[session.id,batch.entries.map(e=>e.id)])).rows[0].seq;
  const {rows}=await db.query("SELECT source_id AS id,role,content AS text FROM team_session_messages WHERE session_id=$1 AND seq<=$2 ORDER BY seq DESC LIMIT 100",[session.id,cutoff]);
  const entries=[];let size=2;
  for(const entry of rows){const bytes=JSON.stringify(entry).length+1;if(size+bytes>48000)break;entries.unshift(entry);size+=bytes;}
  return entries.length?entries:batch.entries;
}
