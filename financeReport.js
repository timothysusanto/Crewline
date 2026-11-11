"use strict";

/**
 * financeReport.js — the bridge between Crewline and a hotel finance team's
 * daily payroll workbook ("F&B Daily Payroll").
 *
 *  OUT  collectMonth() + buildWorkbook(): one Excel file for a calendar month with
 *       payroll per day split Casual / FT&PT, wages only (ex on-cost). Those are the
 *       two rows finance types by hand into their Input Sheet, laid out the same
 *       way (one column per day, the 1st of the month in column G) so it is one
 *       copy and one paste.
 *
 *  IN   parseFinanceWorkbook(): reads finance's own workbook (sheets "Input Sheet",
 *       "Report", "Index") and returns actual revenue per day by outlet, their
 *       payroll actuals and the month-to-date budget lines.
 *
 *  buildReport(): the numbers behind the animated report page (/report).
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
 * The Excel file finance downloads. Sheet 1 mirrors their Input Sheet (day columns
 * start at G), sheet 2 is one line per day, sheet 3 one line per person.
 * @param {object} o { venue, month, collected, oncost:{casualPct,permanentPct}, finance (optional parsed/stored finance month), generatedAt }
 */
function buildWorkbook(o) {
  const { venue, month, collected, oncost = {}, finance = null } = o;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Crewline"; wb.created = new Date(o.generatedAt || Date.now());
  const rows = collected.rows, FIRST = 7; // column G, as in the finance Input Sheet
  const hasService = rows.some((r) => r.service.total > 0);
  const money = '#,##0.00;[Red]-#,##0.00;"-"';
  const yellow = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2B3" } };
  const head = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3E4C59" } };
  const lastCol = FIRST + rows.length - 1, L = colLetter(lastCol);
  const actualDays = rows.filter((r) => r.basis === "actual");
  const lastActualCol = actualDays.length ? colLetter(FIRST + actualDays.length - 1) : null;

  // ---- Sheet 1: paste block ----
  const s1 = wb.addWorksheet("For Input Sheet", { views: [{ state: "frozen", xSplit: 6, ySplit: 6 }] });
  s1.getColumn(4).width = 34; s1.getColumn(5).width = 14; s1.getColumn(1).width = 3; s1.getColumn(2).width = 3; s1.getColumn(3).width = 10; s1.getColumn(6).width = 3;
  for (let i = 0; i < rows.length; i++) s1.getColumn(FIRST + i).width = 12;
  s1.getCell("D1").value = `${venue || "Venue"} — payroll by day for finance — ${monthLabel(month)}`; s1.getCell("D1").font = { bold: true, size: 14 };
  s1.getCell("D2").value = "From Crewline. Wages only (ex on-cost): the same basis as the Casual and FT&PT rows on the Input Sheet of the F&B Daily Payroll workbook.";
  s1.getCell("D3").value = lastActualCol
    ? `HOW TO USE: copy the yellow cells (G8 to ${lastActualCol}9), then Paste Special > Values on the Input Sheet, starting at the Kitchen > Casual cell for the 1st of the month (G98).`
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
  s1.getCell("D7").value = "ACTUAL TO DATE (ex on-cost)"; s1.getCell("D7").font = { bold: true, color: { argb: "FF3E4C59" } };
  line(8, "Kitchen", "Casual", act((r) => r.kitchen.casual), { yellow: true });
  line(9, "Kitchen", "FT&PT", act((r) => r.kitchen.ftpt), { yellow: true });
  line(10, "Kitchen", "Kitchen total", act((r) => r.kitchen.total), { bold: true });
  line(11, "Kitchen", `Kitchen in on-cost (casual +${oncost.casualPct}%, FT&PT +${oncost.permanentPct}%)`, act((r) => withOncost(r.kitchen, oncost)));
  line(12, "Kitchen", "Kitchen hours", act((r) => r.kitchen.hours));
  let n = 14;
  if (hasService) {
    line(n++, "Service", "Casual (all outlets)", act((r) => r.service.casual));
    line(n++, "Service", "FT&PT (all outlets)", act((r) => r.service.ftpt));
    line(n++, "Service", "Service total", act((r) => r.service.total), { bold: true });
    n++;
  }
  s1.getCell(n, 4).value = "ROSTERED AHEAD (not worked yet, ex on-cost)"; s1.getCell(n, 4).font = { bold: true, color: { argb: "FF3E4C59" } }; n++;
  line(n++, "Kitchen", "Casual", fut((r) => r.kitchen.casual));
  line(n++, "Kitchen", "FT&PT", fut((r) => r.kitchen.ftpt));
  line(n++, "Kitchen", "Kitchen total", fut((r) => r.kitchen.total), { bold: true });
  n++;
  s1.getCell(n, 4).value = "Salaried staff are posted on the days they are rostered (weekly salary ÷ rostered days). Super is inside the on-cost %, never a wage line.";
  s1.getCell(n, 4).font = { italic: true, color: { argb: "FF6B655D" } };

  // ---- Sheet 2: one line per day ----
  const s2 = wb.addWorksheet("Daily", { views: [{ state: "frozen", ySplit: 1 }] });
  const fin = new Map(((finance && finance.days) || []).map((d) => [d.date, d]));
  const cols = [["Date", 12], ["Day", 11], ["Basis", 9], ["Kitchen casual", 15], ["Kitchen FT&PT", 15], ["Kitchen total (ex on-cost)", 22], ["Kitchen in on-cost", 18], ["Kitchen hours", 13],
    ["F&B revenue", 14], ["Revenue is", 11], ["Kitchen % of revenue", 19], ["Finance: kitchen (ex on-cost)", 26], ["Crewline minus finance", 21]];
  s2.columns = cols.map(([header, width]) => ({ header, width }));
  s2.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; s2.getRow(1).fill = head;
  for (const r of rows) {
    const f = fin.get(r.date); const inc = withOncost(r.kitchen, oncost);
    const finEx = f && f.kitchenEx ? round2((f.kitchenEx.casual || 0) + (f.kitchenEx.ftpt || 0)) : null;
    const x = s2.addRow([new Date(r.date + "T00:00:00Z"), DAY[dow(r.date)], r.basis === "actual" ? "Actual" : "Roster", r.kitchen.casual, r.kitchen.ftpt, r.kitchen.total, inc, r.kitchen.hours,
      r.revenue, r.revenueKind ? (r.revenueKind === "actual" ? "Actual" : "Forecast") : null, r.revenue > 0 ? inc / r.revenue : null, finEx, finEx != null ? round2(r.kitchen.total - finEx) : null]);
    x.getCell(1).numFmt = "d-mmm-yy"; for (const c of [4, 5, 6, 7, 9, 12, 13]) x.getCell(c).numFmt = money; x.getCell(11).numFmt = "0.0%";
  }

  // ---- Sheet 3: one line per person ----
  const s3 = wb.addWorksheet("By person", { views: [{ state: "frozen", xSplit: 4, ySplit: 1 }] });
  s3.columns = [{ header: "Name", width: 26 }, { header: "Department", width: 12 }, { header: "Finance class", width: 13 }, { header: "Type", width: 11 },
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
// The animated report
// ---------------------------------------------------------------------------

const money0 = (n) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-AU");

/**
 * Numbers for /report. With a finance month imported, finance's figures lead
 * (they are the official ones) and Crewline's roster cost sits beside them.
 * Without one, it runs on Crewline's own payroll and revenue.
 * @param {object} o { venue, month, today, collected, oncost, targets:{kitchenPct,totalPct}, finance }
 */
function buildReport(o) {
  const { venue, month, today, collected, oncost = {}, targets = {}, finance = null } = o;
  const crew = new Map(collected.rows.map((r) => [r.date, r]));
  const useFin = Boolean(finance && finance.days && finance.days.length);
  const through = useFin ? finance.through : (() => { const past = collected.rows.filter((r) => r.date < today); return past.length ? past[past.length - 1].date : null; })();
  const dates = monthDates(month).filter((d) => through && d <= through);
  const finBy = new Map(((finance && finance.days) || []).map((d) => [d.date, d]));
  const budgetPct = useFin && finance.mtd && finance.mtd.pct && finance.mtd.pct.kitchen ? finance.mtd.pct.kitchen.budget : (Number(targets.kitchenPct) || null);

  const days = dates.map((d) => {
    const c = crew.get(d), f = finBy.get(d);
    const crewline = c ? withOncost(c.kitchen, oncost) : 0;
    const revenue = f ? f.revenue : (c && c.revenue != null ? c.revenue : null);
    const kitchen = f ? f.kitchenInc : crewline;
    return { date: d, label: shortDate(d), dow: dow(d), revenue, revenueKind: f ? "actual" : (c && c.revenueKind) || null, kitchen: round2(kitchen), crewline: round2(crewline), crewlineHours: c ? c.kitchen.hours : 0,
      pct: revenue > 0 ? round1((kitchen / revenue) * 100) : null, outlets: f ? f.outlets : null };
  });
  const sum = (k) => round2(days.reduce((t, d) => t + (d[k] || 0), 0));
  const M = (useFin && finance.mtd) || {};
  // Finance's own month-to-date lines win where they exist (their sheet is the official figure).
  const revenue = M.revenue && M.revenue.total ? M.revenue.total.actual : sum("revenue");
  const kitchen = M.payroll && M.payroll.kitchen ? M.payroll.kitchen.actual : sum("kitchen");
  // Crewline against finance: only days Crewline has a roster or clock-ins for.
  const both = useFin ? days.filter((d) => d.crewlineHours > 0) : [];
  const crewline = round2(both.reduce((t, d) => t + d.crewline, 0)), finSame = round2(both.reduce((t, d) => t + d.kitchen, 0));
  const revBudget = M.revenue && M.revenue.total ? M.revenue.total.budget : null;
  const kitBudget = M.payroll && M.payroll.kitchen ? M.payroll.kitchen.budget : (budgetPct && revenue ? round2(revenue * budgetPct / 100) : null);
  const pct = revenue > 0 ? round1((kitchen / revenue) * 100) : null;
  const status = pct == null || budgetPct == null ? "none" : pct <= budgetPct ? "ok" : pct <= budgetPct * 1.1 ? "warn" : "over";

  const mtd = {
    revenue: { actual: revenue, budget: revBudget, variance: revBudget != null ? revenue - revBudget : null },
    kitchen: { actual: kitchen, budget: kitBudget, variance: kitBudget != null ? kitchen - kitBudget : null, pct, budgetPct, status },
    service: M.payroll && M.payroll.service ? { ...M.payroll.service, variance: M.payroll.service.actual - M.payroll.service.budget, pct: M.pct && M.pct.service ? M.pct.service.actual : null, budgetPct: M.pct && M.pct.service ? M.pct.service.budget : null } : null,
    total: M.payroll && M.payroll.total ? { ...M.payroll.total, variance: M.payroll.total.actual - M.payroll.total.budget, pct: M.pct && M.pct.total ? M.pct.total.actual : null, budgetPct: M.pct && M.pct.total ? M.pct.total.budget : null } : null,
    crewline: both.length ? { kitchen: crewline, finance: finSame, days: both.length, variance: round2(crewline - finSame) } : null,
  };
  const outlets = ((M.revenue && M.revenue.outlets) || []).map((x) => ({ name: x.name, actual: x.actual, budget: x.budget, variance: x.actual - x.budget, pctOfBudget: x.budget > 0 ? round1((x.actual / x.budget) * 100) : null }));

  // ---- plain-English findings, strongest first ----
  const insights = [];
  if (pct != null && budgetPct != null) {
    insights.push({ tone: status === "ok" ? "good" : "bad", text: `Kitchen payroll is ${pct}% of F&B revenue against a ${budgetPct}% budget` + (mtd.kitchen.variance != null ? `: ${money0(Math.abs(mtd.kitchen.variance))} ${mtd.kitchen.variance <= 0 ? "under" : "over"}.` : ".") });
  }
  const withRev = days.filter((d) => d.revenue > 0);
  if (withRev.length >= 4) {
    const top = [...withRev].sort((a, b) => b.revenue - a.revenue)[0];
    const rest = withRev.filter((d) => d !== top);
    const restRev = rest.reduce((t, d) => t + d.revenue, 0), restKit = rest.reduce((t, d) => t + d.kitchen, 0);
    const avg = restRev / rest.length;
    if (top.revenue > avg * 2 && restRev > 0) {
      const without = round1((restKit / restRev) * 100);
      insights.push({ tone: budgetPct != null && without > budgetPct ? "bad" : "info", key: "bigday", without, day: top.date,
        text: `One day carries the month: ${top.label} took ${money0(top.revenue)}. Without it, kitchen payroll is ${without}% of revenue.` });
    }
  }
  if (budgetPct != null) {
    const worst = days.filter((d) => d.pct != null && d.pct > budgetPct * 1.25).sort((a, b) => b.pct - a.pct).slice(0, 2);
    if (worst.length) insights.push({ tone: "bad", text: `Heaviest ${worst.length === 1 ? "day" : "days"}: ` + worst.map((d) => `${d.label} at ${d.pct}% (${money0(d.kitchen)} payroll on ${money0(d.revenue)} revenue)`).join("; ") + "." });
  }
  if (outlets.length) {
    const down = [...outlets].sort((a, b) => a.variance - b.variance)[0], up = [...outlets].sort((a, b) => b.variance - a.variance)[0];
    if (down && down.variance < 0) insights.push({ tone: "bad", text: `${down.name} is ${money0(Math.abs(down.variance))} behind its revenue budget (${down.pctOfBudget}% of budget).` });
  }
  if (mtd.crewline && finSame > 0 && crewline > 0) {
    const diff = mtd.crewline.variance, p = round1((diff / finSame) * 100);
    const span = both.length === days.length ? "the same days" : `the ${both.length} days Crewline has a roster for`;
    insights.push({ tone: "info", key: "crewline", text: `Crewline costs the roster at ${money0(crewline)} for ${span}; finance has ${money0(finSame)}. Crewline is ${money0(Math.abs(diff))} ${diff < 0 ? "lower" : "higher"} (${Math.abs(p)}%).` });
  }
  if (outlets.length) {
    const down = [...outlets].sort((a, b) => a.variance - b.variance)[0], up = [...outlets].sort((a, b) => b.variance - a.variance)[0];
    if (up && up.variance > 0 && up !== down) insights.push({ tone: "good", text: `${up.name} is ${money0(up.variance)} ahead of budget.` });
  }

  return { venue: (useFin && finance.venue) || venue || "", month, monthLabel: monthLabel(month), through, daysElapsed: dates.length, daysInMonth: monthDates(month).length,
    rangeLabel: through ? `1–${Number(through.slice(8))} ${MON[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}` : monthLabel(month),
    source: useFin ? { kind: "finance", fileName: finance.fileName || null, importedAt: finance.importedAt || null } : { kind: "crewline" },
    oncost: { casualPct: Number(oncost.casualPct) || 0, permanentPct: Number(oncost.permanentPct) || 0 }, days, mtd, outlets, insights };
}

module.exports = { monthDates, monthLabel, classOf, collectMonth, withOncost, buildWorkbook, parseFinanceWorkbook, parseReportSheet, toStored, buildReport, addDays };
