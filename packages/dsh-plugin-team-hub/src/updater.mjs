import fs from "node:fs/promises";
import path from "node:path";
import { c } from "tar";
import { verifyRelease,inspectPackage,hash,newer,check,PACKAGE_NAME,MAX_PACKAGE_BYTES } from "../../../src/team/plugin-release-protocol.mjs";
export class PluginUpdater {
  constructor({dir,profileDir,runningVersion,publicKey,installer,fetcher=fetch,packageDir}){
    Object.assign(this,{dir:path.join(dir,"updates"),profileDir,runningVersion,publicKey,installer,fetcher,packageDir});
    this.abort=new AbortController();this.pending=null;this.status="idle";this.error=null;
    this.ready=this.initialize();
  }
  async initialize(){
    await fs.mkdir(this.dir,{recursive:true,mode:0o700});
    try{this.state=JSON.parse(await fs.readFile(path.join(this.dir,"state.json"),"utf8"));check(this.state&&typeof this.state==="object"&&!Array.isArray(this.state),"invalid_update_state");}catch(e){if(e.code&&e.code!=="ENOENT")throw e;this.state={enabled:true};}
    this.state.installed=await this.installed();
    if(newer(this.state.installed,this.runningVersion))this.status="restart_required";
  }
  async save(){const file=path.join(this.dir,"state.json");await fs.writeFile(file+".tmp",JSON.stringify(this.state),{mode:0o600});await fs.rename(file+".tmp",file);}
  view(){return {runningVersion:this.runningVersion,installedVersion:this.state?.installed??this.runningVersion,latestVersion:this.latest??null,enabled:this.state?.enabled!==false,supported:typeof this.installer()?.runPlugin==="function",status:this.status,error:this.error,lastChecked:this.state?.lastChecked??null};}
  async configure(enabled){await this.ready;check(typeof enabled==="boolean","invalid_update_setting");check(!this.pending,"update_in_progress");this.state.enabled=enabled;await this.save();return this.view();}
  async connect(hub){await this.ready;await this.pending;const url=new URL(hub);check(["http:","https:"].includes(url.protocol)&&!url.username&&!url.password&&url.pathname==="/","invalid_update_source");this.state.hub=url.origin;await this.save();return this.check();}
  async get(url,max){
    const response=await this.fetcher(url,{redirect:"error",signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(60000)])});
    check(response.ok,response.status===404?"release_not_published":"update_download_failed");
    check(!response.headers.get("content-length")||Number(response.headers.get("content-length"))<=max,"update_too_large");
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;check(size<=max,"update_too_large");chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);
  }
  async installed(required=false){try{const metadata=JSON.parse(await fs.readFile(path.join(this.profileDir,"node_modules",PACKAGE_NAME,"package.json"),"utf8"));check(metadata.name===PACKAGE_NAME&&typeof metadata.version==="string","invalid_installed_metadata");return metadata.version;}catch(error){if(!required&&error.code==="ENOENT")return this.runningVersion;throw error;}}
  check(force=false){if(this.pending)return this.pending;this.pending=this.perform(force).finally(()=>{this.pending=null;});return this.pending;}
  async install(file,signal){
    const service=this.installer();check(typeof service?.runPlugin==="function","desktop_updater_unavailable");
    signal.throwIfAborted();
    const operation=service.runPlugin(["add","--save-exact","--ignore-scripts",file],this.profileDir,signal);
    operation.stdout?.resume();operation.stderr?.resume();
    const cancel=()=>operation.cancel();signal.addEventListener("abort",cancel,{once:true});
    try{const result=await operation.done;check(result.exitCode===0&&result.signal==null,"plugin_install_failed");}finally{signal.removeEventListener("abort",cancel);}
  }
  async perform(force){
    let lock;
    try{
      await this.ready;if(this.abort.signal.aborted||!this.state.hub||(!force&&(!this.state.enabled||Date.now()-(this.state.lastChecked??0)<1800000)))return this.view();
      if(this.status==="restart_required")return this.view();
      if(typeof this.installer()?.runPlugin!=="function"){this.status="unsupported";return this.view();}
      const lockfile=path.join(this.dir,"install.lock");
      try{lock=await fs.open(lockfile,"wx",0o600);}catch(e){if(e.code!=="EEXIST")throw e;const stat=await fs.stat(lockfile);if(Date.now()-stat.mtimeMs>600000){await fs.unlink(lockfile);lock=await fs.open(lockfile,"wx",0o600);}else throw new Error("update_in_progress");}
      this.error=null;this.status="checking";this.state.lastChecked=Date.now();await this.save();
      const hub=this.state.hub,envelope=JSON.parse((await this.get(hub+"/team/v1/plugin-releases/latest",32000)).toString());
      const release=verifyRelease(envelope,this.publicKey);this.latest=release.version;
      const installed=await this.installed();
      if(!newer(release.version,installed)||!newer(release.version,this.runningVersion)){this.status=newer(installed,this.runningVersion)?"restart_required":"current";this.state.installed=installed;await this.save();return this.view();}
      this.status="downloading";
      const bytes=await this.get(hub+"/team/v1/plugin-releases/"+release.sha256+".tgz",MAX_PACKAGE_BYTES);
      check(bytes.length===release.size&&hash(bytes)===release.sha256,"package_hash_mismatch");
      const file=path.join(this.dir,release.sha256+".tgz");await fs.writeFile(file+".tmp",bytes,{mode:0o600});await fs.rename(file+".tmp",file);
      const metadata=await inspectPackage(file);check(metadata.version===release.version,"package_version_mismatch");
      const rollback=path.join(this.dir,`rollback-${this.runningVersion}.tgz`);
      const entries=["package.json","lib","cordis.patch.yml","README.md","THIRD_PARTY_NOTICES.md"];
      await c({file:rollback,cwd:this.packageDir,prefix:"package",gzip:true},entries);
      this.state.rollback=rollback;this.status="installing";await this.save();
      const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(180000)]);
      try{await this.install(file,signal);check(await this.installed(true)===release.version,"installed_version_mismatch");}
      catch(error){
        if(!this.abort.signal.aborted){try{await this.install(rollback,AbortSignal.any([this.abort.signal,AbortSignal.timeout(180000)]));check(await this.installed(true)===this.runningVersion,"rollback_version_mismatch");}catch{throw new Error("plugin_rollback_failed");}}
        throw error;
      }
      this.state.installed=release.version;this.status="restart_required";await this.save();
    }catch(error){if(!this.abort.signal.aborted){this.error=error.message;this.status="error";}}
    finally{if(lock){await lock.close();await fs.unlink(path.join(this.dir,"install.lock")).catch(()=>{});}}
    return this.view();
  }
  async close(){this.abort.abort();await this.pending;}
}
