"use strict";

/**
 * financeReport.js — the bridge between Crewline and a hotel finance team's
 * daily payroll workbook ("F&B Daily Payroll").
 *
 *  OUT  collectMonth() + buildWorkbook(): one Excel file for a calendar month with
 *       payroll per day split Casual / FT&PT, wages only (ex on-cost). Those are the
 *       two rows a finance team keys per department, laid out one column per day
 *       (the 1st of the month in column G) so it is one copy and one paste.
 *
 *  IN   parseFinanceWorkbook(): reads finance's own workbook (sheets "Input Sheet",
 *       "Report", "Index") and returns actual revenue per day by outlet, their
 *       payroll actuals and the month-to-date budget lines.
 *
 *  buildReport(): the numbers behind the month-to-date report (animated at /report,
 *       printable at /report/print).
 *
 * Everything here is a pure function except parseFinanceWorkbook, which only reads
 * the buffer it is given.
 */
const ExcelJS = require("exceljs");
const { Readable } = require("stream");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function monthDates(month) {
  const [y, m] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}
function monthLabel(month) { const [y, m] = month.split("-").map(Number); return `${MON[m - 1]} ${y}`; }
function shortDate(d) { return `${DAY[dow(d)].slice(0, 3)} ${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1].slice(0, 3)}`; }

/** Finance splits payroll two ways only: casual, and everyone else (full-time, part-time, salaried). */
const classOf = (c) => (c.employmentType === "casual" ? "casual" : "ftpt");

// ---------------------------------------------------------------------------
// OUT: Crewline → finance
// ---------------------------------------------------------------------------

/**
 * Fold a month's pay weeks (payroll.buildWeek results) into one row per day.
 * Wages only. A day before `today` is "actual" (clocked, or the roster where the
 * venue doesn't clock in); today onward is "roster".
 */
function collectMonth(weeks, month, today) {
  const dates = monthDates(month);
  const blank = () => ({ casual: 0, ftpt: 0, hours: 0 });
  const byDate = {};
  for (const d of dates) byDate[d] = { date: d, basis: d < today ? "actual" : "roster", kitchen: blank(), service: blank(), other: blank(), revenue: null, revenueKind: null };
  const people = new Map();

  for (const w of weeks) {
    for (const rd of w.days || []) {
      const row = byDate[rd.date];
      if (!row) continue;
      if (rd.actual != null) { row.revenue = rd.actual; row.revenueKind = "actual"; }
      else if (rd.forecast != null) { row.revenue = rd.forecast; row.revenueKind = "forecast"; }
    }
    for (const c of w.crew || []) {
      const dept = c.department === "kitchen" || c.department === "service" ? c.department : "other";
      const cls = classOf(c);
      const key = c.id || c.name;
      const add = (date, cost, hours) => {
        const row = byDate[date];
        if (!row || !(cost || hours)) return;
        row[dept][cls] += cost; row[dept].hours += hours;
        let p = people.get(key);
        if (!p) { p = { name: c.name, department: dept, cls, typeLabel: c.typeLabel, byDate: {}, total: 0, hours: 0 }; people.set(key, p); }
        p.byDate[date] = round2((p.byDate[date] || 0) + cost); p.total += cost; p.hours += hours;
      };
      for (const d of c.days || []) add(d.date, d.projectedCost || 0, d.projectedHours || 0);
      // 152-hour cycle overtime is priced on the week, not a day: post it on the week's last day in the month.
      if (c.cycle && c.cycle.overtimePremium) {
        const last = [...(c.days || [])].reverse().find((d) => byDate[d.date]);
        if (last) add(last.date, c.cycle.overtimePremium, 0);
      }
    }
  }
  const rows = dates.map((d) => {
    const r = byDate[d];
    for (const k of ["kitchen", "service", "other"]) { r[k].casual = round2(r[k].casual); r[k].ftpt = round2(r[k].ftpt); r[k].hours = round2(r[k].hours); r[k].total = round2(r[k].casual + r[k].ftpt); }
    return r;
  });
  const list = [...people.values()].map((p) => ({ ...p, total: round2(p.total), hours: round2(p.hours) }))
    .sort((a, b) => a.department.localeCompare(b.department) || a.cls.localeCompare(b.cls) || b.total - a.total);
  return { month, today, rows, people: list };
}

/** Wages → in on-cost, the way the finance Index sheet does it (one loading for casuals, one for FT&PT). */
function withOncost(part, oncost) {
  const c = 1 + (Number(oncost && oncost.casualPct) || 0) / 100, p = 1 + (Number(oncost && oncost.permanentPct) || 0) / 100;
  return round2((part.casual || 0) * c + (part.ftpt || 0) * p);
}

function colLetter(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/**
 * The month's payroll as Excel. Sheet 1 runs one column per day (starting at G) with
 * Casual / FT&PT rows per department, sheet 2 is one line per day, sheet 3 one line per person.
 * @param {object} o { venue, month, collected, oncost:{casualPct,permanentPct}, generatedAt }
 */
function buildWorkbook(o) {
  const { venue, month, collected, oncost = {} } = o;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Crewline"; wb.created = new Date(o.generatedAt || Date.now());
  const rows = collected.rows, FIRST = 7; // day columns start at G
  const money = '#,##0.00;[Red]-#,##0.00;"-"';
  const yellow = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2B3" } };
  const head = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3E4C59" } };
  const lastCol = FIRST + rows.length - 1, L = colLetter(lastCol);
  const actualDays = rows.filter((r) => r.basis === "actual");
  const lastActualCol = actualDays.length ? colLetter(FIRST + actualDays.length - 1) : null;

  // ---- Sheet 1: paste block ----
  const s1 = wb.addWorksheet("By day", { views: [{ state: "frozen", xSplit: 6, ySplit: 6 }] });
  s1.getColumn(4).width = 34; s1.getColumn(5).width = 14; s1.getColumn(1).width = 3; s1.getColumn(2).width = 3; s1.getColumn(3).width = 10; s1.getColumn(6).width = 3;
  for (let i = 0; i < rows.length; i++) s1.getColumn(FIRST + i).width = 12;
  s1.getCell("D1").value = `${venue || "Venue"} — payroll by day — ${monthLabel(month)}`; s1.getCell("D1").font = { bold: true, size: 14 };
  s1.getCell("D2").value = "Wages only (ex on-cost), split Casual and FT&PT, one column per day.";
  s1.getCell("D3").value = lastActualCol
    ? `For your finance workbook: copy the yellow cells (G8 to ${lastActualCol}9) and paste them as values, Casual row first, starting at the 1st of the month.`
    : "No days have passed yet this month, so there is nothing to paste. Rostered cost is further down.";
  s1.getCell("D3").font = { bold: true, color: { argb: "FFC13F0F" } };
  s1.getCell("E5").value = "MTD"; s1.getCell("E5").font = { bold: true };
  rows.forEach((r, i) => {
    const a = s1.getCell(5, FIRST + i), b = s1.getCell(6, FIRST + i);
    a.value = DAY[dow(r.date)]; b.value = new Date(r.date + "T00:00:00Z"); b.numFmt = "d-mmm-yy";
    for (const c of [a, b]) { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = head; c.alignment = { horizontal: "center" }; }
  });
  const line = (rowNo, tag, label, getter, opts = {}) => {
    s1.getCell(rowNo, 3).value = tag || null; s1.getCell(rowNo, 4).value = label;
    if (opts.bold) s1.getCell(rowNo, 4).font = { bold: true };
    let total = 0;
    rows.forEach((r, i) => {
      const v = getter(r); const c = s1.getCell(rowNo, FIRST + i);
      if (v == null) return;
      c.value = round2(v); c.numFmt = money; total += v;
      if (opts.yellow) c.fill = yellow;
      if (opts.bold) c.font = { bold: true };
    });
    const t = s1.getCell(rowNo, 5); t.value = { formula: `SUM(G${rowNo}:${L}${rowNo})`, result: round2(total) }; t.numFmt = money; t.font = { bold: true };
    return round2(total);
  };
  const act = (f) => (r) => (r.basis === "actual" ? f(r) : null);
  const fut = (f) => (r) => (r.basis === "roster" ? f(r) : null);
  // One block per department that has payroll this month; a single-team employer gets one block called "Payroll".
  const NAMES = { kitchen: "Kitchen", service: "Service", other: "Team" };
  let depts = ["kitchen", "service", "other"].filter((k) => rows.some((r) => r[k].total > 0 || r[k].hours > 0));
  if (!depts.length) depts = ["other"];
  const nameOf = (k) => (depts.length === 1 && k === "other" ? "Payroll" : NAMES[k]);
  s1.getCell("D7").value = "ACTUAL TO DATE (ex on-cost)"; s1.getCell("D7").font = { bold: true, color: { argb: "FF3E4C59" } };
  let n = 8;
  depts.forEach((k, i) => {
    const nm = nameOf(k);
    line(n++, nm, "Casual", act((r) => r[k].casual), { yellow: i === 0 });
    line(n++, nm, "FT&PT", act((r) => r[k].ftpt), { yellow: i === 0 });
    line(n++, nm, `${nm} total`, act((r) => r[k].total), { bold: true });
    line(n++, nm, `${nm} in on-cost (casual +${oncost.casualPct}%, FT&PT +${oncost.permanentPct}%)`, act((r) => withOncost(r[k], oncost)));
    line(n++, nm, `${nm} hours`, act((r) => r[k].hours));
    n++;
  });
  s1.getCell(n, 4).value = "ROSTERED AHEAD (not worked yet, ex on-cost)"; s1.getCell(n, 4).font = { bold: true, color: { argb: "FF3E4C59" } }; n++;
  depts.forEach((k) => {
    const nm = nameOf(k);
    line(n++, nm, "Casual", fut((r) => r[k].casual));
    line(n++, nm, "FT&PT", fut((r) => r[k].ftpt));
    line(n++, nm, `${nm} total`, fut((r) => r[k].total), { bold: true });
  });
  n++;
  s1.getCell(n, 4).value = "Salaried staff are posted on the days they are rostered (weekly salary ÷ rostered days). Super is inside the on-cost %, never a wage line.";
  s1.getCell(n, 4).font = { italic: true, color: { argb: "FF6B655D" } };

  // ---- Sheet 2: one line per day ----
  const s2 = wb.addWorksheet("Daily", { views: [{ state: "frozen", ySplit: 1 }] });
  const cols = [["Date", 12], ["Day", 11], ["Basis", 9], ...depts.flatMap((k) => [[`${nameOf(k)} casual`, 15], [`${nameOf(k)} FT&PT`, 15]]),
    ["Total wages (ex on-cost)", 22], ["Total in on-cost", 16], ["Hours", 10], ["Revenue", 14], ["Revenue is", 11], ["Payroll % of revenue", 19]];
  s2.columns = cols.map(([header, width]) => ({ header, width }));
  s2.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; s2.getRow(1).fill = head;
  const base = 3 + depts.length * 2;
  for (const r of rows) {
    const ex = round2(depts.reduce((t, k) => t + r[k].total, 0)), inc = round2(depts.reduce((t, k) => t + withOncost(r[k], oncost), 0)), hours = round2(depts.reduce((t, k) => t + r[k].hours, 0));
    const x = s2.addRow([new Date(r.date + "T00:00:00Z"), DAY[dow(r.date)], r.basis === "actual" ? "Actual" : "Roster", ...depts.flatMap((k) => [r[k].casual, r[k].ftpt]), ex, inc, hours,
      r.revenue, r.revenueKind ? (r.revenueKind === "actual" ? "Actual" : "Forecast") : null, r.revenue > 0 ? inc / r.revenue : null]);
    x.getCell(1).numFmt = "d-mmm-yy"; for (let c = 4; c <= base + 2; c++) x.getCell(c).numFmt = money; x.getCell(base + 4).numFmt = money; x.getCell(base + 6).numFmt = "0.0%";
  }

  // ---- Sheet 3: one line per person ----
  const s3 = wb.addWorksheet("By person", { views: [{ state: "frozen", xSplit: 4, ySplit: 1 }] });
  s3.columns = [{ header: "Name", width: 26 }, { header: "Department", width: 12 }, { header: "Class", width: 10 }, { header: "Type", width: 11 },
    { header: "Month total", width: 13 }, { header: "Hours", width: 9 }, ...rows.map((r) => ({ header: shortDate(r.date), width: 11 }))];
  s3.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; s3.getRow(1).fill = head;
  for (const p of collected.people) {
    const x = s3.addRow([p.name, p.department, p.cls === "casual" ? "Casual" : "FT&PT", p.typeLabel, p.total, p.hours, ...rows.map((r) => p.byDate[r.date] || null)]);
    x.getCell(5).numFmt = money; for (let i = 0; i < rows.length; i++) x.getCell(7 + i).numFmt = money;
  }
  return wb;
}

// ---------------------------------------------------------------------------
// IN: finance → Crewline
// ---------------------------------------------------------------------------

function cellVal(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return cellVal(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return v.text;
    if ("error" in v) return null;
    return null;
  }
  return v;
}
const numOf = (v) => { const x = cellVal(v); return typeof x === "number" && isFinite(x) ? x : null; };
const strOf = (v) => { const x = cellVal(v); return typeof x === "string" ? x.trim() : ""; };
function dateOf(v) {
  const x = cellVal(v);
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  if (typeof x === "number" && x > 40000 && x < 60000) return new Date(Date.UTC(1899, 11, 30) + Math.round(x) * 86400000).toISOString().slice(0, 10);
  return null;
}

async function readSheets(buffer, wanted) {
  const out = {};
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buffer]), { sharedStrings: "cache", worksheets: "emit", hyperlinks: "ignore", styles: "ignore", entries: "emit" });
  for await (const ws of reader) {
    const name = String(ws.name || "").trim();
    const keep = wanted.includes(name.toLowerCase());
    const rows = [];
    for await (const row of ws) { if (keep && rows.length < 400) rows.push({ n: row.number, v: row.values }); }
    if (keep) out[name.toLowerCase()] = rows;
  }
  return out;
}

const SUB_REV = { food: "food", beverage: "bev", "f&b other income": "other" };

/**
 * Read finance's "F&B Daily Payroll" workbook.
 * @param {Buffer} buffer the .xlsx file
 * @returns {Promise<{ok:true, venue, month, through, daysElapsed, daysInMonth, oncost, outlets, days, mtd}|{ok:false,error}>}
 */
async function parseFinanceWorkbook(buffer) {
  let sheets;
  try { sheets = await readSheets(buffer, ["input sheet", "report", "index"]); }
  catch (e) { return { ok: false, error: "That file isn't an Excel workbook Crewline can read (.xlsx)." }; }
  const input = sheets["input sheet"];
  if (!input) return { ok: false, error: "No sheet called \"Input Sheet\" in that workbook. Send the F&B Daily Payroll file from finance." };

  // 1. The row of dates: at least 20 dates in a row, first one in column G or later.
  let dateCols = null, venue = "";
  for (const r of input) {
    const cols = {};
    for (let c = 5; c < r.v.length; c++) { const d = dateOf(r.v[c]); if (d) cols[c] = d; }
    if (Object.keys(cols).length >= 20) { dateCols = cols; break; }
    if (!venue) venue = strOf(r.v[4]) || strOf(r.v[1]);
  }
  if (!dateCols) return { ok: false, error: "Couldn't find the row of dates on the Input Sheet." };
  const colList = Object.keys(dateCols).map(Number).sort((a, b) => a - b);
  const month = dateCols[colList[0]].slice(0, 7);

  // 2. Walk the labels in column D.
  const lines = {}; // key → { date: value }
  const outlets = [];
  let section = null, outlet = null, dept = null, afterTotals = false;
  const put = (key, r) => { const o = (lines[key] = lines[key] || {}); for (const c of colList) { const v = numOf(r.v[c]); if (v != null) o[dateCols[c]] = v; } };
  for (const r of input) {
    const label = strOf(r.v[4]); if (!label) continue;
    const low = label.toLowerCase();
    if (/^f&b revenue/.test(low)) { section = "rev"; outlet = null; afterTotals = false; continue; }
    if (/payroll\s*\(ex oncost\)/.test(low)) { section = "ex"; outlet = null; dept = null; afterTotals = false; continue; }
    if (/payroll\s*\(inc? oncost\).*\$/.test(low)) { section = "inc"; outlet = null; dept = null; afterTotals = false; continue; }
    if (/payroll\s*\(inc? oncost\).*%/.test(low)) { section = null; continue; }
    if (!section) continue;
    if (/^total /.test(low)) { put(`${section}|_total|${low.replace(/^total /, "")}`, r); if (/total f&b/.test(low)) afterTotals = true; continue; }
    if (section === "rev") {
      if (SUB_REV[low]) { if (outlet) put(`rev|${outlet}|${SUB_REV[low]}`, r); continue; }
      if (afterTotals) continue;
      outlet = label; if (!outlets.includes(label)) outlets.push(label); put(`rev|${outlet}|_all`, r); continue;
    }
    if (low === "service" || low === "kitchen") { dept = low; if (afterTotals) outlet = "_all"; continue; }
    if (low === "casual" || low === "ft&pt") { if (outlet && dept) put(`${section}|${outlet}|${dept}|${low === "casual" ? "casual" : "ftpt"}`, r); continue; }
    if (afterTotals) { outlet = null; dept = null; continue; } // the allocation table under the totals
    outlet = label; dept = null;
  }
  const at = (key, d) => (lines[key] && lines[key][d]) || 0;
  const sumOutlets = (section, dp, type, d) => outlets.reduce((t, o) => t + at(`${section}|${o}|${dp}|${type}`, d), 0);

  const dates = colList.map((c) => dateCols[c]).filter((d) => d.slice(0, 7) === month);
  const all = dates.map((d) => {
    const byOutlet = {}; for (const o of outlets) byOutlet[o] = round2(at(`rev|${o}|_all`, d));
    const revenue = round2(lines["rev|_total|f&b revenue"] ? at("rev|_total|f&b revenue", d) : Object.values(byOutlet).reduce((t, v) => t + v, 0));
    const hasAll = lines["ex|_all|kitchen|casual"] || lines["ex|_all|kitchen|ftpt"];
    const kitchenEx = hasAll ? { casual: round2(at("ex|_all|kitchen|casual", d)), ftpt: round2(at("ex|_all|kitchen|ftpt", d)) }
      : { casual: round2(sumOutlets("ex", "kitchen", "casual", d)), ftpt: round2(sumOutlets("ex", "kitchen", "ftpt", d)) };
    const serviceEx = { casual: round2(sumOutlets("ex", "service", "casual", d)), ftpt: round2(sumOutlets("ex", "service", "ftpt", d)) };
    const kitchenInc = round2(lines["inc|_total|kitchen"] ? at("inc|_total|kitchen", d) : sumOutlets("inc", "kitchen", "casual", d) + sumOutlets("inc", "kitchen", "ftpt", d));
    const serviceInc = round2(lines["inc|_total|service"] ? at("inc|_total|service", d) : sumOutlets("inc", "service", "casual", d) + sumOutlets("inc", "service", "ftpt", d));
    return { date: d, revenue, food: round2(at("rev|_total|food", d)), bev: round2(at("rev|_total|beverage", d)), other: round2(at("rev|_total|f&b other income", d)), outlets: byOutlet, kitchenEx, serviceEx, kitchenInc, serviceInc };
  });
  // Days that have happened: everything up to the last day with revenue or payroll.
  let last = -1;
  all.forEach((d, i) => { if (d.revenue > 0 || d.kitchenInc > 0 || d.serviceInc > 0) last = i; });
  if (last < 0) return { ok: false, error: "The Input Sheet has no revenue or payroll filled in yet." };
  const days = all.slice(0, last + 1);

  // 3. Index: on-cost loadings.
  const oncost = {};
  for (const r of sheets.index || []) {
    const k = strOf(r.v[1]).toLowerCase(), v = numOf(r.v[2]);
    if (v == null) continue;
    if (k === "casual") oncost.casualPct = round2((v > 1 ? v - 1 : v) * 100);
    if (k === "pt/ft" || k === "ft/pt" || k === "ft&pt") oncost.permanentPct = round2((v > 1 ? v - 1 : v) * 100);
  }

  // 4. Report: month to date against budget.
  const mtd = parseReportSheet(sheets.report || []);
  const sum = (f) => round2(days.reduce((t, d) => t + f(d), 0));
  const totals = { revenue: sum((d) => d.revenue), kitchenInc: sum((d) => d.kitchenInc), serviceInc: sum((d) => d.serviceInc), kitchenEx: sum((d) => d.kitchenEx.casual + d.kitchenEx.ftpt) };
  return { ok: true, venue: mtd.venue || venue || "", month, through: days[days.length - 1].date, daysElapsed: mtd.daysElapsed || days.length, daysInMonth: mtd.daysInMonth || monthDates(month).length,
    oncost, outlets, days, totals, mtd: mtd.lines };
}

/** The "Report" sheet: label in A, MTD in B, Budget in C. */
function parseReportSheet(rows) {
  const out = { venue: "", daysElapsed: null, daysInMonth: null, lines: { revenue: { outlets: [] }, payroll: { outlets: [] }, pct: {} } };
  let section = null, cur = null;
  const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000; // 4dp, so a variance rounds the way finance's sheet shows it
  const pair = (r) => ({ actual: r4(numOf(r.v[2])), budget: r4(numOf(r.v[3])) });
  const pct = (r) => ({ actual: round1((numOf(r.v[2]) || 0) * 100), budget: round1((numOf(r.v[3]) || 0) * 100) });
  for (const r of rows) {
    const label = strOf(r.v[1]); if (!label) continue;
    const low = label.toLowerCase();
    if (r.n === 1) { out.venue = label; continue; }
    if (low === "days") { out.daysElapsed = numOf(r.v[2]); continue; }
    if (low === "days in a month") { out.daysInMonth = numOf(r.v[2]); continue; }
    if (/^f&b revenue/.test(low)) { section = "revenue"; cur = null; continue; }
    if (/payroll.*-\s*\$/.test(low)) { section = "payroll"; cur = null; continue; }
    if (/payroll.*-\s*%/.test(low)) { section = "pct"; cur = null; continue; }
    if (!section) continue;
    const L = out.lines[section];
    if (/^total /.test(low)) {
      const k = low.replace(/^total /, "").replace("f&b revenue", "total").replace("f&b payroll", "total").replace("f&b other income", "other").replace("beverage", "bev");
      L[k] = section === "pct" ? pct(r) : pair(r); continue;
    }
    if (section === "pct") { if (cur == null) cur = label; if (!["service", "kitchen"].includes(low)) cur = label; continue; }
    if (section === "revenue" && SUB_REV[low]) { if (cur) cur[SUB_REV[low]] = pair(r); continue; }
    if (section === "payroll" && (low === "service" || low === "kitchen")) { if (cur) cur[low] = pair(r); continue; }
    cur = { name: label, ...pair(r) }; L.outlets.push(cur);
  }
  return out;
}

/** What gets stored (small: one doc per month). */
function toStored(parsed, meta = {}) {
  return { month: parsed.month, venue: parsed.venue, through: parsed.through, daysElapsed: parsed.daysElapsed, daysInMonth: parsed.daysInMonth, oncost: parsed.oncost,
    outlets: parsed.outlets, days: parsed.days, totals: parsed.totals, mtd: parsed.mtd, fileName: meta.fileName || null, importedAt: meta.importedAt || new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// The report (animated at /report, printable at /report/print)
// ---------------------------------------------------------------------------

const money0 = (n) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-AU");
const HOSTS = ["chef", "server", "team", "site"];
const FOCUS = { kitchen: "Kitchen payroll", service: "Service payroll", all: "Payroll" };
const DEPT_LABEL = { kitchen: "Kitchen", service: "Service", other: "Team" };

/**
 * Numbers for the month-to-date report. It reports the payroll this venue runs in
 * Crewline: one department if that's all there is ("Kitchen payroll"), otherwise
 * all payroll. Where a finance month has been loaded its revenue, payroll and
 * budget lines are used; otherwise Crewline's own payroll and revenue.
 * Payroll is always in on-cost.
 * @param {object} o { venue, month, today, collected, oncost, targets:{kitchenPct,totalPct}, finance, host }
 */
function buildReport(o) {
  const { venue, month, today, collected, oncost = {}, targets = {}, finance = null } = o;
  const crew = new Map(collected.rows.map((r) => [r.date, r]));
  const useFin = Boolean(finance && finance.days && finance.days.length);
  const used = new Set((collected.people || []).map((p) => p.department));
  const focus = used.size === 1 && used.has("kitchen") ? "kitchen" : used.size === 1 && used.has("service") ? "service" : "all";
  const label = FOCUS[focus];
  const through = useFin ? finance.through : (() => { const past = collected.rows.filter((r) => r.date < today); return past.length ? past[past.length - 1].date : null; })();
  const dates = monthDates(month).filter((d) => through && d <= through);
  const finBy = new Map(((finance && finance.days) || []).map((d) => [d.date, d]));
  const M = (useFin && finance.mtd) || {};
  const finKey = focus === "all" ? "total" : focus;
  const tk = Number(targets.kitchenPct) || 0, tt = Number(targets.totalPct) || 0;
  const targetFor = (k) => (k === "kitchen" ? tk : k === "service" ? Math.max(0, tt - tk) : tt) || null;
  const budgetPct = M.pct && M.pct[finKey] ? M.pct[finKey].budget : targetFor(focus);
  const own = (c, k) => (k === "all" ? withOncost(c.kitchen, oncost) + withOncost(c.service, oncost) + withOncost(c.other, oncost) : withOncost(c[k], oncost));

  const days = dates.map((d) => {
    const c = crew.get(d), f = finBy.get(d);
    const revenue = f ? f.revenue : (c && c.revenue != null ? c.revenue : null);
    const payroll = round2(f ? (focus === "kitchen" ? f.kitchenInc : focus === "service" ? f.serviceInc : (f.kitchenInc || 0) + (f.serviceInc || 0)) : c ? own(c, focus) : 0);
    return { date: d, label: shortDate(d), revenue, revenueKind: f ? "actual" : (c && c.revenueKind) || null, payroll, pct: revenue > 0 ? round1((payroll / revenue) * 100) : null };
  });
  const sum = (k) => round2(days.reduce((t, d) => t + (d[k] || 0), 0));
  const revenue = M.revenue && M.revenue.total ? M.revenue.total.actual : sum("revenue");
  const revBudget = M.revenue && M.revenue.total ? M.revenue.total.budget : null;
  const payroll = M.payroll && M.payroll[finKey] ? M.payroll[finKey].actual : sum("payroll");
  const payBudget = M.payroll && M.payroll[finKey] ? M.payroll[finKey].budget : (budgetPct && revenue ? round2(revenue * budgetPct / 100) : null);
  const pct = revenue > 0 ? round1((payroll / revenue) * 100) : null;
  const statusOf = (p, b) => (p == null || b == null ? "none" : p <= b ? "ok" : p <= b * 1.1 ? "warn" : "over");
  const status = statusOf(pct, budgetPct);
  const mtd = {
    revenue: { actual: revenue, budget: revBudget, variance: revBudget != null ? revenue - revBudget : null },
    payroll: { label, actual: payroll, budget: payBudget, variance: payBudget != null ? payroll - payBudget : null, pct, budgetPct, status },
  };

  // Payroll by department, for the table.
  let departments = [];
  if (M.payroll) {
    for (const [k, name] of [["kitchen", "Kitchen"], ["service", "Service"], ["total", "Total payroll"]]) {
      const x = M.payroll[k]; if (!x) continue;
      const p = M.pct && M.pct[k] ? M.pct[k] : null;
      departments.push({ name, total: k === "total", actual: x.actual, budget: x.budget, variance: x.actual - x.budget, pct: p ? p.actual : null, budgetPct: p ? p.budget : null });
    }
  } else {
    const rowsIn = dates.map((d) => crew.get(d)).filter(Boolean);
    for (const k of ["kitchen", "service", "other"]) {
      const actual = round2(rowsIn.reduce((t, c) => t + withOncost(c[k], oncost), 0)); if (!actual) continue;
      const b = k === "other" ? null : targetFor(k);
      const budget = b && revenue ? round2(revenue * b / 100) : null;
      departments.push({ name: DEPT_LABEL[k], total: false, actual, budget, variance: budget != null ? actual - budget : null, pct: revenue > 0 ? round1((actual / revenue) * 100) : null, budgetPct: b });
    }
    if (departments.length > 1) {
      const actual = round2(departments.reduce((t, x) => t + x.actual, 0)), b = targetFor("all"), budget = b && revenue ? round2(revenue * b / 100) : null;
      departments.push({ name: "Total payroll", total: true, actual, budget, variance: budget != null ? actual - budget : null, pct: revenue > 0 ? round1((actual / revenue) * 100) : null, budgetPct: b });
    }
  }
  const outlets = ((M.revenue && M.revenue.outlets) || []).map((x) => ({ name: x.name, actual: x.actual, budget: x.budget, variance: x.actual - x.budget, pctOfBudget: x.budget > 0 ? round1((x.actual / x.budget) * 100) : null }));

  // ---- findings in plain English, strongest first ----
  const insights = [], low = label.toLowerCase();
  if (pct != null && budgetPct != null) {
    insights.push({ key: "headline", tone: status === "ok" ? "good" : "bad", text: `${label} is ${pct}% of revenue against a ${budgetPct}% budget` + (mtd.payroll.variance != null ? `, ${money0(Math.abs(mtd.payroll.variance))} ${mtd.payroll.variance <= 0 ? "under" : "over"}.` : ".") });
  }
  const withRev = days.filter((d) => d.revenue > 0);
  if (withRev.length >= 4) {
    const top = [...withRev].sort((a, b) => b.revenue - a.revenue)[0];
    const rest = withRev.filter((d) => d !== top);
    const restRev = rest.reduce((t, d) => t + d.revenue, 0), restPay = rest.reduce((t, d) => t + d.payroll, 0);
    if (top.revenue > (restRev / rest.length) * 2 && restRev > 0) {
      const without = round1((restPay / restRev) * 100);
      insights.push({ key: "bigday", tone: budgetPct != null && without > budgetPct ? "bad" : "info", without, day: top.date,
        text: `One day carries the period: ${top.label} took ${money0(top.revenue)}. Without it, ${low} is ${without}% of revenue.` });
    }
  }
  if (budgetPct != null && withRev.length) {
    const over = withRev.filter((d) => d.pct > budgetPct).length;
    if (over * 2 >= withRev.length) insights.push({ key: "overdays", tone: "bad", count: over, of: withRev.length, text: `${over} of ${withRev.length} days ran above the ${budgetPct}% budget.` });
    const worst = withRev.filter((d) => d.pct > budgetPct * 1.25).sort((a, b) => b.pct - a.pct).slice(0, 2);
    if (worst.length) insights.push({ key: "worst", tone: "bad", text: `Heaviest ${worst.length === 1 ? "day" : "days"}: ` + worst.map((d) => `${d.label} at ${d.pct}% (${money0(d.payroll)} payroll on ${money0(d.revenue)} revenue)`).join("; ") + "." });
  }
  if (outlets.length) {
    const down = [...outlets].sort((a, b) => a.variance - b.variance)[0], up = [...outlets].sort((a, b) => b.variance - a.variance)[0];
    if (down && down.variance < 0) insights.push({ key: "down", tone: "bad", text: `${down.name} is ${money0(Math.abs(down.variance))} behind its revenue budget (${down.pctOfBudget}% of budget).` });
    if (up && up.variance > 0 && up !== down) insights.push({ key: "up", tone: "good", text: `${up.name} is ${money0(up.variance)} ahead of its revenue budget.` });
  }

  const host = HOSTS.includes(o.host) ? o.host : focus === "kitchen" ? "chef" : focus === "service" ? "server" : "team";
  return { venue: venue || (useFin && finance.venue) || "", month, monthLabel: monthLabel(month), through, daysElapsed: dates.length, daysInMonth: monthDates(month).length,
    rangeLabel: through ? `1–${Number(through.slice(8))} ${MON[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}` : monthLabel(month),
    focus, payrollLabel: label, host, oncost: { casualPct: Number(oncost.casualPct) || 0, permanentPct: Number(oncost.permanentPct) || 0 }, days, mtd, departments, outlets, insights };
}

module.exports = { monthDates, monthLabel, classOf, collectMonth, withOncost, buildWorkbook, parseFinanceWorkbook, parseReportSheet, toStored, buildReport, addDays, HOSTS };
