import { ensure, str, audit } from "./contracts.mjs";
import { transaction } from "./db.mjs";

export async function readModel(db, fallback = {}, key="model") {
  const { rows: [row] } = await db.query("SELECT value FROM team_settings WHERE key=$1",[key]);
  return row?.value ?? fallback;
}
export function publicModel(config) {
  return { baseUrl:config.baseUrl ?? "", name:config.name ?? "", timeoutMs:config.timeoutMs ?? 120000, hasApiKey:Boolean(config.apiKey) };
}
export async function saveModel(db, user, input, fallback, key="model") {
  ensure(user.admin, 403, "permission_denied");
  const baseUrl = str(input.baseUrl, 1000), name = str(input.name, 200);
  let url; try { url=new URL(baseUrl); } catch { ensure(false); }
  ensure(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
  const timeoutMs = Number(input.timeoutMs ?? 120000);
  ensure(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000);
  ensure(input.apiKey === undefined || (typeof input.apiKey === "string" && input.apiKey.length <= 4000));
  return transaction(db, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(731090)");
    const previous = await readModel(tx, fallback, key);
    const config = { baseUrl:url.href.replace(/\/$/, ""), name, timeoutMs,
      apiKey:input.clearApiKey === true ? "" : input.apiKey || previous.apiKey || "" };
    await tx.query("INSERT INTO team_settings VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key,JSON.stringify(config)]);
    await audit(tx, user, null, `${key}.configured`);
    return publicModel(config);
  });
}
