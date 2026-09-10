import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensure, str, redact } from "../../../src/team/contracts.mjs";

export function excerpt(event) {
  const m = event.type === "user/message" ? event.data : event.type === "assistant/message" ? event.data?.message : null;
  if (!m || !["user", "model"].includes(m.source?.kind)) return null;
  const text = (m.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n");
  if (!text.trim()) return null;
  return { id: String(event.seq), role: event.type === "user/message" ? "user" : "assistant", text: redact(text.slice(0, 12000)) };
}

export class TeamEngine {
  constructor(dir, { fetcher = fetch } = {}) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "team.sqlite");
    this.db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    this.db.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    this.device = this.read("device") ?? randomUUID(); this.write("device", this.device);
    this.profile = this.read("profile") ?? randomUUID(); this.write("profile", this.profile);
    this.fetcher = fetcher; this.auth = null; this.epoch = 0; this.data = null; this.status = "需要登录";
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
  async login(input) {
    ensure(!this.auth, 409, "logout_first");
    const url = new URL(str(input.hub, 500));
    ensure(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/");
    const epoch = ++this.epoch, hub = url.origin;
    const auth = await this.raw(hub, "/auth/login", "POST", { name: input.name, password: input.password, device: this.device });
    ensure(epoch === this.epoch, 409, "identity_changed");
    this.hub = hub; this.auth = auth; this.key = hub + ":" + auth.user.id;
    this.data = this.read(this.key) ?? { sessions: {}, workspaces: {}, queue: [], caches: {} };
    this.data.caches = {}; this.projects = []; this.persist();
    this.status = auth.user.mustChangePassword ? "需要修改密码" : "已连接";
    return auth.user;
  }
  async api(route, method = "GET", input) {
    ensure(this.auth, 401, "unauthorized");
    const epoch = this.epoch;
    if (this.auth.expires < Date.now() + 30000) {
      this.refreshing ??= this.raw(this.hub, "/auth/refresh", "POST", { refreshToken: this.auth.refreshToken })
        .then(auth => { ensure(epoch === this.epoch, 409, "identity_changed"); this.auth = auth; })
        .finally(() => { this.refreshing = null; });
      await this.refreshing;
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
    if (project && !this.data.sessions[session.id]) this.bind(session, project, session.firstLiveSeq ?? session.seq);
  }
  capture(sessionId, events) {
    const binding = this.data?.sessions[sessionId];
    if (!this.auth || this.auth.user.mustChangePassword || !binding) return;
    const end = events.findLast(e => e.type === "turn/end" && e.seq >= binding.cursor);
    if (!end) return;
    const entries = events.filter(e => e.seq >= binding.cursor && e.seq <= end.seq).map(excerpt).filter(Boolean);
    const batches = []; let current = [], size = 0;
    for (const entry of entries) {
      const length = JSON.stringify(entry).length + 1;
      if (size + length > 45000 || current.length === 100) { batches.push(current); current = []; size = 0; }
      current.push(entry); size += length;
    }
    if (current.length) batches.push(current);
    ensure(this.data.queue.length + batches.length <= 200, 409, "local_queue_full");
    for (const group of batches) this.data.queue.push({ projectId: binding.projectId, operationId: randomUUID(), profile: this.profile, session: sessionId, entries: group });
    binding.cursor = end.seq + 1; this.persist();
  }
  sync() {
    if (this.busy) return this.busy;
    this.busy = this.runSync().finally(() => { this.busy = null; }); return this.busy;
  }
  async runSync() {
    if (!this.auth || this.auth.user.mustChangePassword) return;
    const epoch = this.epoch;
    try {
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
