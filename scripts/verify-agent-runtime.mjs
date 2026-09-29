import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn,execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const exec=promisify(execFile),dir=await fs.mkdtemp(path.join(os.tmpdir(),"team-agent-runtime-"));
const workspace=path.join(dir,"workspace"),control=path.join(dir,"control");await fs.mkdir(workspace);await fs.mkdir(control);
const autoApprove=process.env.TEAM_TEST_AUTO_APPROVE==="1";
let calls=0,memberCalls=0;const names=new Set(),claimed=new Set();
const model=http.createServer(async(req,res)=>{
  let raw="";for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw);calls++;for(const t of input.tools??[])names.add(t.function?.name);
  const isMember=!(input.tools??[]).some(t=>t.function?.name==="agent_teams_create_task");
  let operation=calls===1?{name:"agent_teams_create_task",args:{subject:"Prepare a result",description:"Write a short result",assignee:"engineer",dependencies:[]}}:null;
  if(isMember){
    memberCalls++;
    const dirs=await fs.readdir(path.join(workspace,".agent-teams"));
    const team=JSON.parse(await fs.readFile(path.join(workspace,".agent-teams",dirs.find(d=>d.startsWith("project-")),"team.json"),"utf8")),task=team.tasks[0];
    if(task.attemptId&&!claimed.has(task.attemptId)){claimed.add(task.attemptId);operation={name:"agent_teams_claim_task",args:{task_id:"t1"}};}
    else if(task.status==="claimed"||task.status==="in_progress")operation={name:"agent_teams_update_task",args:{task_id:"t1",attempt_id:task.attemptId,status:task.status==="claimed"?"in_progress":"completed",output:"Runtime fixture result"}};
  }
  const id="fixture-"+calls,tool=operation?{index:0,id:"tool-"+calls,type:"function",function:{name:operation.name,arguments:JSON.stringify(operation.args)}}:null;
  res.setHeader("content-type","text/event-stream");
  res.write("data: "+JSON.stringify({id,object:"chat.completion.chunk",created:1,model:"fixture",choices:[{index:0,delta:tool?{role:"assistant",tool_calls:[tool]}:{role:"assistant",content:"Plan ready for approval."},finish_reason:null}]})+"\n\n");
  res.end("data: "+JSON.stringify({id,object:"chat.completion.chunk",created:1,model:"fixture",choices:[{index:0,delta:{},finish_reason:tool?"tool_calls":"stop"}]})+"\n\ndata: [DONE]\n\n");
});
await new Promise(r=>model.listen(0,"0.0.0.0",r));
await fs.writeFile(path.join(control,"job.json"),JSON.stringify({id:randomUUID(),title:"Runtime test",goal:"Prepare a one-task plan",definition:{autoApprove,agents:[{name:"engineer",role:"developer",instructions:"Prepare the result"}],repositories:[]},model:{name:"fixture",baseUrl:`http://host.docker.internal:${model.address().port}/v1`},maxDurationMs:90000,maxRequests:20}));
const name="dsh-team-runtime-test-"+randomUUID();
let logs="";const child=spawn("docker",["run","--rm","--name",name,"-e","TEAM_AGENT_MODEL_KEY=fixture","-v",`${workspace}:/workspace`,"-v",`${control}:/control:ro`,"dsh-team-agent-runtime:rc1"],{stdio:["ignore","pipe","pipe"]});
child.stdout.on("data",c=>logs+=c);child.stderr.on("data",c=>logs+=c);
const done=new Promise(r=>child.on("close",r));
try{
  let status;
  for(let i=0;i<120;i++){
    try{status=JSON.parse(await fs.readFile(path.join(workspace,".team-status.json"),"utf8"));}catch{}
    if(status?.state==="awaiting_approval"||status?.state==="failed"||(autoApprove&&["running","completed"].includes(status?.state)))break;
    if(child.exitCode!==null)break;
    await new Promise(r=>setTimeout(r,500));
  }
  if(!["awaiting_approval",...(autoApprove?["running","completed"]:[])].includes(status?.state))throw new Error(`Runtime did not stage a plan: ${JSON.stringify(status)}\n${logs.slice(-7000)}`);
  assert.equal(status.activity.members.length,1);
  assert.ok(names.has("agent_teams_create_task"));
  assert.equal(status.activity.tasks.length,1);
  if(!autoApprove)await fs.writeFile(path.join(control,"command.json"),JSON.stringify({id:randomUUID(),action:"approve"}));
  for(let i=0;i<120;i++){
    try{status=JSON.parse(await fs.readFile(path.join(workspace,".team-status.json"),"utf8"));}catch{}
    if(["completed","failed"].includes(status.state))break;
    await new Promise(r=>setTimeout(r,500));
  }
  if(status.state!=="completed")throw new Error(`Approved task did not complete: ${JSON.stringify(status)}\n${logs.slice(-5000)}`);
  assert.ok(memberCalls>=3);assert.equal(status.activity.tasks[0].state,"completed");
  console.log("Real Docker Harness + AgentTeams passed: native team/member creation, model tool call, plan approval, scheduler dispatch, member claim/update, task completion and results; Desktop is absent.");
}finally{
  await exec("docker",["stop","-t","2",name]).catch(()=>{});await done;
  await new Promise(r=>model.close(r));await fs.rm(dir,{recursive:true,force:true});
}
