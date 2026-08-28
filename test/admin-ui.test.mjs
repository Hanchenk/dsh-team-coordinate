import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("admin UI is zero-build and uses namespaced API", () => {
  const html = fs.readFileSync(path.join(root, "admin-ui", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "admin-ui", "app.js"), "utf8");
  assert.ok(app.includes('/__teamhub/api'));
  assert.ok(!html.includes("cdn."));
});

test("admin UI references assets via absolute /admin/ paths (no relative-path misresolution)", () => {
  const html = fs.readFileSync(path.join(root, "admin-ui", "index.html"), "utf8");
  assert.ok(html.includes('href="/admin/styles.css"'), "stylesheet must use absolute /admin/ path");
  assert.ok(html.includes('src="/admin/app.js"'), "script must use absolute /admin/ path");
  assert.ok(!html.includes("./styles.css") && !html.includes("./app.js"), "no relative asset refs");
});
