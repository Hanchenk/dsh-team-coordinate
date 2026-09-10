import React, { useState, useEffect } from "react";
import { Users, X } from "lucide";

function Icon({ value }) {
  return React.createElement("svg", { viewBox:"0 0 24 24",width:18,height:18,fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":true },
    value[2].map(([tag,props],index)=>React.createElement(tag,{...props,key:index})));
}

export const inject = ["slots"];
export function apply(ctx) {
  let open = () => {};
  function Launcher() { return <button title="团队项目" onClick={() => open()} style={{display:"inline-flex",alignItems:"center",gap:6}}><Icon value={Users}/>团队项目</button>; }
  function Overlay() {
    const [visible, setVisible] = useState(false); open = () => setVisible(true);
    useEffect(()=>{const key=e=>{if(e.key==="Escape")setVisible(false);};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[]);
    return visible ? <div role="dialog" aria-modal="true" aria-label="团队项目" style={{ position: "fixed", inset: 12, zIndex: 50, background: "white", display: "flex", flexDirection: "column", border: "1px solid #ccd2d8" }}>
      <button title="关闭团队项目" aria-label="关闭团队项目" onClick={() => setVisible(false)} style={{ alignSelf: "flex-end", display:"grid",placeItems:"center",width:32,height:32,border:0,background:"white",cursor:"pointer" }}><Icon value={X}/></button>
      <iframe title="团队项目" src="/team-plugin/" style={{ width: "100%", flex: 1, border: 0 }} />
    </div> : null;
  }
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "team-hub", order: 30 }, Launcher));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "team-hub", order: 30 }, Overlay));
}
