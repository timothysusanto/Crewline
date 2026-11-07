"use strict";

/**
 * rosterImport.js — turn an Excel / CSV / PDF roster into shifts.
 *
 * The usual rota shape is a grid: names down the side, days across the top,
 * a time range in each cell ("10:00-18:30", "7am-3pm", "OFF"). That is what
 * this reads. It is deliberately forgiving about the details (12/24-hour
 * times, d/m dates, weekday-only headers, wrapped cells) and deliberately
 * strict about guessing: anything it cannot place goes back to the manager
 * as "couldn't read", it never invents a shift.
 *
 * Pure functions + two file readers. Nothing here touches a database.
 */

const DAY_RE = /^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\b/i;
const DAY_IDX = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NOT_WORKING = /^(off|rdo|ro|al|sl|pl|leave|holiday|sick|unavail\w*|n\/a|na|x|-+|—|–)$/i;

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function addDays(dateIso, n) {
  const d = new Date(dateIso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = (dateIso) => new Date(dateIso + "T12:00:00Z").getUTCDay();
function mondayOf(dateIso) { return addDays(dateIso, -((dow(dateIso) + 6) % 7)); }
function nextMonday(fromIso) { const off = (8 - dow(fromIso)) % 7; return addDays(fromIso, off); }

// ---------- times ----------

// One end of a range: "10", "10:30", "10.30", "10h30", or compact 24-hour "0530" / "1336" / "200".
const T = String.raw`(\d{1,2}[:.h]\d{2}|\d{3,4}|\d{1,2})`;
const RANGE_RE = new RegExp(String.raw`(?<![\d:.])${T}\s*(am|pm|a|p)?\s*(?:-|–|—|to|until|till)\s*${T}\s*(am|pm|a|p)?(?![\d:.])`, "gi");

/** "0530" → [5,30]; "10:30" → [10,30]; "9" → [9,0]; null if it isn't a clock time. */
function hm(tok) {
  let h, m = 0;
  if (/[:.h]/i.test(tok)) { [h, m] = tok.split(/[:.h]/i).map(Number); }
  else if (tok.length >= 3) { h = Math.floor(+tok / 100); m = +tok % 100; }
  else h = +tok;
  return h <= 24 && m <= 59 ? [h, m] : null;
}

function to24(h, m, mer) {
  if (mer) { const pm = mer[0].toLowerCase() === "p"; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return h * 60 + m;
}
const hhmm = (mins) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;

/** All time ranges in a piece of text → [{start:"HH:MM", end:"HH:MM"}]; text with the times removed → rest. */
function parseTimes(text) {
  const out = [];
  const rest = String(text || "").replace(RANGE_RE, (_m, t1, mer1, t2, mer2) => {
    const A = hm(t1), B = hm(t2);
    if (!A || !B) return _m;
    const [a, am] = A, [b, bm] = B;
    const compact = /^\d{3,4}$/.test(t1) || /^\d{3,4}$/.test(t2);
    let s, e;
    if (mer1 || mer2) {
      if (mer1) { s = to24(a, am, mer1); e = to24(b, bm, mer2 || mer1); if (!mer2 && e <= s) e += 12 * 60; }
      else {
        e = to24(b, bm, mer2);
        s = to24(a, am, "am");
        if (e - s > 14 * 60 || e <= s) s = to24(a, am, "pm");
      }
    } else {
      s = a * 60 + am; e = b * 60 + bm;
      if (!compact && a <= 12 && b <= 12 && e <= s) e += 12 * 60; // "7-3" → 07:00–15:00
    }
    if (e < s) e += 24 * 60; // overnight stays overnight (end is next day)
    out.push({ start: hhmm(s), end: hhmm(e) });
    return " ";
  });
  return { ranges: out, rest: rest.replace(/[()\[\],;/]+/g, " ").replace(/\s+/g, " ").trim() };
}

// ---------- dates ----------

/** A header cell → { date } or { weekday } or null. `ref` is today's ISO date (to pick a year). */
function parseHeader(text, ref) {
  const t = String(text || "").trim();
  if (!t) return null;
  const refYear = +ref.slice(0, 4);
  const pickYear = (m, d, y) => {
    if (y) return y < 100 ? 2000 + y : y;
    // No year written: use whichever year puts the date closest to today.
    let best = refYear, diff = Infinity;
    for (const yy of [refYear - 1, refYear, refYear + 1]) { const dd = Math.abs(new Date(iso(yy, m, d)) - new Date(ref)); if (dd < diff) { diff = dd; best = yy; } }
    return best;
  };
  let m;
  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return { date: iso(+m[1], +m[2], +m[3]) };
  if ((m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*[-\s/]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s*,?\s*(\d{2,4}))?/i)))
    return { date: iso(pickYear(MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1], m[3] && +m[3]), MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]) };
  if ((m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?\b(?:\s*,?\s*(\d{4}))?/i))) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    return { date: iso(pickYear(mo, +m[2], m[3] && +m[3]), mo, +m[2]) };
  }
  if ((m = t.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/)) && +m[1] <= 31 && +m[2] <= 12) // Australian d/m
    return { date: iso(pickYear(+m[2], +m[1], m[3] && +m[3]), +m[2], +m[1]) };
  if ((m = t.match(DAY_RE))) return { weekday: DAY_IDX[m[1].slice(0, 3).toLowerCase()] };
  return null;
}

// ---------- names ----------

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

/** Match a roster name to a staff record: full name, then a unique first name, then a unique "starts with". */
function matchStaff(label, staff) {
  const n = norm(label);
  if (!n || n.length < 2) return null;
  const list = staff.map((s) => ({ s, n: norm(s.name) }));
  const exact = list.filter((x) => x.n === n);
  if (exact.length === 1) return exact[0].s;
  const first = list.filter((x) => x.n.split(" ")[0] === n.split(" ")[0] && (n.split(" ").length === 1 || x.n.startsWith(n) || n.startsWith(x.n)));
  if (first.length === 1) return first[0].s;
  const loose = list.filter((x) => x.n.startsWith(n) || n.startsWith(x.n));
  if (loose.length === 1) return loose[0].s;
  return null;
}

// ---------- the grid → shifts ----------

/**
 * @param {Array<Array<{text:string,c:number,x0:number,x1:number}>>} rows  cells with positions
 */
function gridToShifts(rows, staff, { ref, weekStart }) {
  // 1. Find the header row: the first row with 3+ day/date cells.
  let hi = -1, heads = [];
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const hs = rows[i].map((c) => ({ c, h: parseHeader(c.text, ref) })).filter((x) => x.h && x.c.text.length <= 24);
    if (hs.length >= 3) { hi = i; heads = hs; break; }
  }
  if (hi < 0) return null;

  // 2. Give every header column a real date. Weekday-only headers count up from weekStart.
  let cursor = null;
  const cols = [];
  for (const { c, h } of heads) {
    let date = h.date;
    if (!date) {
      let d = cursor ? addDays(cursor, 1) : weekStart;
      for (let k = 0; k < 7 && dow(d) !== h.weekday; k++) d = addDays(d, 1);
      date = d;
    }
    cursor = date;
    cols.push({ c: c.c, date });
  }
  const gaps = cols.slice(1).map((x, i) => Math.abs(x.c - cols[i].c)).sort((a, b) => a - b);
  const spacing = gaps.length ? gaps[Math.floor(gaps.length / 2)] || 1 : 1;
  const firstC = Math.min(...cols.map((x) => x.c));
  const colFor = (cell) => {
    let best = null, d = Infinity;
    for (const x of cols) { const dd = Math.abs(x.c - cell.c); if (dd < d) { d = dd; best = x; } }
    return d <= spacing * 0.6 ? best : null;
  };

  // 3. Each row below: a name on the left, times in the day columns.
  const shifts = [], unmatchedMap = new Map(), skipped = [];
  let current = null; // { label, staff }
  for (let i = hi + 1; i < rows.length; i++) {
    const left = rows[i].filter((c) => c.c < firstC - spacing * 0.5).sort((a, b) => a.c - b.c);
    const body = rows[i].filter((c) => c.c >= firstC - spacing * 0.5);
    const cellsWithTimes = body.filter((c) => parseTimes(c.text).ranges.length);
    if (left.length) {
      const labelCells = left.filter((c) => /[a-z]/i.test(c.text));
      const hit = labelCells.map((c) => ({ c, s: matchStaff(c.text, staff) })).find((x) => x.s);
      if (hit) current = { label: hit.c.text.trim(), staff: hit.s };
      else if (labelCells.length && cellsWithTimes.length) current = { label: labelCells[0].text.trim(), staff: null };
      else if (labelCells.length) current = null; // a heading row ("KITCHEN") — nothing to read
    } else if (!cellsWithTimes.length) continue;
    // (no left cell + times = a wrapped continuation of the row above, keep `current`)
    if (!current) continue;

    for (const cell of body) {
      const { ranges, rest } = parseTimes(cell.text);
      if (!ranges.length) {
        const t = cell.text.trim();
        if (t && !NOT_WORKING.test(t) && /\d/.test(t)) skipped.push({ who: current.label, text: t });
        continue;
      }
      const col = colFor(cell);
      if (!col) { skipped.push({ who: current.label, text: cell.text.trim() }); continue; }
      const role = rest && !NOT_WORKING.test(rest) && /^[a-z][a-z .&'-]{1,24}$/i.test(rest) ? rest : null;
      for (const r of ranges) {
        if (!current.staff) { unmatchedMap.set(current.label, (unmatchedMap.get(current.label) || 0) + 1); continue; }
        const mins = (+r.end.slice(0, 2) * 60 + +r.end.slice(3) + (r.end < r.start ? 1440 : 0)) - (+r.start.slice(0, 2) * 60 + +r.start.slice(3));
        shifts.push({
          workerId: String(current.staff.phone), name: current.staff.name, date: col.date,
          start: r.start, end: r.end, role, unpaidBreakMins: mins > 330 ? 30 : 0,
        });
      }
    }
  }
  return { shifts, unmatched: [...unmatchedMap].map(([name, count]) => ({ name, count })), skipped };
}

function transpose(rows) {
  // rows of cells → columns of cells, using the original row index as the new position.
  const byCol = new Map();
  rows.forEach((r, ri) => r.forEach((c) => { const k = Math.round(c.c * 100); (byCol.get(k) || byCol.set(k, []).get(k)).push({ text: c.text, c: ri, x0: ri, x1: ri }); }));
  return [...byCol.keys()].sort((a, b) => a - b).map((k) => byCol.get(k));
}

/** Rows of cells → shifts (tries across-the-top first, then days-down-the-side). */
function parseRows(rows, staff, opts = {}) {
  const ref = opts.today || new Date().toISOString().slice(0, 10);
  const weekStart = opts.weekStart || nextMonday(ref);
  const a = gridToShifts(rows, staff, { ref, weekStart }) || gridToShifts(transpose(rows), staff, { ref, weekStart });
  if (!a) return { ok: false, error: "I couldn't find the days (Mon, Tue… or dates) along the top of the roster." };
  const dates = a.shifts.map((s) => s.date).sort();
  return { ok: true, ...a, from: dates[0] || null, to: dates[dates.length - 1] || null, weekStart: dates[0] ? mondayOf(dates[0]) : weekStart };
}

// ---------- file readers ----------

function csvToRows(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === "," || ch === ";" || ch === "\t") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((t, i) => ({ text: t.trim(), c: i, x0: i, x1: i })).filter((c) => c.text));
  }
  return rows;
}

async function xlsxToRows(buffer) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((w) => w.actualRowCount > 1) || wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      let v = cell.value;
      if (v && typeof v === "object" && !(v instanceof Date)) v = v.result !== undefined ? v.result : v.text !== undefined ? v.text : v.richText ? v.richText.map((r) => r.text).join("") : "";
      let text;
      if (v instanceof Date) {
        // Excel stores a time of day as a date in 1899; a real date is a real date.
        text = v.getUTCFullYear() < 1950 ? `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : v.toISOString().slice(0, 10);
      } else if (typeof v === "number" && v > 0 && v < 1 && /h/.test(String(cell.numFmt || ""))) {
        const m = Math.round(v * 1440); text = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
      } else text = v == null ? "" : String(v);
      text = text.replace(/\s*\n\s*/g, " ").trim();
      if (text) cells.push({ text, c: col, x0: col, x1: col });
    });
    if (cells.length) rows.push(cells);
  });
  return rows;
}

async function pdfToRows(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const rows = [];
  for (let p = 1; p <= Math.min(doc.numPages, 5); p++) {
    const page = await (await doc.getPage(p)).getTextContent();
    const items = page.items.filter((it) => it.str && it.str.trim()).map((it) => ({ t: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 10 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2.5, it.h * 0.35));
      if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
      const cells = [];
      for (const it of line.items) {
        const last = cells[cells.length - 1];
        // Same cell when the gap is smaller than about one space-and-a-bit.
        if (last && it.x - last.x1 <= Math.max(3, it.h * 0.45)) { last.text += (it.x - last.x1 > 0.8 ? " " : "") + it.t; last.x1 = it.x + it.w; }
        else cells.push({ text: it.t, x0: it.x, x1: it.x + it.w });
      }
      rows.push(cells.map((c) => ({ ...c, text: c.text.trim(), c: (c.x0 + c.x1) / 2 })));
    }
  }
  return rows.sort(() => 0); // order is already top-to-bottom per page
}

/** Read a roster file into rows of cells. Throws a friendly Error for formats we can't read. */
async function fileToRows(buffer, filename = "", mime = "") {
  const name = String(filename).toLowerCase(), type = String(mime).toLowerCase();
  if (/\.xlsx$|\.xlsm$/.test(name) || /spreadsheetml/.test(type)) return xlsxToRows(buffer);
  if (/\.csv$|\.tsv$/.test(name) || /csv/.test(type)) return csvToRows(buffer.toString("utf8"));
  if (/\.pdf$/.test(name) || /pdf/.test(type) || buffer.slice(0, 4).toString() === "%PDF") return pdfToRows(buffer);
  if (/\.xls$/.test(name)) throw new Error("That's an old .xls file. Open it and Save As .xlsx (or send a PDF), then send it again.");
  if (buffer.slice(0, 2).toString() === "PK") return xlsxToRows(buffer);
  throw new Error("I can read Excel (.xlsx), CSV and PDF rosters.");
}

/** File + staff list → preview. */
async function importRoster(buffer, { filename, mime, staff, weekStart, today }) {
  let rows;
  try { rows = await fileToRows(buffer, filename, mime); }
  catch (e) { return { ok: false, error: e.message || "I couldn't open that file." }; }
  if (!rows.length) return { ok: false, error: "That file looks empty." };
  const r = parseRows(rows, staff, { weekStart, today });
  if (r.ok && !r.shifts.length && !r.unmatched.length) return { ok: false, error: "I found the days but no shift times (like 10:00-18:30 or 7am-3pm) under them." };
  return r;
}

/**
 * Save previewed shifts as DRAFTS (the crew see nothing until the roster is
 * published). Shifts already on the roster for the same person, day and times
 * are skipped, so sending the same file twice does no harm.
 */
async function commitShifts({ rosterStore, tenantId, shifts, actor = "import" }) {
  if (!shifts.length) return { added: 0, skipped: 0 };
  const dates = shifts.map((s) => s.date).sort();
  const existing = await rosterStore.listByRange(tenantId, dates[0], dates[dates.length - 1]);
  const key = (s) => `${s.workerId}|${s.date}|${s.start}|${s.end}`;
  const have = new Set(existing.map(key));
  let added = 0, skipped = 0;
  const at = new Date().toISOString();
  for (const s of shifts) {
    if (have.has(key(s))) { skipped++; continue; }
    have.add(key(s));
    await rosterStore.addShift({
      tenantId, workerId: s.workerId, date: s.date, start: s.start, end: s.end,
      unpaidBreakMins: s.unpaidBreakMins || 0, role: s.role || null, published: false,
      createdAt: at, updatedAt: at, audit: [{ at, action: "imported", by: actor, guardWarnings: [] }],
    });
    added++;
  }
  return { added, skipped };
}

module.exports = { parseTimes, parseHeader, matchStaff, parseRows, importRoster, commitShifts, fileToRows, mondayOf, nextMonday };
