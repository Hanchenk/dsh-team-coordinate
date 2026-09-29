import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database,migrate } from "../../src/team/db.mjs";
import { createUser } from "../../src/team/auth.mjs";
import { startTeamServer } from "../../src/team/server.mjs";
import { repositoryInput,encryptCredential,decryptCredential } from "../../src/team/agent-projects.mjs";

test("repository URLs and checkout paths are restricted",()=>{
  const valid={name:"frontend",url:"http://gitlab.yemast.com/group/frontend.git",branch:"feature/agents"};
  assert.equal(repositoryInput(valid).name,"frontend");
  for(const bad of [{name:"../outside"},{url:"file:///tmp/repo.git"},{url:"http://user:password@gitlab.yemast.com/a.git"},{url:"http://127.0.0.1/a.git"},{url:"http://gitlab.yemast.com/a.git?key=secret"},{branch:"--upload-pack=x"},{branch:"main..next"}])assert.throws(()=>repositoryInput({...valid,...bad}));
});
test("GitLab credentials use authenticated encryption",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"team-key-"));process.env.TEAM_SECRET_DIR=dir;
  try{const encrypted=await encryptCredential("private-test-token");assert.ok(!JSON.stringify(encrypted).includes("private-test-token"));assert.equal(await decryptCredential(encrypted),"private-test-token");await assert.rejects(()=>decryptCredential({...encrypted,tag:Buffer.alloc(16).toString("base64")}));}finally{await fs.rm(dir,{recursive:true,force:true});delete process.env.TEAM_SECRET_DIR;}
});
test("project agents, multiple repositories, immutable runs, permissions and approvals",{skip:!process.env.TEAM_TEST_DATABASE_URL},async t=>{
  const schema="agent_"+randomUUID().replaceAll("-",""),admin=database(process.env.TEAM_TEST_DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.TEAM_TEST_DATABASE_URL);url.searchParams.set("options",`-c search_path=${schema}`);const db=database(url.href);await migrate(db);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"team-key-"));process.env.TEAM_SECRET_DIR=dir;
  const app=await startTeamServer({db,port:0,model:{},workerOptions:{intervalMs:3600000}}),base=`http://127.0.0.1:${app.server.address().port}/team/v1`;
  t.after(async()=>{await app.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await fs.rm(dir,{recursive:true,force:true});delete process.env.TEAM_SECRET_DIR;});
  const call=async(token,route,method="GET",input)=>{const r=await fetch(base+route,{method,headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})},body:input===undefined?undefined:JSON.stringify(input)});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;};
  const login=async(name,adminRole=false)=>{
    const user=await createUser(db,{name,password:"initial-password",assignedRoles:[adminRole?"project_manager":"developer"],admin:adminRole});
    let auth=await call(null,"/auth/login","POST",{name,password:"initial-password",device:name});auth=await call(auth.accessToken,"/auth/change-password","POST",{current:"initial-password",next:"changed-password"});return {token:auth.accessToken,user};
  };
  const pm=await login("manager",true),dev=await login("developer"),outsider=await login("outsider");
  const project=await call(pm.token,"/projects","POST",{name:"Multi-repo"}),p=`/projects/${project.id}`;
  await call(pm.token,p+"/members","POST",{userId:dev.user.id,role:"developer"});
  const repos=[];for(const name of ["frontend","backend"])repos.push(await call(pm.token,p+"/repositories","POST",{name,url:`http://gitlab.yemast.com/test/${name}.git`,branch:"main",token:"test-private-token"}));
  assert.equal((await call(dev.token,p+"/repositories")).length,2);
  assert.ok(!JSON.stringify(await call(dev.token,p+"/repositories")).includes("test-private-token"));
  const {rows:[stored]}=await db.query("SELECT credential FROM team_repositories LIMIT 1");assert.equal(await decryptCredential(stored.credential),"test-private-token");
  await assert.rejects(()=>call(outsider.token,p+"/repositories"),/project_access_revoked/);
  await assert.rejects(()=>call(dev.token,p+"/agents","POST",{name:"evil",role:"developer",instructions:"work"}),/permission_denied/);
  const agent=await call(pm.token,p+"/agents","POST",{name:"engineer",role:"developer",instructions:"Implement and verify changes"});
  await assert.rejects(()=>call(dev.token,"/settings/agent-model","POST",{baseUrl:"http://model/v1",name:"test"}),/permission_denied/);
  await call(pm.token,"/settings/agent-model","POST",{baseUrl:"http://model/v1",name:"test",apiKey:"private-model-key"});
  assert.equal((await call(pm.token,"/settings/agent-model")).hasApiKey,true);
  const input={operationId:randomUUID(),title:"Cross-repo task",goal:"Coordinate API and frontend changes",agentIds:[agent.id],repositoryIds:repos.map(r=>r.id)};
  await assert.rejects(()=>call(dev.token,p+"/agent-runs","POST",{...input,repositoryIds:[randomUUID()]}),/invalid_project_selection/);
  const [a,b]=await Promise.all([call(dev.token,p+"/agent-runs","POST",input),call(dev.token,p+"/agent-runs","POST",input)]);assert.equal(a.id,b.id);
  const run=await call(pm.token,p+"/agent-runs/"+a.id);assert.equal(run.definition.repositories.length,2);assert.equal(run.definition.agents.length,1);assert.equal(run.state,"queued");
  await call(pm.token,p+"/agents/"+agent.id,"DELETE",{});
  assert.equal((await call(pm.token,p+"/agent-runs/"+a.id)).definition.agents[0].name,"engineer");
  await assert.rejects(()=>call(pm.token,p+"/agent-runs/"+a.id+"/approve","POST",{}),/plan_not_ready/);
  await db.query("UPDATE team_agent_runs SET state='awaiting_approval' WHERE id=$1",[a.id]);
  await call(dev.token,p+"/agent-runs/"+a.id+"/approve","POST",{});
  await call(pm.token,p+"/agent-runs/"+a.id+"/cancel","POST",{});
  assert.equal((await db.query("SELECT command FROM team_agent_runs WHERE id=$1",[a.id])).rows[0].command,"cancel");
});
