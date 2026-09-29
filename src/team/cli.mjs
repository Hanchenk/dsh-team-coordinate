import { database, migrate } from "./db.mjs";
import { createUser } from "./auth.mjs";
import { modelConfig } from "./model.mjs";
import { startTeamServer } from "./server.mjs";
import { readModel } from "./settings.mjs";

export async function runTeamCli(args) {
  const [command, name, role = "developer"] = args;
  if (!["init", "user-add", "start"].includes(command)) throw new Error("Usage: team init | user-add <name> <role> | start");
  const db = database();
  try {
    await migrate(db);
    if (command === "init" || command === "user-add") {
      const password = process.env.TEAM_INITIAL_PASSWORD;
      if (!password) throw new Error("Set TEAM_INITIAL_PASSWORD (minimum 10 characters)");
      const user = await createUser(db, { name: name || "admin", password,
        assignedRoles: command === "init" ? ["project_manager"] : role.split(","), admin: command === "init" });
      console.log(`Created ${user.name}; password change required on first login.`);
      await db.end(); return;
    }
    const host = process.env.TEAM_HOST || "127.0.0.1", port = Number(process.env.TEAM_PORT || 3090);
    const ssoBaseUrl = process.env.TEAM_SSO_BASE_URL || process.env.TEAM_CERTIFICATE_BASE_URL || "";
    const sso = {
      timeoutMs: Number(process.env.TEAM_SSO_TIMEOUT_MS || 5000),
      provider: process.env.TEAM_SSO_PROVIDER || "yemast",
      allowInsecure: String(process.env.TEAM_SSO_ALLOW_INSECURE || "").trim().toLowerCase() === "true",
      trustProxy: process.env.TEAM_SSO_TRUST_PROXY,
      defaultRoles: (process.env.TEAM_SSO_DEFAULT_ROLES || "developer").split(",").map(value => value.trim()).filter(Boolean),
    };
    if (ssoBaseUrl) sso.baseUrl = ssoBaseUrl;
    const app = await startTeamServer({ db, host, port, model: modelConfig(),
      allowedHosts: (process.env.TEAM_ALLOWED_HOSTS || "").split(",").map(value => value.trim()).filter(Boolean),
      sso });
    console.log(`Team collaboration: http://${host}:${app.server.address().port}`);
    const currentModel=await readModel(db,modelConfig());
    if (!currentModel.baseUrl || !currentModel.name) console.log("Model not configured; received batches remain queued. Configure it in the admin console.");
    if (ssoBaseUrl) {
      let displayUrl = "<invalid configuration>";
      try { displayUrl = new URL(ssoBaseUrl).origin; } catch {}
      console.log(`Yemast SSO enabled: ${displayUrl}`);
    }
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await app.close(); await db.end(); };
    process.once("SIGTERM", close); process.once("SIGINT", close);
  } catch (error) { await db.end(); throw error; }
}
