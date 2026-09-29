const views=new Map();
const stateNames={todo:"待开始",doing:"进行中",paused:"暂停",done:"完成"};
const actions={"project.configured":"更新了项目指令与技能","expert.imported":"添加了专家团","plan.created":"创建了项目计划","plan.updated":"更新了项目计划","asset.added":"添加了项目资产","asset.removed":"移除了项目资产","automation.created":"创建了自动化","automation.updated":"更新了自动化","agent-run.created":"发起了 Agent 协作","agent-run.approve":"批准了协作计划","agent-run.cancel":"停止了协作","repository.added":"关联了 GitLab 仓库","member.added":"添加了项目成员","project.created":"创建了项目"};
Object.assign(actions,{"agent-run.delivered":"提交了协作成果","session.updated":"更新了项目会话","member.invited":"邀请了项目成员","member.joined":"加入了项目","member.removed":"移除了项目成员","memory.withdrawn":"撤销了项目记忆","repository.removed":"解除了仓库关联","agent.added":"添加了 Agent","agent.removed":"移除了 Agent"});
const newId=()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;return [...b].map((v,i)=>([4,6,8,10].includes(i)?"-":"")+v.toString(16).padStart(2,"0")).join("");};
export async function renderWorkbench(section,ui){
  const {el,btn,field,form,api,base,project,refresh,formatDate,user}=ui;
  if(!views.has(base))views.set(base,{tab:"activity",folder:null,filter:"all",query:"",expertQuery:""});
  const state=views.get(base),manager=["project_manager","technical_director"].includes(project.role),endpoint=base+"/workbench";
  const dialog=(title,fields,label,submit)=>{const d=el("dialog",{class:"workspace-dialog"});d.append(el("h2",{},title),form(fields,label,async v=>{await submit(v,d);d.close();}),btn("取消","arrow-left",async()=>d.close()));d.addEventListener("close",()=>d.remove(),{once:true});document.body.append(d);d.showModal();};
  const textarea=(label,name,value="")=>el("label",{},label,el("textarea",{name,rows:4,maxlength:12000},value));
  const select=(label,name,items,value)=>el("label",{},label,el("select",{name,"aria-label":label},items.map(([id,title])=>el("option",{value:id,selected:id===value},title))));
  const choices=(label,name,items)=>el("fieldset",{},el("legend",{},label),items.map(i=>el("label",{class:"check"},el("input",{type:"checkbox",name,value:i.id,checked:i.checked??items.length<=16}),i.name)));
  section.append(el("div",{class:"page-title"},el("img",{src:"./agent-team.png",alt:"",width:32,height:32}),el("h2",{},"项目工作台")));
  const navigation=el("div",{class:"workbench-tabs",role:"tablist","aria-label":"项目视图"});
  for(const [id,label] of [["activity","动态"],["plan","计划"],["tasks","任务"],["assets","资产"],["config","配置"]]){const b=btn(label,id==="config"?"settings-2":null,async()=>{state.tab=id;await refresh();},state.tab===id?"active":"");b.setAttribute("role","tab");b.setAttribute("aria-selected",String(state.tab===id));navigation.append(b);}
  section.append(navigation);
  async function execute(item){const [agents,repos]=await Promise.all([api(base+"/agents"),api(base+"/repositories")]);if(!agents.length)throw new Error("请先在配置中添加专家或 Agent");const operationId=newId();dialog("交给 Agent 执行",[choices("专家成员","agentIds",agents),choices("GitLab 仓库","repositoryIds",repos)],"发起执行",async(v,d)=>{const values=new FormData(d.querySelector("form"));await api(endpoint+`/items/${item.id}/run`,"POST",{version:item.version,operationId,agentIds:values.getAll("agentIds"),repositoryIds:values.getAll("repositoryIds")});await refresh();});}
  async function edit(item={},initial="todo"){
    const members=await api(base+"/members"),due=field("截止时间","dueAt","datetime-local",item.due_at?new Date(new Date(item.due_at).getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):"");due.querySelector("input").required=false;
    dialog(item.id?"编辑待办":"新建待办",[field("待办标题","title","text",item.title??""),textarea("任务说明","description",item.description),select("状态","state",Object.entries(stateNames),item.state??initial),select("可见范围","visibility",[["shared","项目共享"],["private","仅自己"]],item.visibility??"shared"),select("负责人","assignee",[["","未分配"],...members.map(m=>[m.id,m.name])],item.assignee??""),due],"保存待办",async v=>{await api(endpoint+"/items"+(item.id?"/"+item.id:""),"POST",{...v,dueAt:v.dueAt?new Date(v.dueAt).toISOString():null,version:item.version});await refresh();});
  }
  if(state.tab==="activity"){
    const items=await api(endpoint+"/activity");
    const mine=el("input",{type:"checkbox",checked:state.filter==="mine",onChange:async e=>{state.filter=e.target.checked?"mine":"all";await refresh();}});
    section.append(el("label",{class:"check"},mine,"仅看我的动态"));
    const visible=items.filter(i=>state.filter!=="mine"||i.name===user.name);
    for(const item of visible)section.append(el("article",{class:"workbench-event"},el("span",{class:"event-avatar"},(item.name??"系统").slice(0,1)),el("div",{},el("strong",{},item.name??"系统"),el("p",{},actions[item.action]??"更新了项目"),item.title?el("p",{},item.title):null,el("span",{class:"muted"},formatDate(item.created_at)))));
    if(!visible.length)section.append(el("div",{class:"empty"},"暂无项目动态"));
  }else if(["plan","tasks"].includes(state.tab)){
    const all=await api(endpoint+"/items");
    const controls=el("div",{class:"workbench-toolbar"},btn("新建待办","plus",()=>edit(),"primary"));
    const filter=el("select",{"aria-label":"任务范围",onChange:async e=>{state.filter=e.target.value;await refresh();}},[["all","全部任务"],["mine","由我创建"],["assigned","分配给我"],["private","个人任务"],["shared","协同任务"]].map(([id,label])=>el("option",{value:id,selected:id===state.filter},label)));
    const search=el("input",{type:"search","aria-label":"搜索任务",placeholder:"搜索任务",value:state.query});
    controls.append(filter,search);section.append(controls);
    const container=el("div");section.append(container);
    const draw=()=>{
      const items=all.filter(i=>(state.filter==="mine"?i.created_by===user.id:state.filter==="assigned"?i.assignee===user.id:["private","shared"].includes(state.filter)?i.visibility===state.filter:true)&&`${i.title} ${i.description}`.toLowerCase().includes(state.query.toLowerCase()));
      container.replaceChildren();
      const card=item=>{const editable=item.created_by===user.id||item.assignee===user.id||manager;
        return el("article",{class:`plan-item plan-${item.state}`},el("h3",{},item.title),el("p",{},item.description),el("div",{class:"meta"},el("span",{},item.assignee_name??"未分配"),el("span",{},item.visibility==="private"?"仅自己":"项目共享"),item.due_at?el("time",{},formatDate(item.due_at)):null),item.run_id?el("p",{class:"muted"},`Agent · ${item.run_state}`):null,editable?el("div",{class:"workbench-toolbar"},btn("编辑待办","settings-2",()=>edit(item),"icon-only"),btn("删除待办","trash-2",async()=>{await api(endpoint+"/items/"+item.id,"DELETE",{version:item.version});await refresh();},"icon-only danger"),item.visibility==="shared"&&(!item.run_id||["completed","failed","cancelled"].includes(item.run_state))?btn("交给 Agent","bot",()=>execute(item)):null,el("select",{"aria-label":`状态：${item.title}`,onChange:async e=>{await api(endpoint+"/items/"+item.id,"POST",{version:item.version,state:e.target.value});await refresh();}},Object.entries(stateNames).map(([id,label])=>el("option",{value:id,selected:item.state===id},label)))):null);};
      if(state.tab==="plan"){
        const board=el("div",{class:"plan-board"});
        for(const [id,label] of Object.entries(stateNames)){
          const heading=el("div",{class:"plan-column-heading"},el("h3",{},label),el("span",{class:"muted"},String(items.filter(i=>i.state===id).length)),btn(`新建${label}待办`,"plus",()=>edit({},id),"icon-only"));
          const column=el("section",{class:"plan-column"},heading);
          for(const item of items.filter(i=>i.state===id))column.append(card(item));
          board.append(column);
        }
        container.append(board);
      }
      else{for(const item of items)container.append(card(item));if(!items.length)container.append(el("div",{class:"empty"},"暂无符合条件的任务"));}
    };search.addEventListener("input",()=>{state.query=search.value;draw();});draw();
  }else if(state.tab==="assets"){
    const assets=await api(endpoint+"/assets");if(state.folder&&!assets.some(a=>a.id===state.folder))state.folder=null;
    const parent=assets.find(a=>a.id===state.folder);
    const upload=el("input",{type:"file","aria-label":"上传项目文件",hidden:true,onChange:async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>5*1024*1024)throw new Error("文件不能超过 5 MB");const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(",")[1]);reader.onerror=reject;reader.readAsDataURL(file);});await api(endpoint+"/assets","POST",{name:file.name,parentId:state.folder,base64});await refresh();}catch(error){document.getElementById("content").prepend(el("div",{class:"error",role:"alert"},error.message));}}});
    section.append(el("div",{class:"workbench-toolbar"},parent?btn("上级目录","arrow-left",async()=>{state.folder=parent.parent_id;await refresh();}):null,btn("新建文件夹","plus",()=>dialog("新建文件夹",[field("文件夹名称","name")],"创建",async v=>{await api(endpoint+"/assets","POST",{name:v.name,parentId:state.folder,folder:true});await refresh();})),btn("上传文件","upload",()=>upload.click()),upload),el("p",{class:"muted"},`${parent?.name??"项目资产"} · ${(assets.reduce((s,a)=>s+(a.size??0),0)/1024/1024).toFixed(1)} / 100 MB`));
    for(const asset of assets.filter(a=>a.parent_id===state.folder))section.append(el("article",{class:"asset-row"},el("div",{},el("strong",{},asset.name),el("p",{class:"muted"},asset.folder?"文件夹":`${(asset.size/1024).toFixed(1)} KB`)),asset.folder?btn("打开文件夹","folder",async()=>{state.folder=asset.id;await refresh();},"icon-only"):btn("下载文件","download",async()=>{const file=await api(endpoint+"/assets/"+asset.id),bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"})),a=el("a",{href:url,download:file.name});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},"icon-only"),asset.created_by===user.id||manager?btn("删除资产","trash-2",async()=>{await api(endpoint+"/assets/"+asset.id,"DELETE",{});await refresh();},"icon-only danger"):null));
  }else{
    const [config,catalog,automations,agents,repos]=await Promise.all([api(endpoint+"/config"),api(endpoint+"/catalog"),api(endpoint+"/automations"),api(base+"/agents"),api(base+"/repositories")]);
    section.append(el("h3",{},"项目指令"));
    if(manager)section.append(form([textarea("项目背景与协作规范","instructions",config.instructions)],"保存项目指令",async v=>{await api(endpoint+"/config","POST",{...v,skills:config.skills,version:config.version});await refresh();}));else section.append(el("p",{},config.instructions||"暂无项目指令"));
    section.append(el("h3",{class:"workbench-section-title"},`专家与技能 · ${catalog.length}`));
    const search=el("input",{type:"search","aria-label":"搜索专家团",placeholder:"搜索专家团",value:state.expertQuery}),list=el("div",{class:"expert-catalog"});section.append(search,list);
    const draw=()=>{list.replaceChildren();for(const group of catalog.filter(g=>`${g.name} ${g.description} ${g.id}`.toLowerCase().includes(state.expertQuery.toLowerCase()))){
      const enabled=config.skills.includes(group.id);
      const members=group.members.length?group.members:[{id:"lead",name:group.name,checked:true},...group.resources.map((r,i)=>({id:`resource-${i}`,name:r.name,checked:false}))];
      list.append(el("article",{class:"expert-item"},el("h3",{},group.name),el("p",{class:"muted"},group.description),el("div",{class:"meta"},el("span",{},group.members.length?`${group.members.length} 位已映射成员`:`主理人及 ${group.resources.length} 份角色资源`),el("span",{},enabled?"技能已启用":"技能未启用")),manager?el("div",{class:"workbench-toolbar"},btn("添加专家团","users",()=>dialog(group.name,[choices("参与成员（最多 16 位）","memberIds",members)],"加入项目",async(v,d)=>{await api(endpoint+"/experts","POST",{groupId:group.id,memberIds:new FormData(d.querySelector("form")).getAll("memberIds")});await refresh();})),el("label",{class:"check"},el("input",{type:"checkbox",checked:enabled,onChange:async e=>{try{await api(endpoint+"/config","POST",{instructions:config.instructions,version:config.version,skills:e.target.checked?[...config.skills,group.id]:config.skills.filter(id=>id!==group.id)});await refresh();}catch(error){e.target.checked=enabled;document.getElementById("content").prepend(el("div",{class:"error",role:"alert"},error.message));}}}),"启用技能")):null));}};search.addEventListener("input",()=>{state.expertQuery=search.value;draw();});draw();
    section.append(el("h3",{class:"workbench-section-title"},`GitLab 连接器 · ${repos.length}`),el("div",{class:"muted"},repos.map(r=>r.name).join("、")||"尚未关联仓库"));
    section.append(el("h3",{class:"workbench-section-title"},"自动化"));
    if(manager)section.append(btn("新建自动化","plus",()=>dialog("新建自动化",[field("自动化名称","title"),textarea("执行目标","goal"),field("间隔（分钟）","intervalMinutes","number","1440"),field("首次运行","nextAt","datetime-local"),choices("参与 Agent","agentIds",agents),choices("参与仓库","repositoryIds",repos),el("label",{class:"check"},el("input",{type:"checkbox",required:true}),"允许到期后自动批准并执行任务")],"启用自动化",async(v,d)=>{const values=new FormData(d.querySelector("form"));await api(endpoint+"/automations","POST",{...v,autoApprove:true,intervalMinutes:Number(v.intervalMinutes),nextAt:new Date(v.nextAt).toISOString(),agentIds:values.getAll("agentIds"),repositoryIds:values.getAll("repositoryIds")});await refresh();})));
    for(const a of automations)section.append(el("article",{class:"memory"},el("h3",{},a.title),el("p",{},`每 ${a.interval_minutes} 分钟 · ${a.enabled?"已启用":"已暂停"}`),el("p",{class:"muted"},`下次：${formatDate(a.next_at)}`),a.error?el("p",{class:"error"},a.error):null,manager?el("div",{class:"workbench-toolbar"},btn(a.enabled?"暂停自动化":"启用自动化",a.enabled?"square":"check",async()=>{await api(endpoint+"/automations/"+a.id,"POST",{enabled:!a.enabled});await refresh();}),btn("删除自动化","trash-2",async()=>{await api(endpoint+"/automations/"+a.id,"DELETE",{});await refresh();},"icon-only danger")):null));
  }
}
