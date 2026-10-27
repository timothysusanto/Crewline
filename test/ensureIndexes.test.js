"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ensureIndexes, sameIndex } = require("../ensureIndexes");

const SA = { project_id: "demo-proj", client_email: "x@y", private_key: "k" };

function fakeApi(existing, { listStatus = 200, createStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization });
    if (!opts.method) return { ok: listStatus === 200, status: listStatus, json: async () => (listStatus === 200 ? { indexes: existing } : { error: { status: "PERMISSION_DENIED" } }) };
    return { ok: createStatus === 200, status: createStatus, json: async () => ({ name: "operations/1" }) };
  };
  return { fetchImpl, calls };
}

test("sameIndex ignores __name__ and compares fields in order", () => {
  const a = { queryScope: "COLLECTION", fields: [{ fieldPath: "tenantId", order: "ASCENDING" }, { fieldPath: "clockIn.time", order: "ASCENDING" }, { fieldPath: "__name__", order: "ASCENDING" }] };
  const b = { fields: [{ fieldPath: "tenantId", order: "ASCENDING" }, { fieldPath: "clockIn.time", order: "ASCENDING" }] };
  const c = { fields: [{ fieldPath: "clockIn.time", order: "ASCENDING" }, { fieldPath: "tenantId", order: "ASCENDING" }] };
  assert.equal(sameIndex(a, b), true);
  assert.equal(sameIndex(a, c), false);
});

test("creates only the indexes that are missing", async () => {
  const existing = [{ queryScope: "COLLECTION", fields: [{ fieldPath: "tenantId", order: "ASCENDING" }, { fieldPath: "clockIn.time", order: "ASCENDING" }, { fieldPath: "__name__", order: "ASCENDING" }] }];
  const { fetchImpl, calls } = fakeApi(existing);
  const r = await ensureIndexes({ serviceAccount: SA, fetchImpl, getToken: async () => "tok" });
  assert.equal(r.existing.length, 1);
  assert.equal(r.created.length, 1);
  assert.equal(r.failed.length, 0);
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /projects\/demo-proj\/databases\/\(default\)\/collectionGroups\/shifts\/indexes$/);
  assert.deepEqual(posts[0].body.fields.map((f) => f.fieldPath), ["workerId", "date"]);
  assert.equal(posts[0].auth, "Bearer tok");
});

test("does nothing when every index exists", async () => {
  const spec = require("../firestore.indexes.json").indexes;
  const { fetchImpl, calls } = fakeApi(spec);
  const r = await ensureIndexes({ serviceAccount: SA, fetchImpl, getToken: async () => "tok" });
  assert.equal(r.created.length, 0);
  assert.equal(r.existing.length, spec.length);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("a 403 on list stops cleanly instead of crashing boot", async () => {
  const { fetchImpl, calls } = fakeApi([], { listStatus: 403 });
  const r = await ensureIndexes({ serviceAccount: SA, fetchImpl, getToken: async () => "tok" });
  assert.deepEqual(r, { created: [], existing: [], failed: [] });
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("no service account → no-op", async () => {
  const r = await ensureIndexes({ serviceAccount: null });
  assert.deepEqual(r, { created: [], existing: [], failed: [] });
});
