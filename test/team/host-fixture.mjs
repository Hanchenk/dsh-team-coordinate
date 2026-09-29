import http from "node:http";
import fs from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../../packages/dsh-plugin-team-hub/lib/index.mjs";
import { randomUUID } from "node:crypto";

export async function createHost(dir, extraRoutes = {}) {
  const routes = new Map(), sessions = new Map(), tools = new Map(), variables = new Map(), contexts = new Map();
  const server = http.createServer(async(req,res)=>{
    try {
      const pathname = new URL(req.url,"http://local").pathname;
      if (pathname === "/client.js") { res.setHeader("content-type","text/javascript"); res.end(await fs.readFile(new URL("../../packages/dsh-plugin-team-hub/lib/client.js",import.meta.url))); return; }
      if (extraRoutes[pathname]) { await extraRoutes[pathname](req,res); return; }
      const match=[...routes.values()].find(r=>pathname===r.path||pathname.startsWith(r.path+"/"));
      if(match)await match.handler(req,res);else{res.statusCode=404;res.end();}
    } catch(error){res.statusCode=500;res.end(error.message);}
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const ctx = new Context();
  ctx.provide("webServer",{port:server.address().port,register(route){routes.set(route.path,route);return()=>routes.delete(route.path);}});
  const persisted=new Map();
  ctx.provide("sessions",{get:id=>sessions.get(id),list:()=>[...sessions.values()],flush:async s=>{persisted.set(s.id,structuredClone({header:s.header,events:s.snapshotEvents()}));return true;}});
  const makeWorkspace=(id,path,title)=>({id,path,title,sessionIds:[],async attachSession(id){if(!this.sessionIds.includes(id))this.sessionIds.push(id);}});
  const workspaces=[makeWorkspace("orders","/workspace/orders","订单工作区")];
  ctx.provide("workspaceRegistry",{list:()=>workspaces,get:id=>workspaces.find(w=>w.id===id),create:async(path,title)=>{const w=makeWorkspace(randomUUID(),path,title);workspaces.push(w);return w;}});
  ctx.provide("agentDefaultModel",{currentSelection:()=>({provider:"fixture",model:"fixture"})});
  ctx.provide("agentPresets",{resolve:async()=>({id:"default"}),mount:async()=>({id:"default"})});
  ctx.provide("agents",{create:async({sessionId:id,seed=[],meta,setup})=>{
    (await setup?.({}))?.commit();
    const events=structuredClone(seed);
    const session={id,seq:events.length,header:{id,...meta},snapshotEvents:()=>events,append(type,data,opts){events.push({seq:this.seq++,time:Date.now(),type,data,...opts});}};
    sessions.set(id,session);ctx.emit("session/created",session);return {agent:{session}};
  }});
  ctx.provide("sessionController",{create:async({workspaceId})=>{
    const id=randomUUID(),events=[],workspace=workspaces.find(w=>w.id===workspaceId);
    const session={id,seq:0,header:{cwd:workspace.path},snapshotEvents:()=>events,append(type,data,opts){events.push({seq:this.seq++,type,data,...opts});}};
    sessions.set(id,session);workspace.sessionIds.push(id);ctx.emit("session/created",session);return {sessionId:id};
  },rename:async({sessionId,title})=>{sessions.get(sessionId).append("session/title",{title});}});
  ctx.provide("desktopProfiles",{current:{dir,name:"fixture"}});
  ctx.provide("systemPrompt",{variable(name,fn){variables.set(name,fn);},context(value){contexts.set(value.name,value);}});
  ctx.provide("tools",{register(tool){tools.set(tool.name,tool);}});
  const fiber=await ctx.plugin(plugin,{dataDir:dir});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(action,input={})=>{
    const response=await fetch(base+"/team-plugin/local",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,...input})});
    const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
  };
  return {ctx,fiber,base,call,sessions,persisted,workspaces,tools,variables,contexts,routes,async close(){await ctx.fiber.dispose();await new Promise(r=>server.close(r));}};
}
