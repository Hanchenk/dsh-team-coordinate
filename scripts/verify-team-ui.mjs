import { chromium } from "playwright";
import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { database, migrate } from "../src/team/db.mjs";
import { createUser } from "../src/team/auth.mjs";
import { startTeamServer } from "../src/team/server.mjs";
import { createHost } from "../test/team/host-fixture.mjs";

if(!process.env.TEAM_TEST_DATABASE_URL)throw new Error("TEAM_TEST_DATABASE_URL is required");
const schema="ui_"+randomUUID().replaceAll("-","");
const admin=database(process.env.TEAM_TEST_DATABASE_URL);await admin.query(`CREATE SCHEMA ${schema}`);
const url=new URL(process.env.TEAM_TEST_DATABASE_URL);url.searchParams.set("options",`-c search_path=${schema}`);
const db=database(url.href), dir=await fs.mkdtemp(path.join(os.tmpdir(),"team-ui-"));
let app,host,browser;
try{
  await migrate(db);
  await createUser(db,{name:"manager",password:"initial-password-2026",assignedRoles:["project_manager"],admin:true});
  await createUser(db,{name:"developer",password:"initial-password-2026",assignedRoles:["developer"]});
  app=await startTeamServer({db,port:0,model:{baseUrl:"http://test-model.invalid",name:"ui-fixture",timeoutMs:1000},workerOptions:{intervalMs:3600000,generate:async entries=>({summary:"订单接口已讨论使用幂等键避免重复提交。",memories:[{title:"订单接口幂等约定",content:"创建订单请求携带 Idempotency-Key。相同幂等键只创建一次订单；来源为当前项目讨论，尚未附带测试证据。",category:"api-contract",evidence:"reported",sourceIds:[entries[0].id]}]})}});
  const hub=`http://127.0.0.1:${app.server.address().port}`;
  const fixture=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';const root=createRoot(document.getElementById('root'));window.__ModuleLoader__={load(m){const c=[];m.factory(()=>React).apply({slots:{inject(n,f){f()},register(s,C){c.push(React.createElement(C,{key:s.name}))}}});root.render(React.createElement(React.Fragment,null,...c));}};const s=document.createElement('script');s.src='/client.js';document.body.append(s);`,resolveDir:process.cwd()},bundle:true,write:false,format:"iife",platform:"browser"});
  host=await createHost(dir,{
    "/":(_req,res)=>{res.setHeader("content-type","text/html");res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');},
    "/fixture.js":(_req,res)=>{res.setHeader("content-type","text/javascript");res.end(fixture.outputFiles[0].contents);}
  });
  const events=[];const session={id:"local-orders-session",seq:0,header:{cwd:"/workspace/orders"},snapshotEvents:()=>events};host.sessions.set(session.id,session);
  browser=await chromium.launch({channel:process.env.TEAM_BROWSER_CHANNEL||"chrome",headless:true});
  const page=await browser.newPage({viewport:{width:1365,height:900}}),errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(hub);await page.getByLabel("账号",{exact:true}).fill("manager");await page.getByLabel("密码",{exact:true}).fill("initial-password-2026");await page.getByRole("button",{name:"登录",exact:true}).click();
  await page.getByLabel("当前密码").fill("initial-password-2026");await page.getByLabel("新密码").fill("changed-password-2026");await page.getByRole("button",{name:"保存新密码"}).click();
  await page.getByText("创建项目",{exact:true}).first().click();await page.getByLabel("项目名称").fill("订单平台 · 团队研发");await page.getByRole("button",{name:"创建项目",exact:true}).click();
  await page.getByRole("button",{name:"项目成员",exact:true}).click();await page.getByLabel("受邀账号").fill("developer");await page.locator("#content").getByLabel("项目角色").selectOption("developer");await page.getByRole("button",{name:"生成邀请"}).click();
  const link=await page.locator("#content .result a").getAttribute("href");const token=new URLSearchParams(new URL(link).hash.slice(1)).get("invite");assert.ok(token);
  const desktop=await browser.newPage({viewport:{width:1365,height:900}});desktop.on("pageerror",e=>errors.push(e.message));await desktop.goto(host.base);
  await desktop.getByRole("button",{name:"团队项目",exact:true}).click();const panel=desktop.frameLocator('iframe[title="团队项目"]');
  await panel.getByLabel("内网服务地址").fill(hub);await panel.getByLabel("账号",{exact:true}).fill("developer");await panel.getByLabel("密码",{exact:true}).fill("initial-password-2026");await panel.getByRole("button",{name:"登录",exact:true}).click();
  await panel.getByLabel("当前密码").fill("initial-password-2026");await panel.getByLabel("新密码").fill("changed-password-2026");await panel.getByRole("button",{name:"保存新密码"}).click();
  await panel.getByText("接受项目邀请",{exact:true}).click();await panel.getByLabel("邀请令牌").fill(token);await panel.getByRole("button",{name:"加入项目",exact:true}).click();
  await panel.getByRole("button",{name:"本地绑定",exact:true}).click();await panel.getByLabel("该目录后续新会话自动绑定").check();await panel.getByRole("button",{name:"绑定当前项目"}).click();
  await panel.locator("tbody").getByText(session.id,{exact:true}).waitFor();
  events.push({seq:0,type:"user/message",data:{source:{kind:"user"},content:[{type:"text",text:"订单创建要使用幂等键，避免重复提交。"}]}},{seq:1,type:"turn/end",data:{}});session.seq=2;
  host.ctx.emit("session/event",session,events[1]);await host.call("sync");await app.worker.tick();await host.call("sync");
  await panel.getByRole("button",{name:"项目记忆",exact:true}).click();await panel.getByRole("heading",{name:"订单接口幂等约定"}).waitFor();
  const context=host.variables.get("team_hub_memory")({agent:{id:session.id}});assert.match(context,/Idempotency-Key/);
  const tool=host.tools.get("team_memory_search");const result=await tool.execute({query:"订单"},{agent:{id:session.id},signal:new AbortController().signal});assert.match(result.text,/幂等/);
  assert.equal((await tool.execute({query:"订单"},{agent:{id:"other-session"},signal:new AbortController().signal})).text,"[]");
  await fs.mkdir("artifacts/team-ui",{recursive:true});
  await desktop.screenshot({path:"artifacts/team-ui/plugin-desktop.png",fullPage:true});
  await desktop.setViewportSize({width:390,height:844});await desktop.screenshot({path:"artifacts/team-ui/plugin-mobile.png",fullPage:true});
  const overflow=await panel.locator("body").evaluate(b=>b.scrollWidth>innerWidth+1);assert.equal(overflow,false);
  await page.getByRole("button",{name:"项目记忆",exact:true}).click();await page.getByRole("heading",{name:"订单接口幂等约定"}).waitFor();await page.screenshot({path:"artifacts/team-ui/hub-desktop.png",fullPage:true});
  assert.deepEqual(errors,[]);console.log("Browser workflow passed: HTTP login, invite, packaged plugin UI, bind, event capture, automatic memory, scoped tools, desktop/mobile screenshots.");
}finally{
  await browser?.close();await host?.close();await app?.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await fs.rm(dir,{recursive:true,force:true});
}
