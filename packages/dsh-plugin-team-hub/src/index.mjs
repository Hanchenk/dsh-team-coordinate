import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TeamEngine } from "./engine.mjs";
import { registerMemoryTools } from "./tools.mjs";
import { ensure, digest } from "../../../src/team/contracts.mjs";

export const name = "team-hub";
export const inject = ["webServer", "sessions", "desktopProfiles"];

export function apply(ctx, config = {}) {
  const profileKey = digest(ctx.desktopProfiles.current.dir);
  const dataDir = config.dataDir ?? path.join(os.homedir(), ".dsh-team-plugin", profileKey);
  ensure(typeof dataDir === "string" && path.isAbsolute(dataDir));
  const engine = new TeamEngine(dataDir);
  const abort = new AbortController(); let pending = null;
  async function sync() {
    if (pending || abort.signal.aborted) return;
    pending = (async () => {
      const epoch = engine.epoch;
      const query = ctx.get("sessionQuery");
      if (engine.auth && query) {
        for (const id of Object.keys(engine.data.sessions)) {
          try {
            const value = await query.readSession(id);
            if (!abort.signal.aborted && engine.epoch === epoch) engine.capture(id, value.events);
          } catch (error) { ctx.logger.warn(`Team history: ${error.code ?? error.name}`); }
        }
      }
      await engine.sync();
    })().catch(error => { ctx.logger.warn(`Team sync: ${error.code ?? error.name}`); }).finally(() => { pending = null; });
    await pending;
  }
  ctx.on("session/created", session => engine.created(session));
  ctx.on("session/event", (session, event) => {
    if (event.type !== "turn/end") return;
    try { engine.capture(session.id, session.snapshotEvents()); }
    catch (error) { engine.status = error.code ?? error.message; }
  });
  ctx.inject(["systemPrompt"], scope => {
    // Variable values are not re-interpolated, so memory text can contain {{...}} safely.
    scope.systemPrompt.variable("team_hub_memory", assembly => engine.context(assembly));
    scope.systemPrompt.context({ name: "team-hub:memory", order: 400, text: assembly => engine.context(assembly) ? "{{team_hub_memory}}" : "" });
  });
  ctx.inject(["tools"], scope => registerMemoryTools(scope, engine));
  const disposeRoute = ctx.webServer.register({ kind: "prefix", path: "/team-plugin", handler: async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
    try {
      const port = ctx.webServer.port, host = req.headers.host;
      ensure([`127.0.0.1:${port}`, `localhost:${port}`].includes(host), 403, "invalid_host");
      ensure(["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress), 403, "loopback_required");
      ensure(!req.headers.origin || req.headers.origin === `http://${host}`, 403, "invalid_origin");
      const url = new URL(req.url, `http://${host}`), relative = url.pathname.slice("/team-plugin".length);
      const asset = { "": "index.html", "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" }[relative];
      if (req.method === "GET" && asset) {
        const content = await fs.readFile(new URL(`./ui/${asset}`, import.meta.url));
        res.writeHead(200, { "content-type": asset.endsWith("html") ? "text/html; charset=utf-8" : asset.endsWith("css") ? "text/css" : "text/javascript",
          "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'" });
        res.end(content); return;
      }
      ensure(req.method === "POST" && relative === "/local", 404, "not_found");
      ensure(req.headers["content-type"]?.split(";")[0] === "application/json", 415, "json_required");
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; ensure(size <= 256000, 413, "body_too_large"); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")); let result;
      if (input.action === "state") result = { ...engine.view(), sessions: ctx.sessions.list().map(s => ({ id: s.id, cwd: s.header?.cwd ?? "" })), autoContext: Boolean(ctx.get("systemPrompt")) };
      else if (input.action === "login") result = await engine.login(input);
      else if (input.action === "logout") { await engine.logout(); result = { ok: true }; }
      else if (input.action === "password") result = await engine.password(input);
      else if (input.action === "bind") {
        const projects = await engine.api("/projects"); ensure(projects.some(p => p.id === input.projectId), 403, "permission_denied");
        const session = ctx.sessions.get(input.sessionId); ensure(session, 404, "session_not_found");
        engine.bind(session, input.projectId);
        if (input.workspace && session.header?.cwd) { engine.data.workspaces[session.header.cwd] = input.projectId; engine.persist(); }
        result = { ok: true };
      } else if (input.action === "sync") { await sync(); result = engine.view(); }
      else if (input.action === "api") {
        ensure(typeof input.route === "string" && /^\/(projects|invites|me|capabilities|users)(\/|\?|$)/.test(input.route) && !input.route.includes("..") && !input.route.includes("#"));
        ensure(["GET", "POST", "DELETE"].includes(input.method ?? "GET"));
        result = await engine.api(input.route, input.method, input.input);
      } else ensure(false, 400, "unknown_action");
      send(200, result);
    } catch (error) { send(error.status ?? 400, { error: error.code ?? error.message }); }
  } });
  const timer = setInterval(() => { void sync(); }, 15000); timer.unref();
  ctx.effect(() => async () => { abort.abort(); clearInterval(timer); disposeRoute(); engine.abort.abort(); await pending; await engine.close(); }, "team-hub lifecycle");
}
