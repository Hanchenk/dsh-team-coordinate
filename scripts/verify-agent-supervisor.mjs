import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { database,migrate } from "../src/team/db.mjs";
import { createUser } from "../src/team/auth.mjs";
const exec=promisify(execFile),id=randomUUID(),schema="supervisor_"+id.replaceAll("-","");
const admin=database(process.env.TEAM_TEST_DATABASE_URL);await admin.query(`CREATE SCHEMA ${schema}`);
const url=new URL(process.env.TEAM_TEST_DATABASE_URL);url.searchParams.set("options",`-c search_path=${schema}`);const db=database(url.href);await migrate(db);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),"team-git-test-"));
for(const name of ["frontend","backend"]){
  const source=path.join(dir,name);await fs.mkdir(source);await exec("git",["init","-b","main",source]);await fs.writeFile(path.join(source,"README.md"),name+" fixture\n");await exec("git",["-C",source,"add","README.md"]);await exec("git",["-C",source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","Fixture"]);await exec("git",["clone","--bare",source,path.join(dir,name+".git")]);await exec("git",["--git-dir",path.join(dir,name+".git"),"update-server-info"]);
}
const server=http.createServer(async(req,res)=>{
  if(req.method==="POST"){
    for await(const _ of req){}res.setHeader("content-type","text/event-stream");
    const chunk={id:"fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta:{role:"assistant",content:"The staged team is ready."},finish_reason:null}]};res.write("data: "+JSON.stringify(chunk)+"\n\n");chunk.choices[0]={index:0,delta:{},finish_reason:"stop"};res.end("data: "+JSON.stringify(chunk)+"\n\ndata: [DONE]\n\n");return;
  }
  try{const p=new URL(req.url,"http://fixture").pathname;assert.ok(!p.includes(".."));res.end(await fs.readFile(path.join(dir,p)));}catch{res.statusCode=404;res.end();}
});await new Promise(r=>server.listen(0,"0.0.0.0",r));
const host=`host.docker.internal:${server.address().port}`,project=randomUUID(),supervisor="team-supervisor-test-"+id,volume="team-agent-test-"+id,runName="dsh-team-run-"+id;
const user=await createUser(db,{name:"manager",password:"fixture-password",assignedRoles:["project_manager"]});
await db.query("INSERT INTO team_projects(id,name,owner_id) VALUES($1,'Fixture',$2)",[project,user.id]);await db.query("INSERT INTO team_members VALUES($1,$2,'project_manager')",[project,user.id]);
const repositories=[];for(const name of ["frontend","backend"]){const repo={id:randomUUID(),name,url:`http://${host}/${name}.git`,branch:"main"};repositories.push(repo);await db.query("INSERT INTO team_repositories VALUES($1,$2,$3,$4,$5,NULL)",[repo.id,project,name,repo.url,repo.branch]);}
await db.query("INSERT INTO team_settings VALUES('agent-model',$1)",[{name:"fixture",baseUrl:`http://${host}/v1`,apiKey:"test"}]);
const assetId=randomUUID();
await db.query("INSERT INTO team_agent_runs(id,project_id,created_by,operation_id,title,goal,definition) VALUES($1,$2,$3,$4,'Fixture','Prepare a plan',$5)",[id,project,user.id,randomUUID(),{agents:[{name:"engineer",role:"developer",instructions:"Plan the work"}],repositories,context:{instructions:"Follow the fixture contract",skills:["mvp-dev-skills-dsh"],assets:[{id:assetId,name:"contract.txt"}]}}]);
await db.query("INSERT INTO team_run_assets VALUES($1,$2,'contract.txt',$3)",[id,assetId,Buffer.from("immutable project contract")]);
const inside=new URL(url);inside.hostname="host.docker.internal";
const waitState=async target=>{
  let row;
  for(let i=0;i<120;i++){row=(await db.query("SELECT * FROM team_agent_runs WHERE id=$1",[id])).rows[0];if(row.state===target)return row;if(row.state==="failed")throw new Error(row.error);await new Promise(r=>setTimeout(r,500));}
  throw new Error(`Expected ${target}, got ${row.state}`);
};
try{
  await exec("docker",["run","-d","--name",supervisor,"--group-add","0","-e",`TEAM_DATABASE_URL=${inside.href}`,"-e",`TEAM_GITLAB_HOSTS=${host}`,"-e",`TEAM_RUN_VOLUME=${volume}`,"-e","TEAM_RUN_NETWORK=bridge","-v","/var/run/docker.sock:/var/run/docker.sock","-v",`${volume}:/var/lib/team-runs`,"dsh-team-agent-supervisor"]);
  const ready=await waitState("awaiting_approval");assert.equal(ready.summary.repositories.length,2);for(const r of ready.summary.repositories)assert.match(r.commit,/^[0-9a-f]{40}$/);
  const inspect=async()=>JSON.parse((await exec("docker",["inspect",runName])).stdout)[0];const before=await inspect();assert.equal(before.State.Running,true);assert.equal(before.HostConfig.ReadonlyRootfs,true);assert.ok(!before.Mounts.some(m=>m.Destination.includes("docker.sock")));
  const resources=await exec("docker",["exec",runName,"node","-e",`const fs=require('fs');if(fs.readFileSync('/control/assets/${assetId}','utf8')!=='immutable project contract')process.exit(1);fs.accessSync('/control/skills/mvp-dev-skills-dsh/frontend/SKILL.md');console.log('Expert resources and immutable asset mounted');`]);assert.match(resources.stdout,/mounted/);
  await exec("docker",["restart",supervisor]);await new Promise(r=>setTimeout(r,3500));const after=await inspect();assert.equal(after.Id,before.Id);assert.equal(after.State.StartedAt,before.State.StartedAt);assert.equal(after.State.Running,true);
  await db.query("UPDATE team_agent_runs SET command='cancel',command_id=$2 WHERE id=$1",[id,randomUUID()]);await waitState("cancelled");assert.equal((await inspect()).State.Running,false);
  console.log("Supervisor passed: two real Git clones with commit snapshots, isolated Docker launch, native AgentTeams activity, same-container adoption after restart, and cancellation.");
}catch(error){const logs=await exec("docker",["logs",supervisor]).catch(()=>({stdout:"",stderr:""}));throw new Error(error.message+"\n"+logs.stdout.slice(-2000)+logs.stderr.slice(-2000));}
finally{await exec("docker",["rm","-f",supervisor,runName]).catch(()=>{});await exec("docker",["volume","rm",volume]).catch(()=>{});await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
