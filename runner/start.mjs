import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
const job=JSON.parse(await fs.readFile("/control/job.json","utf8"));
const home="/workspace/.harness",profile=path.join(home,"profiles","headless");
await fs.mkdir(profile,{recursive:true});
try{await fs.symlink("/opt/runtime/node_modules",path.join(profile,"node_modules"));}catch(e){if(e.code!=="EEXIST")throw e;}
await fs.writeFile(path.join(profile,"package.json"),JSON.stringify({name:"team-agent-profile",private:true,type:"module",dsh:{profile:{bundles:["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","@nanmicoder/dsh-agent-teams"],patchReload:"startup"}}}));
const patch=[
  {id:"headless-startup",disabled:true},{id:"headless-runner",disabled:true},{id:"session-title-llm",disabled:true},{id:"llm-deepseek",disabled:true},
  {id:"llm-pi-ai",config:{providers:{"team-model":{api:"openai-completions",baseURL:job.model.baseUrl,apiKeyEnv:"TEAM_AGENT_MODEL_KEY",models:[{id:job.model.name,contextWindow:128000}],defaultMaxTokens:8192}}}},
  {id:"agent-default-model",config:{provider:"team-model",model:job.model.name}},
  {id:"skill-filesystem",config:{customSkillDirs:["/control/skills"]}},
  {id:"approval",config:{policy:"never"}},
  {id:"permission",config:{defaultPreset:"team-workspace",presets:{"team-workspace":{sandbox:"workspace-write",approval:"never"}}}},
  {insert:[{id:"team-cloud-driver",name:"/opt/runtime/driver.mjs"}]}
];
await fs.writeFile(path.join(profile,"cordis.patch.yml"),YAML.stringify(patch));
const child=spawn(process.execPath,["/opt/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js","--profile","headless"],{cwd:"/workspace",stdio:"inherit",env:{...process.env,HOME:home,DSH_HOME:home,DSH_PERMISSION_MODE:"workspace-write"}});
process.on("SIGTERM",()=>child.kill("SIGTERM"));process.on("SIGINT",()=>child.kill("SIGINT"));
child.on("error",()=>{process.exitCode=1;});child.on("exit",code=>{process.exitCode=code??1;});
