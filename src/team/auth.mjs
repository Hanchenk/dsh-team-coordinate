import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "../passwords.mjs";
import { roles, ensure, str, digest } from "./contracts.mjs";
import { transaction } from "./db.mjs";

export const publicUser = u => ({ id: u.id, name: u.name, roles: u.roles, admin: u.admin, mustChangePassword: u.must_change });
export async function createUser(db, { name, password, assignedRoles, admin = false }) {
  str(name, 32); ensure(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name));
  str(password, 256); ensure(password.length >= 10);
  ensure(Array.isArray(assignedRoles) && assignedRoles.length && assignedRoles.every(r => roles.includes(r)));
  const { salt, hash } = hashPassword(password);
  const { rows: [user] } = await db.query(`INSERT INTO team_users(id,name,salt,hash,roles,admin)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), name, salt, hash, [...new Set(assignedRoles)], admin]);
  return publicUser(user);
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
