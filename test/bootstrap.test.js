"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildStores } = require("../stores");
const { runBootstrap } = require("../bootstrap");

const quiet = { log() {}, error() {} };
const cfg = {
  id: "t1",
  venue: { name: "Test Hotel", plan: "pro", staffLimit: 100 },
  payroll: { timezone: "Australia/Perth", targets: { kitchenPct: 22, totalPct: 55 } },
  crew: [
    { name: "Boss Person", owner: true, aliases: ["Bossy"], jobTitle: "Exec Chef", department: "kitchen" },
    { name: "Sam S", jobTitle: "CDP", department: "kitchen" },
    { name: "Ana B", department: "kitchen", phone: "0412 345 678" },
  ],
  shifts: [
    { name: "Boss Person", date: "2026-11-10", start: "11:00", end: "19:00" },
    { name: "Sam S", date: "2026-11-10", start: "05:30", end: "13:36", role: "Breakfast", unpaidBreakMins: 30 },
    { name: "Nobody", date: "2026-11-10", start: "05:30", end: "13:36" },
  ],
};

async function setup() {
  const stores = buildStores();
  await stores.tenantStore.create("v", { name: "Demo Venue", active: true });
  await stores.staffStore.upsert({ phone: "61420000000", tenantId: "v", name: "Bossy", role: "owner", active: true });
  return stores;
}

test("sets the venue up once: name, plan, limit, Perth timezone", async () => {
  const st = await setup();
  const r = await runBootstrap(st, "v", JSON.stringify(cfg), quiet);
  assert.equal(r.ok, true);
  const t = await st.tenantStore.findById("v");
  assert.deepEqual([t.name, t.plan, t.staffLimit, t.payroll.timezone, t.bootstrapId], ["Test Hotel", "pro", 100, "Australia/Perth", "t1"]);
  assert.deepEqual(await runBootstrap(st, "v", JSON.stringify(cfg), quiet), { skipped: "already applied" });
});

test("existing owner is kept (no duplicate); new crew get placeholders or their mobile; shifts are drafts", async () => {
  const st = await setup();
  await runBootstrap(st, "v", JSON.stringify(cfg), quiet);
  const crew = await st.staffStore.listByTenant("v");
  assert.equal(crew.length, 3);
  const boss = crew.find((s) => s.role === "owner");
  assert.equal(boss.phone, "61420000000");
  assert.equal(boss.jobTitle, "Exec Chef");
  const sam = crew.find((s) => s.name === "Sam S");
  assert.equal(sam.phone, "pending-sam-s"); assert.equal(sam.pendingMobile, true);
  const ana = crew.find((s) => s.name === "Ana B");
  assert.equal(ana.phone, "0412345678"); assert.ok(!ana.pendingMobile);
  const shifts = await st.rosterStore.listByRange("v", "2026-11-10", "2026-11-10");
  assert.equal(shifts.length, 2, "the unknown name is skipped");
  assert.ok(shifts.every((s) => s.published === false));
  assert.deepEqual(shifts.map((s) => s.workerId).sort(), ["61420000000", "pending-sam-s"]);
});

test("no config, or bad JSON, does nothing", async () => {
  const st = await setup();
  assert.deepEqual(await runBootstrap(st, "v", undefined, quiet), { skipped: "no config" });
  assert.deepEqual(await runBootstrap(st, "v", "{nope", quiet), { error: "bad json" });
});
