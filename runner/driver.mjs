import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { collectTeamsActivity } from "./node_modules/@nanmicoder/dsh-agent-teams/lib/snapshot.js";
import { findTeamByCaptain } from "./node_modules/@nanmicoder/dsh-agent-teams/lib/state.js";
export const name="team-cloud-driver";
export const inject=["llm","agents","sessions","tools"];
const file="/workspace/.team-status.json";
async function write(value){await fs.writeFile(file+".tmp",JSON.stringify(value));await fs.rename(file+".tmp",file);}
export function apply(ctx){
  const messages=[];let captainId,requests=0,latest={},commandId;
  ctx.on("session/event",(session,event)=>{
    const message=event.type==="user/message"?event.data:event.type==="assistant/message"?event.data?.message:undefined;
    if(!message||!["user","model"].includes(message.source?.kind))return;
    const text=message.content?.filter(p=>p.type==="text").map(p=>p.text).join("\n");
    if(text){messages.push({sessionId:session.id,role:event.type==="user/message"?"user":"assistant",text:text.slice(0,6000)});if(messages.length>20)messages.shift();}
  });
  ctx.on("llm/stream",async function*(options,next){if(++requests>200)throw new Error("agent_request_limit");yield* next();});
  const run=async()=>{
    const job=JSON.parse(await fs.readFile("/control/job.json","utf8")),started=Date.now();
    await ctx.get("loader").await();
    const presets=ctx.get("agentPresets"),preset=presets?await presets.resolve():undefined;
    const handle=await ctx.agents.create({sessionId:`session-${randomUUID()}`,meta:{cwd:"/workspace",...(preset?{agentPreset:preset.id}:{})},agentOptions:{provider:"team-model",model:job.model.name},...(preset?{setup:async scope=>{await presets.mount(scope,preset.id);}}:{})});
    ctx.effect(()=>()=>handle.dispose());const captain=handle.agent;captainId=captain.id;
    const execute=async(name,args)=>{
      const result=await ctx.tools.execute({name,arguments:args,callId:randomUUID(),agent:captain,signal:new AbortController().signal});
      if(result.isError)throw new Error(`native_tool_failed:${name}`);return result;
    };
    await execute("agent_teams_create",{name:`project-${job.id}`,description:job.goal,approval:"required"});
    const context=job.definition.context??{};
    for(const agent of job.definition.agents)await execute("agent_teams_add_member",{name:agent.name,role:agent.role,executionPrompt:`${agent.instructions}\n项目指令：${context.instructions??""}\n项目资产目录 /control/assets（只读），专家技能目录 /control/skills（只读）。只在 /workspace 产出文件。`});
    const resources=`Project instructions: ${context.instructions??""}\nEnabled expert SOP files: ${(context.skills??[]).map(id=>`/control/skills/${id}/SKILL.md`).join(", ")}\nRead applicable SOP and member resources. Use ONLY the existing AgentTeams roster and tools for delegation, translating WorkBuddy TeamCreate/Agent/SendMessage or subagent instructions to native AgentTeams tasks. Never create a second team.\nProject assets (read-only): ${JSON.stringify((context.assets??[]).map(a=>({name:a.name,path:`/control/assets/${a.id}`})))}`;
    captain.followup(createUserMessage({source:{kind:"user"},content:[{type:"text",text:`Use the existing staged AgentTeams team and its configured roster. Plan dependency-aware tasks for this goal: ${job.goal}\n${resources}\nRepositories: ${JSON.stringify(job.definition.repositories.map(r=>({directory:`repos/${r.name}`,branch:r.branch,commit:r.commit})))}\nKeep changes in these checkouts and deliverables/. Do not push, merge, deploy or create another team. Present the plan and wait for the project's Approve button. Keep the team record after completion and summarize the deliverables.`}]}));
    let idleSince;
    while(Date.now()-started<job.maxDurationMs){
      const team=await findTeamByCaptain("/workspace/.agent-teams",captainId);
      const activity=(await collectTeamsActivity(ctx,[{workspace:job.title,stateRoot:"/workspace/.agent-teams"}])).find(t=>t.captainSessionId===captainId);
      const idle=ctx.agents.list().every(a=>a.status==="idle");if(idle)idleSince??=Date.now();else idleSince=undefined;
      let state=team?.phase==="staged"&&idle?"awaiting_approval":team?.phase==="running"?"running":"planning";
      if(team?.phase==="running"&&team.tasks.length&&team.tasks.every(t=>["completed","failed","cancelled"].includes(t.status))&&idle&&Date.now()-idleSince>1000)state=team.tasks.every(t=>t.status==="completed")?"completed":"failed";
      latest={state,captainSessionId:captainId,activity,messages:[...messages],results:team?.tasks.map(t=>({id:t.id,output:t.output?.slice(0,8000)})),requests,commandId};
      await write(latest);
      if(["completed","failed"].includes(state)){
        for(const a of ctx.agents.list())await ctx.sessions.flush(a.session);
        ctx.get("appExit")(state==="completed"?0:1);return;
      }
      try{
        const command=job.definition.autoApprove?{id:"scheduled-approval",action:"approve"}:JSON.parse(await fs.readFile("/control/command.json","utf8"));
        if(command.id!==commandId&&command.action==="approve"&&state==="awaiting_approval"){
          await execute("agent_teams_approve",{confirmation:"Project user approved this plan through Team Hub."});commandId=command.id;
          captain.followup(createUserMessage({source:{kind:"user"},content:[{type:"text",text:"The project user approved the staged plan. Coordinate the existing team, let the scheduler dispatch work, then summarize the results. Retain the team record. Do not push, merge or deploy."}]}));
        }
      }catch(e){if(e.code!=="ENOENT")throw e;}
      if(state==="planning"&&idleSince&&Date.now()-idleSince>30000)throw new Error("agent_did_not_produce_plan");
      await new Promise(r=>setTimeout(r,1000));
    }
    throw new Error("agent_run_timeout");
  };
  void run().catch(async error=>{await write({...latest,state:"failed",error:String(error.message).slice(0,200),requests});ctx.get("appExit")(1);});
}
