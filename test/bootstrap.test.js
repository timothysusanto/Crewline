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

test("a second config: `set` updates existing crew, settings merge, forecasts fill empty days only", async () => {
  const st = await setup();
  await runBootstrap(st, "v", JSON.stringify(cfg), quiet);
  const weeks = new Map();
  const extras = {
    readWeek: async (t, ws) => weeks.get(ws) || { weekStart: ws, forecast: {}, actual: {} },
    writeWeek: async (t, ws, doc) => weeks.set(ws, { weekStart: ws, ...doc }),
    writeHolidays: async () => {},
  };
  weeks.set("2026-11-09", { weekStart: "2026-11-09", forecast: { "2026-11-10": 999 }, actual: {} });
  const cfg2 = { id: "t2", payroll: { oncost: { include: true, casualPct: 22.17, permanentPct: 31.21 }, publicHolidays: ["2026-12-25"] },
    crew: [{ name: "Sam S", set: { employmentType: "fulltime", payType: "salary", annualSalary: 80000, jobTitle: "Junior Sous Chef" } }],
    forecast: { "2026-11-10": 5000, "2026-11-11": 6000, "2026-11-16": 7000 } };
  const r = await runBootstrap(st, "v", JSON.stringify(cfg2), quiet, extras);
  assert.equal(r.forecastDays, 2);
  assert.equal(weeks.get("2026-11-09").forecast["2026-11-10"], 999, "manager's number kept");
  assert.equal(weeks.get("2026-11-09").forecast["2026-11-11"], 6000);
  assert.equal(weeks.get("2026-11-16").forecast["2026-11-16"], 7000);
  const sam = (await st.staffStore.listByTenant("v")).find((s) => s.name === "Sam S");
  assert.deepEqual([sam.payType, sam.annualSalary, sam.jobTitle, sam.tenantId], ["salary", 80000, "Junior Sous Chef", "v"]);
  const t = await st.tenantStore.findById("v");
  assert.equal(t.payroll.timezone, "Australia/Perth", "earlier settings kept");
  assert.equal(t.payroll.oncost.include, true);
  assert.deepEqual(t.payroll.publicHolidays, ["2026-12-25"]);
});
