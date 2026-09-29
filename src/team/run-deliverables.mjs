import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { transaction } from "./db.mjs";
import { member,audit,redact } from "./contracts.mjs";
export async function publishRunOutputs(db,run,status,workspace){
  if(run.summary?.assetsPublished)return run.summary.outputAssetIds??[];
  const files=[{name:"执行结果.md",content:Buffer.from(`# ${run.title}\n\n${(status.results??[]).map(r=>`## ${r.id}\n\n${redact(r.output??"")}`).join("\n\n")}`)}];
  let bytes=files[0].content.length;
  const walk=async(dir,prefix="",depth=0)=>{
    if(depth>4)return;
    const directory=await fs.lstat(dir).catch(()=>null);if(!directory?.isDirectory()||directory.isSymbolicLink())return;
    for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
      if(entry.name.startsWith(".")||entry.isSymbolicLink()||files.length>=20)continue;
      const file=path.join(dir,entry.name),name=prefix+entry.name;
      if(entry.isDirectory()){await walk(file,name+"-",depth+1);continue;}
      if(!entry.isFile())continue;
      const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const stat=await handle.stat();if(stat.size>5*1024*1024||bytes+stat.size>20*1024*1024)continue;files.push({name,content:await handle.readFile()});bytes+=stat.size;}finally{await handle.close();}
    }
  };
  await walk(path.join(workspace,"deliverables"));
  return transaction(db,async tx=>{
    await member(tx,{id:run.created_by},run.project_id,false,true);
    const stored=(await tx.query("SELECT summary FROM team_agent_runs WHERE id=$1",[run.id])).rows[0];if(stored.summary.assetsPublished)return stored.summary.outputAssetIds??[];
    const quota=(await tx.query("SELECT coalesce(sum(octet_length(content)),0) AS size,count(*) AS count FROM team_assets WHERE project_id=$1",[run.project_id])).rows[0];
    let size=Number(quota.size),count=Number(quota.count);const ids=[];
    for(const file of files){if(size+file.content.length>100*1024*1024||count>=1000)continue;const id=randomUUID();await tx.query("INSERT INTO team_assets(id,project_id,name,content,created_by) VALUES($1,$2,$3,$4,$5)",[id,run.project_id,`${run.id.slice(0,8)}-${file.name}`.slice(0,180),file.content,run.created_by]);ids.push(id);size+=file.content.length;count++;}
    await tx.query("UPDATE team_agent_runs SET summary=summary || $2::jsonb WHERE id=$1",[run.id,JSON.stringify({assetsPublished:true,outputAssetIds:ids,skippedOutputCount:files.length-ids.length})]);
    await audit(tx,{id:run.created_by},run.project_id,"agent-run.delivered");return ids;
  });
}
