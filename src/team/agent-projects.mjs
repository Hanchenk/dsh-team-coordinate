import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ensure, str, uuid, member, audit, roles } from "./contracts.mjs";
import { transaction } from "./db.mjs";
import { projectContext } from "./project-context.mjs";

export async function secretKey() {
  const dir=process.env.TEAM_SECRET_DIR ?? path.join(os.homedir(),".dsh-team-hub-secrets");
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,"repository.key");
  try {await fs.writeFile(file,randomBytes(32),{flag:"wx",mode:0o600});} catch(e){if(e.code!=="EEXIST")throw e;}
  const key=await fs.readFile(file);ensure(key.length===32,503,"invalid_secret_key");return key;
}
export async function encryptCredential(value) {
  if(!value)return null;
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",await secretKey(),iv);
  return {iv:iv.toString("base64"),data:Buffer.concat([cipher.update(value,"utf8"),cipher.final()]).toString("base64"),tag:cipher.getAuthTag().toString("base64")};
}
export async function decryptCredential(value) {
  if(!value)return "";
  const cipher=createDecipheriv("aes-256-gcm",await secretKey(),Buffer.from(value.iv,"base64"));
  cipher.setAuthTag(Buffer.from(value.tag,"base64"));return Buffer.concat([cipher.update(Buffer.from(value.data,"base64")),cipher.final()]).toString("utf8");
}
export function repositoryInput(input) {
  const name=str(input.name,40);ensure(/^[a-z][a-z0-9_-]*$/.test(name),400,"invalid_repository_name");
  const url=new URL(str(input.url,1000));
  const hosts=(process.env.TEAM_GITLAB_HOSTS??"gitlab.yemast.com").split(",").map(s=>s.trim());
  ensure(["http:","https:"].includes(url.protocol)&&hosts.includes(url.host)&&!url.username&&!url.password&&!url.search&&!url.hash,400,"gitlab_host_not_allowed");
  ensure(/^\/[\w./-]+\.git$/.test(url.pathname)&&!url.pathname.includes(".."),400,"invalid_repository_url");
  const branch=str(input.branch??"main",200);
  ensure(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)&&!branch.includes("..")&&!branch.includes("//")&&!branch.endsWith("/")&&!branch.endsWith(".")&&!branch.endsWith(".lock"),400,"invalid_branch");
  ensure(input.token===undefined || typeof input.token==="string"&&input.token.length<=4000);
  return {name,url:url.href,branch};
}
export const publicRepository = r => ({id:r.id,name:r.name,url:r.url,branch:r.branch,hasToken:Boolean(r.credential)});
export async function agentProjectRoute(db,user,projectId,action,method,input) {
  if(action==="repositories" && method==="GET")return (await db.query("SELECT * FROM team_repositories WHERE project_id=$1 ORDER BY name",[projectId])).rows.map(publicRepository);
  if(action==="repositories" && method==="POST")return transaction(db,async tx=>{
    await member(tx,user,projectId,true,true);const value=repositoryInput(input),credential=await encryptCredential(input.token);
    const {rows:[row]}=await tx.query("INSERT INTO team_repositories(id,project_id,name,url,branch,credential) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[randomUUID(),projectId,value.name,value.url,value.branch,credential]);
    await audit(tx,user,projectId,"repository.added");return publicRepository(row);
  });
  if(/^repositories\/[^/]+$/.test(action) && method==="DELETE")return transaction(db,async tx=>{
    await member(tx,user,projectId,true,true);await tx.query("DELETE FROM team_repositories WHERE id=$1 AND project_id=$2",[uuid(action.split("/")[1]),projectId]);await audit(tx,user,projectId,"repository.removed");return {ok:true};
  });
  if(action==="agents" && method==="GET")return (await db.query("SELECT id,name,role,instructions FROM team_agent_members WHERE project_id=$1 ORDER BY name",[projectId])).rows;
  if(action==="agents" && method==="POST")return transaction(db,async tx=>{
    await member(tx,user,projectId,true,true);const name=str(input.name,50),instructions=str(input.instructions,4000);
    ensure(/^[a-z][a-z0-9_-]*$/.test(name),400,"invalid_agent_name");ensure(roles.includes(input.role));
    const {rows:[row]}=await tx.query("INSERT INTO team_agent_members VALUES($1,$2,$3,$4,$5) RETURNING id,name,role,instructions",[randomUUID(),projectId,name,input.role,instructions]);
    await audit(tx,user,projectId,"agent.added");return row;
  });
  if(/^agents\/[^/]+$/.test(action)&&method==="DELETE")return transaction(db,async tx=>{
    await member(tx,user,projectId,true,true);await tx.query("DELETE FROM team_agent_members WHERE id=$1 AND project_id=$2",[uuid(action.split("/")[1]),projectId]);await audit(tx,user,projectId,"agent.removed");return {ok:true};
  });
  if(action==="agent-runs" && method==="GET")return (await db.query("SELECT id,title,state,created_at,updated_at,created_by,summary,error FROM team_agent_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100",[projectId])).rows;
  if(action==="agent-runs" && method==="POST")return transaction(db,tx=>queueRun(tx,user,projectId,input));
  const match=action.match(/^agent-runs\/([^/]+)(?:\/(approve|cancel))?$/);
  if(match){
    const id=uuid(match[1]);
    if(method==="GET"&&!match[2]){const {rows:[row]}=await db.query("SELECT id,title,goal,state,definition,summary,error,created_at,updated_at FROM team_agent_runs WHERE id=$1 AND project_id=$2",[id,projectId]);ensure(row,404,"run_not_found");return row;}
    if(method==="POST"&&match[2])return transaction(db,async tx=>{
      const membership=await member(tx,user,projectId,false,true);
      const {rows:[row]}=await tx.query("SELECT * FROM team_agent_runs WHERE id=$1 AND project_id=$2 FOR UPDATE",[id,projectId]);ensure(row,404,"run_not_found");
      ensure(row.created_by===user.id||["project_manager","technical_director"].includes(membership.role),403,"permission_denied");
      ensure(!["completed","failed","cancelled"].includes(row.state),409,"run_finished");
      if(match[2]==="approve")ensure(row.state==="awaiting_approval"&&row.command!=="cancel",409,"plan_not_ready");
      await tx.query("UPDATE team_agent_runs SET command=$2,command_id=$3,updated_at=now() WHERE id=$1",[id,match[2],randomUUID()]);await audit(tx,user,projectId,`agent-run.${match[2]}`);return {ok:true};
    });
  }
  return undefined;
}
export async function queueRun(tx,user,projectId,input){
    await member(tx,user,projectId,false,true);
    const operation=uuid(input.operationId),title=str(input.title,120),goal=str(input.goal,12000);
    ensure(Array.isArray(input.agentIds)&&input.agentIds.length>0&&input.agentIds.length<=16);input.agentIds.forEach(uuid);
    ensure(Array.isArray(input.repositoryIds)&&input.repositoryIds.length<=20);input.repositoryIds.forEach(uuid);
    const {rows:[existing]}=await tx.query("SELECT id FROM team_agent_runs WHERE project_id=$1 AND operation_id=$2 AND created_by=$3",[projectId,operation,user.id]);if(existing)return existing;
    const agents=(await tx.query("SELECT id,name,role,instructions FROM team_agent_members WHERE project_id=$1 AND id=ANY($2::uuid[])",[projectId,input.agentIds])).rows;
    const repositories=(await tx.query("SELECT id,name,url,branch FROM team_repositories WHERE project_id=$1 AND id=ANY($2::uuid[])",[projectId,input.repositoryIds])).rows;
    ensure(agents.length===new Set(input.agentIds).size&&repositories.length===new Set(input.repositoryIds).size,400,"invalid_project_selection");
    const {rows:[configured]}=await tx.query("SELECT value FROM team_settings WHERE key='agent-model'");ensure(configured?.value?.name&&configured.value.baseUrl,409,"agent_model_not_configured");
    const id=randomUUID();await tx.query("INSERT INTO team_agent_runs(id,project_id,created_by,operation_id,title,goal,definition) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,projectId,user.id,operation,title,goal,{agents,repositories}]);
    const context=await projectContext(tx,projectId,id,agents);
    await tx.query("UPDATE team_agent_runs SET definition=definition || $2::jsonb WHERE id=$1",[id,JSON.stringify({context})]);
    await audit(tx,user,projectId,"agent-run.created");return {id};
}
