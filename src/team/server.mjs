import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ApiError, ensure, member, str, uuid, audit } from "./contracts.mjs";
import { login, refresh, authenticate, changePassword, publicUser, createUser } from "./auth.mjs";
import { createProject, invite, acceptInvite, removeMember, submitBatch, snapshot, withdraw } from "./projects.mjs";
import { transaction } from "./db.mjs";
import { startWorker } from "./worker.mjs";

async function body(req) {
  ensure(req.headers["content-type"]?.split(";")[0] === "application/json", 415, "json_required");
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; ensure(size <= 256000, 413, "body_too_large"); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); ensure(value && !Array.isArray(value) && typeof value === "object"); return value; }
  catch { throw new ApiError(400, "invalid_json"); }
}
const assets = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };

export async function startTeamServer({ db, model, host = "127.0.0.1", port = 3090, allowedHosts = [], workerOptions = {} }) {
  const worker = startWorker(db, model, workerOptions), attempts = new Map();
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      const authority = req.headers.host;
      const activePort = server.address()?.port ?? port;
      const hosts = allowedHosts.length ? allowedHosts : [`${host}:${activePort}`, `localhost:${activePort}`, `127.0.0.1:${activePort}`];
      ensure(hosts.includes(authority), 403, "invalid_host");
      ensure(!req.headers.origin || req.headers.origin === `http://${authority}`, 403, "invalid_origin");
      const url = new URL(req.url, `http://${authority}`), p = url.pathname;
      if (req.method === "GET" && assets[p]) {
        const [file, type] = assets[p];
        const content = await fs.readFile(new URL(`../../team-ui/${file}`, import.meta.url));
        res.writeHead(200, { "content-type": type });
        res.end(content); return;
      }
      if (req.method === "GET" && p === "/health") { send(200, { ok: true }); return; }
      ensure(p.startsWith("/team/v1/"), 404, "not_found");
      const input = ["POST", "PATCH", "DELETE"].includes(req.method) ? await body(req) : {};
      let result;
      if (req.method === "POST" && ["/team/v1/auth/login", "/team/v1/auth/refresh"].includes(p)) {
        const now = Date.now(), key = req.socket.remoteAddress;
        const state = attempts.get(key) ?? { count: 0, until: now + 60000 };
        if (state.until < now) { state.count = 0; state.until = now + 60000; }
        state.count++; attempts.set(key, state);
        if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
        if (state.count > 30) { res.setHeader("retry-after", "60"); throw new ApiError(429, "rate_limited"); }
        result = p.endsWith("/login") ? await login(db, input) : await refresh(db, input);
      } else {
        const user = await authenticate(db, req.headers.authorization?.replace(/^Bearer /, ""));
        if (p === "/team/v1/auth/change-password" && req.method === "POST") result = await changePassword(db, user, input);
        else if (p === "/team/v1/auth/logout" && req.method === "POST") {
          await db.query("UPDATE team_tokens SET revoked=true WHERE family=$1", [user.family]); result = { ok: true };
        } else {
          ensure(!user.must_change, 403, "password_change_required");
          if (p === "/team/v1/me" && req.method === "GET") result = publicUser(user);
          else if (p === "/team/v1/capabilities" && req.method === "GET") result = { protocol: 1, autoPublish: true, modelConfigured: Boolean(model.baseUrl && model.name) };
          else if (p === "/team/v1/users" && req.method === "POST") {
            ensure(user.admin, 403, "permission_denied");
            result = await createUser(db, { name: input.name, password: input.password, assignedRoles: input.roles });
            await audit(db, user, null, "user.created");
          } else if (p === "/team/v1/projects" && req.method === "GET") {
            result = (await db.query(`SELECT p.id,p.name,p.owner_id,m.role FROM team_projects p JOIN team_members m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.created_at DESC`, [user.id])).rows;
          } else if (p === "/team/v1/projects" && req.method === "POST") result = await createProject(db, user, input);
          else if (p === "/team/v1/invites/accept" && req.method === "POST") result = await acceptInvite(db, user, input);
          else {
            const match = p.match(/^\/team\/v1\/projects\/([^/]+)\/(.+)$/);
            ensure(match, 404, "not_found");
            const [, projectId, action] = match;
            await member(db, user, projectId);
            if (action === "invites" && req.method === "POST") result = await invite(db, user, projectId, input);
            else if (action === "source-batches" && req.method === "POST") result = await submitBatch(db, user, projectId, input);
            else if (action === "snapshot" && req.method === "GET") result = await snapshot(db, user, projectId);
            else if (action === "members" && req.method === "GET") result = (await db.query("SELECT u.id,u.name,m.role FROM team_members m JOIN team_users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY u.name", [projectId])).rows;
            else if (action.startsWith("members/") && req.method === "DELETE") result = await removeMember(db, user, projectId, action.slice(8));
            else if (action === "transfer-owner" && req.method === "POST") result = await transaction(db, async tx => {
              const m = await member(tx, user, projectId, true, true); ensure(m.owner_id === user.id, 403, "permission_denied");
              const target = await member(tx, { id: uuid(input.userId) }, projectId, true);
              ensure(target.role === "project_manager");
              await tx.query("UPDATE team_projects SET owner_id=$2 WHERE id=$1", [projectId, input.userId]);
              return { ok: true };
            });
            else if (action === "changes" && req.method === "GET") {
              const cursor = Number(url.searchParams.get("cursor") ?? 0); ensure(Number.isSafeInteger(cursor) && cursor >= 0);
              const items = (await db.query("SELECT seq,kind,resource_id,payload FROM team_changes WHERE project_id=$1 AND seq>$2 ORDER BY seq LIMIT 100", [projectId, cursor])).rows;
              result = { items, cursor: items.at(-1)?.seq ?? cursor, hasMore: items.length === 100 };
            } else if (action === "memories/search" && req.method === "POST") {
              const q = str(input.query, 200).replace(/[\\%_]/g, "\\$&");
              result = (await db.query("SELECT * FROM team_memories WHERE project_id=$1 AND NOT withdrawn AND (title ILIKE $2 OR content ILIKE $2) ORDER BY created_at DESC LIMIT 30", [projectId, `%${q}%`])).rows;
            } else if (/^memories\/[^/]+\/withdraw$/.test(action) && req.method === "POST") result = await withdraw(db, user, projectId, action.split("/")[1]);
            else if (action === "model-jobs" && req.method === "GET") result = (await db.query("SELECT j.id,j.state,j.attempts,j.error,j.model,j.created_at,u.name FROM team_jobs j JOIN team_batches b ON b.id=j.batch_id JOIN team_users u ON u.id=b.user_id WHERE b.project_id=$1 ORDER BY j.created_at DESC LIMIT 100", [projectId])).rows;
            else if (action === "shared-sessions" && req.method === "GET") result = (await db.query("SELECT s.batch_id,s.content,s.created_at,u.name,b.session FROM team_summaries s JOIN team_batches b ON b.id=s.batch_id JOIN team_users u ON u.id=b.user_id WHERE s.project_id=$1 ORDER BY s.created_at DESC LIMIT 100", [projectId])).rows;
            else throw new ApiError(404, "not_found");
          }
        }
      }
      send(p.endsWith("/source-batches") ? 202 : 200, result);
    } catch (error) {
      const status = error.status ?? (error.code === "23505" ? 409 : 500);
      if (status === 500) console.error("Team request failed", requestId, error.code ?? error.name);
      send(status, { error: error.status ? error.code : status === 409 ? "already_exists" : "internal_error", requestId });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return { server, worker, async close() { await worker.close(); await new Promise(resolve => server.close(resolve)); } };
}
