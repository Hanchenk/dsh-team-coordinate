import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ApiError, ensure, member, str, uuid, audit } from "./contracts.mjs";
import { login, loginWithSso, refresh, authenticate, changePassword, publicUser, createUser } from "./auth.mjs";
import { createProject, addMember, invite, acceptInvite, removeMember, submitBatch, snapshot, withdraw } from "./projects.mjs";
import { readModel, publicModel, saveModel } from "./settings.mjs";
import { transaction } from "./db.mjs";
import { startWorker } from "./worker.mjs";
import { agentProjectRoute } from "./agent-projects.mjs";
import { workbenchRoute } from "./workbench.mjs";
import { defaultSsoProxyAddresses, normalizeSsoDevice, normalizeSsoProxyAddress, parseSsoProxyAddresses, resolveSsoIdentity, validateSsoConfig, validateSsoDefaultRoles } from "./sso.mjs";

async function body(req) {
  ensure(req.headers["content-type"]?.split(";")[0] === "application/json", 415, "json_required");
  let size = 0; const chunks = [];
  const limit=/\/workbench\/assets$/.test(req.url)?8_000_000:256000;
  for await (const chunk of req) { size += chunk.length; ensure(size <= limit, 413, "body_too_large"); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); ensure(value && !Array.isArray(value) && typeof value === "object"); return value; }
  catch { throw new ApiError(400, "invalid_json"); }
}
const assets = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"], "/agent-team.png":["agent-team.png","image/png"] };

function loopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function loopbackAddress(address) {
  const value = normalizeSsoProxyAddress(address);
  return value === "127.0.0.1" || value === "::1";
}

function forwardedHttps(req, trustProxy, proxyAddresses = defaultSsoProxyAddresses) {
  if (!trustProxy) return false;
  const trusted = (Array.isArray(proxyAddresses) ? proxyAddresses : parseSsoProxyAddresses(proxyAddresses)).map(normalizeSsoProxyAddress);
  if (!trusted.includes(normalizeSsoProxyAddress(req.socket?.remoteAddress))) return false;
  const value = req.headers?.["x-forwarded-proto"];
  // The proxy must overwrite this header. Accepting a comma list would allow
  // an untrusted client value to be carried into the first position.
  return typeof value === "string" && value.trim().toLowerCase() === "https";
}

/**
 * Return whether an SSO request arrived over an encrypted client connection.
 * `X-Forwarded-Proto` is considered only when the operator explicitly trusts
 * the reverse proxy; otherwise a direct client could forge the header.
 */
export function isSecureSsoRequest(req, authority, { trustProxy = false, proxyAddresses = defaultSsoProxyAddresses } = {}) {
  if (req.socket?.encrypted === true || forwardedHttps(req, trustProxy, proxyAddresses)) return true;
  // Once a reverse proxy is configured, a loopback peer may be the proxy
  // itself rather than the local browser. Do not let a remote HTTP request
  // through that proxy forge a localhost Host header to bypass TLS checks.
  if (trustProxy) return false;
  let hostname;
  try { hostname = new URL(`http://${authority}`).hostname; } catch { return false; }
  return loopbackHostname(hostname) && loopbackAddress(req.socket?.remoteAddress);
}

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  ensure(normalized === "true" || normalized === "false", 500, "sso_configuration_invalid");
  return normalized === "true";
}

export async function startTeamServer({ db, model, host = "127.0.0.1", port = 3090, allowedHosts = [], workerOptions = {}, sso = {} }) {
  const ssoBaseUrl = Object.prototype.hasOwnProperty.call(sso, "baseUrl")
    ? sso.baseUrl
    : process.env.TEAM_SSO_BASE_URL || process.env.TEAM_CERTIFICATE_BASE_URL || "";
  const ssoOptions = validateSsoConfig({
    baseUrl: ssoBaseUrl,
    timeoutMs: sso.timeoutMs ?? Number(process.env.TEAM_SSO_TIMEOUT_MS || 5000),
    provider: sso.provider ?? process.env.TEAM_SSO_PROVIDER ?? "yemast",
    allowInsecure: sso.allowInsecure ?? String(process.env.TEAM_SSO_ALLOW_INSECURE || "").trim().toLowerCase() === "true",
    fetcher: sso.fetcher,
  });
  const defaultRoles = validateSsoDefaultRoles(sso.defaultRoles ?? (process.env.TEAM_SSO_DEFAULT_ROLES || "developer").split(",").map(value => value.trim()).filter(Boolean));
  const trustProxy = booleanOption(sso.trustProxy ?? process.env.TEAM_SSO_TRUST_PROXY, false);
  const proxyAddresses = parseSsoProxyAddresses(sso.proxyAddresses ?? process.env.TEAM_SSO_PROXY_ADDRESSES);
  const worker = startWorker(db, model, workerOptions), attempts = new Map();
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    // Browser SSO reads the token from the loopback service before handing it
    // to this server. Keep the allowlist narrow: only the fixed local port is
    // needed in addition to the Hub origin.
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:19800; frame-ancestors 'none'; base-uri 'none'");
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      const authority = req.headers.host;
      const activePort = server.address()?.port ?? port;
      const hosts = allowedHosts.length ? allowedHosts : [`${host}:${activePort}`, `localhost:${activePort}`, `127.0.0.1:${activePort}`, `[::1]:${activePort}`];
      ensure(hosts.includes(authority), 403, "invalid_host");
      // A TLS reverse proxy preserves the browser's https Origin while the
      // Hub process receives plain HTTP. The host allowlist remains the trust
      // boundary, so accepting both schemes does not widen it.
      ensure(!req.headers.origin || [`http://${authority}`, `https://${authority}`].includes(req.headers.origin), 403, "invalid_origin");
      const url = new URL(req.url, `http://${authority}`), p = url.pathname;
      // Keep the health probe available so clients can discover that HTTPS is
      // required, but never serve the login page or API over remote cleartext
      // once SSO is enabled.
      if (ssoOptions.baseUrl && p !== "/health") {
        ensure(isSecureSsoRequest(req, authority, { trustProxy, proxyAddresses }), 400, "sso_secure_transport_required");
      }
      if (req.method === "GET" && assets[p]) {
        const [file, type] = assets[p];
        const content = await fs.readFile(new URL(`../../team-ui/${file}`, import.meta.url));
        res.writeHead(200, { "content-type": type });
        res.end(content); return;
      }
      if (req.method === "GET" && p === "/health") {
        send(200, { ok: true, ssoEnabled: Boolean(ssoOptions.baseUrl), secureApi: Boolean(ssoOptions.baseUrl) });
        return;
      }
      // Once SSO is enabled, every API request may carry a password, refresh
      // token, or Hub access token. The page/static guard above covers the
      // browser surface; keep this path-specific check as defense in depth.
      if (ssoOptions.baseUrl && p.startsWith("/team/v1/")) {
        ensure(isSecureSsoRequest(req, authority, { trustProxy, proxyAddresses }), 400, "sso_secure_transport_required");
      }
      if(req.method==="GET"&&p.startsWith("/team/v1/plugin-releases/")){
        const filename=p.slice("/team/v1/plugin-releases/".length);
        ensure(filename==="latest"||/^[a-f0-9]{64}\.tgz$/.test(filename),404,"not_found");
        const directory=process.env.TEAM_PLUGIN_RELEASE_DIR??new URL("../../artifacts/plugin-releases/",import.meta.url);
        const {join}=await import("node:path"),{fileURLToPath}=await import("node:url");
        let content;try{content=await fs.readFile(join(directory instanceof URL?fileURLToPath(directory):directory,filename==="latest"?"latest.json":filename));}catch(e){if(e.code==="ENOENT"){send(404,{error:"release_not_published"});return;}throw e;}
        res.writeHead(200,{"content-type":filename==="latest"?"application/json":"application/octet-stream","content-length":content.length});res.end(content);return;
      }
      ensure(p.startsWith("/team/v1/"), 404, "not_found");
      const input = ["POST", "PATCH", "DELETE"].includes(req.method) ? await body(req) : {};
      let result;
      if (req.method === "POST" && ["/team/v1/auth/login", "/team/v1/auth/refresh", "/team/v1/auth/sso"].includes(p)) {
        const now = Date.now(), key = req.socket.remoteAddress;
        const state = attempts.get(key) ?? { count: 0, until: now + 60000 };
        if (state.until < now) { state.count = 0; state.until = now + 60000; }
        state.count++; attempts.set(key, state);
        if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
        if (state.count > 30) { res.setHeader("retry-after", "60"); throw new ApiError(429, "rate_limited"); }
        if (p.endsWith("/login")) result = await login(db, input);
        else if (p.endsWith("/refresh")) result = await refresh(db, input);
        else {
          const identity = await resolveSsoIdentity(input, ssoOptions);
          result = await loginWithSso(db, {
            provider: ssoOptions.provider,
            subject: identity.user.subject,
            username: identity.user.username,
            displayName: identity.user.displayName,
            ssoRole: identity.user.role,
            device: normalizeSsoDevice(input.device),
            defaultRoles,
          });
        }
      } else {
        const user = await authenticate(db, req.headers.authorization?.replace(/^Bearer /, ""));
        if (p === "/team/v1/auth/change-password" && req.method === "POST") result = await changePassword(db, user, input);
        else if (p === "/team/v1/auth/logout" && req.method === "POST") {
          await db.query("UPDATE team_tokens SET revoked=true WHERE family=$1", [user.family]); result = { ok: true };
        } else {
          ensure(!user.must_change, 403, "password_change_required");
          if (p === "/team/v1/me" && req.method === "GET") result = publicUser(user);
          else if (p === "/team/v1/capabilities" && req.method === "GET") {
            const current = await readModel(db, model);
            const agentModel=await readModel(db,{},"agent-model");
            const {rows:[runner]}=await db.query("SELECT value FROM team_settings WHERE key='agent-supervisor'");
            result = { protocol:2, autoPublish:true, modelConfigured:Boolean(current.baseUrl && current.name),agentModelConfigured:Boolean(agentModel.baseUrl&&agentModel.name),agentRunnerReady:Date.now()-(runner?.value?.heartbeat??0)<30000 };
          } else if (p === "/team/v1/settings/agent-model" && req.method === "GET") {
            ensure(user.admin,403,"permission_denied");result=publicModel(await readModel(db,{},"agent-model"));
          } else if (p === "/team/v1/settings/agent-model" && req.method === "POST") result=await saveModel(db,user,input,{},"agent-model");
          else if (p === "/team/v1/settings/model" && req.method === "GET") {
            ensure(user.admin,403,"permission_denied"); result = publicModel(await readModel(db, model));
          } else if (p === "/team/v1/settings/model" && req.method === "POST") result = await saveModel(db,user,input,model);
          else if (p === "/team/v1/users" && req.method === "POST") {
            ensure(user.admin, 403, "permission_denied");
            result = await createUser(db, { name: input.name, password: input.password, assignedRoles: input.roles });
            await audit(db, user, null, "user.created");
          } else if (p === "/team/v1/projects" && req.method === "GET") {
            result = (await db.query(`SELECT p.id,p.name,p.description,p.owner_id,m.role FROM team_projects p JOIN team_members m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.created_at DESC`, [user.id])).rows;
          } else if (p === "/team/v1/projects" && req.method === "POST") result = await createProject(db, user, input);
          else if (p === "/team/v1/invites/accept" && req.method === "POST") result = await acceptInvite(db, user, input);
          else {
            const match = p.match(/^\/team\/v1\/projects\/([^/]+)\/(.+)$/);
            ensure(match, 404, "not_found");
            const [, projectId, action] = match;
            await member(db, user, projectId);
            if(action.startsWith("workbench/")){
              result=await workbenchRoute(db,user,projectId,action,req.method,input);ensure(result!==undefined,404,"not_found");
            }
            else if (/^(repositories|agents|agent-runs)(\/|$)/.test(action)) {
              result=await agentProjectRoute(db,user,projectId,action,req.method,input);ensure(result!==undefined,404,"not_found");
            }
            else if (action === "invites" && req.method === "POST") result = await invite(db, user, projectId, input);
            else if (action === "member-candidates" && req.method === "GET") {
              await member(db,user,projectId,true);
              result = (await db.query("SELECT id,name,roles FROM team_users WHERE active AND id NOT IN (SELECT user_id FROM team_members WHERE project_id=$1) ORDER BY name", [projectId])).rows;
            }
            else if (action === "members" && req.method === "POST") result = await addMember(db,user,projectId,input);
            else if (action === "sessions" && req.method === "GET") {
              const offset = Number(url.searchParams.get("offset") ?? 0); ensure(Number.isSafeInteger(offset) && offset >= 0);
              const items = (await db.query(`SELECT s.*,u.name,
                (SELECT count(*)::int FROM team_session_messages m WHERE m.session_id=s.id) AS message_count,
                (SELECT su.content FROM team_summaries su JOIN team_batches b ON b.id=su.batch_id
                  WHERE b.project_id=s.project_id AND b.device=s.device AND b.profile=s.profile AND b.session=s.session
                  ORDER BY su.created_at DESC LIMIT 1) AS summary
                FROM team_shared_sessions s JOIN team_users u ON u.id=s.user_id
                WHERE s.project_id=$1 AND s.merged_into IS NULL ORDER BY s.updated_at DESC,s.id LIMIT 51 OFFSET $2`, [projectId,offset])).rows;
              result = { items:items.slice(0,50),hasMore:items.length>50 };
            }
            else if (/^sessions\/[^/]+$/.test(action) && req.method === "GET") {
              const id=uuid(action.split("/")[1]), cursor=Number(url.searchParams.get("cursor") ?? 0);
              ensure(Number.isSafeInteger(cursor) && cursor>=0);
              const { rows:[session] }=await db.query("SELECT s.*,u.name FROM team_shared_sessions requested JOIN team_shared_sessions s ON s.id=COALESCE(requested.merged_into,requested.id) JOIN team_users u ON u.id=s.user_id WHERE requested.id=$1 AND requested.project_id=$2 AND s.project_id=$2",[id,projectId]);
              ensure(session,404,"session_not_found");
              const items=(await db.query("SELECT seq,source_id,role,content FROM team_session_messages WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT 201",[session.id,cursor])).rows;
              result={session,items:items.slice(0,200),hasMore:items.length>200,cursor:items.slice(0,200).at(-1)?.seq ?? cursor};
            }
            else if (action === "source-batches" && req.method === "POST") result = await submitBatch(db, user, projectId, input);
            else if (action === "snapshot" && req.method === "GET") result = await snapshot(db, user, projectId);
            else if (action === "update-description" && req.method === "POST") {
              await member(db, user, projectId, true);
              const description = typeof input.description === "string" ? input.description.slice(0, 500) : "";
              await db.query("UPDATE team_projects SET description=$2 WHERE id=$1", [projectId, description]);
              result = { ok: true, description };
            }
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
            else if (action === "model-jobs" && req.method === "GET") result = (await db.query("SELECT j.id,j.state,j.attempts,j.error,j.model,j.created_at,u.name,(SELECT count(*)::int FROM team_memories m WHERE m.batch_id=b.id) AS memory_count FROM team_jobs j JOIN team_batches b ON b.id=j.batch_id JOIN team_users u ON u.id=b.user_id WHERE b.project_id=$1 ORDER BY j.created_at DESC LIMIT 100", [projectId])).rows;
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
