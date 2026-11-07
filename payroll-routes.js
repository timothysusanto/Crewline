"use strict";

/**
 * payroll-routes.js — the Pay page's API. Mounted at /api/pay behind
 * requireDashboardKey (req.tenantId is set).
 *
 *   GET  /api/pay/week?start=YYYY-MM-DD      the week: budget, by day, by person, 152h cycle
 *   POST /api/pay/week/:start/revenue        { forecast?:{date:$}, actual?:{date:$}, weekTotal?:$ }
 *   GET  /api/pay/settings                   targets, week start, timezone, cycle, public holidays
 *   POST /api/pay/settings
 *   GET  /api/pay/export.csv?start=YYYY-MM-DD the pay run, one line per person per day
 *
 * Storage:
 *   tenants/{t}.payroll                      settings (on the tenant doc)
 *   tenants/{t}/payWeeks/{weekStart}         { forecast:{date:$}, actual:{date:$}, updatedAt }
 *   (in-memory twin when Firestore is absent, so the pages work locally)
 */

const express = require("express");
const P = require("./payroll");

module.exports = function payrollRoutes({ db, staffStore, tenantStore, shiftsStore, rosterStore }) {
  const router = express.Router();
  const memWeeks = new Map(); // `${tenantId}|${weekStart}` → doc (no-Firestore mode)

  // ---------- storage helpers ----------
  async function readWeeks(tenantId, from, to) {
    if (db) {
      const snap = await db.collection("tenants").doc(tenantId).collection("payWeeks")
        .where("weekStart", ">=", from).where("weekStart", "<=", to).get();
      return snap.docs.map((d) => ({ weekStart: d.id, ...d.data() }));
    }
    return [...memWeeks.entries()]
      .filter(([k]) => k.startsWith(tenantId + "|"))
      .map(([, v]) => v)
      .filter((w) => w.weekStart >= from && w.weekStart <= to);
  }
  async function readWeek(tenantId, weekStart) {
    const rows = await readWeeks(tenantId, weekStart, weekStart);
    return rows[0] || { weekStart, forecast: {}, actual: {} };
  }
  async function writeWeek(tenantId, weekStart, doc) {
    const data = { weekStart, forecast: doc.forecast || {}, actual: doc.actual || {}, updatedAt: new Date().toISOString() };
    if (db) await db.collection("tenants").doc(tenantId).collection("payWeeks").doc(weekStart).set(data, { merge: true });
    else memWeeks.set(`${tenantId}|${weekStart}`, data);
    return data;
  }

  async function loadSettings(req) {
    const tenant = (await tenantStore.findById(req.tenantId)) || {};
    const s = { ...P.DEFAULT_SETTINGS, ...(tenant.payroll || {}) };
    s.targets = { ...P.DEFAULT_SETTINGS.targets, ...((tenant.payroll || {}).targets || {}) };
    s.oncost = { ...P.DEFAULT_SETTINGS.oncost, ...((tenant.payroll || {}).oncost || {}) };
    s.publicHolidays = Array.isArray(s.publicHolidays) ? s.publicHolidays : [];
    // Legacy: public holidays entered on the old cost-settings panel.
    if (!s.publicHolidays.length && tenant.penaltyRules && Array.isArray(tenant.penaltyRules.publicHolidays)) {
      s.publicHolidays = tenant.penaltyRules.publicHolidays;
    }
    if (!s.cycleAnchor) {
      // First look: the 4-week cycle starts this week. Persist so it stays put.
      s.cycleAnchor = P.weekStartFor(P.todayIn(s.timezone), s.weekStartsOn);
      await tenantStore.updateSettings(req.tenantId, { payroll: { ...(tenant.payroll || {}), cycleAnchor: s.cycleAnchor } }).catch(() => {});
    }
    return { settings: s, tenant };
  }

  async function rosterInRange(tenantId, from, to) {
    if (!rosterStore || !rosterStore.listByRange) return [];
    const rows = await rosterStore.listByRange(tenantId, from, to);
    return rows.map((s) => ({ id: s.id, workerId: s.workerId, date: s.date, start: s.start, end: s.end, unpaidBreakMins: s.unpaidBreakMins || 0, role: s.role || null, published: Boolean(s.published) }));
  }

  // ---------- the week ----------
  async function buildWeekFor(req, weekStart) {
    const { settings } = await loadSettings(req);
    const today = P.todayIn(settings.timezone);
    const cycle = P.cycleFor(weekStart, settings);
    const weekEnd = P.addDays(weekStart, 6);
    const from = cycle.start < weekStart ? cycle.start : weekStart;
    const to = cycle.end > weekEnd ? cycle.end : weekEnd;

    const [workers, roster, attendanceRaw, weekDoc, history] = await Promise.all([
      staffStore.listByTenant(req.tenantId),
      rosterInRange(req.tenantId, from, to),
      shiftsStore.listRecentByTenant(req.tenantId, new Date(new Date(from + "T00:00:00Z").getTime() - 36 * 3600 * 1000).toISOString()),
      readWeek(req.tenantId, weekStart),
      readWeeks(req.tenantId, P.addDays(weekStart, -8 * 7), P.addDays(weekStart, -7)),
    ]);
    const attendance = attendanceRaw.filter((r) => r.clockOut && !r.clockOut.denied);
    const workersWithId = workers.map((w) => ({ ...w, id: w.phone }));

    const cycleHours = {};
    for (const w of workersWithId) {
      if (w.employmentType !== "fulltime") continue;
      cycleHours[w.id] = P.cycleHoursOutsideWeek({ workerId: w.id, weekStart, cycle, today, rosterShifts: roster, attendance, timezone: settings.timezone });
    }

    const week = P.buildWeek({
      weekStart, settings, today, workers: workersWithId,
      rosterShifts: roster.filter((s) => s.date >= weekStart && s.date <= weekEnd),
      attendance, revenue: { forecast: weekDoc.forecast || {}, actual: weekDoc.actual || {} }, cycleHours,
    });
    week.revenue = { forecast: weekDoc.forecast || {}, actual: weekDoc.actual || {}, suggested: P.suggestForecast(weekStart, history) };
    week.lastWeek = history.find((h) => h.weekStart === P.addDays(weekStart, -7)) || null;
    return week;
  }

  router.get("/week", async (req, res) => {
    try {
      const { settings } = await loadSettings(req);
      const raw = String(req.query.start || "");
      const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? P.weekStartFor(raw, settings.weekStartsOn)
        : P.weekStartFor(P.todayIn(settings.timezone), settings.weekStartsOn);
      res.json(await buildWeekFor(req, weekStart));
    } catch (e) { err(res, e); }
  });

  router.post("/week/:start/revenue", async (req, res) => {
    try {
      const { settings } = await loadSettings(req);
      const weekStart = String(req.params.start || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || P.weekStartFor(weekStart, settings.weekStartsOn) !== weekStart) {
        return res.status(400).json({ error: "start must be the first day of a pay week (YYYY-MM-DD)." });
      }
      const dates = new Set(P.weekDates(weekStart));
      const cur = await readWeek(req.tenantId, weekStart);
      const body = req.body || {};
      const clean = (obj) => {
        const out = {};
        for (const [d, v] of Object.entries(obj || {})) {
          if (!dates.has(d)) continue;
          if (v === null || v === "") { out[d] = null; continue; }
          const n = Number(v);
          if (!isFinite(n) || n < 0 || n > 10000000) throw Object.assign(new Error(`${d}: amount must be a number ≥ 0`), { status: 400 });
          out[d] = Math.round(n);
        }
        return out;
      };
      const forecast = { ...(cur.forecast || {}) }, actual = { ...(cur.actual || {}) };
      if (body.weekTotal != null && body.weekTotal !== "") {
        const total = Number(body.weekTotal);
        if (!isFinite(total) || total < 0) return res.status(400).json({ error: "weekTotal must be a number ≥ 0." });
        const history = await readWeeks(req.tenantId, P.addDays(weekStart, -8 * 7), P.addDays(weekStart, -7));
        const pattern = P.suggestForecast(weekStart, history);
        Object.assign(forecast, P.spreadWeekTotal(weekStart, Math.round(total), pattern));
      }
      for (const [d, v] of Object.entries(clean(body.forecast))) { if (v == null) delete forecast[d]; else forecast[d] = v; }
      for (const [d, v] of Object.entries(clean(body.actual))) { if (v == null) delete actual[d]; else actual[d] = v; }
      await writeWeek(req.tenantId, weekStart, { forecast, actual });
      res.json(await buildWeekFor(req, weekStart));
    } catch (e) { err(res, e); }
  });

  // ---------- settings ----------
  router.get("/settings", async (req, res) => {
    try {
      const { settings } = await loadSettings(req);
      res.json({ settings, timezones: TIMEZONES, awards: require("./award-engine").listAwards() });
    } catch (e) { err(res, e); }
  });

  router.post("/settings", async (req, res) => {
    try {
      const { settings: cur } = await loadSettings(req);
      const b = req.body || {};
      const next = { ...cur };
      if (b.weekStartsOn != null) {
        const n = Number(b.weekStartsOn);
        if (!(n >= 0 && n <= 6)) return res.status(400).json({ error: "weekStartsOn must be 0 (Sunday) to 6 (Saturday)." });
        next.weekStartsOn = n;
      }
      if (b.timezone) {
        try { new Intl.DateTimeFormat("en", { timeZone: b.timezone }); } catch { return res.status(400).json({ error: "Unknown timezone." }); }
        next.timezone = b.timezone;
      }
      if (b.targets) {
        const k = Number(b.targets.kitchenPct), t = Number(b.targets.totalPct);
        if (!(k >= 0 && k <= 100) || !(t >= 0 && t <= 100)) return res.status(400).json({ error: "Targets must be between 0 and 100." });
        if (k > t) return res.status(400).json({ error: "Kitchen % can't be more than the total payroll %." });
        next.targets = { kitchenPct: Math.round(k * 10) / 10, totalPct: Math.round(t * 10) / 10 };
      }
      if (b.cycleAnchor) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.cycleAnchor)) return res.status(400).json({ error: "cycleAnchor must be YYYY-MM-DD." });
        next.cycleAnchor = P.weekStartFor(b.cycleAnchor, next.weekStartsOn);
      }
      if (b.oncost) {
        const c = Number(b.oncost.casualPct), p = Number(b.oncost.permanentPct);
        if (!(c >= 0 && c <= 60) || !(p >= 0 && p <= 60)) return res.status(400).json({ error: "On-cost % must be between 0 and 60." });
        next.oncost = { include: Boolean(b.oncost.include), casualPct: Math.round(c * 100) / 100, permanentPct: Math.round(p * 100) / 100 };
      }
      if (Array.isArray(b.publicHolidays)) {
        next.publicHolidays = [...new Set(b.publicHolidays.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().slice(0, 60);
      }
      // Anchor must sit on the (possibly new) week start day.
      next.cycleAnchor = P.weekStartFor(next.cycleAnchor || P.todayIn(next.timezone), next.weekStartsOn);
      const payroll = {
        weekStartsOn: next.weekStartsOn, timezone: next.timezone, targets: next.targets,
        cycleAnchor: next.cycleAnchor, cycleWeeks: 4, publicHolidays: next.publicHolidays, oncost: next.oncost,
      };
      await tenantStore.updateSettings(req.tenantId, { payroll });
      // The roster page's award costing reads public holidays from here.
      if (db) await db.collection("tenants").doc(req.tenantId).collection("settings").doc("publicHolidays").set({ dates: payroll.publicHolidays }, { merge: true });
      res.json({ ok: true, settings: payroll });
    } catch (e) { err(res, e); }
  });

  // ---------- export ----------
  router.get("/export.csv", async (req, res) => {
    try {
      const { settings } = await loadSettings(req);
      const raw = String(req.query.start || "");
      const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? P.weekStartFor(raw, settings.weekStartsOn) : P.weekStartFor(P.todayIn(settings.timezone), settings.weekStartsOn);
      const week = await buildWeekFor(req, weekStart);
      const rows = [["Name", "Department", "Type", "Level", "Rate", "Date", "Day", "Start", "End", "UnpaidBreakMins", "PaidHours", "Multiplier", "LoadingAmt", "OTHours", "Wage", "Note"]];
      for (const c of week.crew) {
        for (const d of c.days) {
          if (c.payType === "salary") {
            if (d.rosteredCost > 0) rows.push([c.name, c.department || "", "Salaried", "", (c.weeklySalary || 0).toFixed(2) + "/wk", d.date, dayName(d.date), "", "", "", d.workedHours || "", "", "", "", d.rosteredCost.toFixed(2), "salary posted daily"]);
            continue;
          }
          for (const l of d.lines) {
            rows.push([c.name, c.department || "", c.typeLabel, c.level, c.hourlyRate.toFixed(2), l.date, l.dayType, l.start, l.end, l.unpaidBreakMins, l.hours, l.multiplier,
              (l.loadings || []).reduce((t, x) => t + x.amount, 0).toFixed(2), l.otHours || 0, l.wage.toFixed(2), [l.amended ? "amended" : "", l.forcedByManager ? "closed by manager" : ""].filter(Boolean).join("; ")]);
          }
        }
        if (c.cycle && c.cycle.overtimePremium) rows.push([c.name, c.department || "", c.typeLabel, c.level, c.hourlyRate.toFixed(2), "", "", "", "", "", "", "", "", c.cycle.overtimeHoursThisWeek, c.cycle.overtimePremium.toFixed(2), "152h cycle overtime premium"]);
      }
      rows.push([]);
      rows.push(["Totals", "", "", "", "", "", "", "", "", "", week.totals.hours, "", "", "", week.totals.projected.toFixed(2), week.totals.inOncost ? `week ${week.weekStart} to ${week.weekEnd}; in on-cost (wages ${week.totals.wages.toFixed(2)} + on-costs ${week.totals.oncost.toFixed(2)})` : `week ${week.weekStart} to ${week.weekEnd}; wages only (on-costs not included)`]);
      for (const k of ["kitchen", "service", "total"]) {
        const d = week.departments[k];
        rows.push([k, "", "", "", "", "", "", "", "", "", d.hours, "", "", "", d.projected.toFixed(2), d.budget != null ? `budget ${d.budget.toFixed(2)} (${d.targetPct}% of ${week.totals.expectedRevenue}); ${d.pct}%` : "no revenue forecast"]);
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=crewline_pay_${weekStart}.csv`);
      res.send("﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n"));
    } catch (e) { err(res, e); }
  });

  // Used by the one-off venue setup (bootstrap.js) to load revenue forecasts.
  router.readWeek = readWeek;
  router.writeWeek = writeWeek;
  return router;
};

const TIMEZONES = ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Australia/Hobart", "Australia/Darwin", "Pacific/Auckland"];

function dayName(d) { return new Date(d + "T12:00:00Z").toLocaleDateString("en-AU", { weekday: "short", timeZone: "UTC" }); }
function csvCell(v) { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function err(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.message });
  console.error("[pay]", e);
  res.status(500).json({ error: e.message || "Payroll failed." });
}
