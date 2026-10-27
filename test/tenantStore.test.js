"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { InMemoryTenantStore } = require("../tenantStore");

test("create / findByDashboardKey / listAll", async () => {
  const t = new InMemoryTenantStore();
  await t.create("blue-door", { name: "Blue Door", dashboardKey: "k1", active: true });
  await assert.rejects(() => t.create("blue-door", { name: "dup" }), /TENANT_EXISTS/);
  assert.equal((await t.findByDashboardKey("k1")).tenantId, "blue-door");
  assert.equal(await t.findByDashboardKey("nope"), null);
  assert.equal(await t.findByDashboardKey(""), null);
  const all = await t.listAll();
  assert.ok(all.some((x) => x.tenantId === "blue-door") && all.some((x) => x.tenantId === "demo-venue"));
});
