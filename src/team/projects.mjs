import { randomBytes, randomUUID } from "node:crypto";
import { transaction, change } from "./db.mjs";
import { ensure, member, str, uuid, digest, redact, roles, audit } from "./contracts.mjs";

export async function createProject(db, user, input) {
  ensure(user.roles.includes("project_manager"), 403, "permission_denied");
  const name = str(input.name, 120), id = randomUUID();
  return transaction(db, async tx => {
    await tx.query("INSERT INTO team_projects(id,name,owner_id) VALUES($1,$2,$3)", [id, name, user.id]);
    await tx.query("INSERT INTO team_members VALUES($1,$2,'project_manager')", [id, user.id]);
    await audit(tx, user, id, "project.created");
    return { id, name, role: "project_manager", owner_id: user.id };
  });
}

export async function invite(db, user, projectId, input) {
  str(input.name, 32); ensure(roles.includes(input.role));
  return transaction(db, async tx => {
    await member(tx, user, projectId, true, true);
    const { rows: [target] } = await tx.query("SELECT id,roles FROM team_users WHERE name=$1 AND active", [input.name]);
    ensure(target, 404, "user_not_found");
    ensure(target.roles.includes(input.role), 403, "role_not_granted");
    const token = randomBytes(32).toString("base64url"), expires = Date.now() + 72 * 3600_000;
    await tx.query("INSERT INTO team_invites VALUES($1,$2,$3,$4,$5,false,$6)", [digest(token), projectId, target.id, input.role, expires, user.id]);
    await audit(tx, user, projectId, "member.invited");
    return { token, expires };
  });
}

export async function addMember(db, user, projectId, input) {
  uuid(input.userId); ensure(roles.includes(input.role));
  return transaction(db, async tx => {
    await member(tx, user, projectId, true, true);
    const { rows:[target] } = await tx.query("SELECT id,roles FROM team_users WHERE id=$1 AND active", [input.userId]);
    ensure(target, 404, "user_not_found");
    ensure(target.roles.includes(input.role), 403, "role_not_granted");
    await tx.query("INSERT INTO team_members VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [projectId,target.id,input.role]);
    await audit(tx,user,projectId,"member.added");
    return { ok:true };
  });
}

export async function acceptInvite(db, user, input) {
  str(input.token, 200);
  return transaction(db, async tx => {
    const { rows: [inv] } = await tx.query("SELECT * FROM team_invites WHERE hash=$1", [digest(input.token)]);
    ensure(inv && inv.target_id === user.id && !inv.used && Number(inv.expires) > Date.now(), 400, "invalid_invite");
    await tx.query("SELECT id FROM team_projects WHERE id=$1 FOR UPDATE", [inv.project_id]);
    await member(tx, { id: inv.created_by }, inv.project_id, true);
    ensure(user.roles.includes(inv.role), 403, "role_not_granted");
    const used = await tx.query("UPDATE team_invites SET used=true WHERE hash=$1 AND NOT used RETURNING hash", [digest(input.token)]);
    ensure(used.rowCount, 409, "invite_used");
    await tx.query("INSERT INTO team_members VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [inv.project_id, user.id, inv.role]);
    await audit(tx, user, inv.project_id, "member.joined");
    return { projectId: inv.project_id };
  });
}

export async function removeMember(db, user, projectId, targetId) {
  uuid(targetId);
  return transaction(db, async tx => {
    const membership = await member(tx, user, projectId, true, true);
    ensure(membership.owner_id !== targetId, 409, "owner_transfer_required");
    await tx.query("DELETE FROM team_members WHERE project_id=$1 AND user_id=$2", [projectId, targetId]);
    await tx.query("UPDATE team_invites SET used=true WHERE project_id=$1 AND (target_id=$2 OR created_by=$2)", [projectId, targetId]);
    await tx.query(`UPDATE team_jobs SET state='cancelled' WHERE batch_id IN
      (SELECT id FROM team_batches WHERE project_id=$1 AND user_id=$2) AND state NOT IN ('succeeded','cancelled')`, [projectId, targetId]);
    await audit(tx, user, projectId, "member.removed");
    return { ok: true };
  });
}

export async function submitBatch(db, user, projectId, input) {
  uuid(input.operationId); str(input.profile, 100); str(input.session, 200);
  ensure(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= 100);
  const entries = input.entries.map(e => {
    const id = str(e.id, 100); ensure(["user", "assistant"].includes(e.role));
    str(e.text, 12000);
    return { id, role: e.role, text: redact(e.text) };
  });
  ensure(new Set(entries.map(e => e.id)).size === entries.length);
  ensure(JSON.stringify(entries).length <= 48000, 413, "batch_too_large");
  const hash = digest(JSON.stringify({ projectId, profile: input.profile, session: input.session, entries }));
  return transaction(db, async tx => {
    await member(tx, user, projectId, false, true);
    await tx.query(`INSERT INTO team_sources VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [user.id, user.device, input.profile, input.session, projectId]);
    const { rows: [source] } = await tx.query("SELECT project_id FROM team_sources WHERE user_id=$1 AND device=$2 AND profile=$3 AND session=$4", [user.id, user.device, input.profile, input.session]);
    ensure(source.project_id === projectId, 409, "session_project_conflict");
    const batchId = randomUUID(), jobId = randomUUID();
    const inserted = await tx.query(`INSERT INTO team_batches(id,project_id,user_id,device,profile,session,operation_id,input_hash,entries)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,device,operation_id) DO NOTHING RETURNING id`,
    [batchId, projectId, user.id, user.device, input.profile, input.session, input.operationId, hash, JSON.stringify(entries)]);
    if (!inserted.rowCount) {
      const { rows: [existing] } = await tx.query("SELECT b.input_hash,j.id FROM team_batches b LEFT JOIN team_jobs j ON j.batch_id=b.id WHERE b.user_id=$1 AND b.device=$2 AND b.operation_id=$3", [user.id, user.device, input.operationId]);
      ensure(existing?.input_hash === hash, 409, "idempotency_conflict");
      return { jobId: existing.id };
    }
    // A local session belongs to its project/device/profile, independently of the uploader account.
    const { rows:[known] }=await tx.query("SELECT id FROM team_shared_sessions WHERE project_id=$1 AND device=$2 AND profile=$3 AND session=$4 AND merged_into IS NULL",[projectId,user.device,input.profile,input.session]);
    const shared=known ?? (await tx.query(`INSERT INTO team_shared_sessions(id,project_id,user_id,device,profile,session,title)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [randomUUID(),projectId,user.id,user.device,input.profile,input.session,entries[0].text.slice(0,120)])).rows[0];
    const fresh=[];let throughSeq;
    for (const entry of entries) {
      const inserted=await tx.query(`INSERT INTO team_session_messages(session_id,source_id,role,content)
        VALUES($1,$2,$3,$4) ON CONFLICT(session_id,source_id) DO NOTHING RETURNING seq`, [shared.id,entry.id,entry.role,entry.text]);
      if(inserted.rowCount){fresh.push(entry);throughSeq=inserted.rows[0].seq;}
      else {
        const {rows:[existing]}=await tx.query("SELECT role,content FROM team_session_messages WHERE session_id=$1 AND source_id=$2",[shared.id,entry.id]);
        ensure(existing.role===entry.role && existing.content===entry.text,409,"source_content_conflict");
      }
    }
    if(!fresh.length)return {jobId:null,duplicate:true};
    await tx.query("UPDATE team_batches SET entries=$2 WHERE id=$1",[batchId,JSON.stringify(fresh)]);
    await tx.query("INSERT INTO team_jobs(id,batch_id,through_seq) VALUES($1,$2,$3)",[jobId,batchId,throughSeq]);
    await tx.query("UPDATE team_shared_sessions SET updated_at=now() WHERE id=$1",[shared.id]);
    await change(tx,projectId,"session.updated",shared.id,{});
    return { jobId };
  });
}

export async function snapshot(db, user, projectId) {
  return transaction(db, async tx => {
    await member(tx, user, projectId, false, true);
    const { rows: [project] } = await tx.query("SELECT seq,name,description FROM team_projects WHERE id=$1", [projectId]);
    const { rows: memories } = await tx.query("SELECT * FROM team_memories WHERE project_id=$1 AND NOT withdrawn ORDER BY created_at DESC LIMIT 501", [projectId]);
    ensure(memories.length <= 500, 409, "snapshot_capacity_exceeded");
    return { cursor: project.seq, name: project.name, description: project.description ?? "", memories };
  });
}

export async function withdraw(db, user, projectId, memoryId) {
  uuid(memoryId);
  return transaction(db, async tx => {
    const m = await member(tx, user, projectId, false, true);
    ensure(["project_manager", "technical_director"].includes(m.role), 403, "permission_denied");
    const { rows: [memory] } = await tx.query("UPDATE team_memories SET withdrawn=true,version=version+1 WHERE id=$1 AND project_id=$2 AND NOT withdrawn RETURNING id,version", [memoryId, projectId]);
    ensure(memory, 404, "memory_not_found");
    await change(tx, projectId, "memory.deleted", memoryId, memory);
    await audit(tx, user, projectId, "memory.withdrawn");
    return memory;
  });
}
