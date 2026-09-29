import fs from "node:fs/promises";
import { ensure } from "./contracts.mjs";
export const expertCatalog=JSON.parse(await fs.readFile(new URL("./expert-catalog.json",import.meta.url),"utf8"));
export function expertMembers(group){return group.members.length?group.members:[{id:"lead",name:group.name,file:"SKILL.md"},...group.resources.map((r,i)=>({id:`resource-${i}`,name:r.name,file:r.file}))];}
export function validateSkills(value){ensure(Array.isArray(value)&&value.length<=12);ensure(value.every(id=>expertCatalog.some(g=>g.id===id)),400,"unknown_expert");return [...new Set(value)];}
export async function projectContext(tx,projectId,runId,agents=[]){
  const {rows:[config]}=await tx.query("SELECT instructions,skills FROM team_project_config WHERE project_id=$1",[projectId]);
  await tx.query("INSERT INTO team_run_assets SELECT $1,id,name,content FROM team_assets WHERE project_id=$2 AND NOT folder",[runId,projectId]);
  const assets=(await tx.query("SELECT asset_id AS id,name FROM team_run_assets WHERE run_id=$1",[runId])).rows;
  const referenced=agents.map(a=>a.instructions.match(/^Expert bundle: ([a-z0-9-]+)/)?.[1]).filter(id=>expertCatalog.some(g=>g.id===id));
  return {instructions:config?.instructions??"",skills:[...new Set([...(config?.skills??[]),...referenced])],assets};
}
