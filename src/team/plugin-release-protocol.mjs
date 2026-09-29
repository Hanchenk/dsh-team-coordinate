import { createHash,verify } from "node:crypto";
import { t } from "tar";
import semver from "semver";
export const PACKAGE_NAME="dsh-plugin-team-hub",MAX_PACKAGE_BYTES=8*1024*1024;
export function check(value,message){if(!value)throw new Error(message);}
export const hash=buffer=>createHash("sha256").update(buffer).digest("hex");
export const newer=(a,b)=>Boolean(semver.valid(a)&&semver.valid(b)&&semver.gt(a,b));
export function verifyRelease(envelope,key){
  check(typeof envelope?.payload==="string"&&envelope.payload.length<24000&&typeof envelope.signature==="string","invalid_release_manifest");
  const raw=Buffer.from(envelope.payload,"base64");check(verify(null,raw,key,Buffer.from(envelope.signature,"base64")),"invalid_release_signature");
  const release=JSON.parse(raw);check(release.name===PACKAGE_NAME&&semver.valid(release.version)&&/^[a-f0-9]{64}$/.test(release.sha256)&&Number.isSafeInteger(release.size)&&release.size>0&&release.size<=MAX_PACKAGE_BYTES,"invalid_release_manifest");
  check(release.protocol===1,"updater_upgrade_required");return release;
}
export async function inspectPackage(file){
  let metadata=null,expanded=0,count=0;const pending=[];let problem;
  await t({file,strict:true,onReadEntry(entry){
    count++;expanded+=entry.size;
    if(count>1000||expanded>32*1024*1024||!entry.path.startsWith("package/")||entry.path.split("/").includes("..")||entry.path.includes("\\")||!["File","Directory"].includes(entry.type))problem="invalid_package_archive";
    if(entry.path==="package/package.json"){
      if(metadata!==null||entry.size>32000){problem="invalid_package_metadata";entry.resume();return;}
      metadata={};pending.push(new Promise(resolve=>{const chunks=[];entry.on("data",b=>chunks.push(b));entry.on("end",()=>{try{metadata=JSON.parse(Buffer.concat(chunks).toString());}catch{problem="invalid_package_metadata";}resolve();});}));
    }else entry.resume();
  }});await Promise.all(pending);
  check(!problem,problem);check(metadata?.name===PACKAGE_NAME&&semver.valid(metadata.version)&&metadata.dsh?.bundle?.patch==="./cordis.patch.yml","wrong_plugin_package");
  check(!metadata.scripts?.preinstall&&!metadata.scripts?.install&&!metadata.scripts?.postinstall,"package_install_scripts_not_allowed");return metadata;
}
