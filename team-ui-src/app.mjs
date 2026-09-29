import { createIcons, Users, LogOut, RefreshCw, Plus, Search, Link, Database, Activity, FileText, Trash2, Copy, ArrowLeft, Bot, GitBranch, Check, Square, Settings2, LayoutDashboard, Upload, Download, Folder, KeyRound, Edit3, X } from "lucide";
import { renderAgents, renderRepositories } from "./agent-ui.mjs";
import { renderWorkbench } from "./workbench-ui.mjs";

const icons = { Users, LogOut, RefreshCw, Plus, Search, Link, Database, Activity, FileText, Trash2, Copy, ArrowLeft, Bot, GitBranch, Check, Square, Settings2, LayoutDashboard, Upload, Download, Folder, KeyRound, Edit3, X };
const plugin = location.pathname.startsWith("/team-plugin");
document.documentElement.classList.toggle("plugin-panel", plugin);
if (plugin && window.parent !== window) {
  // The iframe does not inherit Harness tokens; copy their resolved values from its same-origin host.
  const host = window.parent.document;
  let appliedTokens = [];
  const syncTheme = () => {
    const style = window.parent.getComputedStyle(host.body);
    document.documentElement.toggleAttribute("data-ds-dark-theme", host.body.hasAttribute("data-ds-dark-theme"));
    for (const name of appliedTokens) document.documentElement.style.removeProperty(name);
    appliedTokens = [];
    for (const name of style) {
      if (name.startsWith("--dsw-")) { document.documentElement.style.setProperty(name, style.getPropertyValue(name)); appliedTokens.push(name); }
    }
  };
  syncTheme();
  const observer = new MutationObserver(syncTheme);
  for (const target of [host.documentElement, host.body]) observer.observe(target, { attributes:true, attributeFilter:["class", "style", "data-ds-dark-theme"] });
  window.addEventListener("pagehide", () => observer.disconnect(), { once:true });
}
const root = document.getElementById("app");
const roles = { technical_director:"技术总监", product_manager:"产品经理", project_manager:"项目经理", developer:"开发工程师", qa_engineer:"测试工程师" };
let user = null, auth = null, projects = [], selected = "", tab = "workbench", local = null, busy = false;
let sharedSelection=null, sessionOffset=0, messagePages=1;
let contentGeneration=0, memoryQuery="", memoryDraft="";
const renderedContent=new WeakMap();
const promptedWorkspaces=new Set();
const errorNames = { invalid_credentials:"账号或密码错误",password_change_required:"请先修改初始密码",role_not_granted:"该用户尚未获得所选组织角色",invalid_invite:"邀请无效或已过期",permission_denied:"没有该操作权限",session_project_conflict:"此会话已绑定其他项目",project_access_revoked:"项目访问权限已撤销",already_exists:"记录已存在",invalid_request:"请检查填写内容",unauthorized:"登录已失效，请重新登录",model_not_configured:"尚未配置整理模型",owner_transfer_required:"请先移交项目负责人",user_not_found:"用户不存在",snapshot_capacity_exceeded:"项目记忆超过当前快照容量上限" };
const statuses = {queued:"等待整理",running:"模型整理中",succeeded:"已自动发布",retry_wait:"等待重试",failed:"整理失败",cancelled:"已取消"};
Object.assign(errorNames,{edit_conflict:"内容已被其他成员更新，请刷新后再编辑",skill_limit:"一个项目最多启用 12 个专家技能",share_before_run:"请先将个人待办改为项目共享",run_already_active:"此待办已有正在执行的协作",folder_not_empty:"文件夹非空，请先移除其中的文件",asset_too_large:"单个文件不能超过 5 MB",asset_quota_exceeded:"项目资产已达到容量或数量上限",automation_approval_required:"请确认允许自动批准并执行",unknown_expert:"专家定义不存在",agent_model_not_configured:"请管理员先配置 Agent 执行模型"});
Object.assign(errorNames,{workspace_service_unavailable:"当前 Desktop 未提供工作区服务",workspace_not_found:"工作区不存在",workspace_project_conflict:"此工作区已关联其他团队项目",workspace_binding_required:"请先关联目标项目的本地工作区",session_creation_unavailable:"当前 Desktop 未提供会话创建服务",identity_changed:"账号已切换，请重新操作",empty_session:"该会话暂无可复用记录",sso_not_logged_in:"未检测到已登录的野马通行证",sso_not_configured:"服务端尚未配置野马通行证",sso_unavailable:"野马通行证暂时不可用",sso_timeout:"野马通行证连接超时",sso_token_invalid:"野马通行证登录态已失效",sso_invalid_response:"野马通行证返回格式异常",sso_identity_conflict:"该通行证账号已绑定其他团队账号",sso_configuration_invalid:"服务端野马通行证配置无效",sso_request_failed:"野马通行证请求失败",sso_invalid_request:"野马通行证请求参数无效",sso_conflict:"野马通行证账号状态冲突",sso_credentials_required:"请输入野马通行证账号和密码",sso_secure_transport_required:"SSO 登录需要使用 HTTPS（本机 localhost 可用于开发）",sso_transport_check_failed:"无法确认服务端传输安全状态，请改用 HTTPS"});
function el(tag, props={}, ...children) {
  const node=document.createElement(tag);
  for(const [k,v] of Object.entries(props)) {
    if(k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(),event=>{try{Promise.resolve(v(event)).catch(error);}catch(e){error(e);}});
    else if(k==="class") node.className=v;
    else if(k==="text") node.textContent=v;
    else if(v!==false && v!=null) node.setAttribute(k,v===true?"":v);
  }
  children.flat().forEach(c=>{if(c!=null)node.append(typeof c==="string"?document.createTextNode(c):c);}); return node;
}
const icon = name => el("i",{"data-lucide":name});
const btn = (label, name, action, cls="") => el("button",{type:"button",class:cls,title:label,"aria-label":label,onClick:()=>run(action)},name?icon(name):null,el("span",{},label));
const field = (label,name,type="text",value="",placeholder="") => el("label",{class:"field"},el("span",{class:"field-label"},label),el("input",{class:"field-input",name,type,value,placeholder,required:true,autocomplete:type==="password"?(name==="next"?"new-password":"current-password"):name==="name"?"username":"off"}));
function roleSelect() { return el("label",{},"项目角色",el("select",{name:"role"},Object.entries(roles).map(([k,v])=>el("option",{value:k,selected:k==="developer"},v)))); }
function formatDate(value){return new Date(value).toLocaleString("zh-CN",{hour12:false});}
function paintIcons(){if(document.querySelector("i[data-lucide]"))createIcons({icons});}
async function request(url,options){const r=await fetch(url,{...options,redirect:"error"});const v=await r.json();if(!r.ok){const e=new Error(v.error||"request_failed");e.status=r.status;throw e;}return v;}
async function localCall(action,input={}) {return request("/team-plugin/local",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,...input})});}
async function desktopSsoToken(){
  const base="http://127.0.0.1:19800";
  let state;
  try {
    const response=await fetch(`${base}/sso/state`,{credentials:"omit",redirect:"error",signal:AbortSignal.timeout(2000)});
    try { state=await response.json(); } catch(cause) { const e=new Error(cause?.name === "AbortError" || cause?.name === "TimeoutError" ? "sso_timeout" : "sso_invalid_response");e.status=e.message === "sso_timeout" ? 504 : 502;throw e; }
    if(!response.ok) {
      const e=new Error(response.status===401?"sso_not_logged_in":"sso_unavailable");e.status=response.status===401?401:503;throw e;
    }
    if(!state || typeof state!=="object" || Array.isArray(state)) { const e=new Error("sso_invalid_response");e.status=502;throw e; }
    if(state.logged_in!==true) { const e=new Error("sso_not_logged_in");e.status=401;throw e; }
    const tokenResponse=await fetch(`${base}/sso/token`,{credentials:"omit",redirect:"error",signal:AbortSignal.timeout(2000)});
    let token;
    try { token=await tokenResponse.json(); } catch(cause) { const e=new Error(cause?.name === "AbortError" || cause?.name === "TimeoutError" ? "sso_timeout" : "sso_invalid_response");e.status=e.message === "sso_timeout" ? 504 : 502;throw e; }
    if(!tokenResponse.ok) {
      const e=new Error(tokenResponse.status===401?"sso_token_invalid":"sso_unavailable");e.status=tokenResponse.status===401?401:503;throw e;
    }
    if(!token || typeof token!=="object" || Array.isArray(token) || typeof token.access_token!=="string" || token.access_token.length<20 || token.access_token.length>8192) { const e=new Error("sso_invalid_response");e.status=502;throw e; }
    const username=typeof state.username === "string" ? state.username.trim() : "";
    if(!username){const e=new Error("sso_invalid_response");e.status=502;throw e;}
    return {accessToken:token.access_token,username};
  } catch(e) {
    if(e?.message && errorNames[e.message]) throw e;
    if(e?.name === "AbortError" || e?.name === "TimeoutError") {
      const error=new Error("sso_timeout");error.status=504;throw error;
    }
    const error=new Error("sso_unavailable");error.status=503;throw error;
  }
}
async function desktopSsoLoggedIn(){
  try {
    const response=await fetch("http://127.0.0.1:19800/sso/state",{credentials:"omit",redirect:"error",signal:AbortSignal.timeout(2000)});
    if(!response.ok)return false;
    const value=await response.json();
      if(!value||typeof value!=="object"||Array.isArray(value)||value.logged_in!==true)return false;
    return {username:typeof value.username==="string"?value.username.trim():""};
  } catch { return null; }
}
function isLoopbackHostname(hostname){
  const value=String(hostname||"").toLowerCase().replace(/^\[|\]$/g,"");
  return value==="localhost"||value==="127.0.0.1"||value==="::1";
}
function ensureSsoPageTransport(){
  if(location.protocol==="https:"||(location.protocol==="http:"&&isLoopbackHostname(location.hostname)))return;
  const error=new Error("sso_secure_transport_required");error.status=400;throw error;
}
async function ssoLogin(values){
  const hub=plugin?values.hub:(location.origin+"/");
  if(plugin) user=await localCall("sso-login",{hub});
  else {
    ensureSsoPageTransport();
    const desktop=await desktopSsoToken();
    auth={...await api("/auth/sso","POST",{accessToken:desktop.accessToken,device:"web-console"}),sso:true,
      ssoUsername:desktop.username};
    user=auth.user;
  }
  if(user.mustChangePassword)passwordPage();else await load();
}
async function ensurePasswordTransport(){
  if(location.protocol!=="http:"||isLoopbackHostname(location.hostname))return;
  let response;
  try { response=await fetch("/health",{credentials:"omit",redirect:"error",signal:AbortSignal.timeout(2000)}); }
  catch { const error=new Error("sso_transport_check_failed");error.status=503;throw error; }
  let value;
  try { value=await response.json(); } catch { const error=new Error("sso_transport_check_failed");error.status=503;throw error; }
  if(!response.ok||!value||typeof value!=="object"||Array.isArray(value)){const error=new Error("sso_transport_check_failed");error.status=503;throw error;}
  if(value.ssoEnabled!==false||value.secureApi!==false){const error=new Error("sso_secure_transport_required");error.status=400;throw error;}
}
async function api(route,method="GET",input){
  if(plugin)return localCall("api",{route,method,input});
  if(auth && auth.expires<Date.now()+30000){const previous=auth;const refreshed=await request("/team/v1/auth/refresh",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({refreshToken:auth.refreshToken})});auth=previous.sso?{...refreshed,sso:true,...(previous.ssoUsername?{ssoUsername:previous.ssoUsername}: {})}:refreshed;}
  return request("/team/v1"+route,{method,headers:{"content-type":"application/json",...(auth?{authorization:"Bearer "+auth.accessToken}:{})},body:input===undefined?undefined:JSON.stringify(input)});
}
function error(e){if(e.status===401){user=null;auth=null;loginPage();}document.querySelector(".error")?.remove();(document.querySelector("dialog[open]")??root.querySelector(".login-page")??root).prepend(el("div",{class:"error",role:"alert"},errorNames[e.message]||e.message));}
async function run(fn){if(busy)return;busy=true;try{await fn();}catch(e){error(e);}finally{busy=false;paintIcons();}}
function form(fields, label, fn) {
  const f=el("form",{class:"stack",onSubmit:event=>{event.preventDefault();run(async()=>{const b=f.querySelector("button[type=submit]");b.disabled=true;try{await fn(Object.fromEntries(new FormData(f)));}finally{b.disabled=false;}});}},fields,el("button",{type:"submit",class:"primary"},label));return f;
}
function loginPage(){
  const badge=el("div",{class:"login-badge"},icon("users"));
  const headerInfo=el("div",{class:"login-header"},badge,el("h2",{class:"login-title"},"团队登录"),el("p",{class:"login-desc"},"连接内网团队服务，同步项目记忆与资产"));
  const fields=[];if(plugin)fields.push(field("内网服务地址","hub","url",local?.hub||"http://192.168.100.46:3090","http://192.168.100.46:3090"));
  fields.push(field("账号","name","text","","请输入团队账号"),field("密码","password","password","","请输入密码"));
  const loginForm=form(fields,"登录",async values=>{
    if(plugin)user=await localCall("login",values);
    else {await ensurePasswordTransport();auth=await api("/auth/login","POST",{...values,device:"web-console"});user=auth.user;}
    if(user.mustChangePassword)passwordPage();else await load();
  });
  loginForm.classList.add("login-form");
  const ssoButton=btn("使用野马通行证登录","key-round",async()=>{
    ssoButton.disabled=true;
    ssoButton.setAttribute("aria-busy","true");
    try { await ssoLogin(Object.fromEntries(new FormData(loginForm))); }
    finally {
      ssoButton.disabled=false;
      ssoButton.removeAttribute("aria-busy");
    }
  },"sso-login");
  const divider=el("div",{class:"login-divider",role:"separator"},el("span",{},"或使用账号密码"));
  const footer=el("div",{class:"login-footer"},el("span",{class:"muted"},"DSH Team Hub · 团队协作服务"));
  const card=el("section",{class:"login login-page"},headerInfo,ssoButton,divider,loginForm,footer);
  const main=el("main",{class:"login-main"},card);
  if(!plugin) root.replaceChildren(el("header",{},el("div",{class:"brand"},icon("users"),el("h1",{},"DSH Team Hub"))),main);
  else root.replaceChildren(main);
  paintIcons();
}
function passwordPage(){
  const passwordForm=form([
    field("当前密码","current","password","","请输入当前初始密码"),field("新密码（至少 10 位）","next","password","","请输入新密码（至少 10 位）")],"保存新密码",async values=>{
      if(plugin)user=await localCall("password",values);else{auth=await api("/auth/change-password","POST",values);user=auth.user;}await load();
    });
  passwordForm.classList.add("login-form");
  const badge=el("div",{class:"login-badge"},icon("key-round"));
  const headerInfo=el("div",{class:"login-header"},badge,el("h2",{class:"login-title"},"修改初始密码"),el("p",{class:"login-desc"},"首次登录请修改初始密码以保障账号安全"));
  const card=el("section",{class:"login login-page"},headerInfo,passwordForm);
  const main=el("main",{class:"login-main"},card);
  if(!plugin) root.replaceChildren(el("header",{},el("div",{class:"brand"},icon("users"),el("h1",{},"DSH Team Hub"))),main);
  else root.replaceChildren(main);
  paintIcons();
}
async function load(){projects=await api("/projects");if(!projects.some(p=>p.id===selected))selected=projects[0]?.id||"";if(plugin)local=await localCall("state");await shell();await promptWorkspace();}
async function shell(){
  root.replaceChildren(el("header",{},el("div",{class:"brand"},icon("users"),el("h1",{},"DSH Team Hub")),el("span",{class:"spacer"}),el("span",{class:"status",id:"sync-status"},plugin?`${local?.status||""} · 待上传 ${local?.pending||0}`:"内网协作"),el("span",{class:"muted"},user.displayName||user.name),btn("退出","log-out",async()=>{if(plugin)await localCall("logout");else await api("/auth/logout","POST",{});auth=null;user=null;loginPage();})));
  const main=el("main");root.append(main);
  if(plugin)root.querySelector("header").insertBefore(btn("插件更新","download",showPluginUpdate),root.querySelector("header").lastElementChild);
  const select=el("select",{"aria-label":"当前项目",onChange:async e=>{if(busy){e.target.value=selected;return;}selected=e.target.value;sharedSelection=null;sessionOffset=0;await run(async()=>{await content();await promptWorkspace();});}},projects.map(p=>el("option",{value:p.id,selected:p.id===selected},p.name)));
  main.append(el("div",{class:"toolbar"},select,btn("刷新","refresh-cw",async()=>{if(plugin)await localCall("sync");await load();})));
  if(user.roles.includes("project_manager"))main.append(el("details",{},el("summary",{},"创建项目"),el("div",{class:"form-band"},form([field("项目名称","name")],"创建项目",async values=>{const p=await api("/projects","POST",values);selected=p.id;await load();}))));
  if(user.admin)main.append(el("details",{},el("summary",{},"添加团队账号"),el("div",{class:"form-band"},form([field("账号","name"),field("初始密码（至少 10 位）","password","password"),roleSelect()],"添加账号",async values=>{await api("/users","POST",{...values,roles:[values.role]});await load();}))));
  if(user.admin) {
    const config=await api("/settings/model"), key=field(config.hasApiKey?"API Key（已配置，留空保留）":"API Key（可选）","apiKey","password");
    key.querySelector("input").required=false;
    main.append(el("details",{},el("summary",{},"整理模型配置"),el("div",{class:"form-band"},form([
      field("模型服务地址","baseUrl","url",config.baseUrl),field("模型名称","name","text",config.name),key,
      field("超时（毫秒）","timeoutMs","number",String(config.timeoutMs)),
      el("label",{class:"check"},el("input",{name:"clearApiKey",type:"checkbox"}),"清除 API Key")
    ],"保存模型配置",async v=>{await api("/settings/model","POST",{...v,timeoutMs:Number(v.timeoutMs),clearApiKey:v.clearApiKey==="on"});await load();}))));
  }
  if(user.admin){
    const config=await api("/settings/agent-model"),key=field(config.hasApiKey?"执行模型 API Key（留空保留）":"执行模型 API Key","apiKey","password");key.querySelector("input").required=false;
    main.append(el("details",{},el("summary",{},"Agent 执行模型"),el("div",{class:"form-band"},form([field("执行模型服务地址","baseUrl","url",config.baseUrl),field("执行模型名称","name","text",config.name),key],"保存执行模型",async v=>{await api("/settings/agent-model","POST",v);await load();}))));
  }
  const tabs=[["memories","项目记忆","database"],["sessions","会话摘要","file-text"],["members","项目成员","users"],["jobs","整理任务","activity"],["agents","Agent 协作","bot"],["repositories","GitLab 仓库","git-branch"]];
  if(plugin){
    const items=[...main.children].filter(node=>node.tagName==="DETAILS");
    if(items.length){
      const menu=el("div",{class:"management-menu",hidden:true},el("h2",{},"项目管理"),items);
      const toggle=btn("项目管理","settings-2",()=>{menu.hidden=!menu.hidden;toggle.setAttribute("aria-expanded",String(!menu.hidden));});
      toggle.setAttribute("aria-expanded","false");
      const management=el("div",{class:"project-management"},toggle,menu);
      main.querySelector(".toolbar").append(management);
      const close=()=>{menu.hidden=true;toggle.setAttribute("aria-expanded","false");};
      management.addEventListener("keydown",event=>{if(event.key==="Escape"){close();toggle.focus();event.stopPropagation();}});
      main.addEventListener("click",event=>{if(!management.contains(event.target))close();});
    }
  }
  if(plugin)tabs.push(["bindings","本地绑定","link"]);
  tabs.unshift(["workbench","项目工作台","layout-dashboard"]);
  main.append(el("nav",{class:"primary-nav"},tabs.map(([id,label,name])=>{const b=btn(label,name,async()=>{tab=id;await content();},tab===id?"active":"");b.dataset.tab=id;return b;})),el("section",{id:"content",class:"content"}));
  await content();paintIcons();
}
async function showPluginUpdate(){
  const dialog=el("dialog",{class:"workspace-dialog"});
  const content=el("div",{class:"stack"});dialog.append(el("h2",{},"插件更新"),content,btn("关闭","arrow-left",async()=>dialog.close()));
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});root.append(dialog);dialog.showModal();
  const labels={idle:"等待版本检查",checking:"检查新版本",downloading:"下载并校验中",installing:"正在安装",restart_required:"已安装新版本，待重启 Desktop",current:"已是最新版本",unsupported:"当前 Desktop 未提供自动安装接口",error:"更新未完成"};
  const errors={invalid_release_signature:"版本签名无效",package_hash_mismatch:"包体校验失败",release_not_published:"云端尚未发布插件",plugin_install_failed:"安装失败，已尝试恢复旧版",plugin_rollback_failed:"恢复旧版失败，请在 Desktop 插件管理中修复",update_in_progress:"其他更新操作正在进行",desktop_updater_unavailable:"当前 Desktop 未提供安装接口",updater_upgrade_required:"此更新需要升级基础更新器",update_download_failed:"无法下载更新，请检查内网连接"};
  function render(value){
    content.replaceChildren(el("p",{},`运行版本：${value.runningVersion}`),el("p",{},`安装版本：${value.installedVersion}`),el("div",{class:"status",role:"status"},labels[value.status]??value.status));
    if(value.error)content.append(el("div",{class:"error"},errors[value.error]??"更新失败，请稍后重试"));
    content.append(el("label",{class:"check"},el("input",{type:"checkbox",checked:value.enabled,onChange:async e=>{render(await localCall("update-settings",{enabled:e.target.checked}));}}),"自动更新插件"));
    if(value.lastChecked)content.append(el("p",{class:"muted"},`上次检查：${formatDate(value.lastChecked)}`));
    const check=btn("检查并更新","refresh-cw",async()=>{check.disabled=true;content.querySelector("[role=status]").textContent="正在检查并安装更新";try{render(await localCall("check-update"));}finally{check.disabled=false;}});
    check.disabled=!value.supported||value.status==="restart_required";content.append(check);paintIcons();
  }
  const state=await localCall("state");render(state.update);
}
function table(headers,rows){return el("div",{class:"table-scroll"},el("table",{},el("thead",{},el("tr",{},headers.map(t=>el("th",{},t)))),el("tbody",{},rows.map(r=>el("tr",{},r.map(c=>el("td",{},c)))))));}
async function content({background=false}={}){
  const target=document.getElementById("content");if(!target)return;
  const generation=background?contentGeneration:++contentGeneration;
  const viewKey=()=>JSON.stringify([selected,tab,sharedSelection,sessionOffset,messagePages]);
  const key=viewKey(),section=el("section");
  function commit(){
    if(generation!==contentGeneration || key!==viewKey() || !target.isConnected || (background && (busy || document.querySelector("dialog[open]") || document.activeElement?.matches("input,select,textarea") || !window.getSelection()?.isCollapsed)))return;
    const html=section.innerHTML;
    if(renderedContent.get(target)!==html){
      const scroll=window.scrollY;
      target.replaceChildren(...section.childNodes);renderedContent.set(target,html);paintIcons();
      if(background)window.scrollTo(0,scroll);
    }
    if(!background)document.querySelectorAll(".primary-nav button").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  }
  if(plugin){local=await localCall("state");const status=document.getElementById("sync-status"),text=`${local.status} · 待上传 ${local.pending}`;if(status && status.textContent!==text)status.textContent=text;}
  if(!selected){section.append(el("div",{class:"empty"},"暂无项目"));commit();return;}
  const project=projects.find(p=>p.id===selected),base=`/projects/${selected}`;
  if(tab==="workbench"){
    await renderWorkbench(section,{el,btn,field,form,api,base,project,refresh:content,formatDate,user});
  }else if(tab==="agents"||tab==="repositories"){
    await (tab==="agents"?renderAgents:renderRepositories)(section,{el,btn,field,form,roleSelect,roles,api,base,project,refresh:content,formatDate});
  }else if(tab==="memories"){
    const snap=await api(base+"/snapshot");
    const allMemories=memoryQuery?await api(base+"/memories/search","POST",{query:memoryQuery}):snap.memories;
    // Category labels and order
    const catLabels={"requirement":"需求约定","architecture":"架构设计","api-contract":"接口约定","implementation":"功能实现","bugfix":"问题修复","testing":"测试规则","workflow":"工作流程"};
    const catOrder=Object.keys(catLabels);
    const canManage=["project_manager","technical_director"].includes(project.role);
    // ── Project header ─────────────────────────────────────────────────────────
    const descText=snap.description||(projects.find(p=>p.id===selected)?.description||"");
    const descDisplay=el("p",{class:"memory-desc"},descText||el("span",{class:"muted"},"暂无项目简介"));
    let editingDesc=false;
    const editDescBtn=canManage?btn("编辑简介","edit-3",async()=>{
      if(editingDesc)return;editingDesc=true;
      const ta=el("textarea",{class:"field-input",rows:"3",placeholder:"输入项目简介，描述这个项目的目标、背景和已实现的主要能力…",style:"resize:vertical;min-height:64px;width:100%;margin-top:6px;"},descText);
      const saveBtn=btn("保存","check",async()=>{
        const val=ta.value.trim();
        const res=await api(`${base}/update-description`,"POST",{description:val});
        // update local project description
        const p=projects.find(q=>q.id===selected);if(p)p.description=res.description;
        await content();
      },"primary");
      const cancelBtn=btn("取消","x",()=>content());
      descDisplay.replaceWith(el("div",{class:"memory-desc-edit"},ta,el("div",{class:"row",style:"margin-top:6px;"},saveBtn,cancelBtn)));
      editingDesc=false;
    }):null;
    section.append(el("div",{class:"memory-project-header"},
      el("div",{class:"memory-project-title-row"},
        el("h2",{class:"memory-project-name"},snap.name||project.name),
        editDescBtn
      ),
      descDisplay,
      el("div",{class:"meta"},el("span",{},`共 ${snap.memories.length} 条记忆`),el("span",{},`${catOrder.filter(c=>snap.memories.some(m=>m.category===c)).length} 个模块`))
    ));
    // ── Search bar ─────────────────────────────────────────────────────────────
    const search=form([field("搜索记忆","query","search",memoryDraft)],"搜索",async v=>{memoryQuery=v.query;memoryDraft=v.query;await content();});
    search.className="search-form";search.querySelector("button").prepend(icon("search"));
    search.querySelector("input").required=false;
    search.querySelector("input").addEventListener("input",e=>{memoryDraft=e.target.value;});
    if(memoryQuery){const clearBtn=btn("清除","x",async()=>{memoryQuery="";memoryDraft="";await content();});clearBtn.style.cssText="flex:none";search.append(clearBtn);}
    section.append(search);
    // ── Memory list ────────────────────────────────────────────────────────────
    if(!allMemories.length){section.append(el("div",{class:"empty"},memoryQuery?"未找到匹配的记忆":"暂无项目记忆"));commit();return;}
    function memoryCard(m){
      return el("article",{class:"memory memory-card"},
        el("h3",{class:"memory-card-title"},m.title),
        el("p",{class:"memory-card-content"},m.content),
        el("div",{class:"meta"},
          el("span",{class:"tag"},m.evidence==="uncertain"?"证据不足":"已确认"),
          el("span",{},`v${m.version}`),
          el("span",{class:"muted"},formatDate(m.created_at))
        ),
        canManage?btn("撤销","trash-2",async()=>{await api(`${base}/memories/${m.id}/withdraw`,"POST",{});await content();},`danger icon-only memory-withdraw`):null
      );
    }
    if(memoryQuery){
      // flat list in search mode
      for(const m of allMemories)section.append(memoryCard(m));
    } else {
      // grouped by category
      const byCategory=new Map();
      for(const m of allMemories){if(!byCategory.has(m.category))byCategory.set(m.category,[]);byCategory.get(m.category).push(m);}
      const orderedCats=[...catOrder.filter(c=>byCategory.has(c)),...[...byCategory.keys()].filter(c=>!catOrder.includes(c))];
      for(const cat of orderedCats){
        const items=byCategory.get(cat);
        const label=catLabels[cat]||cat;
        const group=el("div",{class:"memory-group"});
        group.append(el("div",{class:"memory-group-header"},
          el("span",{class:"memory-group-label"},label),
          el("span",{class:"memory-group-count"},`${items.length} 条`)
        ));
        for(const m of items)group.append(memoryCard(m));
        section.append(group);
      }
    }
  }else if(tab==="sessions"){
    section.append(el("h2",{},"会话摘要"));
    if(sharedSelection) {
      section.append(btn("返回会话列表","arrow-left",async()=>{sharedSelection=null;await content();}));
      let cursor=0,page;
      for(let i=0;i<messagePages;i++) {
        page=await api(`${base}/sessions/${sharedSelection}?cursor=${cursor}`);cursor=page.cursor;
        if(i===0)section.append(el("h3",{},page.session.title),el("div",{class:"meta"},el("span",{},page.session.name),el("span",{},formatDate(page.session.updated_at))),plugin?btn("复用会话","copy",()=>reuseSession(page.session.id)):null);
        for(const m of page.items)section.append(el("article",{class:"memory transcript"},el("div",{class:"meta"},m.role==="user"?"用户":"助手"),el("p",{},m.content)));
        if(!page.hasMore)break;
      }
      if(page?.hasMore)section.append(btn("加载更多消息","plus",async()=>{messagePages++;await content();}));
    } else {
      const result=await api(`${base}/sessions?offset=${sessionOffset}`);
      if(!result.items.length)section.append(el("div",{class:"empty"},"暂无同步会话"));
      for(const s of result.items)section.append(el("article",{class:"memory"},el("h3",{},s.title),el("p",{},s.summary||"尚未生成模型摘要"),el("div",{class:"meta"},el("span",{},s.name),el("span",{},`${s.message_count} 条记录`),el("span",{},formatDate(s.updated_at))),el("div",{class:"toolbar"},btn("查看对话","file-text",async()=>{sharedSelection=s.id;messagePages=1;await content();}),plugin?btn("复用会话","copy",()=>reuseSession(s.id)):null)));
      if(sessionOffset)section.append(btn("上一页","arrow-left",async()=>{sessionOffset=Math.max(0,sessionOffset-50);await content();}));
      if(result.hasMore)section.append(btn("下一页","plus",async()=>{sessionOffset+=50;await content();}));
    }
  }else if(tab==="jobs"){
    section.append(el("h2",{},"整理任务"));const cap=await api("/capabilities");if(!cap.modelConfigured)section.append(el("div",{class:"notice"},"整理模型尚未配置"));
    const jobs=await api(base+"/model-jobs");section.append(table(["成员","状态","尝试次数","模型","时间"],jobs.map(j=>[j.name,j.state==="succeeded"?(j.memory_count?`已整理 · 新增 ${j.memory_count} 条记忆`:"已整理 · 无新增项目记忆"):statuses[j.state]||j.state,String(j.attempts),j.model||j.error||"—",formatDate(j.created_at)])));
  }else if(tab==="members"){
    section.append(el("h2",{},"项目成员"));const members=await api(base+"/members");
    const agentMembers=await api(base+"/agents");
    if(agentMembers.length)section.append(el("h3",{},"Agent 成员"),table(["名称","角色"],agentMembers.map(a=>[a.name,roles[a.role]])),btn("管理 Agent","bot",async()=>{tab="agents";await content();}));
    section.append(table(["账号","角色","操作"],members.map(m=>[m.name+(m.id===project.owner_id?"（负责人）":""),roles[m.role],["project_manager","technical_director"].includes(project.role)&&m.id!==project.owner_id?btn("移除","trash-2",async()=>{await api(`${base}/members/${m.id}`,"DELETE",{});await load();},"danger"):""])));
    if(["project_manager","technical_director"].includes(project.role)){
      const candidates=await api(base+"/member-candidates");
      const role=roleSelect(),select=el("select",{name:"userId","aria-label":"添加项目成员",onChange:()=>updateRoles()},candidates.map(u=>el("option",{value:u.id},u.name)));
      const updateRoles=()=>{const target=candidates.find(u=>u.id===select.value);role.querySelector("select").replaceChildren(...(target?.roles||[]).map(r=>el("option",{value:r},roles[r])));};updateRoles();
      if(candidates.length)section.append(el("div",{class:"form-band"},form([el("label",{},`可添加用户（${candidates.length}）`,select),role],"添加成员",async v=>{await api(base+"/members","POST",v);await content();})));
      else section.append(el("div",{class:"muted"},"全部用户已在项目中"));
      if(project.owner_id===user.id){const targets=members.filter(m=>m.role==="project_manager"&&m.id!==user.id);if(targets.length)section.append(el("details",{},el("summary",{},"移交负责人"),form([el("label",{},"新负责人",el("select",{name:"userId"},targets.map(m=>el("option",{value:m.id},m.name))))],"移交",async v=>{await api(base+"/transfer-owner","POST",v);await load();})));}
    }
  }else if(tab==="bindings"){
    local=await localCall("state");section.append(el("h2",{},"本地会话绑定"));
    section.append(btn("选择或新建工作区","link",()=>promptWorkspace(true)));
    const paths=Object.entries(local.workspaces).filter(([,id])=>id===selected);
    if(!paths.length)section.append(el("div",{class:"empty"},"尚未关联工作区"));
    for(const [path] of paths)section.append(el("div",{class:"memory"},el("h3",{},local.availableWorkspaces?.find(w=>w.path===path)?.title||path),el("code",{},path)));
    section.append(table(["会话","采集位置"],Object.entries(local.bindings).filter(([,b])=>b.projectId===selected).map(([id,b])=>[id,String(b.cursor)])));
  }
  commit();
}
await run(async()=>{if(plugin){local=await localCall("state");user=local.user;if(user){if(user.mustChangePassword)passwordPage();else await load();return;}}loginPage();});

async function promptWorkspace(force=false) {
  if(!plugin || !selected || document.querySelector("dialog[open]"))return;
  local=await localCall("state");
  if(!force && (Object.values(local.workspaces).includes(selected) || promptedWorkspaces.has(selected)))return;
  promptedWorkspaces.add(selected);
  const dialog=el("dialog",{class:"workspace-dialog"}), fields=el("div",{class:"stack"});
  const choices=local.availableWorkspaces ?? [];
  const modes=el("select",{"aria-label":"工作区方式",onChange:()=>renderFields()},el("option",{value:"existing",disabled:!choices.length},"已有工作区"),el("option",{value:"new",selected:!choices.length},"新建工作区"));
  function renderFields(){fields.replaceChildren(...(modes.value==="existing"?[el("label",{},"工作区",el("select",{name:"workspaceId"},choices.map(w=>el("option",{value:w.id},`${w.title} · ${w.path}`))))]:[field("工作区名称","title"),field("本机目录（绝对路径）","path")]));}
  renderFields();
  dialog.append(el("h2",{},"关联项目工作区"),el("p",{class:"muted"},projects.find(p=>p.id===selected)?.name),modes,form([fields],"关联工作区并同步",async v=>{await localCall("bind-workspace",{...v,projectId:selected});dialog.close();dialog.remove();await load();}),btn("稍后","arrow-left",async()=>{dialog.close();dialog.remove();}));
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});root.append(dialog);dialog.showModal();paintIcons();
}
async function reuseSession(sharedId) {
  local=await localCall("state");
  const choices=(local.availableWorkspaces??[]).filter(w=>local.workspaces[w.path]===selected);
  if(!choices.length){await promptWorkspace(true);return;}
  const dialog=el("dialog",{class:"workspace-dialog"});
  dialog.append(el("h2",{},"复用到我的会话"),form([el("label",{},"目标工作区",el("select",{name:"workspaceId"},choices.map(w=>el("option",{value:w.id},w.title))))],"创建复用会话",async v=>{
    const result=await localCall("reuse-session",{...v,projectId:selected,sharedId});dialog.close();dialog.remove();
    document.getElementById("content").prepend(el("div",{class:"result status",role:"status"},`已创建复用会话：复用 · ${result.title}`));
  }),btn("取消","arrow-left",async()=>{dialog.close();dialog.remove();}));
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});root.append(dialog);dialog.showModal();paintIcons();
}
let polling=false;
setInterval(async()=>{
  if(!user || user.mustChangePassword || busy || polling || document.hidden || document.querySelector("dialog[open]") || document.activeElement?.matches("input,select,textarea"))return;
  polling=true;
  const pollingUser=user.id;
  try {
    if(!plugin && auth?.sso){
      const loggedIn=await desktopSsoLoggedIn();
      if(loggedIn===false || (loggedIn && (!loggedIn.username || loggedIn.username!==auth.ssoUsername))){auth=null;user=null;loginPage();return;}
    }
    const latest=await api("/projects");
    if(busy || user?.id!==pollingUser)return;
    if(JSON.stringify(latest)!==JSON.stringify(projects)){await run(load);return;}
    if(["sessions","jobs","memories","agents","workbench"].includes(tab))await content({background:true});
  } catch(e){if(e.status===401 && !busy)error(e);}
  finally{polling=false;}
},2000);
