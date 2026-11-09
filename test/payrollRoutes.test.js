"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { buildStores } = require("../stores");
const payrollRoutes = require("../payroll-routes");
const { seedDemo } = require("../demoSeed");
const P = require("../payroll");

async function boot() {
  const stores = buildStores();
  await seedDemo(stores);
  const app = express();
  app.use(express.json());
  app.use("/api/pay", (req, _res, next) => { req.tenantId = "demo-venue"; next(); }, payrollRoutes({ db: null, ...stores }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, opts = {}) => { const res = await fetch(base + path, { ...opts, headers: { "content-type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: res.status, json: res.headers.get("content-type").includes("json") ? await res.json() : await res.text() }; };
  return { call, close: () => server.close() };
}

test("GET /week builds the seeded week with departments, crew and a cycle for full-timers", async () => {
  const { call, close } = await boot();
  try {
    const { status, json } = await call("/api/pay/week");
    assert.equal(status, 200);
    assert.equal(json.crew.length, 7);
    assert.ok(json.flags.some((f) => f.code === "setup"), "Priya has no pay details");
    const maria = json.crew.find((c) => c.name === "Maria Gomez");
    assert.ok(maria.cycle && maria.cycle.limit === 152);
    assert.equal(json.departments.service.targetPct, 33);
    assert.equal(json.totals.expectedRevenue, null);
    assert.ok(json.flags.some((f) => /revenue forecast/.test(f.text)));
  } finally { close(); }
});

test("POST revenue: weekTotal spreads, actuals override, settings change the budget", async () => {
  const { call, close } = await boot();
  try {
    const wk = (await call("/api/pay/week")).json;
    const r = await call(`/api/pay/week/${wk.weekStart}/revenue`, { method: "POST", body: { weekTotal: 21000, actual: { [wk.weekStart]: 2500 } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.totals.forecastRevenue, 21000);
    assert.equal(r.json.days[0].actual, 2500);
    assert.equal(r.json.totals.expectedRevenue, 21000 - 3000 + 2500);
    assert.equal(r.json.totals.budget, Math.round((21000 - 500) * 0.55 * 100) / 100);
    const bad = await call(`/api/pay/week/${P.addDays(wk.weekStart, 1)}/revenue`, { method: "POST", body: { weekTotal: 1 } });
    assert.equal(bad.status, 400);
    const s = await call("/api/pay/settings", { method: "POST", body: { targets: { kitchenPct: 25, totalPct: 50 } } });
    assert.equal(s.status, 200);
    const after = (await call("/api/pay/week")).json;
    assert.equal(after.departments.service.targetPct, 25);
    assert.equal(after.totals.projected, r.json.totals.projected, "super is never in payroll");
    const rej = await call("/api/pay/settings", { method: "POST", body: { targets: { kitchenPct: 60, totalPct: 50 } } });
    assert.equal(rej.status, 400);
  } finally { close(); }
});

test("export.csv has one line per worked shift and the totals", async () => {
  const { call, close } = await boot();
  try {
    const { status, json: csv } = await call("/api/pay/export.csv");
    assert.equal(status, 200);
    const lines = csv.split("\n");
    assert.ok(lines[0].startsWith("Name,Department,Type"), lines[0]); // fetch strips the BOM
    assert.ok(lines.some((l) => l.startsWith("Tim Susanto,kitchen,Salaried")));
    assert.ok(lines.some((l) => l.startsWith("Totals,")));
  } finally { close(); }
});

test("timesheet fixes: forgot clock-out → one tap closes at the rostered end; second call is a no-op", async () => {
  const stores = buildStores();
  await seedDemo(stores);
  const app = express(); app.use(express.json());
  app.use("/api/pay", (req, _res, next) => { req.tenantId = "demo-venue"; next(); }, payrollRoutes({ db: null, ...stores }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, o = {}) => { const res = await fetch(base + p, { ...o, headers: { "content-type": "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined }); return { status: res.status, json: await res.json() }; };
  try {
    const staff = (await stores.staffStore.listByTenant("demo-venue")).find((s) => s.payType !== "salary" && s.active !== false);
    const settings = (await stores.tenantStore.findById("demo-venue")) || {};
    const tz = (settings.payroll || {}).timezone || P.DEFAULT_SETTINGS.timezone;
    const yesterday = P.addDays(P.todayIn(tz), -1);
    await stores.rosterStore.addShift({ tenantId: "demo-venue", workerId: staff.phone, date: yesterday, start: "09:00", end: "17:00", unpaidBreakMins: 30, published: true });
    const { zonedToIso } = require("../timesheetFixes");
    await stores.shiftsStore.openShift({ tenantId: "demo-venue", staffPhone: staff.phone, clockIn: { time: zonedToIso(yesterday, "08:58", tz) } });
    const before = await call("/api/pay/timesheet/fixes");
    assert.equal(before.json.active, true);
    const f = before.json.fixes.find((x) => x.type === "no_out" && x.workerId === String(staff.phone));
    assert.ok(f, "open clock-in past the rostered end is flagged");
    const r = await call("/api/pay/timesheet/fix", { method: "POST", body: { keys: [f.key] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.done.length, 1);
    assert.ok(!r.json.fixes.some((x) => x.key === f.key));
    const rec = (await stores.shiftsStore.listByTenant("demo-venue")).find((s) => s.staffPhone === staff.phone && !s.clockOut === false && s.clockIn.time === zonedToIso(yesterday, "08:58", tz));
    assert.equal(rec.clockOut.time, zonedToIso(yesterday, "17:00", tz));
    assert.equal(rec.amended.breakMinutes, 30);
    const again = await call("/api/pay/timesheet/fix", { method: "POST", body: { keys: [f.key] } });
    assert.equal(again.json.done.length, 0);
    assert.equal(again.json.failed[0].error, "Already fixed.");
  } finally { server.close(); }
});
