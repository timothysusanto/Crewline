"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const ExcelJS = require("exceljs");
const FR = require("../financeReport");
const { buildStores } = require("../stores");
const payrollRoutes = require("../payroll-routes");
const { seedDemo } = require("../demoSeed");

// ---- a miniature of finance's "F&B Daily Payroll" workbook: same sheets, same label layout ----
const serial = (d) => Math.round((Date.parse(d + "T00:00:00Z") - Date.UTC(1899, 11, 30)) / 86400000);
async function financeFile({ month = "2026-11", days = 4, revenue = [[1000, 200], [900, 100], [5000, 0], [800, 300]], kitchen = [[300, 100], [250, 100], [320, 110], [280, 100]] } = {}) {
  const wb = new ExcelJS.Workbook();
  const rep = wb.addWorksheet("Report");
  const inp = wb.addWorksheet("Input Sheet");
  const idx = wb.addWorksheet("Index");
  const dates = FR.monthDates(month);
  inp.getCell("D1").value = "Test Hotel";
  dates.forEach((d, i) => { inp.getCell(4, 7 + i).value = serial(d); });
  const row = (n, label, vals, tag) => { inp.getCell(n, 4).value = label; if (tag) inp.getCell(n, 3).value = tag; (vals || []).forEach((v, i) => { inp.getCell(n, 7 + i).value = v; }); };
  const pad = (f) => dates.map((_, i) => (i < days ? f(i) : 0));
  row(6, "F&B Revenue");
  row(7, "Bistro", pad((i) => revenue[i][0])); row(8, "Food", pad((i) => revenue[i][0])); row(9, "Beverage", pad(() => 0)); row(10, "F&B Other Income", pad(() => 0));
  row(12, "Bar", pad((i) => revenue[i][1])); row(13, "Food", pad(() => 0)); row(14, "Beverage", pad((i) => revenue[i][1])); row(15, "F&B Other Income", pad(() => 0));
  row(17, "Total Food", pad((i) => revenue[i][0])); row(18, "Total Beverage", pad((i) => revenue[i][1])); row(19, "Total F&B Other Income", pad(() => 0));
  inp.getCell(20, 4).value = "Total F&B Revenue"; dates.forEach((_, i) => { inp.getCell(20, 7 + i).value = { formula: "SUM(X)", result: i < days ? revenue[i][0] + revenue[i][1] : 0 }; });
  row(22, "F&B Payroll (Ex Oncost)");
  row(24, "Bistro"); row(25, "Service", null, "Service"); row(26, "Casual", pad(() => 150)); row(27, "FT&PT", pad(() => 50));
  row(28, "Kitchen", null, "Kitchen"); row(29, "Casual", pad((i) => kitchen[i][0] / 2)); row(30, "FT&PT", pad((i) => kitchen[i][1] / 2));
  row(32, "Total Service", pad(() => 200)); row(33, "Total Kitchen", pad((i) => kitchen[i][0] + kitchen[i][1])); row(34, "Total F&B Payroll", pad((i) => 200 + kitchen[i][0] + kitchen[i][1]));
  row(36, "Kitchen"); row(37, "Casual", pad((i) => kitchen[i][0])); row(38, "FT&PT", pad((i) => kitchen[i][1]));
  row(40, "Bistro"); inp.getCell("E40").value = 0.8; row(41, "Bar"); inp.getCell("E41").value = 0.2;
  row(44, "F&B Payroll (Inc Oncost) - $");
  row(46, "Bistro"); row(47, "Service"); row(48, "Casual", pad(() => 183.26)); row(49, "FT&PT", pad(() => 65.61));
  row(51, "Total Service", pad(() => 248.87)); row(52, "Total Kitchen", pad((i) => Math.round((kitchen[i][0] * 1.2217 + kitchen[i][1] * 1.3121) * 100) / 100)); row(53, "Total F&B Payroll", pad(() => 0));
  row(55, "F&B Payroll (Inc Oncost) - %"); row(56, "Bistro", pad(() => 0.3));
  // Report: label A, MTD B, Budget C
  const r = (n, label, a, b) => { rep.getCell(n, 1).value = label; if (a != null) rep.getCell(n, 2).value = a; if (b != null) rep.getCell(n, 3).value = b; };
  const revTot = revenue.slice(0, days).reduce((t, x) => t + x[0] + x[1], 0);
  const kitInc = kitchen.slice(0, days).reduce((t, x) => t + x[0] * 1.2217 + x[1] * 1.3121, 0);
  r(1, "Test Hotel"); r(2, "Days", days); r(3, "Days in a month", dates.length);
  r(6, "F&B Revenue"); r(7, "Bistro", 7700, 9000); r(8, "Food", 7700, 9000); r(12, "Bar", 600, 500); r(14, "Beverage", 600, 500);
  r(32, "Total Food", 7700, 9000); r(33, "Total Beverage", 600, 500); r(35, "Total F&B Revenue", revTot, 9500);
  r(37, "F&B Payroll (In Oncost) - $"); r(39, "Bistro", 3000, 3100); r(40, "Service", 995.48, 1100); r(41, "Kitchen", kitInc, 2000.004);
  r(60, "Total Service", 995.48, 1100); r(61, "Total Kitchen", kitInc, 2000.004); r(62, "Total F&B Payroll", 995.48 + kitInc, 3100);
  r(64, "F&B Payroll (In Oncost) - %"); r(66, "Bistro", 0.4, 0.35); r(67, "Service", 0.12, 0.1); r(87, "Total Service", 0.12, 0.116); r(88, "Total Kitchen", kitInc / revTot, 0.2105); r(89, "Total F&B Payroll", 0.36, 0.326);
  idx.getCell("A10").value = "Casual"; idx.getCell("B10").value = 1.2217; idx.getCell("A11").value = "PT/FT"; idx.getCell("B11").value = 1.3121;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const person = (name, employmentType, department, costs, extra = {}) => ({ id: name, name, employmentType, department, typeLabel: employmentType, days: Object.entries(costs).map(([date, c]) => ({ date, projectedCost: c, projectedHours: c / 40 })), ...extra });

test("collectMonth: casual and FT&PT per day, only the month asked for, past days are actual", () => {
  const weeks = [
    { days: [{ date: "2026-10-31", forecast: 900 }, { date: "2026-11-01", forecast: 1000, actual: 1100 }],
      crew: [person("Cas", "casual", "kitchen", { "2026-10-31": 200, "2026-11-01": 300 }), person("Sal", "fulltime", "kitchen", { "2026-11-01": 400 }), person("Flo", "casual", "service", { "2026-11-01": 80 })] },
    { days: [{ date: "2026-11-02", forecast: 1200 }],
      crew: [person("Cas", "casual", "kitchen", { "2026-11-02": 120 }), person("Pt", "parttime", "kitchen", { "2026-11-02": 90 }, { cycle: { overtimePremium: 15 } })] },
  ];
  const m = FR.collectMonth(weeks, "2026-11", "2026-11-02");
  assert.equal(m.rows.length, 30);
  assert.deepEqual([m.rows[0].kitchen.casual, m.rows[0].kitchen.ftpt, m.rows[0].kitchen.total, m.rows[0].service.casual], [300, 400, 700, 80]);
  assert.equal(m.rows[0].basis, "actual"); assert.equal(m.rows[1].basis, "roster");
  assert.equal(m.rows[0].revenue, 1100); assert.equal(m.rows[0].revenueKind, "actual"); assert.equal(m.rows[1].revenueKind, "forecast");
  assert.equal(m.rows[1].kitchen.ftpt, 105, "cycle overtime lands on the week's last day in the month");
  assert.equal(m.people.find((p) => p.name === "Cas").total, 420, "October is left out");
  assert.equal(FR.withOncost({ casual: 100, ftpt: 100 }, { casualPct: 22.17, permanentPct: 31.21 }), 253.38);
});

test("buildWorkbook: the paste block starts at G8, yellow only for days that have happened", async () => {
  const weeks = [{ days: [], crew: [person("Cas", "casual", "kitchen", { "2026-11-01": 300, "2026-11-02": 310, "2026-11-03": 500 }), person("Sal", "fulltime", "kitchen", { "2026-11-01": 400, "2026-11-03": 410 })] }];
  const collected = FR.collectMonth(weeks, "2026-11", "2026-11-03");
  const wb = FR.buildWorkbook({ venue: "Test Hotel", month: "2026-11", collected, oncost: { casualPct: 22.17, permanentPct: 31.21 } });
  const back = new ExcelJS.Workbook(); await back.xlsx.load(await wb.xlsx.writeBuffer());
  assert.deepEqual(back.worksheets.map((w) => w.name), ["For Input Sheet", "Daily", "By person"]);
  const s = back.getWorksheet("For Input Sheet");
  assert.equal(s.getCell("G8").value, 300); assert.equal(s.getCell("G9").value, 400); assert.equal(s.getCell("H8").value, 310);
  assert.equal(s.getCell("I8").value, null, "today onward is not in the paste block");
  assert.equal(s.getCell("G8").fill.fgColor.argb, "FFFFF2B3");
  assert.equal(s.getCell("E8").value.result, 610);
  assert.match(String(s.getCell("D3").value), /G8 to H9/);
  assert.equal(s.getCell("G5").value, "Sunday");
  assert.equal(back.getWorksheet("Daily").rowCount, 31);
  assert.equal(back.getWorksheet("By person").getCell("A2").value, "Cas");
});

test("parseFinanceWorkbook: revenue by outlet, kitchen Casual / FT&PT, on-cost and the budget lines", async () => {
  const p = await FR.parseFinanceWorkbook(await financeFile());
  assert.equal(p.ok, true);
  assert.equal(p.venue, "Test Hotel"); assert.equal(p.month, "2026-11"); assert.equal(p.through, "2026-11-04"); assert.equal(p.days.length, 4);
  assert.deepEqual(p.outlets, ["Bistro", "Bar"]);
  assert.deepEqual(p.oncost, { casualPct: 22.17, permanentPct: 31.21 });
  assert.equal(p.days[0].revenue, 1200); assert.deepEqual(p.days[0].outlets, { Bistro: 1000, Bar: 200 });
  assert.deepEqual(p.days[2].kitchenEx, { casual: 320, ftpt: 110 }, "the standalone Kitchen block, not one outlet's share");
  assert.equal(p.days[0].kitchenInc, 497.72);
  assert.equal(p.mtd.revenue.total.budget, 9500); assert.equal(p.mtd.revenue.outlets.length, 2); assert.equal(p.mtd.revenue.outlets[0].food.budget, 9000);
  assert.equal(p.mtd.payroll.kitchen.budget, 2000.004); assert.equal(p.mtd.pct.kitchen.budget, 21.1);
  const bad = await FR.parseFinanceWorkbook(Buffer.from("not a spreadsheet"));
  assert.equal(bad.ok, false);
  const other = new ExcelJS.Workbook(); other.addWorksheet("Sheet1").getCell("A1").value = 1;
  assert.match((await FR.parseFinanceWorkbook(Buffer.from(await other.xlsx.writeBuffer()))).error, /Input Sheet/);
});

test("buildReport: finance figures lead, the big day is called out, Crewline is compared on the days it has", async () => {
  const parsed = await FR.parseFinanceWorkbook(await financeFile());
  const weeks = [{ days: [], crew: [person("Cas", "casual", "kitchen", { "2026-11-01": 290, "2026-11-02": 260 }), person("Sal", "fulltime", "kitchen", { "2026-11-01": 100, "2026-11-02": 100 })] }];
  const collected = FR.collectMonth(weeks, "2026-11", "2026-11-05");
  const r = FR.buildReport({ venue: "x", month: "2026-11", today: "2026-11-05", collected, oncost: { casualPct: 22.17, permanentPct: 31.21 }, targets: { kitchenPct: 25 }, finance: FR.toStored(parsed) });
  assert.equal(r.source.kind, "finance"); assert.equal(r.venue, "Test Hotel"); assert.equal(r.rangeLabel, "1–4 November 2026");
  assert.equal(r.days.length, 4); assert.equal(r.mtd.revenue.actual, 8300); assert.equal(r.mtd.kitchen.budgetPct, 21.1);
  assert.equal(r.mtd.kitchen.pct, Math.round((r.mtd.kitchen.actual / 8300) * 1000) / 10);
  const big = r.insights.find((i) => i.key === "bigday");
  assert.ok(big && big.day === "2026-11-03", "5,000 on one day against ~1,100 on the others");
  assert.equal(big.without, Math.round(((497.72 + 436.64 + 473.31) / 3300) * 1000) / 10);
  assert.equal(r.mtd.crewline.days, 2);
  assert.match(r.insights.find((i) => i.key === "crewline").text, /the 2 days Crewline has a roster for/);
  assert.equal(r.outlets[0].name, "Bistro"); assert.equal(r.outlets[0].variance, -1300);
});

test("buildReport without a finance file runs on Crewline's own numbers up to yesterday", () => {
  const weeks = [{ days: [{ date: "2026-11-01", actual: 2000 }, { date: "2026-11-02", forecast: 2000 }], crew: [person("Cas", "casual", "kitchen", { "2026-11-01": 400, "2026-11-02": 700 })] }];
  const collected = FR.collectMonth(weeks, "2026-11", "2026-11-03");
  const r = FR.buildReport({ venue: "Cafe", month: "2026-11", today: "2026-11-03", collected, oncost: { casualPct: 22.17, permanentPct: 31.21 }, targets: { kitchenPct: 30 }, finance: null });
  assert.equal(r.source.kind, "crewline"); assert.equal(r.through, "2026-11-02"); assert.equal(r.days.length, 2);
  assert.equal(r.days[0].kitchen, 488.68); assert.equal(r.days[0].pct, 24.4);
  assert.equal(r.mtd.kitchen.status, "over"); assert.equal(r.mtd.crewline, null); assert.deepEqual(r.outlets, []);
  const empty = FR.buildReport({ month: "2026-11", today: "2026-11-01", collected: FR.collectMonth([], "2026-11", "2026-11-01"), oncost: {}, targets: {}, finance: null });
  assert.equal(empty.days.length, 0);
});

test("routes: Excel for finance downloads, finance's file loads actual revenue, the report answers", async () => {
  const stores = buildStores();
  await seedDemo(stores);
  const app = express();
  app.use(express.json());
  app.use("/api/pay", (req, _res, next) => { req.tenantId = "demo-venue"; next(); }, payrollRoutes({ db: null, ...stores }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const x = await fetch(base + "/api/pay/finance.xlsx?month=2026-11");
    assert.equal(x.status, 200); assert.match(x.headers.get("content-disposition"), /crewline_finance_2026-11\.xlsx/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
    assert.ok(wb.getWorksheet("For Input Sheet"));

    const up = await fetch(base + "/api/pay/finance/import?filename=fb.xlsx", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: await financeFile() });
    const j = await up.json();
    assert.equal(up.status, 200); assert.equal(j.month, "2026-11"); assert.equal(j.days, 4); assert.equal(j.revenue, 8300);
    const wk = await (await fetch(base + "/api/pay/week?start=2026-11-02")).json();
    assert.equal(wk.days.find((d) => d.date === "2026-11-03").actual, 5000, "their revenue is now the day's actual");
    const rep = await (await fetch(base + "/api/pay/report?month=2026-11")).json();
    assert.equal(rep.source.kind, "finance"); assert.equal(rep.source.fileName, "fb.xlsx"); assert.equal(rep.days.length, 4);
    const junk = await fetch(base + "/api/pay/finance/import", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from("hello") });
    assert.equal(junk.status, 422);
  } finally { server.close(); }
});
