import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError, ensure, str, redact } from "../../../src/team/contracts.mjs";

const defaultLocalSsoBase = "http://127.0.0.1:19800";

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function parseHubUrl(value) {
  const url = new URL(str(value, 500));
  ensure(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/");
  return url;
}

function ensureSsoHubTransport(url) {
  ensure(url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname)), 400, "sso_secure_transport_required");
}

export function excerpt(event) {
  const m = event.type === "user/message" ? event.data : event.type === "assistant/message" ? event.data?.message : null;
  if (!m || !["user", "model"].includes(m.source?.kind)) return null;
  const text = (m.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n");
  if (!text.trim()) return null;
  return { id: String(event.seq), role: event.type === "user/message" ? "user" : "assistant", text: redact(text) };
}

export class TeamEngine {
  constructor(dir, { fetcher = fetch, localSsoBase = defaultLocalSsoBase } = {}) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "team.sqlite");
    this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    this.db.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    this.device = this.read("device") ?? randomUUID(); this.write("device", this.device);
    this.profile = this.read("profile") ?? randomUUID(); this.write("profile", this.profile);
    const local = new URL(str(localSsoBase, 200));
    ensure(local.protocol === "http:" && local.hostname === "127.0.0.1" && local.port === "19800" && local.pathname === "/" && !local.username && !local.password && !local.search && !local.hash);
    this.fetcher = fetcher; this.localSsoBase = local.origin; this.auth = null; this.epoch = 0; this.data = null; this.status = "需要登录";
    this.abort = new AbortController(); this.busy = null;
  }
  read(key) { const row = this.db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; }
  write(key, value) { this.db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
  persist() { if (this.data && this.key) this.write(this.key, this.data); }
  async raw(hub, route, method = "GET", input, token) {
    const response = await this.fetcher(hub + "/team/v1" + route, { method, redirect: "error",
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input) });
    const value = await response.json();
    if (!response.ok) { const error = new Error(value.error ?? "hub_request_failed"); error.status = response.status; throw error; }
    return value;
  }
  async health(hub) {
    let response;
    try {
      response = await this.fetcher(hub + "/health", { method: "GET", redirect: "error",
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(2000)]),
        headers: { accept: "application/json" } });
    } catch (cause) {
      if (this.abort.signal.aborted) throw cause;
      throw new ApiError(503, "sso_transport_check_failed");
    }
    let value;
    try { value = await response.json(); }
    catch (cause) {
      if (this.abort.signal.aborted) throw cause;
      throw new ApiError(503, "sso_transport_check_failed");
    }
    ensure(response.ok && value && typeof value === "object" && !Array.isArray(value), 503, "sso_transport_check_failed");
    return value;
  }
  async ensurePasswordTransport(url) {
    if (url.protocol !== "http:" || isLoopbackHostname(url.hostname)) return;
    // A health check contains no credentials. If this Hub has SSO enabled,
    // refuse the password request before it can cross a cleartext LAN link.
    const health = await this.health(url.origin);
    // Treat an older or malformed health response as unsafe. A cleartext
    // password request is allowed only when the Hub explicitly says SSO is
    // disabled and its API does not require secure transport.
    ensure(health.ssoEnabled === false && health.secureApi === false, 400, "sso_secure_transport_required");
  }
  async localSso(route) {
    let response;
    try {
      response = await this.fetcher(this.localSsoBase + route, { method: "GET", redirect: "error",
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(2000)]), headers: { accept: "application/json" } });
    } catch (cause) {
      if (this.abort.signal.aborted) throw cause;
      const timeout = cause?.name === "AbortError" || cause?.name === "TimeoutError";
      throw new ApiError(timeout ? 504 : 503, timeout ? "sso_timeout" : "sso_unavailable");
    }
    let value;
    try { value = await response.json(); }
    catch (cause) {
      if (this.abort.signal.aborted) throw cause;
      if (cause?.name === "AbortError" || cause?.name === "TimeoutError") throw new ApiError(504, "sso_timeout");
      throw new ApiError(502, "sso_invalid_response");
    }
    ensure(value && typeof value === "object" && !Array.isArray(value), 502, "sso_invalid_response");
    if (!response.ok) {
      if (response.status === 401) {
        const code = route === "/sso/state" ? "sso_not_logged_in" : "sso_token_invalid";
        throw new ApiError(401, code);
      }
      throw new ApiError(503, "sso_unavailable");
    }
    return value;
  }
  async completeLogin(hub, auth, epoch) {
    ensure(epoch === this.epoch, 409, "identity_changed");
    this.hub = hub; this.auth = auth; this.key = hub + ":" + auth.user.id;
    this.data = this.read(this.key) ?? { sessions: {}, workspaces: {}, queue: [], caches: {} };
    if(this.data.historySyncVersion!==2) {
      for(const binding of Object.values(this.data.sessions)){binding.cursor=0;binding.part=0;}
      this.data.historySyncVersion=2;
    }
    this.data.caches = {}; this.projects = []; this.persist();
    this.status = auth.user.mustChangePassword ? "需要修改密码" : "已连接";
    return auth.user;
  }
  async login(input) {
    ensure(!this.auth, 409, "logout_first");
    const url = parseHubUrl(input.hub);
    await this.ensurePasswordTransport(url);
    const epoch = ++this.epoch, hub = url.origin;
    const auth = await this.raw(hub, "/auth/login", "POST", { name: input.name, password: input.password, device: this.device });
    return this.completeLogin(hub, auth, epoch);
  }
  async ssoLogin(input) {
    ensure(!this.auth, 409, "logout_first");
    const url = parseHubUrl(input.hub);
    // The desktop access token is read immediately after this check. Keep
    // cleartext LAN endpoints out of the flow so the token never leaves the
    // machine over an unencrypted connection.
    ensureSsoHubTransport(url);
    const epoch = ++this.epoch, hub = url.origin;
    const state = await this.localSso("/sso/state");
    ensure(state.logged_in === true, 401, "sso_not_logged_in");
    const ssoUsername = typeof state.username === "string" && state.username.trim() ? state.username.trim() : "";
    ensure(ssoUsername, 502, "sso_invalid_response");
    const token = await this.localSso("/sso/token");
    ensure(typeof token.access_token === "string" && token.access_token.length >= 20 && token.access_token.length <= 8192, 401, "sso_token_invalid");
    const auth = { ...await this.raw(hub, "/auth/sso", "POST", { accessToken: token.access_token, device: this.device }), sso: true,
      ...(ssoUsername ? { ssoUsername } : {}) };
    return this.completeLogin(hub, auth, epoch);
  }
  async api(route, method = "GET", input) {
    ensure(this.auth, 401, "unauthorized");
    const epoch = this.epoch;
    if (this.auth.expires < Date.now() + 30000) {
      this.refreshing ??= this.raw(this.hub, "/auth/refresh", "POST", { refreshToken: this.auth.refreshToken })
        .then(auth => {
          ensure(epoch === this.epoch, 409, "identity_changed");
          this.auth = this.auth?.sso
            ? { ...auth, sso: true, ...(this.auth.ssoUsername ? { ssoUsername: this.auth.ssoUsername } : {}) }
            : auth;
        })
        .finally(() => { this.refreshing = null; });
      try {
        await this.refreshing;
      } catch (error) {
        // Refresh failures happen before the ordinary request try/catch below.
        // Clear a still-current session when the Hub rejects its refresh token;
        // otherwise an SSO session can remain stuck in a retry loop forever.
        if (epoch === this.epoch && error?.status === 401) {
          this.auth = null;
          this.projects = [];
          this.status = "需要登录";
        }
        throw error;
      }
    }
    let result;
    try { result = await this.raw(this.hub, route, method, input, this.auth.accessToken); }
    catch (error) {
      if (epoch === this.epoch && error.status === 401) { this.auth = null; this.projects = []; this.status = "需要登录"; }
      throw error;
    }
    ensure(epoch === this.epoch, 409, "identity_changed");
    return result;
  }
  async password(input) {
    const auth = await this.api("/auth/change-password", "POST", input); this.auth = auth; this.status = "已连接"; return auth.user;
  }
  async logout() {
    const auth = this.auth, hub = this.hub;
    ++this.epoch; this.auth = null; this.data = null; this.projects = []; this.status = "需要登录";
    if (auth) await this.raw(hub, "/auth/logout", "POST", {}, auth.accessToken).catch(() => {});
  }
  bind(session, projectId, from = session.seq) {
    ensure(this.auth && !this.auth.user.mustChangePassword, 401, "unauthorized");
    const old = this.data.sessions[session.id];
    ensure(!old || old.projectId === projectId, 409, "session_project_conflict");
    this.data.sessions[session.id] = old ?? { projectId, cursor: from, cwd: session.header?.cwd ?? "" };
    this.persist();
  }
  created(session) {
    if (!this.auth || !this.data || this.auth.user.mustChangePassword) return;
    const cwd = session.header?.cwd;
    const project = cwd && this.data.workspaces[cwd];
    if (project && !this.data.sessions[session.id]) this.bind(session, project, 0);
  }
  capture(sessionId, events) {
    const binding = this.data?.sessions[sessionId];
    if (!this.auth || this.auth.user.mustChangePassword || !binding) return;
    const end = events.findLast(e => e.seq >= binding.cursor);
    if (!end) return;
    const entries = events.filter(e => e.seq >= binding.cursor && e.seq <= end.seq).map(excerpt).filter(Boolean).flatMap(entry => {
      const parts=[];
      for(let i=0;i<entry.text.length;i+=12000) {
        if(Number(entry.id)===binding.cursor && i/12000<(binding.part??0))continue;
        parts.push({...entry,id:i?`${entry.id}:${i/12000}`:entry.id,text:entry.text.slice(i,i+12000),nextCursor:i+12000>=entry.text.length?Number(entry.id)+1:Number(entry.id),nextPart:i+12000>=entry.text.length?0:i/12000+1});
      }
      return parts;
    });
    const batches = []; let current = [], size = 0;
    for (const entry of entries) {
      const length = JSON.stringify(entry).length + 1;
      if (size + length > 45000 || current.length === 100) { batches.push(current); current = []; size = 0; }
      current.push(entry); size += length;
    }
    if (current.length) batches.push(current);
    const accepted=batches.slice(0,Math.max(0,200-this.data.queue.length));
    for (const group of accepted) this.data.queue.push({ projectId: binding.projectId, operationId: randomUUID(), profile: this.profile, session: sessionId, entries: group.map(({nextCursor,nextPart,...entry})=>entry) });
    if(accepted.length===batches.length){binding.cursor=end.seq+1;binding.part=0;}
    else if(accepted.length){const last=accepted.at(-1).at(-1);binding.cursor=last.nextCursor;binding.part=last.nextPart;}
    this.persist();
  }
  sync() {
    if (this.busy) return this.busy;
    this.busy = this.runSync().finally(() => { this.busy = null; }); return this.busy;
  }
  async runSync() {
    if (!this.auth || this.auth.user.mustChangePassword) return;
    const epoch = this.epoch;
    try {
      if (this.auth.sso) {
        try {
          const state = await this.localSso("/sso/state");
          const currentUsername = typeof state.username === "string" ? state.username.trim() : "";
          if (state.logged_in !== true || !currentUsername || currentUsername !== this.auth.ssoUsername) {
            this.auth = null; this.projects = []; this.status = "需要登录";
            return;
          }
        } catch (error) {
          if (error?.status === 401 || error?.code === "sso_not_logged_in") {
            this.auth = null; this.projects = []; this.status = "需要登录";
            return;
          }
          // A transient local service outage should not discard a valid Hub
          // session; the next poll will retry the state check.
        }
      }
      const projects = await this.api("/projects"), allowed = new Set(projects.map(p => p.id));
      this.projects = projects;
      for (const id of Object.keys(this.data.caches)) if (!allowed.has(id)) delete this.data.caches[id];
      this.data.queue = this.data.queue.filter(q => allowed.has(q.projectId));
      for (const [id,b] of Object.entries(this.data.sessions)) if (!allowed.has(b.projectId)) delete this.data.sessions[id];
      for (const [cwd,id] of Object.entries(this.data.workspaces)) if (!allowed.has(id)) delete this.data.workspaces[cwd];
      this.persist();
      for (const item of [...this.data.queue].slice(0, 10)) {
        await this.api(`/projects/${item.projectId}/source-batches`, "POST", item);
        this.data.queue = this.data.queue.filter(q => q.operationId !== item.operationId); this.persist();
      }
      for (const project of projects) {
        let cache = this.data.caches[project.id];
        if (!cache) {
          const snap = await this.api(`/projects/${project.id}/snapshot`);
          cache = { cursor: snap.cursor, memories: Object.fromEntries(snap.memories.map(m => [m.id,m])), checked: Date.now() };
          this.data.caches[project.id] = cache; this.persist();
        } else {
          let pages = 0, more;
          do {
            const result = await this.api(`/projects/${project.id}/changes?cursor=${cache.cursor}`);
            for (const e of result.items) {
              if (e.kind === "memory.deleted") delete cache.memories[e.resource_id];
              else if (e.kind === "memory.upsert") cache.memories[e.resource_id] = e.payload;
            }
            cache.cursor = result.cursor; cache.checked = Date.now(); this.persist(); more = result.hasMore;
          } while (more && ++pages < 10);
        }
      }
      this.status = "已同步";
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (error.status === 401) { this.auth = null; this.status = "需要登录"; }
      else if (error.message === "project_access_revoked") {
        this.data.caches = {}; this.persist(); this.status = "项目权限已变化";
      } else this.status = `同步暂停：${error.message}`;
    }
  }
  memories(assembly) {
    if (!this.auth || this.auth.user.mustChangePassword) return [];
    const id = assembly.agent?.id;
    const binding = id && this.data?.sessions[id];
    const cache = binding && this.data.caches[binding.projectId];
    if (!cache || Date.now() - cache.checked > 86400_000) return [];
    return Object.values(cache.memories).sort((a,b) => b.created_at.localeCompare(a.created_at));
  }
  context(assembly) {
    const memories = this.memories(assembly);
    if (!memories.length) return "";
    return memories.slice(0,12).map(m => `[Project memory ${m.id} v${m.version}; ${m.evidence}; model-generated reference]\n${m.title}\n${m.content}`).join("\n\n").slice(0, 8000);
  }
  view() { return { user: this.auth?.user ?? null, hub: this.hub ?? "", status: this.status,
    pending: this.data?.queue.length ?? 0, bindings: this.data?.sessions ?? {}, workspaces: this.data?.workspaces ?? {}, projects: this.projects ?? [] }; }
  async close() { ++this.epoch; this.abort.abort(); await this.busy; this.db.close(); }
}
