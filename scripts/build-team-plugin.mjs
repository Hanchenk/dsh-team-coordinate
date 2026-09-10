import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const pkg=path.join(root,"packages/dsh-plugin-team-hub");
await fs.mkdir(path.join(root,"team-ui"),{recursive:true});
await build({entryPoints:[path.join(root,"team-ui-src/app.mjs")],bundle:true,format:"esm",platform:"browser",outfile:path.join(root,"team-ui/app.js"),minify:true});
for(const file of ["index.html","style.css"])await fs.copyFile(path.join(root,"team-ui-src",file),path.join(root,"team-ui",file));
await fs.mkdir(path.join(pkg,"lib/ui"),{recursive:true});
for(const file of ["index.html","style.css","app.js"])await fs.copyFile(path.join(root,"team-ui",file),path.join(pkg,"lib/ui",file));
await build({entryPoints:[path.join(pkg,"src/index.mjs")],bundle:true,platform:"node",format:"esm",packages:"external",outfile:path.join(pkg,"lib/index.mjs"),target:"node22"});
await build({entryPoints:[path.join(pkg,"src/client.jsx")],bundle:true,platform:"browser",format:"cjs",external:["react"],outfile:path.join(pkg,"lib/client.js"),
  banner:{js:'window.__ModuleLoader__.load({id:"dsh-plugin-team-hub",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},
  footer:{js:'return module.exports;}});'}});
console.log("Built Team Hub UI and dsh-plugin-team-hub");
