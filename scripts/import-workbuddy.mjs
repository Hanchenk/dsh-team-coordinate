import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { marked } from "marked";
const source=path.resolve(process.argv[2]??"../WorkbuddySkillGroups4DSH");
const destination=path.resolve("src/team/expert-pack");
await fs.mkdir(destination,{recursive:true});
const catalog=[];
function parse(text){const match=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/),document=match?YAML.parseDocument(match[1]):null;return {meta:document&&!document.errors.length?document.toJSON():{},body:match?text.slice(match[0].length):text};}
for(const entry of (await fs.readdir(path.join(source,"skills"),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(!entry.isDirectory()||!/^[a-z0-9-]+$/.test(entry.name))continue;
  const dir=path.join(source,"skills",entry.name),text=await fs.readFile(path.join(dir,"SKILL.md"),"utf8"),{meta,body}=parse(text);
  const files=await fs.readdir(dir,{recursive:true});
  const resources=[];
  for(const file of files){if(!file.endsWith(".md")||file==="SKILL.md"||/README|reference|original-lead/i.test(file))continue;
    const content=await fs.readFile(path.join(dir,file),"utf8"),parsed=parse(content);
    const heading=marked.lexer(parsed.body).find(t=>t.type==="heading");
    resources.push({file,name:heading?.text??parsed.meta.name??file});
  }
  const members=[];
  for(const table of marked.lexer(body).filter(t=>t.type==="table")){
    const column=table.header.findIndex(c=>/Agent ID/i.test(c.text));if(column<0)continue;
    for(const row of table.rows){const id=row[column].text.replaceAll("`","").trim();
      if(!/^[a-z][a-z0-9-]*$/.test(id))continue;
      const file=resources.find(r=>r.file===`${id}/SKILL.md`||r.file.endsWith(`/${id}/SKILL.md`)||r.file===`${id}.md`||r.file.endsWith(`/${id}.md`)||r.file.endsWith(`/${id}-SKILL.md`));
      if(file&&!members.some(m=>m.id===id))members.push({id,name:row[0].text.replaceAll("`",""),file:file.file});
    }
  }
  await fs.cp(dir,path.join(destination,entry.name),{recursive:true,filter:src=>!path.basename(src).startsWith(".")});
  catalog.push({id:entry.name,name:marked.lexer(body).find(t=>t.type==="heading")?.text??entry.name,description:meta.description??"",version:createHash("sha256").update(text).digest("hex").slice(0,12),members,resources});
}
await fs.copyFile(path.join(source,"LICENSE"),path.join(destination,"LICENSE"));
await fs.writeFile("src/team/expert-catalog.json",JSON.stringify(catalog,null,2)+"\n");
console.log(`Imported ${catalog.length} expert bundles; ${catalog.reduce((n,g)=>n+g.members.length,0)} mapped members.`);
