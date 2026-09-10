import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHost } from "./host-fixture.mjs";

test("packaged Host loads through Cordis and disposes routes",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"team-host-"));const host=await createHost(dir);
  t.after(async()=>{await host.close();fs.rmSync(dir,{recursive:true,force:true});});
  assert.ok(host.routes.has("/team-plugin"));
  assert.equal((await host.call("state")).user,null);
  assert.equal(host.variables.get("team_hub_memory")({}),"");
  assert.equal(host.tools.size,2);
  const tool=host.tools.get("team_memory_search");
  assert.deepEqual(await tool.execute({query:"test"},{signal:new AbortController().signal}),{text:"[]"});
  assert.equal((await fetch(host.base+"/team-plugin/")).status,200);
  const denied=await fetch(host.base+"/team-plugin/local",{method:"POST",headers:{origin:"http://wrong.example","content-type":"application/json"},body:'{"action":"state"}'});
  assert.equal(denied.status,403);
  await host.fiber.dispose();assert.equal(host.routes.size,0);
});

test("client package uses the DSH ModuleLoader and additive slots",()=>{
  const source=fs.readFileSync(new URL("../../packages/dsh-plugin-team-hub/lib/client.js",import.meta.url),"utf8");
  let module;
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load(value){module=value;}}}});
  assert.equal(module.id,"dsh-plugin-team-hub");
  const api=module.factory(name=>{assert.equal(name,"react");return {createElement(){},useState(){}};});
  const slots=[];
  api.apply({slots:{inject(_name,fn){fn();},register(config){slots.push(config.name);}}});
  assert.deepEqual(slots,["sidebar.footer.action","shell.overlay"]);
});
