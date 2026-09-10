import { createIcons, Users, LogOut, RefreshCw, Plus, Search, Link, Database, Activity, FileText, Trash2 } from "lucide";

const icons = { Users, LogOut, RefreshCw, Plus, Search, Link, Database, Activity, FileText, Trash2 };
const plugin = location.pathname.startsWith("/team-plugin");
const root = document.getElementById("app");
const roles = { technical_director:"技术总监", product_manager:"产品经理", project_manager:"项目经理", developer:"开发工程师", qa_engineer:"测试工程师" };
let user = null, auth = null, projects = [], selected = "", tab = "memories", local = null, busy = false;
let invitation = new URLSearchParams(location.hash.slice(1)).get("invite") || "";
if (invitation) history.replaceState(null,"",location.pathname);
const errorNames = { invalid_credentials:"账号或密码错误",password_change_required:"请先修改初始密码",role_not_granted:"该用户尚未获得所选组织角色",invalid_invite:"邀请无效或已过期",permission_denied:"没有该操作权限",session_project_conflict:"此会话已绑定其他项目",project_access_revoked:"项目访问权限已撤销",already_exists:"记录已存在",invalid_request:"请检查填写内容",unauthorized:"登录已失效，请重新登录",model_not_configured:"尚未配置整理模型",owner_transfer_required:"请先移交项目负责人",user_not_found:"用户不存在",snapshot_capacity_exceeded:"项目记忆超过当前快照容量上限" };
const statuses = {queued:"等待整理",running:"模型整理中",succeeded:"已自动发布",retry_wait:"等待重试",failed:"整理失败",cancelled:"已取消"};
function el(tag, props={}, ...children) {
  const node=document.createElement(tag);
  for(const [k,v] of Object.entries(props)) {
    if(k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(),v);
    else if(k==="class") node.className=v;
    else if(k==="text") node.textContent=v;
    else if(v!==false && v!=null) node.setAttribute(k,v===true?"":v);
  }
  children.flat().forEach(c=>{if(c!=null)node.append(typeof c==="string"?document.createTextNode(c):c);}); return node;
}
const icon = name => el("i",{"data-lucide":name});
const btn = (label, name, action, cls="") => el("button",{type:"button",class:cls,title:label,onClick:()=>run(action)},icon(name),label);
const field = (label,name,type="text",value="") => el("label",{},label,el("input",{name,type,value,required:true,autocomplete:type==="password"?"current-password":"off"}));
function roleSelect() { return el("label",{},"项目角色",el("select",{name:"role"},Object.entries(roles).map(([k,v])=>el("option",{value:k,selected:k==="developer"},v)))); }
function formatDate(value){return new Date(value).toLocaleString("zh-CN",{hour12:false});}
function paintIcons(){createIcons({icons});}
async function request(url,options){const r=await fetch(url,options);const v=await r.json();if(!r.ok){const e=new Error(v.error||"request_failed");e.status=r.status;throw e;}return v;}
async function localCall(action,input={}) {return request("/team-plugin/local",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,...input})});}
async function api(route,method="GET",input){
  if(plugin)return localCall("api",{route,method,input});
  if(auth && auth.expires<Date.now()+30000){auth=await request("/team/v1/auth/refresh",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({refreshToken:auth.refreshToken})});}
  return request("/team/v1"+route,{method,headers:{"content-type":"application/json",...(auth?{authorization:"Bearer "+auth.accessToken}:{})},body:input===undefined?undefined:JSON.stringify(input)});
}
function error(e){if(e.status===401){user=null;auth=null;loginPage();}document.querySelector(".error")?.remove();root.prepend(el("div",{class:"error",role:"alert"},errorNames[e.message]||e.message));}
async function run(fn){if(busy)return;busy=true;try{await fn();}catch(e){error(e);}finally{busy=false;paintIcons();}}
function form(fields, label, fn) {
  const f=el("form",{class:"stack",onSubmit:event=>{event.preventDefault();run(async()=>{const b=f.querySelector("button[type=submit]");b.disabled=true;try{await fn(Object.fromEntries(new FormData(f)));}finally{b.disabled=false;}});}},fields,el("button",{type:"submit",class:"primary"},label));return f;
}
function loginPage(){
  root.replaceChildren(el("header",{},el("div",{class:"brand"},icon("users"),el("h1",{},"DSH Team Hub"))));
  const fields=[];if(plugin)fields.push(field("内网服务地址","hub","url",local?.hub||"http://192.168.10.20:3090"));
  fields.push(field("账号","name"),field("密码","password","password"));
  root.append(el("main",{},el("section",{class:"login"},el("h2",{},"团队登录"),form(fields,"登录",async values=>{
    if(plugin)user=await localCall("login",values);
    else {auth=await api("/auth/login","POST",{...values,device:"web-console"});user=auth.user;}
    if(user.mustChangePassword)passwordPage();else await load();
  }))));paintIcons();
}
function passwordPage(){root.replaceChildren(el("main",{},el("section",{class:"login"},el("h2",{},"修改初始密码"),form([
  field("当前密码","current","password"),field("新密码（至少 10 位）","next","password")],"保存新密码",async values=>{
    if(plugin)user=await localCall("password",values);else{auth=await api("/auth/change-password","POST",values);user=auth.user;}await load();
  }))));}
async function load(){projects=await api("/projects");if(!projects.some(p=>p.id===selected))selected=projects[0]?.id||"";if(plugin)local=await localCall("state");await shell();}
async function shell(){
  root.replaceChildren(el("header",{},el("div",{class:"brand"},icon("users"),el("h1",{},"DSH Team Hub")),el("span",{class:"spacer"}),el("span",{class:"status",id:"sync-status"},plugin?`${local?.status||""} · 待上传 ${local?.pending||0}`:"内网协作"),el("span",{class:"muted"},user.name),btn("退出","log-out",async()=>{if(plugin)await localCall("logout");else await api("/auth/logout","POST",{});auth=null;user=null;loginPage();})));
  const main=el("main");root.append(main);
  const select=el("select",{"aria-label":"当前项目",onChange:async e=>{if(busy){e.target.value=selected;return;}selected=e.target.value;await run(content);}},projects.map(p=>el("option",{value:p.id,selected:p.id===selected},p.name)));
  main.append(el("div",{class:"toolbar"},select,btn("刷新","refresh-cw",async()=>{if(plugin)await localCall("sync");await load();})));
  if(user.roles.includes("project_manager"))main.append(el("details",{},el("summary",{},"创建项目"),el("div",{class:"form-band"},form([field("项目名称","name")],"创建项目",async values=>{const p=await api("/projects","POST",values);selected=p.id;await load();}))));
  main.append(el("details",{open:Boolean(invitation)},el("summary",{},"接受项目邀请"),el("div",{class:"form-band"},form([field("邀请令牌","token","text",invitation)],"加入项目",async values=>{const p=await api("/invites/accept","POST",values);invitation="";selected=p.projectId;await load();}))));
  if(user.admin)main.append(el("details",{},el("summary",{},"添加团队账号"),el("div",{class:"form-band"},form([field("账号","name"),field("初始密码（至少 10 位）","password","password"),roleSelect()],"添加账号",async values=>{await api("/users","POST",{...values,roles:[values.role]});await load();}))));
  const tabs=[["memories","项目记忆","database"],["sessions","会话摘要","file-text"],["members","项目成员","users"],["jobs","整理任务","activity"]];
  if(plugin)tabs.push(["bindings","本地绑定","link"]);
  main.append(el("nav",{},tabs.map(([id,label,name])=>btn(label,name,async()=>{tab=id;await content();},tab===id?"active":""))),el("section",{id:"content",class:"content"}));
  await content();paintIcons();
}
function table(headers,rows){return el("div",{class:"table-scroll"},el("table",{},el("thead",{},el("tr",{},headers.map(t=>el("th",{},t)))),el("tbody",{},rows.map(r=>el("tr",{},r.map(c=>el("td",{},c)))))));}
async function content(){
  const section=document.getElementById("content");if(!section)return;
  if(plugin){local=await localCall("state");const status=document.getElementById("sync-status");if(status)status.textContent=`${local.status} · 待上传 ${local.pending}`;}
  section.replaceChildren(); document.querySelectorAll("nav button").forEach((b,i)=>b.classList.toggle("active",["memories","sessions","members","jobs","bindings"][i]===tab));
  if(!selected){section.append(el("div",{class:"empty"},"暂无项目"));return;}
  const project=projects.find(p=>p.id===selected),base=`/projects/${selected}`;
  if(tab==="memories"){
    section.append(el("h2",{},"项目记忆"));
    const list=el("div");
    function memories(items){list.replaceChildren();if(!items.length)list.append(el("div",{class:"empty"},"暂无项目记忆"));
      for(const m of items)list.append(el("article",{class:"memory"},el("h3",{},m.title),el("p",{},m.content),el("div",{class:"meta"},el("span",{},m.category),el("span",{class:"tag"},m.evidence==="uncertain"?"证据不足":"对话陈述"),el("span",{},`模型整理 · v${m.version}`),el("code",{},m.id)),["project_manager","technical_director"].includes(project.role)?btn("撤销","trash-2",async()=>{await api(`${base}/memories/${m.id}/withdraw`,"POST",{});await content();},"danger"):null));
    }
    const search=form([field("搜索记忆","query","search")],"搜索",async v=>memories(await api(base+"/memories/search","POST",v)));search.className="search-form";search.querySelector("button").prepend(icon("search"));section.append(search,list);
    memories((await api(base+"/snapshot")).memories);
  }else if(tab==="sessions"){
    section.append(el("h2",{},"会话摘要"));const items=await api(base+"/shared-sessions");
    if(!items.length)section.append(el("div",{class:"empty"},"暂无会话摘要"));
    for(const s of items)section.append(el("article",{class:"memory"},el("h3",{},s.name),el("p",{},s.content),el("div",{class:"meta"},s.session,formatDate(s.created_at),"模型自动整理")));
  }else if(tab==="jobs"){
    section.append(el("h2",{},"整理任务"));const cap=await api("/capabilities");if(!cap.modelConfigured)section.append(el("div",{class:"notice"},"整理模型尚未配置"));
    const jobs=await api(base+"/model-jobs");section.append(table(["成员","状态","尝试次数","模型","时间"],jobs.map(j=>[j.name,statuses[j.state]||j.state,String(j.attempts),j.model||j.error||"—",formatDate(j.created_at)])));
  }else if(tab==="members"){
    section.append(el("h2",{},"项目成员"));const members=await api(base+"/members");
    section.append(table(["账号","角色","操作"],members.map(m=>[m.name+(m.id===project.owner_id?"（负责人）":""),roles[m.role],project.role==="project_manager"&&m.id!==project.owner_id?btn("移除","trash-2",async()=>{await api(`${base}/members/${m.id}`,"DELETE",{});await load();},"danger"):""])));
    if(project.role==="project_manager"){
      const output=el("div",{class:"result"});section.append(el("div",{class:"form-band"},form([field("受邀账号","name"),roleSelect()],"生成邀请",async v=>{
        const inv=await api(base+"/invites","POST",v),hub=plugin?local.hub:location.origin;
        output.replaceChildren(el("div",{},"邀请链接"),el("a",{href:hub+"/#invite="+encodeURIComponent(inv.token),target:"_blank",rel:"noreferrer"},hub+"/#invite="+inv.token),el("p",{},"令牌：",el("code",{},inv.token)));
      }),output));
      if(project.owner_id===user.id){const targets=members.filter(m=>m.role==="project_manager"&&m.id!==user.id);if(targets.length)section.append(el("details",{},el("summary",{},"移交负责人"),form([el("label",{},"新负责人",el("select",{name:"userId"},targets.map(m=>el("option",{value:m.id},m.name))))],"移交",async v=>{await api(base+"/transfer-owner","POST",v);await load();})));}
    }
  }else if(tab==="bindings"){
    local=await localCall("state");section.append(el("h2",{},"本地会话绑定"));
    if(!local.autoContext)section.append(el("div",{class:"notice"},"自动上下文注入不可用"));
    const sessions=local.sessions??[];
    if(!sessions.length)section.append(el("div",{class:"empty"},"暂无运行中的本地会话"));
    else section.append(form([el("label",{},"本地会话",el("select",{name:"sessionId"},sessions.map(s=>el("option",{value:s.id},s.id+" · "+s.cwd)))),el("label",{class:"check"},el("input",{type:"checkbox",name:"workspace"}),"该目录后续新会话自动绑定")],"绑定当前项目",async v=>{await localCall("bind",{...v,projectId:selected,workspace:v.workspace==="on"});await content();}));
    section.append(table(["会话","项目","采集位置"],Object.entries(local.bindings).map(([id,b])=>[id,projects.find(p=>p.id===b.projectId)?.name||b.projectId,String(b.cursor)])));
  }
  paintIcons();
}
await run(async()=>{if(plugin){local=await localCall("state");user=local.user;if(user){if(user.mustChangePassword)passwordPage();else await load();return;}}loginPage();});
