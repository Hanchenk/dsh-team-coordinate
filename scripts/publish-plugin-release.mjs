import fs from "node:fs/promises";
import path from "node:path";
import { sign,createPublicKey } from "node:crypto";
import { hash,inspectPackage,MAX_PACKAGE_BYTES,check,newer } from "../src/team/plugin-release-protocol.mjs";
const file=process.argv[2];check(file,"Usage: node scripts/publish-plugin-release.mjs <plugin.tgz>");
const metadata=await inspectPackage(file),content=await fs.readFile(file);check(content.length<=MAX_PACKAGE_BYTES,"package_too_large");
const key=await fs.readFile(process.env.TEAM_PLUGIN_SIGNING_KEY??".plugin-signing/private.pem");
const pinned=JSON.parse(await fs.readFile("packages/dsh-plugin-team-hub/src/release-key.json","utf8"));check(createPublicKey(key).export({type:"spki",format:"pem"})===pinned.publicKey,"release_key_mismatch");
const dir=process.env.TEAM_PLUGIN_RELEASE_DIR??"artifacts/plugin-releases";await fs.mkdir(dir,{recursive:true});
const sha256=hash(content),release={name:metadata.name,version:metadata.version,protocol:1,sha256,size:content.length,publishedAt:new Date().toISOString()};
let old;try{old=JSON.parse(Buffer.from(JSON.parse(await fs.readFile(path.join(dir,"latest.json"),"utf8")).payload,"base64").toString());}catch(e){if(e.code!=="ENOENT")throw e;}
check(!old||newer(release.version,old.version)||(release.version===old.version&&release.sha256===old.sha256),"release_version_must_increase");
const payload=Buffer.from(JSON.stringify(release)),envelope={payload:payload.toString("base64"),signature:sign(null,payload,key).toString("base64")};
const archive=path.join(dir,sha256+".tgz");await fs.writeFile(archive,content);
await fs.writeFile(path.join(dir,"latest.json.tmp"),JSON.stringify(envelope)+"\n");await fs.rename(path.join(dir,"latest.json.tmp"),path.join(dir,"latest.json"));
console.log(`Published ${metadata.name}@${metadata.version} (${content.length} bytes).`);
