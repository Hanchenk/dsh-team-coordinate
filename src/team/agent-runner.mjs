import http from "node:http";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { database, migrate } from "./db.mjs";
import { decryptCredential, repositoryInput } from "./agent-projects.mjs";
import { redact } from "./contracts.mjs";
import { readModel } from "./settings.mjs";
import { automationTick } from "./workbench.mjs";
import { validateSkills } from "./project-context.mjs";
import { publishRunOutputs } from "./run-deliverables.mjs";
const exec=promisify(execFile);
const root=process.env.TEAM_RUN_DIR??"/var/lib/team-runs";
const volume=process.env.TEAM_RUN_VOLUME??"dsh-team-agent-data";
const image=process.env.TEAM_RUN_IMAGE??"dsh-team-agent-runtime:rc1";
const network=process.env.TEAM_RUN_NETWORK??"dsh-team_default";
const containerName=id=>`dsh-team-run-${id}`;
export function dockerRequest(route,method="GET",body) {
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath:process.env.DOCKER_SOCKET??"/var/run/docker.sock",path:"/v1.47"+route,method,headers:{"content-type":"application/json"}},res=>{
      const chunks=[];let size=0;
      res.on("data",chunk=>{size+=chunk.length;if(size>2_000_000){res.destroy();reject(new Error("docker_response_too_large"));}else chunks.push(chunk);});
      res.on("end",()=>{let value;try{const raw=Buffer.concat(chunks).toString();value=raw?JSON.parse(raw):{};}catch{reject(new Error("invalid_docker_response"));return;}
        if(res.statusCode>=400){const e=new Error(`docker_${res.statusCode}`);e.status=res.statusCode;reject(e);}else resolve(value);});res.on("error",reject);
    });req.setTimeout(30000,()=>req.destroy(new Error("docker_timeout")));req.on("error",reject);req.end(body?JSON.stringify(body):undefined);
  });
}
async function atomic(file,value){const temp=file+".tmp";await fs.writeFile(temp,JSON.stringify(value),{mode:0o600});await fs.rename(temp,file);}
async function inspect(id){try{return await dockerRequest(`/containers/${containerName(id)}/json`);}catch(e){if(e.status===404)return null;throw e;}}
async function statusFile(id){
  let handle;
  try {handle=await fs.open(path.join(root,id,"workspace",".team-status.json"),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();if(!stat.isFile()||stat.size>240000)return {invalid:true};return JSON.parse(await handle.readFile("utf8"));}
  catch(e){if(e.code==="ENOENT"||e instanceof SyntaxError)return {};return {invalid:true};}
  finally{await handle?.close();}
}
function sanitize(value){if(typeof value==="string")return redact(value);if(Array.isArray(value))return value.map(sanitize);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)]));return value;}
async function prepare(db,run) {
  const dir=path.join(root,run.id),workspace=path.join(dir,"workspace"),control=path.join(dir,"control");
  await fs.mkdir(path.join(workspace,"repos"),{recursive:true});await fs.mkdir(path.join(workspace,"deliverables"),{recursive:true});await fs.mkdir(control,{recursive:true});
  for(const skill of run.definition.context?.skills??[]){
    validateSkills([skill]);
    await fs.cp(new URL(`./expert-pack/${skill}/`,import.meta.url),path.join(control,"skills",skill),{recursive:true});
  }
  await fs.mkdir(path.join(control,"assets"),{recursive:true});
  for(const asset of (await db.query("SELECT asset_id,name,content FROM team_run_assets WHERE run_id=$1",[run.id])).rows){
    await fs.writeFile(path.join(control,"assets",asset.asset_id),asset.content,{mode:0o600});
  }
  const commits=[];
  for(const repo of run.definition.repositories){
    repositoryInput(repo);
    const {rows:[current]}=await db.query("SELECT credential,url FROM team_repositories WHERE id=$1 AND project_id=$2",[repo.id,run.project_id]);
    if(!current||current.url!==repo.url)throw new Error("repository_removed_or_changed");
    const token=await decryptCredential(current.credential),env={PATH:process.env.PATH,HOME:"/tmp",GIT_TERMINAL_PROMPT:"0",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"};
    if(token)Object.assign(env,{GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:`http.${repo.url}.extraHeader`,GIT_CONFIG_VALUE_0:`Authorization: Basic ${Buffer.from("oauth2:"+token).toString("base64")}`});
    const target=path.join(workspace,"repos",repo.name);
    try {await exec("git",["-c","http.followRedirects=false","clone","--single-branch","--branch",repo.branch,"--",repo.url,target],{env,timeout:120000,maxBuffer:100000});}catch{throw new Error(`repository_clone_failed:${repo.name}`);}
    const {stdout}=await exec("git",["-C",target,"rev-parse","HEAD"],{env,timeout:10000});commits.push({...repo,commit:stdout.trim()});
  }
  const model=await readModel(db,{},"agent-model");if(!model.name||!model.baseUrl)throw new Error("agent_model_not_configured");
  const {rows:[permission]}=await db.query("SELECT r.command,EXISTS(SELECT 1 FROM team_members m JOIN team_users u ON u.id=m.user_id WHERE m.project_id=r.project_id AND m.user_id=r.created_by AND u.active) AS authorized FROM team_agent_runs r WHERE r.id=$1",[run.id]);
  if(!permission?.authorized||permission.command==="cancel")throw new Error("run_cancelled");
  await atomic(path.join(control,"job.json"),{id:run.id,title:run.title,goal:run.goal,definition:{...run.definition,repositories:commits},model:{name:model.name,baseUrl:model.baseUrl},maxRequests:200,maxDurationMs:3600000});
  // Only the model credential enters the task container. GitLab and database credentials stay in the supervisor.
  await dockerRequest(`/containers/create?name=${containerName(run.id)}`,"POST",{
    Image:image,User:"1000:1000",WorkingDir:"/workspace",Env:[`TEAM_AGENT_MODEL_KEY=${model.apiKey??""}`,"DSH_TELEMETRY_DISABLED=1"],Labels:{"dsh-team.run":run.id},
    HostConfig:{NetworkMode:network,ReadonlyRootfs:true,CapDrop:["ALL"],SecurityOpt:["no-new-privileges:true"],Memory:4*1024**3,NanoCpus:2e9,PidsLimit:256,AutoRemove:false,
      Tmpfs:{"/tmp":"rw,nosuid,size=256m"},Mounts:[
        {Type:"volume",Source:volume,Target:"/workspace",VolumeOptions:{Subpath:`${run.id}/workspace`}},
        {Type:"volume",Source:volume,Target:"/control",ReadOnly:true,VolumeOptions:{Subpath:`${run.id}/control`}}
      ]}
  });
  await db.query("UPDATE team_agent_runs SET state='planning',summary=$2,updated_at=now() WHERE id=$1",[run.id,{repositories:commits}]);
  await dockerRequest(`/containers/${containerName(run.id)}/start`,"POST");
}
export async function runnerTick(db) {
  await automationTick(db);
  const runs=(await db.query("SELECT r.*,EXISTS(SELECT 1 FROM team_members m JOIN team_users u ON u.id=m.user_id WHERE m.project_id=r.project_id AND m.user_id=r.created_by AND u.active) AS authorized FROM team_agent_runs r WHERE state NOT IN ('completed','failed','cancelled') ORDER BY created_at")).rows;
  let active=runs.filter(r=>r.state!=="queued").length;
  for(const run of runs){
    const info=await inspect(run.id);
    if(run.command==="cancel"||!run.authorized){
      if(info?.State.Running)await dockerRequest(`/containers/${containerName(run.id)}/stop?t=10`,"POST");
      await db.query("UPDATE team_agent_runs SET state='cancelled',command=NULL,updated_at=now() WHERE id=$1",[run.id]);continue;
    }
    if(info){
      if(info.State.Status==="created"){await dockerRequest(`/containers/${containerName(run.id)}/start`,"POST");continue;}
      if(run.command==="approve")await atomic(path.join(root,run.id,"control","command.json"),{id:run.command_id,action:"approve"});
      const status=await statusFile(run.id);
      if(info.State.Running&&(status.invalid||Date.now()-Date.parse(info.State.StartedAt)>3600000)){
        await dockerRequest(`/containers/${containerName(run.id)}/stop?t=5`,"POST");
        await db.query("UPDATE team_agent_runs SET state='failed',error=$2,updated_at=now() WHERE id=$1",[run.id,status.invalid?"invalid_activity_file":"agent_run_timeout"]);continue;
      }
      const states=["planning","awaiting_approval","running","completed","failed"];
      let state=states.includes(status.state)?status.state:run.state;
      if(!info.State.Running)state=info.State.ExitCode===0&&status.state==="completed"?"completed":"failed";
      else if(["completed","failed"].includes(state))state="running";
      const summary=sanitize({...run.summary,...status});
      if(!info.State.Running&&["completed","failed"].includes(state)){
        const outputAssetIds=await publishRunOutputs(db,run,summary,path.join(root,run.id,"workspace"));
        Object.assign(summary,{assetsPublished:true,outputAssetIds});
      }
      await db.query("UPDATE team_agent_runs SET state=$2,summary=$3,error=$4,command=CASE WHEN command_id::text=$5 THEN NULL ELSE command END,updated_at=now() WHERE id=$1",[run.id,state,summary,status.error??(!info.State.Running&&state==="failed"?"executor_stopped":null),status.commandId??""]);continue;
    }
    if(run.state!=="queued"){
      await db.query("UPDATE team_agent_runs SET state='failed',error='executor_missing',updated_at=now() WHERE id=$1",[run.id]);continue;
    }
    if(active>=Number(process.env.TEAM_RUN_CONCURRENCY??2))continue;
    active++;
    await db.query("UPDATE team_agent_runs SET state='preparing',updated_at=now() WHERE id=$1",[run.id]);
    try{await prepare(db,run);}catch(error){await db.query("UPDATE team_agent_runs SET state=$3,error=$2,updated_at=now() WHERE id=$1",[run.id,redact(error.message).slice(0,200),error.message==="run_cancelled"?"cancelled":"failed"]);}
  }
  await db.query("UPDATE team_work_items i SET state=CASE WHEN r.state='completed' THEN 'done' ELSE 'paused' END,version=i.version+1,updated_at=now() FROM team_agent_runs r WHERE i.run_id=r.id AND i.state='doing' AND r.state IN ('completed','failed','cancelled')");
}
async function main(){
  const db=database();await migrate(db);await fs.mkdir(root,{recursive:true});
  const lock=await db.connect();const {rows:[row]}=await lock.query("SELECT pg_try_advisory_lock(907114) AS acquired");if(!row.acquired)throw new Error("agent_supervisor_already_running");
  let stopped=false;process.once("SIGTERM",()=>{stopped=true;});process.once("SIGINT",()=>{stopped=true;});lock.on("error",()=>{stopped=true;});
  const beat=()=>db.query("INSERT INTO team_settings VALUES('agent-supervisor',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[{heartbeat:Date.now()}]).catch(()=>{stopped=true;});
  await beat();const heartbeat=setInterval(()=>{void beat();},10000);
  console.log("Agent supervisor ready; task containers survive Desktop disconnects and supervisor restarts.");
  try{while(!stopped){await runnerTick(db).catch(error=>console.error("Agent supervisor:",error.message));await new Promise(r=>setTimeout(r,2000));}}finally{clearInterval(heartbeat);lock.release();await db.end();}
}
if(process.argv[1]===new URL(import.meta.url).pathname)await main();
