import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseSsoProxyAddresses, resolveSsoIdentity, ssoConfig, validateAccessToken, validateSsoDefaultRoles } from "../../src/team/sso.mjs";
import { TeamEngine } from "../../packages/dsh-plugin-team-hub/src/engine.mjs";
import { database, migrate } from "../../src/team/db.mjs";
import { createUser, loginWithSso } from "../../src/team/auth.mjs";
import { isSecureSsoRequest, startTeamServer } from "../../src/team/server.mjs";

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
  };
}

function config(fetcher, extra = {}) {
  return { baseUrl: "https://passport.example.test/", fetcher, timeoutMs: 1000, provider: "yemast", ...extra };
}

test("ssoConfig reads the production environment settings", () => {
  const value = ssoConfig({
    TEAM_SSO_BASE_URL: "https://passport.example.test/",
    TEAM_SSO_PROVIDER: "yemast",
    TEAM_SSO_TIMEOUT_MS: "5000",
  });
  assert.equal(value.baseUrl, "https://passport.example.test");
  assert.equal(value.provider, "yemast");
  assert.equal(value.timeoutMs, 5000);
  assert.deepEqual(value.proxyAddresses, ["127.0.0.1", "::1"]);
  assert.equal(typeof value.fetcher, "function");
  const legacy = ssoConfig({ TEAM_CERTIFICATE_BASE_URL: "https://legacy.example.test/" });
  assert.equal(legacy.baseUrl, "https://legacy.example.test");
});

test("ssoConfig rejects cleartext upstreams unless explicitly enabled", () => {
  assert.throws(
    () => ssoConfig({ TEAM_SSO_BASE_URL: "http://passport.example.test" }),
    error => error.status === 500 && error.code === "sso_configuration_invalid",
  );
  const development = ssoConfig({
    TEAM_SSO_BASE_URL: "http://passport.example.test/",
    TEAM_SSO_ALLOW_INSECURE: "true",
  });
  assert.equal(development.baseUrl, "http://passport.example.test");
  assert.equal(development.allowInsecure, true);
});

test("proxy forwarding is restricted to configured source addresses", () => {
  assert.deepEqual(parseSsoProxyAddresses("::ffff:127.0.0.1,10.0.0.8,10.0.0.8"), ["127.0.0.1", "10.0.0.8"]);
  assert.throws(
    () => parseSsoProxyAddresses("not-an-ip"),
    error => error.status === 500 && error.code === "sso_configuration_invalid",
  );
});

test("SSO default roles allow only low-privilege organization roles", () => {
  assert.deepEqual(validateSsoDefaultRoles(["developer", "qa_engineer", "developer"]), ["developer", "qa_engineer"]);
  for (const role of ["project_manager", "technical_director"]) {
    assert.throws(
      () => validateSsoDefaultRoles([role]),
      error => error.status === 500 && error.code === "sso_configuration_invalid",
    );
  }
});

test("loginWithSso rejects privileged default roles before touching the database", async () => {
  for (const role of ["project_manager", "technical_director"]) {
    await assert.rejects(
      () => loginWithSso({}, {
        provider: "yemast", subject: "42", username: "alice", device: "test-device", defaultRoles: [role],
      }),
      error => error.status === 500 && error.code === "sso_configuration_invalid",
    );
  }
});

test("startTeamServer rejects malformed SSO settings before starting", async () => {
  const db = {};
  await assert.rejects(
    () => startTeamServer({ db, model: {}, port: 0, sso: { baseUrl: "http://passport.example.test" } }),
    error => error.status === 500 && error.code === "sso_configuration_invalid",
  );
  await assert.rejects(
    () => startTeamServer({ db, model: {}, port: 0, sso: { timeoutMs: Number.NaN } }),
    error => error.status === 500 && error.code === "sso_configuration_invalid",
  );
  await assert.rejects(
    () => startTeamServer({ db, model: {}, port: 0, sso: { provider: "not a provider" } }),
    error => error.status === 500 && error.code === "sso_configuration_invalid",
  );
  await assert.rejects(
    () => startTeamServer({ db, model: {}, port: 0, sso: { trustProxy: "sometimes" } }),
    error => error.status === 500 && error.code === "sso_configuration_invalid",
  );
  await assert.rejects(
    () => startTeamServer({ db, model: {}, port: 0, sso: { defaultRoles: ["administrator"] } }),
    error => error.status === 500 && error.code === "sso_configuration_invalid",
  );
  for (const role of ["project_manager", "technical_director"]) {
    await assert.rejects(
      () => startTeamServer({ db, model: {}, port: 0, sso: { defaultRoles: [role] } }),
      error => error.status === 500 && error.code === "sso_configuration_invalid",
    );
  }
});

test("SSO transport guard trusts loopback and an explicitly trusted TLS proxy only", () => {
  const loopback = { headers: {}, socket: { remoteAddress: "127.0.0.1", encrypted: false } };
  assert.equal(isSecureSsoRequest(loopback, "localhost:3090"), true);
  assert.equal(isSecureSsoRequest(loopback, "hub.example.test:3090"), false);
  assert.equal(isSecureSsoRequest(loopback, "localhost:3090", { trustProxy: true }), false);

  const direct = { headers: { "x-forwarded-proto": "https" }, socket: { remoteAddress: "192.168.1.20", encrypted: false } };
  assert.equal(isSecureSsoRequest(direct, "hub.example.test:3090"), false);
  assert.equal(isSecureSsoRequest(direct, "hub.example.test:3090", { trustProxy: true }), false);
  assert.equal(isSecureSsoRequest(direct, "hub.example.test:3090", { trustProxy: true, proxyAddresses: ["192.168.1.20"] }), true);
  assert.equal(isSecureSsoRequest({ ...direct, headers: { "x-forwarded-proto": "https,http" } }, "hub.example.test:3090", { trustProxy: true, proxyAddresses: ["192.168.1.20"] }), false);
  assert.equal(isSecureSsoRequest({ headers: {}, socket: { remoteAddress: "192.168.1.20", encrypted: true } }, "hub.example.test:3090"), true);
});

test("validateAccessToken uses the authoritative validate endpoint", async () => {
  const calls = [];
  const user = { id: 123, username: "alice", name: "Alice", role: "operator" };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return response(200, { valid: true, user, expires_at: 1760000000 });
  };

  const result = await validateAccessToken("access-secret", config(fetcher));

  assert.deepEqual(result, {
    user: { subject: "123", username: "alice", displayName: "Alice", role: "operator" },
    expiresAt: 1760000000,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://passport.example.test/api/validate");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.authorization, "Bearer access-secret");
  assert.equal(calls[0].options.redirect, "error");
});

test("credential login validates the returned access token before trusting identity", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/login")) {
      return response(200, {
        access_token: "access-from-login",
        refresh_token: "refresh-from-login",
        user: { id: 999, username: "untrusted-login-response" },
      });
    }
    return response(200, {
      valid: true,
      user: { id: "42", username: "trusted-user", name: "Trusted User", role: "admin" },
    });
  };

  const result = await resolveSsoIdentity(
    { username: "alice", password: " password " },
    config(fetcher),
  );

  assert.equal(result.accessToken, "access-from-login");
  assert.equal(result.refreshToken, "refresh-from-login");
  assert.equal(result.user.subject, "42");
  assert.equal(result.user.username, "trusted-user");
  assert.equal(calls.map(call => new URL(call.url).pathname).join(","), "/api/login,/api/validate");
  assert.deepEqual(JSON.parse(calls[0].options.body), { username: "alice", password: " password " });
  assert.equal(calls[1].options.headers.authorization, "Bearer access-from-login");
});

test("an expired access token is refreshed once and then validated", async () => {
  const paths = [];
  let validationCount = 0;
  const fetcher = async (url, options) => {
    const pathname = new URL(url).pathname;
    paths.push(pathname);
    if (pathname === "/api/validate" && validationCount++ === 0) return response(401, { error: "expired" });
    if (pathname === "/api/refresh") return response(200, { access_token: "renewed-access" });
    return response(200, { valid: true, user: { id: 7, username: "renewed", name: "Renewed" } });
  };

  const result = await resolveSsoIdentity(
    { accessToken: "expired-access", refreshToken: "refresh-secret" },
    config(fetcher),
  );

  assert.equal(result.refreshed, true);
  assert.equal(result.user.username, "renewed");
  assert.deepEqual(paths, ["/api/validate", "/api/refresh", "/api/validate"]);
});

test("invalid external tokens fail without exposing the token value", async () => {
  const fetcher = async () => response(401, { error: "invalid" });

  await assert.rejects(
    () => resolveSsoIdentity({ accessToken: "do-not-log-this-token" }, config(fetcher)),
    error => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "sso_token_invalid");
      assert.doesNotMatch(error.message, /do-not-log-this-token/);
      return true;
    },
  );
});

test("a remote response body timeout remains a timeout", async () => {
  const fetcher = async () => ({
    ok: true,
    status: 200,
    async json() { throw Object.assign(new Error("body timeout"), { name: "TimeoutError" }); },
  });
  await assert.rejects(
    () => validateAccessToken("access-secret", config(fetcher)),
    error => error.status === 504 && error.code === "sso_timeout",
  );
});

test("a loopback response body timeout remains a timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-local-body-timeout-"));
  const engine = new TeamEngine(dir, {
    fetcher: async () => ({
      ok: true,
      status: 200,
      async json() { throw Object.assign(new Error("loopback body timeout"), { name: "AbortError" }); },
    }),
  });
  try {
    await assert.rejects(
      () => engine.localSso("/sso/state"),
      error => error.status === 504 && error.code === "sso_timeout",
    );
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine SSO reads loopback state before sending a token to Hub", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-engine-"));
  const localToken = "local-access-token-that-must-not-persist";
  const hubAccess = "hub-access-token-that-must-not-persist";
  const hubRefresh = "hub-refresh-token-that-must-not-persist";
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    if (pathname === "/sso/state") return response(200, { logged_in: true, username: "alice" });
    if (pathname === "/sso/token") return response(200, { access_token: localToken });
    assert.equal(pathname, "/team/v1/auth/sso");
    return response(200, {
      accessToken: hubAccess,
      refreshToken: hubRefresh,
      expires: Date.now() + 3_600_000,
      user: { id: "user-1", name: "alice", displayName: "Alice", roles: ["developer"], admin: false, mustChangePassword: false },
    });
  };
  const engine = new TeamEngine(dir, { fetcher });
  try {
    const user = await engine.ssoLogin({ hub: "https://hub.example.test/" });
    assert.equal(user.id, "user-1");
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/sso/state", "/sso/token", "/team/v1/auth/sso"]);
    assert.equal(calls[0].options.headers.authorization, undefined);
    assert.equal(calls[1].options.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(calls[2].options.body), { accessToken: localToken, device: engine.device });
    assert.equal(engine.auth.accessToken, hubAccess);
    assert.equal(engine.auth.refreshToken, hubRefresh);

    const persisted = engine.db.prepare("SELECT value FROM state").all().map(row => row.value).join("\n");
    assert.doesNotMatch(persisted, /local-access-token-that-must-not-persist/);
    assert.doesNotMatch(persisted, /hub-access-token-that-must-not-persist/);
    assert.doesNotMatch(persisted, /hub-refresh-token-that-must-not-persist/);
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine rejects a cleartext LAN Hub before reading the desktop token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-insecure-hub-"));
  const calls = [];
  const engine = new TeamEngine(dir, {
    fetcher: async url => {
      calls.push(url);
      return response(200, { logged_in: true });
    },
  });
  try {
    await assert.rejects(
      () => engine.ssoLogin({ hub: "http://hub.example.test/" }),
      error => error.status === 400 && error.code === "sso_secure_transport_required",
    );
    assert.deepEqual(calls, []);
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine permits cleartext SSO on a loopback Hub for local development", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-loopback-hub-"));
  const calls = [];
  const engine = new TeamEngine(dir, {
    fetcher: async (url) => {
      calls.push(new URL(url).pathname);
      if (url.includes("/sso/state")) return response(200, { logged_in: true, username: "alice" });
      if (url.includes("/sso/token")) return response(200, { access_token: "local-access-token-that-is-long-enough" });
      return response(200, {
        accessToken: "hub-access-token-that-is-long-enough",
        refreshToken: "hub-refresh-token-that-is-long-enough",
        expires: Date.now() + 3_600_000,
        user: { id: "user-loopback", name: "alice", roles: ["developer"], admin: false, mustChangePassword: false },
      });
    },
  });
  try {
    const user = await engine.ssoLogin({ hub: "http://127.0.0.1:3090/" });
    assert.equal(user.id, "user-loopback");
    assert.deepEqual(calls, ["/sso/state", "/sso/token", "/team/v1/auth/sso"]);
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine recognizes IPv6 loopback as a local SSO Hub", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-ipv6-hub-"));
  const engine = new TeamEngine(dir, {
    fetcher: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/sso/state") return response(200, { logged_in: false });
      throw new Error(`unexpected ${pathname}`);
    },
  });
  try {
    await assert.rejects(
      () => engine.ssoLogin({ hub: "http://[::1]:3090/" }),
      error => error.code === "sso_not_logged_in" && error.status === 401,
    );
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine drops an SSO session after the desktop pass drops its login state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-logout-"));
  let stateChecks = 0;
  const engine = new TeamEngine(dir, {
    fetcher: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/sso/state") return response(200, { logged_in: stateChecks++ === 0, username: "alice" });
      if (pathname === "/sso/token") return response(200, { access_token: "local-access-token-that-is-long-enough" });
      if (pathname === "/team/v1/auth/sso") return response(200, {
        accessToken: "hub-access-token-that-is-long-enough",
        refreshToken: "hub-refresh-token-that-is-long-enough",
        expires: Date.now() + 3_600_000,
        user: { id: "user-logout", name: "alice", roles: ["developer"], admin: false, mustChangePassword: false },
      });
      throw new Error(`unexpected ${pathname}`);
    },
  });
  try {
    await engine.ssoLogin({ hub: "https://hub.example.test/" });
    await engine.runSync();
    assert.equal(engine.auth, null);
    assert.equal(engine.status, "需要登录");
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine drops an SSO session when the desktop pass switches user", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-switch-user-"));
  let stateChecks = 0;
  const paths = [];
  const engine = new TeamEngine(dir, {
    fetcher: async url => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname === "/sso/state") {
        return response(200, { logged_in: true, username: stateChecks++ === 0 ? "alice" : "bob" });
      }
      if (pathname === "/sso/token") return response(200, { access_token: "local-access-token-that-is-long-enough" });
      if (pathname === "/team/v1/auth/sso") return response(200, {
        accessToken: "hub-access-token-that-is-long-enough",
        refreshToken: "hub-refresh-token-that-is-long-enough",
        expires: Date.now() + 3_600_000,
        user: { id: "user-switch", name: "alice", roles: ["developer"], admin: false, mustChangePassword: false },
      });
      throw new Error(`unexpected ${pathname}`);
    },
  });
  try {
    await engine.ssoLogin({ hub: "https://hub.example.test/" });
    await engine.runSync();
    assert.equal(engine.auth, null);
    assert.equal(engine.status, "需要登录");
    assert.deepEqual(paths, ["/sso/state", "/sso/token", "/team/v1/auth/sso", "/sso/state"]);
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine maps a loopback SSO timeout to a stable error code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-timeout-"));
  const engine = new TeamEngine(dir, {
    fetcher: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); },
  });
  try {
    await assert.rejects(
      () => engine.ssoLogin({ hub: "https://hub.example.test/" }),
      error => error.code === "sso_timeout" && error.status === 504,
    );
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine reports an unauthenticated loopback SSO state without requesting a token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-logged-out-"));
  const paths = [];
  const engine = new TeamEngine(dir, {
    fetcher: async url => {
      paths.push(new URL(url).pathname);
      return response(200, { logged_in: false });
    },
  });
  try {
    await assert.rejects(
      () => engine.ssoLogin({ hub: "https://hub.example.test/" }),
      error => error.code === "sso_not_logged_in" && error.status === 401,
    );
    assert.deepEqual(paths, ["/sso/state"]);
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine clears a current session when Hub refresh rejects its token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-refresh-rejected-"));
  const calls = [];
  const engine = new TeamEngine(dir, {
    fetcher: async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname === "/health") return response(200, { ok: true, ssoEnabled: false, secureApi: false });
      if (pathname === "/team/v1/auth/login") {
        return response(200, {
          accessToken: "hub-access-token-that-is-long-enough",
          refreshToken: "hub-refresh-token-that-is-long-enough",
          expires: Date.now() - 1,
          user: { id: "user-refresh", name: "alice", roles: ["developer"], admin: false, mustChangePassword: false },
        });
      }
      assert.equal(pathname, "/team/v1/auth/refresh");
      return response(401, { error: "token_reused" });
    },
  });
  try {
    await engine.login({ hub: "http://hub.example.test/", name: "alice", password: "password" });
    engine.projects = [{ id: "project-that-must-be-cleared" }];
    await assert.rejects(
      () => engine.api("/projects"),
      error => error.status === 401 && error.message === "token_reused",
    );
    assert.deepEqual(calls, ["/health", "/team/v1/auth/login", "/team/v1/auth/refresh"]);
    assert.equal(engine.auth, null);
    assert.deepEqual(engine.projects, []);
    assert.equal(engine.status, "需要登录");
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine refuses a remote cleartext password request when Hub SSO is enabled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-password-transport-"));
  const paths = [];
  const engine = new TeamEngine(dir, {
    fetcher: async url => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname === "/health") return response(200, { ok: true, ssoEnabled: true, secureApi: true });
      throw new Error("password request must not be sent");
    },
  });
  try {
    await assert.rejects(
      () => engine.login({ hub: "http://hub.example.test/", name: "alice", password: "password" }),
      error => error.status === 400 && error.code === "sso_secure_transport_required",
    );
    assert.deepEqual(paths, ["/health"]);
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamEngine fails closed when a remote Hub health response omits transport flags", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sso-health-unknown-"));
  const paths = [];
  const engine = new TeamEngine(dir, {
    fetcher: async url => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/health")) return response(200, { ok: true });
      throw new Error("password request must not be sent");
    },
  });
  try {
    await assert.rejects(
      () => engine.login({ hub: "http://hub.example.test/", name: "alice", password: "password" }),
      error => error.status === 400 && error.code === "sso_secure_transport_required",
    );
    assert.deepEqual(paths, ["/health"]);
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SSO identity mapping is idempotent and never inherits administrator privileges", { skip: !process.env.TEAM_TEST_DATABASE_URL }, async t => {
  const schema = `sso_${randomUUID().replaceAll("-", "")}`;
  const adminDb = database(process.env.TEAM_TEST_DATABASE_URL);
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEAM_TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = database(url.href);
  await migrate(db);
  t.after(async () => {
    await db.end();
    await adminDb.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminDb.end();
  });

  const first = await loginWithSso(db, {
    provider: "yemast", subject: "42", username: "alice", displayName: "Alice",
    ssoRole: "admin", device: "test-device",
  });
  const repeat = await loginWithSso(db, {
    provider: "yemast", subject: "42", username: "alice-renamed", displayName: "Alice 2",
    ssoRole: "user", device: "test-device",
  });
  assert.equal(repeat.user.id, first.user.id);
  assert.equal(repeat.user.admin, false);
  assert.deepEqual((await db.query("SELECT roles FROM team_users WHERE id=$1", [first.user.id])).rows[0].roles, ["developer"]);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM team_sso_identities WHERE provider='yemast' AND subject='42'")).rows[0].count, 1);

  await createUser(db, { name: "admin", password: "initial-password", assignedRoles: ["project_manager"], admin: true });
  const isolated = await loginWithSso(db, {
    provider: "yemast", subject: "43", username: "admin", displayName: "External Admin", device: "test-device",
  });
  assert.notEqual(isolated.user.name, "admin");
  assert.match(isolated.user.name, /^sso_[a-f0-9]+$/);
  assert.equal(isolated.user.admin, false);

  const disabled = await createUser(db, { name: "disabled", password: "initial-password", assignedRoles: ["developer"] });
  await db.query("UPDATE team_users SET active=false WHERE id=$1", [disabled.id]);
  const disabledSso = await loginWithSso(db, {
    provider: "yemast", subject: "47", username: "disabled", displayName: "Disabled External", device: "test-device",
  });
  assert.notEqual(disabledSso.user.id, disabled.id);
  assert.match(disabledSso.user.name, /^sso_[a-f0-9]+$/);
  assert.equal(disabledSso.user.admin, false);

  const manager = await createUser(db, { name: "manager", password: "initial-password", assignedRoles: ["project_manager"] });
  const member = await createUser(db, { name: "assigned", password: "initial-password", assignedRoles: ["developer"] });
  const projectId = randomUUID();
  await db.query("INSERT INTO team_projects(id,name,owner_id) VALUES($1,$2,$3)", [projectId, "Assigned project", manager.id]);
  await db.query("INSERT INTO team_members(project_id,user_id,role) VALUES($1,$2,$3)", [projectId, member.id, "developer"]);
  const managerSso = await loginWithSso(db, {
    provider: "yemast", subject: "45", username: "manager", device: "test-device",
  });
  const memberSso = await loginWithSso(db, {
    provider: "yemast", subject: "46", username: "assigned", device: "test-device",
  });
  assert.notEqual(managerSso.user.id, manager.id);
  assert.notEqual(memberSso.user.id, member.id);
  assert.match(managerSso.user.name, /^sso_[a-f0-9]+$/);
  assert.match(memberSso.user.name, /^sso_[a-f0-9]+$/);

  const local = await createUser(db, { name: "bob", password: "initial-password", assignedRoles: ["developer"] });
  await loginWithSso(db, { provider: "yemast", subject: "44", username: "bob", device: "test-device" });
  await assert.rejects(
    () => loginWithSso(db, { provider: "yemast", subject: "45", username: "bob", device: "test-device" }),
    error => error.status === 409 && error.code === "sso_identity_conflict",
  );
  assert.equal(local.roles[0], "developer");
});
