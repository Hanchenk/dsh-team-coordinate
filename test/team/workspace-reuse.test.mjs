import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workspaceActions } from "../../packages/dsh-plugin-team-hub/src/workspaces.mjs";

function fixture({durable=true}={}) {
  const projectId=randomUUID(),sharedId=randomUUID(),sessions=new Map(),calls=[],saved=new Map();
  const workspace={id:"workspace",path:"/workspace/project",sessionIds:[],async attachSession(id){this.sessionIds.push(id);}};
  const services={
    workspaceRegistry:{get:()=>workspace},
    agentDefaultModel:{currentSelection:()=>({provider:"local",model:"default"})},
    agentPresets:{resolve:async()=>({id:"default-preset"}),mount:async(_ctx,id)=>{calls.push(["preset",id]);return {id};}},
    agents:{async create(options){
      calls.push(["create",options]);
      const events=structuredClone(options.seed);
      const session={id:options.sessionId,header:options.meta,seq:events.length,snapshotEvents:()=>events};
      sessions.set(session.id,session);
      // Match the actual AgentLoop setup transaction contract.
      (await options.setup?.({}))?.commit();
      return {agent:{session}};
    }},
    sessionController:{async rename({sessionId,title}){const s=sessions.get(sessionId);s.snapshotEvents().push({seq:s.seq++,type:"session/title",data:{title}});}}
  };
  const ctx={get:key=>services[key],sessions:{get:id=>sessions.get(id),async flush(s){saved.set(s.id,structuredClone(s.snapshotEvents()));return durable;}}};
  const engine={epoch:1,hub:"http://lan",data:{workspaces:{[workspace.path]:projectId}},async api(url){
    const more=url.endsWith("cursor=0");return {session:{id:sharedId,title:"Shared task",name:"Colleague"},items:[{role:more?"user":"assistant",content:more?"Question":"Answer"}],cursor:1,hasMore:more};
  },bind(s,p,seq){calls.push(["bind",s.id,p,seq]);}};
  return {ctx,engine,calls,saved,workspace,input:{projectId,sharedId,workspaceId:workspace.id}};
}

test("reuse publishes a nonblank completed seed before Agent creation and persists title",async()=>{
  const f=fixture();const result=await workspaceActions(f.ctx,f.engine).reuse(f.input);
  const options=f.calls.find(c=>c[0]==="create")[1];
  assert.deepEqual(options.seed.map(e=>e.type),["turn/start","user/message","turn/end"]);
  assert.equal(options.seed[0].data.turn,1);
  assert.deepEqual(options.seed[2].data,{turn:1,reason:{kind:"completed"}});
  assert.equal(options.meta.cwd,f.workspace.path);
  assert.equal(options.meta.agentPreset,"default-preset");
  assert.deepEqual(options.agentOptions,{provider:"local",model:"default"});
  assert.ok(f.calls.some(c=>c[0]==="preset"));
  const recall=options.seed[1];assert.equal(recall.data.source.form,"recall");
  assert.deepEqual(JSON.parse(recall.data.content[0].text).conversation,[{role:"user",text:"Question"},{role:"assistant",text:"Answer"}]);
  assert.ok(f.workspace.sessionIds.includes(result.sessionId));
  assert.equal(f.saved.get(result.sessionId).at(-1).data.title,"复用 · Shared task");
  assert.equal(f.calls.at(-1)[3],4);
});

test("reuse does not report success without durable storage",async()=>{
  const f=fixture({durable:false});
  await assert.rejects(()=>workspaceActions(f.ctx,f.engine).reuse(f.input),/session_persistence_unavailable/);
  assert.ok(!f.calls.some(c=>c[0]==="bind"));
});

test("account change while downloading never creates an imported Agent",async()=>{
  const f=fixture(),api=f.engine.api;
  f.engine.api=async url=>{const page=await api(url);f.engine.epoch++;return page;};
  await assert.rejects(()=>workspaceActions(f.ctx,f.engine).reuse(f.input),/identity_changed/);
  assert.equal(f.calls.length,0);
});

test("reuse histories are isolated from later ordinary and reused sessions",async()=>{
  const f=fixture(),actions=workspaceActions(f.ctx,f.engine);
  const first=await actions.reuse(f.input);
  const ordinary=await f.ctx.get("agents").create({sessionId:"ordinary",seed:[],meta:{cwd:f.workspace.path}});
  assert.deepEqual(ordinary.agent.session.snapshotEvents(),[]);
  f.engine.api=async()=>({session:{id:randomUUID(),title:"Other",name:"Other author"},items:[{role:"user",content:"Different context"}],hasMore:false});
  const second=await actions.reuse(f.input);
  const text=id=>JSON.parse(f.ctx.sessions.get(id).snapshotEvents()[1].data.content[0].text).conversation;
  assert.deepEqual(text(first.sessionId),[{role:"user",text:"Question"},{role:"assistant",text:"Answer"}]);
  assert.deepEqual(text(second.sessionId),[{role:"user",text:"Different context"}]);
  assert.deepEqual(ordinary.agent.session.snapshotEvents(),[]);
});
