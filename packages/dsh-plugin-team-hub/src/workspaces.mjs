import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensure, str, uuid } from "../../../src/team/contracts.mjs";

export function workspaceActions(ctx, engine) {
  const registry = () => { const value=ctx.get("workspaceRegistry"); ensure(value,503,"workspace_service_unavailable"); return value; };
  const list = () => ctx.get("workspaceRegistry")?.list().map(w=>({id:w.id,title:w.title,path:w.path,sessionCount:w.sessionIds.length})) ?? [];
  async function bind(input) {
    const epoch=engine.epoch;
    ensure((await engine.api("/projects")).some(p=>p.id===input.projectId),403,"permission_denied");
    const store=registry(); let workspace;
    if(input.workspaceId) workspace=store.get(input.workspaceId);
    else {
      const dir=str(input.path,2000); ensure(path.isAbsolute(dir));
      await fs.mkdir(dir,{recursive:true});
      workspace=await store.create(dir,str(input.title,120));
    }
    ensure(workspace,404,"workspace_not_found");
    const previous=engine.data.workspaces[workspace.path];
    ensure(!previous || previous===input.projectId,409,"workspace_project_conflict");
    const query=ctx.get("sessionQuery");
    const sessions=query ? (await query.listSessions()).map(r=>({id:r.header.id,header:r.header,seq:0})) : ctx.sessions.list();
    const matching=sessions.filter(s=>s.header?.cwd===workspace.path);
    ensure(epoch===engine.epoch,409,"identity_changed");
    ensure(matching.every(s=>!engine.data.sessions[s.id] || engine.data.sessions[s.id].projectId===input.projectId),409,"session_project_conflict");
    engine.data.workspaces[workspace.path]=input.projectId;
    for(const session of matching) engine.bind(session,input.projectId,0);
    engine.persist();
    return {id:workspace.id,path:workspace.path,title:workspace.title};
  }
  async function reuse(input) {
    const epoch=engine.epoch;
    uuid(input.projectId); uuid(input.sharedId);
    const workspace=registry().get(input.workspaceId);
    ensure(workspace && engine.data?.workspaces[workspace.path]===input.projectId,409,"workspace_binding_required");
    const controller=ctx.get("sessionController"), agents=ctx.get("agents"), defaults=ctx.get("agentDefaultModel");
    ensure(controller?.rename && agents?.create && defaults && workspace.attachSession,503,"session_creation_unavailable");
    let cursor=0, first, items=[];
    do {
      const page=await engine.api(`/projects/${input.projectId}/sessions/${input.sharedId}?cursor=${cursor}`);
      first ??= page.session; items.push(...page.items); cursor=page.cursor;
      if(!page.hasMore)break;
    } while(true);
    ensure(items.length,409,"empty_session");
    const presets=ctx.get("agentPresets");
    const preset=presets ? await presets.resolve() : undefined;
    ensure(epoch===engine.epoch,409,"identity_changed");
    // Seed a completed import turn BEFORE Agent creation. Desktop hides sessions
    // without turn/start; a live Agent also caches its last turn at construction.
    const time=Date.now(), sessionId=`session-${randomUUID()}`;
    const seed=[
      {seq:0,time,type:"turn/start",data:{turn:1}},
      {seq:1,time,type:"user/message",data:{id:randomUUID(),role:"user",source:{kind:"plugin",plugin:"dsh-plugin-team-hub",form:"recall"},content:[{type:"text",text:JSON.stringify({source:{hub:engine.hub,projectId:input.projectId,sessionId:first.id,author:first.name},conversation:items.map(m=>({role:m.role,text:m.content}))})}]},surfaceOp:"append"},
      {seq:2,time,type:"turn/end",data:{turn:1,reason:{kind:"completed"}}}
    ];
    // Keep shared text as recall context; never replay tools or provider-private state.
    await agents.create({sessionId,seed,meta:{cwd:workspace.path,...(preset?{agentPreset:preset.id}:{})},
      // Agent setup may return a transaction; a preset descriptor is not one.
      agentOptions:defaults.currentSelection(),...(preset?{setup:async agentCtx=>{await presets.mount(agentCtx,preset.id);}}:{})});
    ensure(epoch===engine.epoch,409,"identity_changed");
    const session=ctx.sessions.get(sessionId); ensure(session,503,"session_creation_unavailable");
    await workspace.attachSession(session.id);
    await controller.rename({sessionId:session.id,title:`复用 · ${first.title}`.slice(0,120)});
    ensure(await ctx.sessions.flush(session),503,"session_persistence_unavailable");
    engine.bind(session,input.projectId,session.seq);
    return {sessionId:session.id,title:first.title};
  }
  return {list,bind,reuse};
}
