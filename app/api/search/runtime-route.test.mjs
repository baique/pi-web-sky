import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { setDbForTesting } = await jiti.import("@/lib/sqlite-db.ts");
const { GET: searchRoute } = await jiti.import("./route.ts");

test("search route returns empty results for blank query", async () => {
  setDbForTesting(new DatabaseSync(":memory:"));
  const blank = await searchRoute(new Request("http://localhost/api/search?q="));
  assert.equal(blank.status, 200);
  const blankBody = await blank.json();
  assert.equal(blankBody.indexing, false);
  assert.deepEqual(blankBody.results, []);
});

test("search route returns well-formed results for a query (shape-only)", async () => {
  setDbForTesting(new DatabaseSync(":memory:"));
  const res = await searchRoute(new Request("http://localhost/api/search?q=pi"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.results));
  assert.ok(body.results.length <= 30);
  assert.equal(typeof body.indexing, "boolean");
  for (const r of body.results) {
    assert.equal(typeof r.session.id, "string");
    assert.equal(typeof r.session.cwd, "string");
    assert.equal(typeof r.titleMatch, "boolean");
    assert.equal(typeof r.snippet, "string");
  }
});