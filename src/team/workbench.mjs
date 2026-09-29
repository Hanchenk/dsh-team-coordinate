import { randomUUID,createHash } from "node:crypto";
import { ensure,str,uuid,member,audit } from "./contracts.mjs";
import { transaction } from "./db.mjs";
import { expertCatalog,expertMembers,validateSkills } from "./project-context.mjs";
import { queueRun } from "./agent-projects.mjs";
const optional=(v,max)=>v==null||v===""?"":str(v,max);
const managers=["project_manager","technical_director"];
const states=["todo","doing","paused","done"];
function date(v){if(!v)return null;ensure(Number.isFinite(Date.parse(v)),400,"invalid_date");return new Date(v).toISOString();}
const filename=v=>{const name=str(v,180);ensure(!/[\x00-\x1f/\\]/.test(name)&&![".",".."].includes(name));return name;};
export async function workbenchRoute(db,user,projectId,action,method,input){
  const access=await member(db,user,projectId);
  if(action==="workbench/catalog"&&method==="GET")return expertCatalog;
  if(action==="workbench/config"&&method==="GET")return (await db.query("SELECT * FROM team_project_config WHERE project_id=$1",[projectId])).rows[0]??{instructions:"",skills:[],version:0};
  if(action==="workbench/config"&&method==="POST")return transaction(db,async tx=>{
    await member(tx,user,projectId,true,true);const instructions=optional(input.instructions,12000),skills=validateSkills(input.skills);
    const existing=(await tx.query("SELECT version FROM team_project_config WHERE project_id=$1",[projectId])).rows[0];
    ensure((existing?.version??0)===input.version,409,"edit_conflict");
    await tx.query("INSERT INTO team_project_config(project_id,instructions,skills) VALUES($1,$2,$3) ON CONFLICT(project_id) DO UPDATE SET instructions=$2,skills=$3,version=team_project_config.version+1",[projectId,instructions,JSON.stringify(skills)]);
    await audit(tx,user,projectId,"project.configured");return {ok:true};
  });
  if(action==="workbench/experts"&&method==="POST")return transaction(db,async tx=>{
    await member(tx,user,projectId,true,true);const group=expertCatalog.find(g=>g.id===input.groupId);ensure(group,404,"unknown_expert");
    ensure(Array.isArray(input.memberIds)&&input.memberIds.length<=16);
    const picks=input.memberIds.length?expertMembers(group).filter(m=>input.memberIds.includes(m.id)):[{id:"lead",name:group.name,file:"SKILL.md"}];
    ensure(!input.memberIds.length||picks.length===new Set(input.memberIds).size);
    const prefix=createHash("sha256").update(group.id).digest("hex").slice(0,6),ids=[];
    for(const m of picks){
      const name=`wb-${prefix}-${m.id}`.slice(0,50),role=/qa|quality|test/.test(m.id)?"qa_engineer":/product|requirement|roadmap/.test(m.id)?"product_manager":"developer";
      const instructions=`Expert bundle: ${group.id}\n你是 ${m.name}。先读取 /control/skills/${group.id}/${m.file}，按专业职责和 SOP 产出。成员调度只使用本任务已有的 AgentTeams 工具和团队，不调用 WorkBuddy 的 TeamCreate/Agent/SendMessage，不另建团队。专业结论和交付文件回传队长。`;
      const {rows:[agent]}=await tx.query("INSERT INTO team_agent_members(id,project_id,name,role,instructions) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,name) DO UPDATE SET instructions=excluded.instructions RETURNING id",[randomUUID(),projectId,name,role,instructions]);ids.push(agent.id);
    }
    const config=(await tx.query("SELECT skills FROM team_project_config WHERE project_id=$1",[projectId])).rows[0];
    const skills=[...new Set([...(config?.skills??[]),group.id])];ensure(skills.length<=12,400,"skill_limit");
    await tx.query("INSERT INTO team_project_config(project_id,skills) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET skills=$2,version=team_project_config.version+1",[projectId,JSON.stringify(skills)]);
    await audit(tx,user,projectId,"expert.imported");return {agentIds:ids};
  });
  if(action==="workbench/activity"&&method==="GET")return (await db.query(`
    SELECT a.id::text AS id,a.action,a.created_at,u.name,'' AS title FROM team_audit a LEFT JOIN team_users u ON u.id=a.user_id WHERE a.project_id=$1
    UNION ALL SELECT s.id::text,'session.updated',s.updated_at,u.name,s.title FROM team_shared_sessions s JOIN team_users u ON u.id=s.user_id WHERE s.project_id=$1 AND s.merged_into IS NULL
    ORDER BY created_at DESC LIMIT 100`,[projectId])).rows;
  if(action==="workbench/items"&&method==="GET")return (await db.query(`SELECT i.*,u.name AS assignee_name,r.state AS run_state FROM team_work_items i LEFT JOIN team_users u ON u.id=i.assignee LEFT JOIN team_agent_runs r ON r.id=i.run_id WHERE i.project_id=$1 AND (i.visibility='shared' OR i.created_by=$2) ORDER BY i.created_at DESC LIMIT 500`,[projectId,user.id])).rows;
  if(action==="workbench/items"&&method==="POST")return transaction(db,async tx=>{
    await member(tx,user,projectId,false,true);const id=randomUUID(),title=str(input.title,120),description=optional(input.description,12000),visibility=input.visibility??"shared",state=input.state??"todo";
    ensure(["shared","private"].includes(visibility)&&states.includes(state));const assignee=input.assignee?uuid(input.assignee):null;
    if(assignee)await member(tx,{id:assignee},projectId);
    ensure(visibility!=="private"||!assignee||assignee===user.id);
    await tx.query("INSERT INTO team_work_items(id,project_id,created_by,title,description,state,visibility,assignee,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,projectId,user.id,title,description,state,visibility,assignee,date(input.dueAt)]);
    if(visibility==="shared")await audit(tx,user,projectId,"plan.created");return {id};
  });
  const itemMatch=action.match(/^workbench\/items\/([^/]+)(?:\/(run))?$/);
  if(itemMatch&&["POST","DELETE"].includes(method))return transaction(db,async tx=>{
    await member(tx,user,projectId,false,true);const {rows:[item]}=await tx.query("SELECT * FROM team_work_items WHERE id=$1 AND project_id=$2 FOR UPDATE",[uuid(itemMatch[1]),projectId]);
    ensure(item&&(item.visibility==="shared"||item.created_by===user.id),404,"item_not_found");
    ensure(item.created_by===user.id||item.assignee===user.id||managers.includes(access.role),403,"permission_denied");
    ensure(item.version===input.version,409,"edit_conflict");
    if(itemMatch[2]){
      ensure(item.visibility==="shared",409,"share_before_run");
      ensure(!item.run_id||["completed","failed","cancelled"].includes((await tx.query("SELECT state FROM team_agent_runs WHERE id=$1",[item.run_id])).rows[0]?.state),409,"run_already_active");
      const run=await queueRun(tx,user,projectId,{...input,title:item.title,goal:item.description||item.title});
      await tx.query("UPDATE team_work_items SET run_id=$2,state='doing',version=version+1,updated_at=now() WHERE id=$1",[item.id,run.id]);return run;
    }
    if(method==="DELETE")await tx.query("DELETE FROM team_work_items WHERE id=$1",[item.id]);
    else{const state=input.state??item.state;ensure(states.includes(state));const visibility=input.visibility??item.visibility;ensure(["shared","private"].includes(visibility));ensure(visibility===item.visibility||item.created_by===user.id);ensure(!item.run_id||visibility==="shared");
      const assignee=input.assignee===undefined?item.assignee:input.assignee?uuid(input.assignee):null;if(assignee)await member(tx,{id:assignee},projectId);ensure(visibility!=="private"||!assignee||assignee===item.created_by);
      await tx.query("UPDATE team_work_items SET title=$2,description=$3,state=$4,visibility=$5,assignee=$6,due_at=$7,version=version+1,updated_at=now() WHERE id=$1",[item.id,input.title===undefined?item.title:str(input.title,120),input.description===undefined?item.description:optional(input.description,12000),state,visibility,assignee,input.dueAt===undefined?item.due_at:date(input.dueAt)]);
    }
    if(item.visibility==="shared")await audit(tx,user,projectId,"plan.updated");return {ok:true};
  });
  if(action==="workbench/assets"&&method==="GET")return (await db.query("SELECT id,parent_id,name,folder,octet_length(content) AS size,created_by,updated_at FROM team_assets WHERE project_id=$1 ORDER BY folder DESC,name",[projectId])).rows;
  if(action==="workbench/assets"&&method==="POST")return transaction(db,async tx=>{
    await member(tx,user,projectId,false,true);const name=filename(input.name),parent=input.parentId?uuid(input.parentId):null,folder=input.folder===true;
    if(parent)ensure((await tx.query("SELECT 1 FROM team_assets WHERE id=$1 AND project_id=$2 AND folder",[parent,projectId])).rowCount,400,"invalid_folder");
    ensure(!(await tx.query("SELECT 1 FROM team_assets WHERE project_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND name=$3",[projectId,parent,name])).rowCount,409,"already_exists");
    ensure(folder||typeof input.base64==="string"&&input.base64.length<=7_000_000);
    const content=folder?null:Buffer.from(input.base64,"base64");ensure(folder||content.toString("base64")===input.base64,400,"invalid_file_data");ensure(folder||content.length<=5*1024*1024,413,"asset_too_large");
    const size=Number((await tx.query("SELECT coalesce(sum(octet_length(content)),0) AS size,count(*) AS count FROM team_assets WHERE project_id=$1",[projectId])).rows[0].size);
    ensure(size+(content?.length??0)<=100*1024*1024,413,"asset_quota_exceeded");
    ensure(Number((await tx.query("SELECT count(*) FROM team_assets WHERE project_id=$1",[projectId])).rows[0].count)<1000,413,"asset_quota_exceeded");
    const id=randomUUID();await tx.query("INSERT INTO team_assets(id,project_id,parent_id,name,folder,content,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,projectId,parent,name,folder,content,user.id]);await audit(tx,user,projectId,"asset.added");return {id};
  });
  const assetMatch=action.match(/^workbench\/assets\/([^/]+)$/);
  if(assetMatch){const {rows:[asset]}=await db.query("SELECT * FROM team_assets WHERE id=$1 AND project_id=$2",[uuid(assetMatch[1]),projectId]);ensure(asset,404,"asset_not_found");
    if(method==="GET"){ensure(!asset.folder);return {name:asset.name,base64:asset.content.toString("base64")};}
    if(method==="DELETE")return transaction(db,async tx=>{await member(tx,user,projectId,false,true);ensure(asset.created_by===user.id||managers.includes(access.role),403,"permission_denied");ensure(!(await tx.query("SELECT 1 FROM team_assets WHERE parent_id=$1",[asset.id])).rowCount,409,"folder_not_empty");await tx.query("DELETE FROM team_assets WHERE id=$1",[asset.id]);await audit(tx,user,projectId,"asset.removed");return {ok:true};});
  }
  if(action==="workbench/automations"&&method==="GET")return (await db.query("SELECT * FROM team_automations WHERE project_id=$1 ORDER BY created_at DESC",[projectId])).rows;
  if(action==="workbench/automations"&&method==="POST")return transaction(db,async tx=>{
    await member(tx,user,projectId,true,true);ensure(input.autoApprove===true,400,"automation_approval_required");ensure(Number.isInteger(input.intervalMinutes)&&input.intervalMinutes>=5&&input.intervalMinutes<=10080);ensure(Array.isArray(input.agentIds)&&input.agentIds.length>0&&input.agentIds.length<=16&&Array.isArray(input.repositoryIds)&&input.repositoryIds.length<=20);input.agentIds.forEach(uuid);input.repositoryIds.forEach(uuid);
    ensure((await tx.query("SELECT 1 FROM team_agent_members WHERE project_id=$1 AND id=ANY($2::uuid[])",[projectId,input.agentIds])).rowCount===new Set(input.agentIds).size);ensure((await tx.query("SELECT 1 FROM team_repositories WHERE project_id=$1 AND id=ANY($2::uuid[])",[projectId,input.repositoryIds])).rowCount===new Set(input.repositoryIds).size);
    const id=randomUUID();await tx.query("INSERT INTO team_automations(id,project_id,created_by,title,goal,agent_ids,repository_ids,interval_minutes,next_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,projectId,user.id,str(input.title,120),str(input.goal,12000),JSON.stringify(input.agentIds),JSON.stringify(input.repositoryIds),input.intervalMinutes,date(input.nextAt)??new Date(Date.now()+input.intervalMinutes*60000)]);await audit(tx,user,projectId,"automation.created");return {id};
  });
  const autoMatch=action.match(/^workbench\/automations\/([^/]+)$/);
  if(autoMatch&&["POST","DELETE"].includes(method))return transaction(db,async tx=>{await member(tx,user,projectId,true,true);const id=uuid(autoMatch[1]);if(method==="DELETE")await tx.query("DELETE FROM team_automations WHERE id=$1 AND project_id=$2",[id,projectId]);else{ensure(typeof input.enabled==="boolean");await tx.query("UPDATE team_automations SET enabled=$3,error=NULL,next_at=greatest(next_at,now()) WHERE id=$1 AND project_id=$2",[id,projectId,input.enabled]);}await audit(tx,user,projectId,"automation.updated");return {ok:true};});
  return undefined;
}

export async function automationTick(db){
  const due=(await db.query("SELECT id FROM team_automations WHERE enabled AND next_at<=now() ORDER BY next_at LIMIT 10")).rows;
  for(const {id} of due){
    try{await transaction(db,async tx=>{
      const {rows:[a]}=await tx.query("SELECT * FROM team_automations WHERE id=$1 AND enabled AND next_at<=now() FOR UPDATE SKIP LOCKED",[id]);if(!a)return;
      await member(tx,{id:a.created_by},a.project_id,true);
      const active=a.last_run?(await tx.query("SELECT state FROM team_agent_runs WHERE id=$1",[a.last_run])).rows[0]:null;
      if(active&&!["completed","failed","cancelled"].includes(active.state)){await tx.query("UPDATE team_automations SET next_at=now()+interval '1 minute' WHERE id=$1",[id]);return;}
      const run=await queueRun(tx,{id:a.created_by},a.project_id,{title:a.title,goal:a.goal,agentIds:a.agent_ids,repositoryIds:a.repository_ids,operationId:randomUUID()});
      await tx.query("UPDATE team_agent_runs SET definition=definition || '{\"autoApprove\":true}'::jsonb WHERE id=$1",[run.id]);
      await tx.query("UPDATE team_automations SET last_run=$2,next_at=now()+interval_minutes*interval '1 minute',error=NULL WHERE id=$1",[id,run.id]);
    });}catch(error){await db.query("UPDATE team_automations SET error=$2,enabled=false WHERE id=$1",[id,`${error.code??error.message}`.slice(0,120)]);}
  }
}
