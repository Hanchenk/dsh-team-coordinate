import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync,sign } from "node:crypto";
import { c } from "tar";
import { PluginUpdater } from "../../packages/dsh-plugin-team-hub/src/updater.mjs";
import { hash,inspectPackage,PACKAGE_NAME,newer } from "../../src/team/plugin-release-protocol.mjs";

async function fixture(t,{mutation,fail=false,unsupported=false,enabled=true}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"team-update-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const packageDir=path.join(dir,"old"),next=path.join(dir,"next"),profileDir=path.join(dir,"profile");
  const installedFile=path.join(profileDir,"node_modules",PACKAGE_NAME,"package.json");
  const metadata=version=>({name:PACKAGE_NAME,version,dsh:{bundle:{patch:"./cordis.patch.yml"}}});
  for(const [root,version] of [[packageDir,"0.1.0-alpha.10"],[next,"0.1.0-alpha.11"]]){
    await fs.mkdir(path.join(root,"lib"),{recursive:true});
    await fs.writeFile(path.join(root,"package.json"),JSON.stringify(metadata(version)));
    for(const file of ["lib/index.mjs","cordis.patch.yml","README.md","THIRD_PARTY_NOTICES.md"])await fs.writeFile(path.join(root,file),"fixture");
  }
  await fs.mkdir(path.dirname(installedFile),{recursive:true});await fs.copyFile(path.join(packageDir,"package.json"),installedFile);
  const file=path.join(dir,"next.tgz");await c({cwd:next,file,prefix:"package",gzip:true},["package.json","lib","cordis.patch.yml","README.md","THIRD_PARTY_NOTICES.md"]);
  const bytes=await fs.readFile(file),{publicKey,privateKey}=generateKeyPairSync("ed25519");
  const release={name:PACKAGE_NAME,version:"0.1.0-alpha.11",protocol:1,sha256:hash(bytes),size:bytes.length};
  mutation?.(release);
  const payload=Buffer.from(JSON.stringify(release));
  const envelope={payload:payload.toString("base64"),signature:sign(null,payload,privateKey).toString("base64")};
  const calls=[];
  const service={runPlugin(args,anchor){calls.push({args,anchor});return {cancel(){},done:(async()=>{
    if(fail&&calls.length===1)return {exitCode:1};
    const meta=await inspectPackage(args.at(-1));await fs.writeFile(installedFile,JSON.stringify(meta));return {exitCode:0,signal:null};
  })()};}};
  const options={dir,packageDir,profileDir,runningVersion:"0.1.0-alpha.10",publicKey,installer:()=>unsupported?undefined:service,fetcher:async url=>new Response(url.endsWith("latest")?JSON.stringify(envelope):bytes)};
  const updater=new PluginUpdater(options);t.after(()=>updater.close());await updater.ready;
  updater.state.hub="http://hub.local";updater.state.enabled=enabled;
  return {updater,calls,options,installedFile,envelope};
}

test("signed update installs once, retains rollback, and reconciles after restart",async t=>{
  const {updater,calls,options}=await fixture(t);
  const first=updater.check(true);assert.equal(first,updater.check(true));
  assert.equal((await first).status,"restart_required");assert.equal(calls.length,1);
  assert.deepEqual(calls[0].args.slice(0,3),["add","--save-exact","--ignore-scripts"]);assert.equal(calls[0].anchor,options.profileDir);
  assert.equal((await inspectPackage(updater.state.rollback)).version,"0.1.0-alpha.10");
  await updater.check(true);assert.equal(calls.length,1);
  const restarted=new PluginUpdater({...options,runningVersion:"0.1.0-alpha.11"});await restarted.ready;
  assert.equal((await restarted.check(true)).status,"current");await restarted.close();
});

for(const [name,mutation,error] of [
  ["hash mismatch",r=>r.sha256="0".repeat(64),"package_hash_mismatch"],
  ["version mismatch",r=>r.version="0.1.0-alpha.12","package_version_mismatch"],
  ["wrong package",r=>r.name="another-plugin","invalid_release_manifest"],
])test(`rejects ${name} before installation`,async t=>{
  const {updater,calls}=await fixture(t,{mutation});assert.equal((await updater.check(true)).error,error);assert.equal(calls.length,0);
});

test("rejects tampered signature",async t=>{
  const {updater,calls,envelope}=await fixture(t);envelope.signature=Buffer.alloc(64).toString("base64");
  assert.equal((await updater.check(true)).error,"invalid_release_signature");assert.equal(calls.length,0);
});
test("never downgrades and compares prerelease numbers correctly",async t=>{
  assert.equal(newer("0.1.0-alpha.11","0.1.0-alpha.9"),true);
  const {updater,calls}=await fixture(t,{mutation:r=>r.version="0.1.0-alpha.9"});
  assert.equal((await updater.check(true)).status,"current");assert.equal(calls.length,0);
});
test("failed installation reinstalls and verifies retained old package",async t=>{
  const {updater,calls,installedFile}=await fixture(t,{fail:true});
  assert.equal((await updater.check(true)).error,"plugin_install_failed");assert.equal(calls.length,2);
  assert.equal(JSON.parse(await fs.readFile(installedFile)).version,"0.1.0-alpha.10");
});
test("automatic updates can be disabled; explicit update still works",async t=>{
  const {updater,calls}=await fixture(t,{enabled:false});await updater.check();assert.equal(calls.length,0);
  assert.equal((await updater.check(true)).status,"restart_required");
});
test("unsupported Desktop and network failure do not modify installed files",async t=>{
  const {updater,calls}=await fixture(t,{unsupported:true});assert.equal((await updater.check(true)).status,"unsupported");assert.equal(calls.length,0);
  updater.installer=()=>({runPlugin(){throw new Error("must not install");}});updater.fetcher=async()=>{throw new Error("offline");};
  assert.equal((await updater.check(true)).error,"offline");
});
test("corrupted state recovers and manually restored version clears stale restart state",async t=>{
  const {updater,options}=await fixture(t);
  await fs.writeFile(path.join(updater.dir,"state.json"),"{");
  const recovered=new PluginUpdater(options);await recovered.ready;assert.equal(recovered.view().enabled,true);await recovered.close();
  await fs.writeFile(path.join(updater.dir,"state.json"),JSON.stringify({enabled:false,installed:"0.1.0-alpha.11"}));
  const restored=new PluginUpdater(options);await restored.ready;assert.equal(restored.view().status,"idle");assert.equal(restored.view().enabled,false);await restored.close();
});
