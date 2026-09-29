import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { workspaceActions } from "../packages/dsh-plugin-team-hub/src/workspaces.mjs";

// Point at an isolated installation of Desktop's vendored dsh-session package.
const modules=process.env.DSH_RUNTIME_MODULES,tarballs=process.env.DSH_RUNTIME_TARBALLS;
assert.ok(modules && tarballs,"DSH_RUNTIME_MODULES and DSH_RUNTIME_TARBALLS are required");
const {Session}=await import(pathToFileURL(path.join(modules,"@deepseek-ai/dsh-session/lib/index.js")));
function runtimeSource(name,entry){
  const file=fs.readdirSync(tarballs).find(f=>f.startsWith(`deepseek-ai-${name}-0.`));
  assert.ok(file,`missing ${name}`);
  return execFileSync("tar",["-xOf",path.join(tarballs,file),entry],{encoding:"utf8",maxBuffer:10*1024*1024});
}
function runtimeFunction(source,name){
  const match=source.match(new RegExp(`^([\\t ]*)function ${name}\\([^]*?\\n\\1}`,"m"));
  assert.ok(match,`missing runtime contract ${name}`);
  return vm.runInNewContext(`(${match[0]})`);
}
const metadata=runtimeFunction(runtimeSource("dsh-api-session-controller","package/lib/index.js"),"applySessionListMetadata");
const visible=runtimeFunction(runtimeSource("dsh-client-ui-workspace","package/lib/client.js"),"sessionVisible");
const projectId=randomUUID(),sharedId=randomUUID(),sessions=new Map();let durable;
const workspace={id:"target",path:"/workspace/reuse",sessionIds:[],async attachSession(id){this.sessionIds.push(id);}};
const services={workspaceRegistry:{get:()=>workspace},agentDefaultModel:{currentSelection:()=>({provider:"fixture",model:"fixture"})},
  agentPresets:{resolve:async()=>({id:"default"}),mount:async()=>({id:"default",name:"Default preset"})},
  agents:{async create({sessionId,seed,meta,setup}){
    (await setup?.({}))?.commit();
    // The actual Session validates event envelopes, message sources and surface history.
    const session=Session.create(sessionId,seed,{version:2,id:sessionId,createdAt:Date.now(),isSeeded:false,...meta});
    sessions.set(sessionId,session);
    assert.equal(metadataOf(session).blank,false,"first publication must already be nonblank");
    return {agent:{session}};
  }},
  sessionController:{async rename({sessionId,title}){sessions.get(sessionId).append("session/title",{title});}}
};
function metadataOf(s){return s.snapshotEvents().reduce(metadata,{blank:true,lastPromptAt:null});}
const ctx={get:key=>services[key],sessions:{get:id=>sessions.get(id),async flush(s){durable=JSON.parse(JSON.stringify({header:s.header,events:s.snapshotEvents()}));return true;}}};
const engine={epoch:1,hub:"http://lan",data:{workspaces:{[workspace.path]:projectId}},bind(){},async api(){return {session:{id:sharedId,name:"Colleague",title:"Runtime reuse"},items:[{role:"user",content:"Shared question"},{role:"assistant",content:"Shared answer"}],hasMore:false};}};
const result=await workspaceActions(ctx,engine).reuse({projectId,sharedId,workspaceId:workspace.id});
assert.ok(workspace.sessionIds.includes(result.sessionId));
const reopened=Session.create(result.sessionId,durable.events,durable.header);
assert.equal(visible({id:result.sessionId,...metadataOf(reopened)},"other-session",new Set()),true);
assert.equal(durable.events.at(-1).data.title,"复用 · Runtime reuse");
const recall=reopened.snapshotEvents().find(e=>e.type==="user/message");
assert.equal(recall.surfaceOp,"append");
assert.equal(JSON.parse(recall.data.content[0].text).conversation.length,2);
// Reproduce the old implementation against the same unmodified sidebar contract.
const old=Session.create("old",[{...recall,seq:0}]);
assert.equal(visible({id:old.id,...metadataOf(old)},"other-session",new Set()),false);
const lastTurn=reopened.snapshotEvents().findLast(e=>e.type==="turn/start").data.turn;
assert.equal(lastTurn,1);
reopened.append("turn/start",{turn:lastTurn+1});
reopened.append("user/message",{id:randomUUID(),role:"user",source:{kind:"user"},content:[{type:"text",text:"Continue"}]},{surfaceOp:"append"});
reopened.append("turn/end",{turn:2,reason:{kind:"completed"}});
Session.create(result.sessionId,reopened.snapshotEvents(),reopened.header);
const ordinary=Session.create("ordinary-new-session");
assert.deepEqual(ordinary.snapshotEvents(),[]);
console.log("Desktop runtime contracts passed: preset setup transaction, old hidden-session reproduction, seeded visibility, saved title, recalled context, reopen, subsequent turn and empty new session.");
