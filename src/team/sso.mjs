import { isIP } from "node:net";
import { ApiError, ensure, str } from "./contracts.mjs";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PROVIDER = "yemast";
export const defaultSsoProxyAddresses = Object.freeze(["127.0.0.1", "::1"]);

export function normalizeSsoProxyAddress(value) {
  let address = String(value || "").trim().toLowerCase();
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) address = address.slice(7);
  return address;
}

export function parseSsoProxyAddresses(value) {
  const values = Array.isArray(value)
    ? value
    : value === undefined || value === null || String(value).trim() === ""
      ? defaultSsoProxyAddresses
      : String(value).split(",");
  const addresses = values.map(normalizeSsoProxyAddress);
  ensure(addresses.length > 0 && addresses.every(address => isIP(address) !== 0), 500, "sso_configuration_invalid");
  return [...new Set(addresses)];
}

// SSO is an authentication shortcut, not an organization-role provisioning
// channel. Privileged roles must be granted through an explicit local/admin
// workflow after the external identity has been verified.
export const ssoDefaultRoles = Object.freeze(["developer", "qa_engineer"]);

export function validateSsoDefaultRoles(value) {
  ensure(Array.isArray(value) && value.length > 0 && value.every(role => ssoDefaultRoles.includes(role)), 500, "sso_configuration_invalid");
  return [...new Set(value)];
}

function configuredUrl(value, allowInsecure = false) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new ApiError(500, "sso_configuration_invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || (!allowInsecure && url.protocol !== "https:")
    || url.username || url.password || url.search || url.hash) {
    throw new ApiError(500, "sso_configuration_invalid");
  }
  return url.href.replace(/\/+$/, "");
}

export function ssoConfig(env = process.env) {
  const timeoutMs = Number(env.TEAM_SSO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) {
    throw new ApiError(500, "sso_configuration_invalid");
  }
  const provider = String(env.TEAM_SSO_PROVIDER || DEFAULT_PROVIDER).trim();
  if (!/^[a-z][a-z0-9._-]{0,31}$/i.test(provider)) throw new ApiError(500, "sso_configuration_invalid");
  const allowInsecure = String(env.TEAM_SSO_ALLOW_INSECURE || "").trim().toLowerCase() === "true";
  return {
    baseUrl: configuredUrl(env.TEAM_SSO_BASE_URL || env.TEAM_CERTIFICATE_BASE_URL, allowInsecure),
    timeoutMs,
    provider,
    allowInsecure,
    proxyAddresses: parseSsoProxyAddresses(env.TEAM_SSO_PROXY_ADDRESSES),
    fetcher: globalThis.fetch,
  };
}

function configOf(input = {}) {
  const allowInsecure = input.allowInsecure === undefined
    ? String(process.env.TEAM_SSO_ALLOW_INSECURE || "").trim().toLowerCase() === "true"
    : input.allowInsecure === true;
  const baseUrl = configuredUrl(input.baseUrl || input.url || "", allowInsecure);
  const rawTimeout = input.timeoutMs === undefined || input.timeoutMs === null || input.timeoutMs === ""
    ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  const timeoutMs = Number(rawTimeout);
  ensure(Number.isInteger(timeoutMs) && timeoutMs >= 500 && timeoutMs <= 30000, 500, "sso_configuration_invalid");
  const provider = String(input.provider || DEFAULT_PROVIDER).trim();
  ensure(/^[a-z][a-z0-9._-]{0,31}$/i.test(provider), 500, "sso_configuration_invalid");
  return { baseUrl, timeoutMs, provider, allowInsecure, fetcher: input.fetcher || globalThis.fetch };
}

// Keep server startup and per-request validation on the same rules. The
// returned object is safe to retain because it contains no credentials.
export function validateSsoConfig(input = {}) {
  return configOf(input);
}

function tokenValue(value, code = "sso_token_required") {
  ensure(typeof value === "string" && value.trim().length >= 1 && value.length <= 4096, 400, code);
  return value.trim();
}

function externalUser(value) {
  ensure(value && typeof value === "object" && !Array.isArray(value), 502, "sso_invalid_response");
  const rawId = value.id;
  const subject = typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId >= 0
    ? String(rawId)
    : typeof rawId === "string" && /^[0-9]+$/.test(rawId) && rawId.length <= 64 ? rawId : "";
  const username = typeof value.username === "string" ? value.username.trim() : "";
  const displayName = typeof value.name === "string" && value.name.trim() ? value.name.trim() : username;
  const role = typeof value.role === "string" ? value.role.trim().slice(0, 64) : "";
  ensure(subject && username && username.length <= 256 && displayName.length <= 256, 502, "sso_invalid_response");
  return { subject, username, displayName, role };
}

function responseError(status, operation) {
  if (status === 401) return new ApiError(401, operation === "login" ? "invalid_credentials" : "sso_token_invalid");
  if (status === 400) return new ApiError(400, "sso_invalid_request");
  if (status === 409) return new ApiError(409, "sso_conflict");
  if (status >= 500) return new ApiError(503, "sso_unavailable");
  return new ApiError(502, "sso_request_failed");
}

async function request(path, { method = "GET", accessToken, body, config, operation = "validate" } = {}) {
  const current = configOf(config);
  ensure(current.baseUrl, 503, "sso_not_configured");
  ensure(typeof current.fetcher === "function", 503, "sso_unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), current.timeoutMs);
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let response;
  try {
    response = await current.fetcher(`${current.baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error", signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new ApiError(504, "sso_timeout");
    throw new ApiError(503, "sso_unavailable");
  }
  try {
    if (!response.ok) {
      try { await response.json(); } catch (error) {
        if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new ApiError(504, "sso_timeout");
        // Status is authoritative for error mapping even when the body is not JSON.
      }
      throw responseError(response.status, operation);
    }
    let value;
    try { value = await response.json(); } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new ApiError(504, "sso_timeout");
      throw new ApiError(502, "sso_invalid_response");
    }
    ensure(value && typeof value === "object" && !Array.isArray(value), 502, "sso_invalid_response");
    return value;
  } finally { clearTimeout(timer); }
}

export async function validateAccessToken(accessToken, config) {
  const token = tokenValue(accessToken);
  const value = await request("/api/validate", { accessToken: token, config, operation: "validate" });
  ensure(value.valid === true, 401, "sso_token_invalid");
  const user = externalUser(value.user);
  return { user, expiresAt: value.expires_at };
}

export async function loginAgainstSso(username, password, config) {
  const name = str(username, 256);
  ensure(typeof password === "string" && password.length > 0 && password.length <= 4096, 400, "sso_credentials_required");
  const secret = password;
  const value = await request("/api/login", { method: "POST", body: { username: name, password: secret }, config, operation: "login" });
  const accessToken = tokenValue(value.access_token, "sso_invalid_response");
  const refreshToken = tokenValue(value.refresh_token, "sso_invalid_response");
  // The login response contains a user object, but the validate endpoint is the
  // authoritative identity source. Do not trust role/name data from /api/login.
  const validated = await validateAccessToken(accessToken, config);
  return { ...validated, accessToken, refreshToken };
}

export async function refreshSsoToken(refreshToken, config) {
  const token = tokenValue(refreshToken, "sso_refresh_required");
  const value = await request("/api/refresh", { method: "POST", body: { refresh_token: token }, config, operation: "refresh" });
  return { accessToken: tokenValue(value.access_token, "sso_invalid_response"), expiresAt: value.expires_at };
}

/**
 * Resolve a trusted Yemast identity from a desktop access token or credentials.
 * A supplied refresh token is used at most once when validation returns 401.
 */
export async function resolveSsoIdentity(input = {}, config) {
  ensure(input && typeof input === "object" && !Array.isArray(input), 400, "invalid_request");
  const current = configOf(config);
  const accessToken = input.accessToken ?? input.access_token ?? input.token;
  const refreshToken = input.refreshToken ?? input.refresh_token;
  if (accessToken !== undefined) {
    const token = tokenValue(accessToken);
    try {
      return { ...(await validateAccessToken(token, current)), refreshed: false };
    } catch (error) {
      if (error?.status !== 401 || refreshToken === undefined) throw error;
      const refreshed = await refreshSsoToken(refreshToken, current);
      return { ...(await validateAccessToken(refreshed.accessToken, current)), refreshed: true };
    }
  }
  ensure(input.username !== undefined && input.password !== undefined, 400, "sso_credentials_required");
  return { ...(await loginAgainstSso(input.username, input.password, current)), refreshed: false };
}

export function normalizeSsoDevice(value) {
  return str(value || "web-sso", 100);
}
