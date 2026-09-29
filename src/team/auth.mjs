import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "../passwords.mjs";
import { roles, ensure, str, digest } from "./contracts.mjs";
import { transaction } from "./db.mjs";
import { validateSsoDefaultRoles } from "./sso.mjs";

export const publicUser = u => ({ id: u.id, name: u.name, displayName: u.display_name || u.name, roles: u.roles, admin: u.admin, mustChangePassword: u.must_change });
export async function createUser(db, { name, password, assignedRoles, admin = false }) {
  str(name, 32); ensure(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name));
  str(password, 256); ensure(password.length >= 10);
  ensure(Array.isArray(assignedRoles) && assignedRoles.length && assignedRoles.every(r => roles.includes(r)));
  const { salt, hash } = hashPassword(password);
  const { rows: [user] } = await db.query(`INSERT INTO team_users(id,name,salt,hash,roles,admin)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), name, salt, hash, [...new Set(assignedRoles)], admin]);
  return publicUser(user);
}

function ssoLocalName(username, provider, subject) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}$/.test(username)) return username;
  return `sso_${digest(`${provider}:${subject}`).slice(0, 24)}`;
}

const protectedRoles = new Set(["technical_director", "product_manager", "project_manager"]);

async function uniqueSsoName(tx, username, provider, subject) {
  const preferred = ssoLocalName(username, provider, subject);
  const { rows: [existing] } = await tx.query("SELECT id FROM team_users WHERE name=$1", [preferred]);
  if (!existing) return preferred;
  const suffix = digest(`${provider}:${subject}`).slice(0, 24);
  const fallback = `sso_${suffix}`;
  const { rows: [taken] } = await tx.query("SELECT id FROM team_users WHERE name=$1", [fallback]);
  if (!taken) return fallback;
  return `sso_${digest(`${provider}:${subject}:${Date.now()}`).slice(0, 24)}`;
}

/**
 * Exchange a validated external identity for a local Team Hub session.
 * External roles are recorded for audit only; project roles stay local.
 */
export async function loginWithSso(db, { provider = "yemast", subject, username, displayName = "", ssoRole = "", device, defaultRoles = ["developer"] }) {
  provider = str(provider, 32); subject = str(subject, 128); username = str(username, 256); device = str(device, 100);
  if (displayName) displayName = str(displayName, 256);
  if (ssoRole) ssoRole = str(ssoRole, 64);
  defaultRoles = validateSsoDefaultRoles(defaultRoles);
  return transaction(db, async tx => {
    // Serialize first-login races for one external identity. Without this,
    // two simultaneous clicks can both miss the identity row and collide on
    // its primary key after creating separate local users.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${provider}:${subject}`]);
    let user;
    const { rows: [linked] } = await tx.query(`SELECT i.*,u.* FROM team_sso_identities i
      JOIN team_users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2 FOR UPDATE`, [provider, subject]);
    if (linked) {
      ensure(linked.active, 401, "invalid_credentials");
      user = linked;
      await tx.query("UPDATE team_sso_identities SET username=$3,display_name=$4,sso_role=$5,updated_at=now() WHERE provider=$1 AND subject=$2", [provider, subject, username, displayName || linked.display_name || username, ssoRole]);
    } else {
      const { rows: [byName] } = await tx.query("SELECT * FROM team_users WHERE name=$1 FOR UPDATE", [username]);
      if (byName) {
        // A local account may already be linked to another external subject.
        // Keep that identity one-to-one even after its first SSO login clears
        // `must_change`; otherwise a later subject with the same username
        // could silently create a second identity and make ownership unclear.
        const { rows: [other] } = await tx.query(
          "SELECT subject FROM team_sso_identities WHERE provider=$1 AND user_id=$2 FOR UPDATE",
          [provider, byName.id],
        );
        ensure(!other || other.subject === subject, 409, "sso_identity_conflict");
      }
      // Never implicitly attach an external identity to a local administrator.
      // A same-name SSO account also must not inherit project or organization
      // privileges from an already-used local account. Only a fresh, ordinary
      // local account with no project memberships is eligible for the legacy
      // username convenience binding; all other collisions get a generated
      // `sso_<hash>` account. Explicit provisioning can link higher-privilege
      // accounts separately.
      let canBindByName = Boolean(byName && byName.active && !byName.admin && byName.auth_provider === "local" && byName.must_change
        && !(Array.isArray(byName.roles) && byName.roles.some(role => protectedRoles.has(role))));
      if (canBindByName) {
        const { rows: [membership] } = await tx.query(
          "SELECT project_id FROM team_members WHERE user_id=$1 LIMIT 1 FOR UPDATE", [byName.id],
        );
        canBindByName = !membership;
      }
      if (canBindByName) {
        const now = Date.now();
        const { rows: [activeToken] } = await tx.query(
          "SELECT hash FROM team_tokens WHERE user_id=$1 AND NOT revoked AND expires>$2 LIMIT 1 FOR UPDATE",
          [byName.id, now],
        );
        const { rows: [pendingInvite] } = await tx.query(
          "SELECT hash FROM team_invites WHERE target_id=$1 AND NOT used AND expires>$2 LIMIT 1 FOR UPDATE",
          [byName.id, now],
        );
        canBindByName = !activeToken && !pendingInvite;
      }
      if (canBindByName) {
        user = byName;
      } else {
        const localName = await uniqueSsoName(tx, username, provider, subject);
        const { salt, hash } = hashPassword(randomBytes(32).toString("base64url"));
        const { rows: [created] } = await tx.query(`INSERT INTO team_users(id,name,salt,hash,roles,admin,must_change,auth_provider,display_name)
          VALUES($1,$2,$3,$4,$5,false,false,$6,$7) RETURNING *`, [randomUUID(), localName, salt, hash, [...new Set(defaultRoles)], provider, displayName || username]);
        user = created;
      }
      await tx.query(`INSERT INTO team_sso_identities(provider,subject,user_id,username,display_name,sso_role)
        VALUES($1,$2,$3,$4,$5,$6)`, [provider, subject, user.id, username, displayName || user.display_name || username, ssoRole]);
    }
    const shown = displayName || user.display_name || username || user.name;
    await tx.query("UPDATE team_users SET display_name=$2,must_change=false WHERE id=$1", [user.id, shown]);
    user = { ...user, display_name: shown, must_change: false };
    return issue(tx, user, device);
  });
}

async function issue(tx, user, device, family = randomUUID()) {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const expires = Date.now() + 60 * 60_000;
  for (const [token, kind, until] of [[accessToken, "access", expires], [refreshToken, "refresh", Date.now() + 7 * 86400_000]]) {
    await tx.query("INSERT INTO team_tokens(hash,user_id,device,expires,kind,family) VALUES($1,$2,$3,$4,$5,$6)", [digest(token), user.id, device, until, kind, family]);
  }
  return { accessToken, refreshToken, expires, user: publicUser(user) };
}

export async function login(db, input) {
  str(input.name, 32); str(input.password, 256); str(input.device, 100);
  const { rows: [user] } = await db.query("SELECT * FROM team_users WHERE name=$1", [input.name]);
  const valid = verifyPassword(input.password, user?.salt ?? "0".repeat(32), user?.hash ?? "0".repeat(128));
  ensure(user?.active && valid, 401, "invalid_credentials");
  return transaction(db, tx => issue(tx, user, input.device));
}

export async function authenticate(db, token) {
  ensure(typeof token === "string" && token.length <= 200, 401, "unauthorized");
  const { rows: [user] } = await db.query(`SELECT u.*,t.device,t.family FROM team_tokens t
    JOIN team_users u ON u.id=t.user_id WHERE t.hash=$1 AND t.kind='access'
    AND NOT t.revoked AND t.expires>$2 AND u.active`, [digest(token), Date.now()]);
  ensure(user, 401, "unauthorized");
  return user;
}

export async function refresh(db, input) {
  str(input.refreshToken, 200);
  const result = await transaction(db, async tx => {
    const { rows: [token] } = await tx.query("SELECT * FROM team_tokens WHERE hash=$1 AND kind='refresh' FOR UPDATE", [digest(input.refreshToken)]);
    ensure(token && Number(token.expires) > Date.now(), 401, "unauthorized");
    if (token.revoked) {
      await tx.query("UPDATE team_tokens SET revoked=true WHERE family=$1", [token.family]);
      return null;
    }
    const { rows: [user] } = await tx.query("SELECT * FROM team_users WHERE id=$1 AND active", [token.user_id]);
    ensure(user, 401, "unauthorized");
    await tx.query("UPDATE team_tokens SET revoked=true WHERE family=$1", [token.family]);
    return issue(tx, user, token.device, token.family);
  });
  ensure(result, 401, "token_reused");
  return result;
}

export async function changePassword(db, user, input) {
  str(input.current, 256); str(input.next, 256); ensure(input.next.length >= 10 && input.next !== input.current);
  const { salt, hash } = hashPassword(input.next);
  return transaction(db, async tx => {
    const { rows: [current] } = await tx.query("SELECT salt,hash FROM team_users WHERE id=$1 AND active FOR UPDATE", [user.id]);
    ensure(current && verifyPassword(input.current, current.salt, current.hash), 401, "invalid_credentials");
    await tx.query("UPDATE team_users SET salt=$1,hash=$2,must_change=false WHERE id=$3", [salt, hash, user.id]);
    await tx.query("UPDATE team_tokens SET revoked=true WHERE user_id=$1", [user.id]);
    return issue(tx, { ...user, must_change: false }, user.device);
  });
}
