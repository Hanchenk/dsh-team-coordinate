import React, { useState, useEffect } from "react";
import { Users, X, ChevronDown, ChevronUp, PanelRight, Minimize2 } from "lucide";

function Icon({ value }) {
  return React.createElement("svg", { viewBox:"0 0 24 24",width:18,height:18,fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":true },
    value[2].map(([tag,props],index)=>React.createElement(tag,{...props,key:index})));
}

export const inject = ["slots"];
export function apply(ctx) {
  let open = () => {};
  function Launcher() { return <button title="团队项目" onClick={() => open()} style={{display:"flex",alignItems:"center",gap:10,width:"100%",minHeight:36,padding:"8px 10px",border:0,borderRadius:8,background:"transparent",color:"var(--dsw-alias-label-primary, #20242a)",font:"inherit",cursor:"pointer"}}><Icon value={Users}/>团队项目</button>; }
  function Overlay() {
    const [visible, setVisible] = useState(false), [visited, setVisited] = useState(false);
    const [collapsed, setCollapsed] = useState(false), [wide, setWide] = useState(false);
    const [pos, setPos] = useState(null);
    const [size, setSize] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const panelRef = (React.useRef || (() => ({ current: null })))();

    useEffect(() => {
      open = () => { setVisited(true); setVisible(true); setCollapsed(false); };
      const key = e => { if (e.key === "Escape") setVisible(false); };
      window.addEventListener("keydown", key);
      return () => { open = () => {}; window.removeEventListener("keydown", key); };
    }, []);

    const onHeaderPointerDown = (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      setIsDragging(true);

      const onPointerMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const newLeft = Math.max(10, Math.min(window.innerWidth - 80, startLeft + dx));
        const newTop = Math.max(10, Math.min(window.innerHeight - 60, startTop + dy));
        setPos({ left: newLeft, top: newTop });
      };

      const onPointerUp = () => {
        setIsDragging(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    };

    const onResizePointerDown = (direction) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = rect.width;
      const startH = rect.height;
      const startL = rect.left;
      const startT = rect.top;
      setIsResizing(true);

      const onPointerMove = (ev) => {
        let newW = startW;
        let newH = startH;
        let newL = startL;
        let newT = startT;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (direction.includes("e")) {
          newW = Math.max(340, Math.min(window.innerWidth - 20, startW + dx));
        }
        if (direction.includes("w")) {
          const potentialW = startW - dx;
          if (potentialW >= 340 && potentialW <= window.innerWidth - 20) {
            newW = potentialW;
            newL = startL + dx;
          }
        }
        if (direction.includes("s")) {
          newH = Math.max(200, Math.min(window.innerHeight - 20, startH + dy));
        }
        if (direction.includes("n")) {
          const potentialH = startH - dy;
          if (potentialH >= 200 && potentialH <= window.innerHeight - 20) {
            newH = potentialH;
            newT = startT + dy;
          }
        }

        setSize({ width: newW, height: newH });
        if (direction.includes("w") || direction.includes("n")) {
          setPos({ left: newL, top: newT });
        }
      };

      const onPointerUp = () => {
        setIsResizing(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    };

    const control = { display:"grid",placeItems:"center",width:32,height:32,minWidth:32,minHeight:32,padding:0,border:"1px solid var(--glass-edge, #88888820)",borderRadius:"50%",background:"rgba(128,128,128,0.12)",color:"inherit",cursor:"pointer",flexShrink:0,transition:"all 0.15s ease" };
    const currentWidth = size?.width ?? (wide ? 640 : 440);
    const currentHeight = collapsed ? 56 : (size?.height ?? "calc(100svh - 72px)");

    const asideStyle = {
      boxSizing: "border-box",
      position: "fixed",
      zIndex: 50,
      top: pos ? pos.top : 56,
      left: pos ? pos.left : "auto",
      right: pos ? "auto" : 16,
      width: currentWidth,
      maxWidth: "calc(100vw - 32px)",
      height: currentHeight,
      maxHeight: pos ? "calc(100svh - 20px)" : "calc(100svh - 72px)",
      display: visible ? "flex" : "none",
      flexDirection: "column",
      borderRadius: 24,
      overflow: "hidden",
      letterSpacing: 0,
      isolation: "isolate",
      userSelect: (isDragging || isResizing) ? "none" : "auto",
    };

    return <>
    <style>{`
      .team-glass {
        --glass-fill: rgba(255,255,255,.32);
        --glass-edge: rgba(255,255,255,.65);
        --glass-text: #20242a;
        --glass-highlight: rgba(255, 255, 255, 0.6);
        --glass-shadow: rgba(0, 0, 0, 0.12);
      }
      [data-ds-dark-theme] .team-glass {
        --glass-fill: rgba(18,21,28,.32);
        --glass-edge: rgba(255,255,255,.20);
        --glass-text: #f3f5f8;
        --glass-highlight: rgba(255, 255, 255, 0.22);
        --glass-shadow: rgba(0, 0, 0, 0.45);
      }
      .team-glass iframe { color-scheme:light; }
      [data-ds-dark-theme] .team-glass iframe { color-scheme:dark; }
      .team-glass {
        background-color: var(--glass-fill);
        background-image:
          radial-gradient(ellipse at 15% 0%, rgba(255, 255, 255, 0.12) 0%, transparent 60%),
          radial-gradient(ellipse at 85% 100%, rgba(65, 118, 230, 0.08) 0%, transparent 50%),
          linear-gradient(135deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.01) 45%, rgba(0, 0, 0, 0.05) 100%);
        color: var(--glass-text);
        border: 1px solid var(--glass-edge);
        backdrop-filter: blur(32px) saturate(190%) contrast(105%);
        -webkit-backdrop-filter: blur(32px) saturate(190%) contrast(105%);
        box-shadow:
          inset 0 1.5px 1px 0 var(--glass-highlight),
          inset 0 -1px 1px 0 rgba(0, 0, 0, 0.15),
          0 24px 64px -12px var(--glass-shadow),
          0 8px 24px -4px rgba(0, 0, 0, 0.15);
      }
      .team-glass button:hover { filter:brightness(1.15); background:rgba(128,128,128,0.2) !important; }
      .team-glass button:focus-visible { outline:2px solid #4176e6; outline-offset:2px; }
      .team-resize-grip { opacity:0.4; transition:opacity 0.2s ease; }
      .team-resize-grip:hover { opacity:0.9; }
    `}</style>
    <button title={visible?"收起团队面板":"展开团队面板"} aria-label={visible?"收起团队面板":"展开团队面板"} aria-expanded={visible} onClick={()=>{setVisited(true);setVisible(!visible);setCollapsed(false);}} style={{position:"fixed",right:20,bottom:20,zIndex:51,width:48,height:48,borderRadius:"50%",border:"1px solid var(--dsw-alias-border-l2, #0000001a)",background:"var(--dsw-alias-button-primary-fill, #0f1115)",color:"var(--dsw-alias-label-primary-foreground, #fff)",display:"grid",placeItems:"center",boxShadow:"0 4px 16px #00000026",cursor:"pointer",padding:0}}><Icon value={Users}/></button>
    <aside ref={panelRef} className="team-glass" aria-label="团队项目面板" hidden={!visible} style={asideStyle}>
      <div
        onPointerDown={onHeaderPointerDown}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          height: 56,
          boxSizing: "border-box",
          flexShrink: 0,
          borderBottom: collapsed ? 0 : "1px solid var(--glass-edge)",
          cursor: isDragging ? "grabbing" : "grab",
          touchAction: "none"
        }}
      >
        <Icon value={Users}/>
        <strong style={{fontSize:13,flex:1,userSelect:"none",WebkitUserSelect:"none"}}>团队项目</strong>
        <button title={wide?"恢复紧凑宽度":"加宽面板"} aria-label={wide?"恢复紧凑宽度":"加宽面板"} aria-pressed={wide} onClick={()=>{setWide(!wide);setSize(null);}} style={control}><Icon value={wide?Minimize2:PanelRight}/></button>
        <button title={collapsed?"展开团队项目":"折叠团队项目"} aria-label={collapsed?"展开团队项目":"折叠团队项目"} aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)} style={control}><Icon value={collapsed?ChevronDown:ChevronUp}/></button>
        <button title="关闭团队项目" aria-label="关闭团队项目" onClick={()=>setVisible(false)} style={control}><Icon value={X}/></button>
      </div>
      {visited && <iframe title="团队项目" src="/team-plugin/" hidden={collapsed} style={{width:"100%",height:0,flex:"1 1 0",minHeight:0,minWidth:0,border:0,background:"transparent",display:collapsed?"none":"block",pointerEvents:(isDragging||isResizing)?"none":"auto"}} />}

      {/* Edge and corner resize handles */}
      {!collapsed && <>
        <div onPointerDown={onResizePointerDown("w")} style={{position:"absolute",left:0,top:0,bottom:14,width:8,cursor:"ew-resize",zIndex:9,touchAction:"none"}} />
        <div onPointerDown={onResizePointerDown("e")} style={{position:"absolute",right:0,top:0,bottom:14,width:8,cursor:"ew-resize",zIndex:9,touchAction:"none"}} />
        <div onPointerDown={onResizePointerDown("s")} style={{position:"absolute",left:14,right:14,bottom:0,height:8,cursor:"ns-resize",zIndex:9,touchAction:"none"}} />
        <div onPointerDown={onResizePointerDown("sw")} style={{position:"absolute",left:0,bottom:0,width:16,height:16,cursor:"nesw-resize",zIndex:10,touchAction:"none"}} />
        <div
          className="team-resize-grip"
          title="拖动缩放大小"
          aria-label="拖动缩放大小"
          onPointerDown={onResizePointerDown("se")}
          style={{position:"absolute",right:4,bottom:4,width:18,height:18,cursor:"nwse-resize",zIndex:10,display:"flex",alignItems:"center",justifyContent:"center",color:"inherit",touchAction:"none"}}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M9 1L1 9M9 5L5 9M9 9L9 9.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </>}
    </aside></>;
  }
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "team-hub", order: 30 }, Launcher));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "team-hub", order: 30 }, Overlay));
}
