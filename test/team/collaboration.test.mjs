import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database, migrate } from "../../src/team/db.mjs";
import { createUser } from "../../src/team/auth.mjs";
import { startTeamServer } from "../../src/team/server.mjs";
import { TeamEngine, excerpt } from "../../packages/dsh-plugin-team-hub/src/engine.mjs";
import { validateResult } from "../../src/team/model.mjs";

const initial = "initial-password-2026", changed = "changed-password-2026";
const message = (seq, type, text, source = type === "user/message" ? "user" : "model") => ({ seq, type,
  data: type === "assistant/message" ? { message: { content: [{ type: "text", text }], source: { kind: source } } } : { content: [{ type: "text", text }], source: { kind: source } } });

test("collector excludes runtime context, reasoning and tools", () => {
  assert.equal(excerpt(message(0,"user/message","shared memory","plugin")),null);
  assert.equal(excerpt({seq:1,type:"tool/result",data:{message:{content:[{type:"text",text:"secret"}]}}}),null);
  const event=message(2,"assistant/message","Visible");event.data.message.content.push({type:"reasoning",text:"hidden"});
  assert.equal(excerpt(event).text,"Visible");
  assert.match(excerpt(message(3,"user/message","api_key=confidential-value")).text,/redacted/);
});
test("model source validation rejects invented references",()=>{
  assert.throws(()=>validateResult({summary:"Summary",memories:[{title:"Claim",content:"C",category:"bugfix",evidence:"reported",sourceIds:["foreign"]}]},[{id:"1"}]));
});
test("long messages upload without turn-end and resume when the local queue drains",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"team-long-")), engine=new TeamEngine(dir);
  try {
    engine.auth={user:{mustChangePassword:false}};engine.key="test";engine.data={sessions:{},workspaces:{},queue:Array.from({length:199},()=>({})),caches:{}};
    engine.bind({id:"long",seq:0,header:{}},randomUUID(),0);
    const text="完整对话".repeat(40000), events=[message(0,"user/message",text)];
    engine.capture("long",events);
    assert.equal(engine.data.queue.length,200);
    const first=engine.data.queue.at(-1).entries;
    engine.data.queue=[];engine.capture("long",events);
    const all=[...first,...engine.data.queue.flatMap(b=>b.entries)];
    assert.equal(all.map(e=>e.text).join(""),text);assert.equal(new Set(all.map(e=>e.id)).size,all.length);
  } finally {await engine.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test("PostgreSQL, HTTP API, model worker and two desktop engines", {skip:!process.env.TEAM_TEST_DATABASE_URL}, async t=>{
  const schema="test_"+randomUUID().replaceAll("-","");
  const admin=database(process.env.TEAM_TEST_DATABASE_URL);await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.TEAM_TEST_DATABASE_URL);url.searchParams.set("options",`-c search_path=${schema}`);
  const db=database(url.href);await migrate(db);
  let modelMode="good", calls=0;const modelInputs=[];
  const model=http.createServer(async(req,res)=>{
    let raw="";for await(const b of req)raw+=b;
    const input=JSON.parse(raw), entries=JSON.parse(input.messages[1].content).entries;calls++;modelInputs.push(entries);
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:"自动整理的项目会话摘要",memories:[{title:"订单幂等接口",content:"Use Idempotency-Key. {{braces}} remain literal.",category:"api-contract",evidence:"reported",sourceIds:[modelMode==="good"?entries[0].id:"foreign"]}]})}}]}));
  });
  await new Promise(resolve=>model.listen(0,"127.0.0.1",resolve));
  const app=await startTeamServer({db,port:0,model:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,name:"test-model",timeoutMs:2000},workerOptions:{intervalMs:3600_000}});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const dirs=[fs.mkdtempSync(path.join(os.tmpdir(),"team-a-")),fs.mkdtempSync(path.join(os.tmpdir(),"team-b-"))];
  let a=new TeamEngine(dirs[0]), b=new TeamEngine(dirs[1]);
  t.after(async()=>{await a.close();await b.close();await app.close();await new Promise(r=>model.close(r));await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();dirs.forEach(d=>fs.rmSync(d,{recursive:true,force:true}));});
  const pm=await createUser(db,{name:"manager",password:initial,assignedRoles:["project_manager"],admin:true});
  const dev=await createUser(db,{name:"developer",password:initial,assignedRoles:["developer"]});
  await createUser(db,{name:"tester",password:initial,assignedRoles:["qa_engineer"]});
  await a.login({hub:base,name:"manager",password:initial});
  await assert.rejects(()=>a.api("/projects"),/password_change_required/);
  await a.password({current:initial,next:changed});
  await b.login({hub:base,name:"developer",password:initial});await b.password({current:initial,next:changed});
  assert.equal(b.status,"已连接");
  const project=await a.api("/projects","POST",{name:"订单系统"});
  const other=await a.api("/projects","POST",{name:"私有项目"});
  await t.test("roles, invitation ownership and project isolation",async()=>{
    await assert.rejects(()=>b.api("/projects","POST",{name:"unauthorized"}),/permission_denied/);
    await assert.rejects(()=>b.api(`/projects/${project.id}/snapshot`),/project_access_revoked/);
    await assert.rejects(()=>a.api(`/projects/${project.id}/invites`,"POST",{name:"developer",role:"technical_director"}),/role_not_granted/);
    const inv=await a.api(`/projects/${project.id}/invites`,"POST",{name:"developer",role:"developer"});
    await assert.rejects(()=>a.api("/invites/accept","POST",{token:inv.token}),/invalid_invite/);
    const accepted=await Promise.allSettled([b.api("/invites/accept","POST",{token:inv.token}),b.api("/invites/accept","POST",{token:inv.token})]);
    assert.equal(accepted.filter(r=>r.status==="fulfilled").length,1);
    assert.equal((await b.api("/projects")).length,1);
    await assert.rejects(()=>b.api(`/projects/${other.id}/changes?cursor=0`),/project_access_revoked/);
    await assert.rejects(()=>a.api(`/projects/${project.id}/members/${pm.id}`,"DELETE",{}),/owner_transfer_required/);
  });
  const session={id:"session-local-1",seq:0,header:{cwd:"/workspace/orders"}};
  b.bind(session,project.id);a.bind({id:"manager-session",seq:0,header:{}},project.id);
  const events=[message(0,"user/message","订单接口需要避免重复提交"),message(1,"assistant/message","使用 Idempotency-Key"),{seq:2,type:"turn/end",data:{}}];
  b.capture(session.id,events);const operation=structuredClone(b.data.queue[0]);
  await t.test("automatic publication and idempotent ingestion",async()=>{
    await b.sync();assert.equal(b.data.queue.length,0);
    await b.api(`/projects/${project.id}/source-batches`,"POST",operation);
    const tampered={...operation,entries:[{id:"0",role:"user",text:"different"}]};
    await assert.rejects(()=>b.api(`/projects/${project.id}/source-batches`,"POST",tampered),/idempotency_conflict/);
    await app.worker.tick();await a.sync();await b.sync();
    assert.equal(calls,1);assert.equal(Object.keys(a.data.caches[project.id].memories).length,1);
    assert.match(a.context({agent:{id:"manager-session"}}),/Idempotency-Key/);
    assert.equal(a.context({agent:{id:"unbound"}}),"");
    assert.equal(a.context({}),"");
    assert.equal((await b.api(`/projects/${project.id}/shared-sessions`)).length,1);
    assert.equal((await b.api(`/projects/${project.id}/model-jobs`))[0].state,"succeeded");
  });
  await t.test("durable queue survives restart without persisting credentials",async()=>{
    b.capture(session.id,[...events,message(3,"user/message","追加说明"),{seq:4,type:"turn/end",data:{}}]);
    const id=b.data.queue[0].operationId;await b.close();b=new TeamEngine(dirs[1]);
    assert.equal(b.auth,null);await b.login({hub:base,name:"developer",password:changed});
    assert.deepEqual(b.data.caches,{});
    assert.equal(b.data.queue[0].operationId,id);await b.sync();assert.equal(b.data.queue.length,0);
  });
  await t.test("switching accounts on one instance does not duplicate transcripts or model jobs",async()=>{
    const jobs=(await a.api(`/projects/${project.id}/model-jobs`)).length;
    await b.logout();await b.login({hub:base,name:"manager",password:changed});
    b.bind(session,project.id,0);
    b.capture(session.id,[...events,message(3,"user/message","追加说明"),{seq:4,type:"turn/end",data:{}}]);
    await b.sync();assert.equal(b.data.queue.length,0);
    const sessions=await b.api(`/projects/${project.id}/sessions`);assert.equal(sessions.items.length,1);assert.equal(sessions.items[0].message_count,3);
    assert.equal((await b.api(`/projects/${project.id}/model-jobs`)).length,jobs);
    await b.logout();await b.login({hub:base,name:"developer",password:changed});
  });
  await t.test("admin model settings are durable and never disclose credentials",async()=>{
    await assert.rejects(()=>b.api("/settings/model"),/permission_denied/);
    await assert.rejects(()=>b.api("/settings/model","POST",{}),/permission_denied/);
    const config={baseUrl:`http://127.0.0.1:${model.address().port}/v1`,name:"configured-model",apiKey:"test-model-secret",timeoutMs:2000};
    const saved=await a.api("/settings/model","POST",config);assert.equal(saved.hasApiKey,true);assert.equal(saved.apiKey,undefined);
    await a.api("/settings/model","POST",{...config,apiKey:""});
    assert.equal((await db.query("SELECT value FROM team_settings WHERE key='model'")).rows[0].value.apiKey,"test-model-secret");
    await a.api("/settings/model","POST",{...config,clearApiKey:true});assert.equal((await a.api("/settings/model")).hasApiKey,false);
  });
  await t.test("direct membership and shared transcripts are project scoped",async()=>{
    const director=await createUser(db,{name:"director",password:initial,assignedRoles:["technical_director"]});
    const tester=(await db.query("SELECT id FROM team_users WHERE name='tester'")).rows[0];
    await a.api(`/projects/${project.id}/members`,"POST",{userId:director.id,role:"technical_director"});
    const auth=await a.raw(base,"/auth/login","POST",{name:"director",password:initial,device:"test"});
    const changedAuth=await a.raw(base,"/auth/change-password","POST",{current:initial,next:changed},auth.accessToken);
    await a.raw(base,`/projects/${project.id}/members`,"POST",{userId:tester.id,role:"qa_engineer"},changedAuth.accessToken);
    await assert.rejects(()=>b.api(`/projects/${project.id}/member-candidates`),/permission_denied/);
    const list=await b.api(`/projects/${project.id}/sessions`);assert.equal(list.items.length,1);
    const transcript=await b.api(`/projects/${project.id}/sessions/${list.items[0].id}`);
    assert.deepEqual(transcript.items.map(m=>m.content),["订单接口需要避免重复提交","使用 Idempotency-Key","追加说明"]);
    await assert.rejects(()=>a.api(`/projects/${other.id}/sessions/${list.items[0].id}`),/session_not_found/);
    await migrate(db);await migrate(db);
    assert.equal((await b.api(`/projects/${project.id}/sessions/${list.items[0].id}`)).items.length,3);
  });
  await t.test("invalid model output never publishes and schedules retry",async()=>{
    modelMode="bad";await app.worker.tick();
    const jobs=await b.api(`/projects/${project.id}/model-jobs`);assert.equal(jobs[0].state,"retry_wait");
    assert.equal((await b.api(`/projects/${project.id}/snapshot`)).memories.length,1);
    assert.deepEqual(modelInputs.at(-1).map(e=>e.text),["订单接口需要避免重复提交","使用 Idempotency-Key","追加说明"]);
    modelMode="good";
  });
  await t.test("migration merges legacy duplicate sessions and preserves old links",async()=>{
    const canonical=(await b.api(`/projects/${project.id}/sessions`)).items[0],alias=randomUUID();
    await db.query("DROP INDEX team_shared_identity");
    await db.query("DELETE FROM team_settings WHERE key='session-identity-v3'");
    await db.query("INSERT INTO team_shared_sessions(id,project_id,user_id,device,profile,session,title) VALUES($1,$2,$3,$4,$5,$6,'duplicate')",[alias,project.id,pm.id,b.device,b.profile,session.id]);
    await db.query("INSERT INTO team_session_messages(session_id,source_id,role,content) SELECT $1,source_id,role,content FROM team_session_messages WHERE session_id=$2",[alias,canonical.id]);
    await migrate(db);await migrate(db);
    assert.equal((await b.api(`/projects/${project.id}/sessions`)).items.length,1);
    const oldLink=await b.api(`/projects/${project.id}/sessions/${alias}`);
    assert.equal(oldLink.session.id,canonical.id);assert.equal(oldLink.items.length,3);
  });
  await t.test("withdrawal synchronizes a tombstone",async()=>{
    const memory=Object.values(a.data.caches[project.id].memories)[0];
    await assert.rejects(()=>b.api(`/projects/${project.id}/memories/${memory.id}/withdraw`,"POST",{}),/permission_denied/);
    await a.api(`/projects/${project.id}/memories/${memory.id}/withdraw`,"POST",{});await b.sync();
    assert.equal(Object.keys(b.data.caches[project.id].memories).length,0);
  });
  await t.test("membership revocation cancels jobs and removes client caches",async()=>{
    await a.api(`/projects/${project.id}/members/${dev.id}`,"DELETE",{});
    await assert.rejects(()=>b.api(`/projects/${project.id}/snapshot`),/project_access_revoked/);
    await b.sync();assert.equal(b.data.caches[project.id],undefined);assert.equal(b.data.sessions[session.id],undefined);
    const {rows:[job]}=await db.query("SELECT state FROM team_jobs ORDER BY created_at DESC LIMIT 1");assert.equal(job.state,"cancelled");
  });
  await t.test("HTTP browser origin boundary and refresh token reuse",async()=>{
    const response=await fetch(base+"/team/v1/projects",{headers:{origin:"http://evil.example",authorization:"Bearer "+a.auth.accessToken}});assert.equal(response.status,403);
    const old=a.auth.refreshToken;
    const refreshed=await a.raw(base,"/auth/refresh","POST",{refreshToken:old});
    await assert.rejects(()=>a.raw(base,"/auth/refresh","POST",{refreshToken:old}),/token_reused/);
    await assert.rejects(()=>a.raw(base,"/me","GET",undefined,refreshed.accessToken),/unauthorized/);
  });
});
