export const runStates={queued:"排队中",preparing:"检出仓库",planning:"规划中",awaiting_approval:"待批准",running:"执行中",completed:"已完成",failed:"失败",cancelled:"已取消"};
let runId=null;
function operationUUID(){
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function renderAgents(section,ui){
  const {el,btn,field,form,roleSelect,roles,api,base,project,refresh,formatDate}=ui;
  const manager=["project_manager","technical_director"].includes(project.role);
  const [agents,repos,runs]=await Promise.all([api(base+"/agents"),api(base+"/repositories"),api(base+"/agent-runs")]);
  const avatar=()=>el("img",{src:"./agent-team.png",alt:"",class:"agent-avatar",width:44,height:44});
  const dialog=(title,fields,label,submit)=>{
    const d=el("dialog",{class:"workspace-dialog"});d.append(el("h2",{},title),form(fields,label,async v=>{await submit(v,d);d.close();d.remove();await refresh();}),btn("取消","arrow-left",async()=>{d.close();d.remove();}));
    d.addEventListener("close",()=>d.remove(),{once:true});document.body.append(d);d.showModal();
  };
  section.append(el("div",{class:"page-title"},avatar(),el("h2",{},"Agent 协作")));
  const capabilities=await api("/capabilities");
  section.append(el("div",{class:"meta"},el("span",{},capabilities.agentRunnerReady?"服务器执行器在线":"服务器执行器离线"),!capabilities.agentModelConfigured?el("span",{},"执行模型未配置"):null));
  section.append(el("div",{class:"toolbar agent-actions"},btn("发起协作","plus",async()=>{
    const selections=(items,name)=>el("fieldset",{},el("legend",{},name==="agentIds"?"参与 Agent":"参与仓库"),items.map(item=>el("label",{class:"check"},el("input",{type:"checkbox",name,value:item.id,checked:true}),item.name)));
    if(!agents.length)throw new Error("请先添加 Agent 成员");
    const operationId=operationUUID();
    dialog("发起项目协作",[field("任务标题","title"),el("label",{},"目标",el("textarea",{name:"goal",required:true,rows:5,maxlength:12000})),selections(agents,"agentIds"),selections(repos,"repositoryIds")],"生成协作计划",async(v,d)=>{
      const data=new FormData(d.querySelector("form"));const run=await api(base+"/agent-runs","POST",{title:v.title,goal:v.goal,agentIds:data.getAll("agentIds"),repositoryIds:data.getAll("repositoryIds"),operationId});runId=run.id;
    });
  }),manager?btn("添加 Agent","users",async()=>dialog("添加项目 Agent",[field("名称（英文、数字、短横线）","name"),roleSelect(),el("label",{},"职责",el("textarea",{name:"instructions",required:true,rows:4,maxlength:4000}))],"添加",v=>api(base+"/agents","POST",v))):null));
  section.append(el("details",{},el("summary",{},`Agent 成员 · ${agents.length}`),agents.map(a=>el("div",{class:"agent-roster"},avatar(),el("div",{},el("strong",{},a.name),el("div",{class:"muted"},roles[a.role]),el("p",{},a.instructions)),manager?btn("移除 Agent","trash-2",async()=>{await api(base+"/agents/"+a.id,"DELETE",{});await refresh();},"icon-only"):null))));
  if(runId&&!runs.some(r=>r.id===runId))runId=null;
  if(!runs.length){section.append(el("div",{class:"empty"},"暂无协作任务"));return;}
  section.append(el("label",{},"协作任务",el("select",{"aria-label":"协作任务",onChange:async e=>{runId=e.target.value;await refresh();}},runs.map(r=>el("option",{value:r.id,selected:r.id===(runId??runs[0].id)},`${r.title} · ${runStates[r.state]}`)))));
  const run=await api(base+"/agent-runs/"+(runId??runs[0].id)),activity=run.summary.activity;
  section.append(el("div",{class:"meta agent-run-meta"},el("strong",{},runStates[run.state]),el("span",{},formatDate(run.created_at))));
  if(run.error)section.append(el("div",{class:"error"},run.error));
  section.append(el("p",{class:"agent-goal"},run.goal));
  const controls=el("div",{class:"toolbar agent-actions"});
  if(run.state==="awaiting_approval")controls.append(btn("批准并执行","check",async()=>{await api(base+"/agent-runs/"+run.id+"/approve","POST",{});await refresh();},"primary"));
  if(!["completed","failed","cancelled"].includes(run.state))controls.append(btn("停止协作","square",async()=>{await api(base+"/agent-runs/"+run.id+"/cancel","POST",{});await refresh();},"danger"));
  section.append(controls);
  const tasks=activity?.tasks??[],members=activity?.members??[];
  section.append(el("div",{class:"agent-captain"},avatar(),el("div",{},el("strong",{},"队长"),el("div",{class:"muted"},"拆解 · 派发 · 汇总")),el("span",{class:"tag"},`${tasks.filter(t=>t.state==="completed").length}/${tasks.length} 完成`)));
  const progress=el("div",{class:"agent-progress","aria-label":"总进度"});for(const t of tasks)progress.append(el("span",{class:`task-${t.state}`,title:`${t.id} ${t.subject}`}));section.append(progress);
  for(const m of members)section.append(el("div",{class:"agent-roster"},avatar(),el("div",{},el("strong",{},m.name),el("div",{class:"muted"},roles[m.role]??m.role),el("div",{},m.currentTask?`正在执行 ${m.currentTask}`:m.activity==="working"?"工作中":"等待")),el("span",{class:"tag"},`${m.done}/${m.total}`)));
  if(tasks.length)section.append(el("h3",{},"任务依赖"));
  if(tasks.length){
    const diagram=el("div",{class:"agent-dag"});
    for(const depth of [...new Set(tasks.map(t=>t.depth))].sort((a,b)=>a-b))diagram.append(el("div",{class:"agent-dag-column"},tasks.filter(t=>t.depth===depth).map(t=>btn(`${t.id} ${t.subject}`,"git-branch",async()=>document.getElementById(`agent-task-${t.id}`)?.scrollIntoView({block:"nearest"}),`task-${t.state}`))));
    section.append(diagram);
  }
  for(const t of tasks)section.append(el("article",{id:`agent-task-${t.id}`,class:`agent-task task-${t.state}`},el("div",{class:"meta"},el("strong",{},t.id),el("span",{},({open:"待执行",blocked:"等待依赖",running:"进行中",completed:"已交付",failed:"失败",cancelled:"取消"})[t.state]??t.state)),el("h3",{},t.subject),el("p",{},t.description??""),el("div",{class:"meta"},el("span",{},t.assignee||"未分配"),el("span",{},t.dependencies.length?`依赖 ${t.dependencies.join("、")}`:"无前置任务")),run.summary.results?.find(r=>r.id===t.id)?.output?el("details",{},el("summary",{},"交付结果"),el("pre",{},run.summary.results.find(r=>r.id===t.id).output)):null));
  section.append(el("details",{},el("summary",{},`仓库快照 · ${run.definition.repositories.length}`),(run.summary.repositories??run.definition.repositories).map(r=>el("div",{class:"memory"},el("strong",{},r.name),el("div",{},r.branch),el("code",{},r.commit??"等待检出")))));
  section.append(el("details",{},el("summary",{},"近期对话"),(run.summary.messages??[]).map(m=>el("div",{class:"memory"},el("strong",{},m.sessionId===run.summary.captainSessionId?"队长":members.find(a=>a.id===m.sessionId)?.name??"Agent"),el("pre",{},m.text)))));
}
export async function renderRepositories(section,ui){
  const {el,btn,field,form,api,base,project,refresh}=ui,manager=["project_manager","technical_director"].includes(project.role);
  section.append(el("h2",{},"GitLab 仓库"));
  if(manager){const token=field("访问令牌（私有仓库）","token","password");token.querySelector("input").required=false;
    section.append(el("details",{},el("summary",{},"关联仓库"),form([field("目录名称（英文、数字、短横线）","name"),field("GitLab HTTPS / HTTP 克隆地址","url","url"),field("分支","branch","text","main"),token],"关联",async v=>{await api(base+"/repositories","POST",v);await refresh();})));
  }
  const repos=await api(base+"/repositories");if(!repos.length)section.append(el("div",{class:"empty"},"尚未关联仓库"));
  for(const r of repos)section.append(el("article",{class:"memory"},el("h3",{},r.name),el("code",{},r.url),el("div",{class:"meta"},el("span",{},r.branch),el("span",{},r.hasToken?"已配置凭据":"无凭据")),manager?btn("解除关联","trash-2",async()=>{await api(base+"/repositories/"+r.id,"DELETE",{});await refresh();}):null));
}
