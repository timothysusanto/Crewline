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
    const s = await call("/api/pay/settings", { method: "POST", body: { targets: { kitchenPct: 25, totalPct: 50 }, includeSuper: true } });
    assert.equal(s.status, 200);
    const after = (await call("/api/pay/week")).json;
    assert.equal(after.departments.service.targetPct, 25);
    assert.ok(after.totals.projected > r.json.totals.projected, "super now counted");
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
