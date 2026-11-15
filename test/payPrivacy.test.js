"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const ExcelJS = require("exceljs");
const PP = require("../payPrivacy");
const P = require("../payroll");
const { buildStores } = require("../stores");
const payrollRoutes = require("../payroll-routes");
const { seedDemo } = require("../demoSeed");
const { InMemoryTenantStore } = require("../tenantStore");

test("redactWorker / touchesSalary: only salaried records are private, and only the owner link may touch them", () => {
  const sal = { name: "Sal", employmentType: "fulltime", payType: "salary", annualSalary: 110000, weeklySalary: 2115.38 };
  const hr = { name: "Hr", employmentType: "fulltime", payType: "hourly", hourlyRate: 37.96, annualSalary: null };
  const r = PP.redactWorker(sal);
  assert.equal(r.payHidden, true); assert.equal("annualSalary" in r, false); assert.equal("weeklySalary" in r, false);
  assert.equal(sal.annualSalary, 110000, "the stored record is not changed");
  assert.equal(PP.redactWorker(hr), hr, "hourly staff are untouched");
  assert.equal(PP.touchesSalary(sal, { name: "x" }), true, "any edit of a salaried person");
  assert.equal(PP.touchesSalary(hr, { payType: "salary" }), true);
  assert.equal(PP.touchesSalary(null, { annualSalary: 90000 }), true);
  assert.equal(PP.touchesSalary(hr, { payType: "hourly", annualSalary: null, hourlyRate: 40 }), false, "the crew sheet's normal hourly save");
});

test("redactWeek: salaries leave the payload, the group total stays, and totals are unchanged", () => {
  const workers = [
    { id: "a", name: "Exec", department: "kitchen", employmentType: "fulltime", payType: "salary", annualSalary: 110000 },
    { id: "b", name: "Sous", department: "kitchen", employmentType: "fulltime", payType: "salary", annualSalary: 86000 },
    { id: "c", name: "Cdp", department: "kitchen", employmentType: "fulltime", payType: "hourly", level: "L6", hourlyRate: 37.96 },
  ];
  const week = P.buildWeek({ weekStart: "2026-11-16", today: "2026-11-15", workers,
    settings: { oncost: { include: true, casualPct: 22.17, permanentPct: 31.21 } },
    rosterShifts: [{ workerId: "c", date: "2026-11-16", start: "08:00", end: "16:30", unpaidBreakMins: 30 }], attendance: [], revenue: { forecast: { "2026-11-16": 20000 } } });
  const red = PP.redactWeek(week);
  const json = JSON.stringify(red);
  for (const n of ["2115.38", "1653.85", "110000", "86000"]) assert.equal(json.includes(n), false, `${n} must not be sent`);
  const hidden = red.crew.filter((c) => c.payHidden);
  assert.equal(hidden.length, 2);
  for (const c of hidden) { assert.equal(c.weeklySalary, null); assert.equal(c.projectedCost, null); assert.ok(c.days.every((d) => d.projectedCost === null && d.rosteredCost === null && d.actualCost === null)); }
  assert.deepEqual(hidden.map((c) => c.name), ["Exec", "Sous"], "hidden people are listed by name, not by size of salary");
  assert.equal(red.salaried.headcount, 2);
  assert.equal(red.salaried.wages, Math.round(week.crew.filter((c) => c.payType === "salary").reduce((t, c) => t + c.projectedCost, 0) * 100) / 100);
  assert.ok(Math.abs(red.salaried.wages - (110000 + 86000) / 52) < 0.1);
  assert.ok(Math.abs(red.salaried.projected - red.salaried.wages * 1.3121) < 0.05, "combined figure is in on-cost like the totals");
  assert.deepEqual(red.totals, week.totals, "the manager sees the same payroll totals as the owner");
  assert.equal(red.crew.find((c) => c.id === "c").hourlyRate, 37.96, "hourly rates stay visible");
  assert.equal(week.crew.find((c) => c.id === "a").weeklySalary, 2115.38, "the owner's copy is not changed");
  assert.equal(PP.redactWeek({ crew: [{ payType: "hourly" }] }).salaried, undefined, "nothing to hide, nothing added");
});

test("redactPeople: the month export folds salaried people into one line per department", () => {
  const out = PP.redactPeople({ month: "2026-11", people: [
    { name: "Exec", department: "kitchen", cls: "ftpt", typeLabel: "Salaried", byDate: { "2026-11-01": 300, "2026-11-02": 300 }, total: 600, hours: 16 },
    { name: "Sous", department: "kitchen", cls: "ftpt", typeLabel: "Salaried", byDate: { "2026-11-01": 200 }, total: 200, hours: 8 },
    { name: "Cas", department: "kitchen", cls: "casual", typeLabel: "Casual", byDate: { "2026-11-01": 150 }, total: 150, hours: 5 },
  ] });
  assert.deepEqual(out.people.map((p) => p.name), ["Salaried staff (2)", "Cas"]);
  assert.deepEqual([out.people[0].total, out.people[0].hours, out.people[0].byDate["2026-11-01"]], [800, 24, 500]);
});

test("routes: a manager link gets no salary from the week, the CSV or the Excel, and can't change settings", async () => {
  const stores = buildStores();
  await seedDemo(stores);
  const app = express();
  app.use(express.json());
  app.use("/api/pay", (req, _res, next) => { req.tenantId = "demo-venue"; req.isTeam = req.get("x-team") === "1"; next(); }, payrollRoutes({ db: null, ...stores }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const team = { headers: { "x-team": "1", "content-type": "application/json" } };
  try {
    const owner = await (await fetch(base + "/api/pay/week")).json();
    const tim = owner.crew.find((c) => c.name === "Tim Susanto");
    assert.equal(tim.weeklySalary, 1634.62);

    const txt = await (await fetch(base + "/api/pay/week", team)).text();
    assert.equal(txt.includes("1634.62"), false, "weekly salary must not reach a manager link");
    const wk = JSON.parse(txt);
    const hid = wk.crew.find((c) => c.name === "Tim Susanto");
    assert.equal(hid.payHidden, true); assert.equal(hid.projectedCost, null); assert.equal(hid.weeklySalary, null);
    assert.equal(wk.salaried.headcount, 1);
    assert.deepEqual(wk.totals, owner.totals);
    assert.equal(wk.crew.find((c) => c.name === "Maria Gomez").hourlyRate, 31.5);

    const rev = await fetch(base + `/api/pay/week/${owner.weekStart}/revenue`, { method: "POST", ...team, body: JSON.stringify({ forecast: { [owner.weekStart]: 5000 } }) });
    assert.equal(rev.status, 200, "a manager can still enter revenue");
    assert.equal((await rev.text()).includes("1634.62"), false);

    const csv = await (await fetch(base + `/api/pay/export.csv?start=${owner.weekStart}`, team)).text();
    assert.match(csv, /Salaried staff \(1\)/); assert.equal(csv.includes("1634.62"), false); assert.equal(/Tim Susanto/.test(csv), false);
    assert.match(await (await fetch(base + `/api/pay/export.csv?start=${owner.weekStart}`)).text(), /Tim Susanto,kitchen,Salaried,,1634\.62\/wk/);

    const x = await fetch(base + `/api/pay/finance.xlsx?month=${owner.weekStart.slice(0, 7)}`, team);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    const names = []; wb.getWorksheet("By person").eachRow((r) => names.push(String(r.getCell(1).value)));
    assert.ok(names.includes("Salaried staff (1)")); assert.equal(names.includes("Tim Susanto"), false);

    assert.equal((await fetch(base + "/api/pay/settings", { method: "POST", ...team, body: JSON.stringify({ targets: { kitchenPct: 1, totalPct: 2 } }) })).status, 403);
    assert.equal((await fetch(base + "/api/pay/settings", team)).status, 200);
  } finally { server.close(); }
});

test("tenantStore.findByTeamKey: a manager link opens its own venue only", async () => {
  const t = new InMemoryTenantStore();
  await t.create("v1", { name: "One", dashboardKey: "owner-1", teamKey: "team-abcdefghijklmnopqrst" });
  assert.equal((await t.findByTeamKey("team-abcdefghijklmnopqrst")).tenantId, "v1");
  assert.equal(await t.findByTeamKey("owner-1"), null);
  assert.equal(await t.findByDashboardKey("team-abcdefghijklmnopqrst"), null);
  assert.equal(await t.findByTeamKey(""), null);
});
