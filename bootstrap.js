"use strict";

/**
 * bootstrap.js — one-off venue setup applied by the server itself at start-up.
 *
 * Reads the JSON in the BOOTSTRAP_VENUE environment variable (so crew names
 * stay out of git) and, once per `id`, sets the venue's name / plan / staff
 * limit / payroll settings, adds crew that aren't on the list yet, and saves
 * the given shifts as DRAFTS. Safe to leave in place: the same `id` never runs
 * twice, and nothing here deletes or overwrites a crew member that already
 * exists (it only fills in what's blank).
 *
 * Crew without a mobile number get a placeholder id ("pending-julius-a") and
 * `pendingMobile: true`; the manager adds the real number from More → Crew and
 * the record (with its shifts) moves across (see core-os-routes: /workers/:id/mobile).
 *
 * A crew entry's `set` object is applied even to people already on the list (used to
 * load pay details or a promotion). `forecast` ({date: $}) fills revenue forecasts for
 * days that don't have one yet — never overwrites what a manager typed.
 */
const { matchStaff, commitShifts, mondayOf } = require("./rosterImport");

function addDays(d, n) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const slug = (n) => "pending-" + String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

async function runBootstrap({ staffStore, tenantStore, rosterStore }, tenantId, raw = process.env.BOOTSTRAP_VENUE, log = console, extras = {}) {
  if (!raw) return { skipped: "no config" };
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { log.error("[bootstrap] BOOTSTRAP_VENUE is not valid JSON:", e.message); return { error: "bad json" }; }
  if (!cfg.id) { log.error("[bootstrap] config needs an id"); return { error: "no id" }; }

  let tenant = await tenantStore.findById(tenantId);
  if (!tenant) { await tenantStore.create(tenantId, { name: tenantId, active: true, createdAt: new Date().toISOString() }); tenant = await tenantStore.findById(tenantId); }
  if (tenant && tenant.bootstrapId === cfg.id) return { skipped: "already applied" };

  // 1. Venue: name, plan, staff limit, payroll settings.
  const v = cfg.venue || {};
  const patch = { bootstrapId: cfg.id };
  if (v.name) patch.name = v.name;
  if (v.plan) patch.plan = v.plan;
  if (v.staffLimit) patch.staffLimit = Number(v.staffLimit);
  if (cfg.payroll) patch.payroll = { ...(tenant && tenant.payroll), ...cfg.payroll,
    ...(cfg.payroll.publicHolidays ? { publicHolidays: [...new Set([...((tenant && tenant.payroll && tenant.payroll.publicHolidays) || []), ...cfg.payroll.publicHolidays])].sort() } : {}) };

  // 1b. Merge duplicates: move every shift from one record onto another, then retire the duplicate.
  for (const m of cfg.merge || []) {
    const all = await staffStore.listByTenant(tenantId);
    const from = all.find((s) => s.name === m.from && s.active !== false), into = all.find((s) => s.name === m.into && s.active !== false);
    if (!from || !into || from.phone === into.phone) { log.log(`[bootstrap] merge skipped: ${m.from} -> ${m.into}`); continue; }
    const shifts = await rosterStore.listByWorker(tenantId, String(from.phone), "2000-01-01", "2100-12-31");
    for (const s of shifts) await rosterStore.update(tenantId, s.id, { workerId: String(into.phone) });
    await staffStore.upsert({ ...from, active: false, mergedInto: String(into.phone) });
    log.log(`[bootstrap] merged ${m.from} into ${m.into}: ${shifts.length} shift(s) moved, duplicate retired`);
  }

  // 2. Crew. Match people already on the list before adding anyone.
  const existing = (await staffStore.listByTenant(tenantId)).filter((s) => s.active !== false);
  if (cfg.listCrew) {
    const all = await staffStore.listByTenant(tenantId);
    log.log(`[bootstrap] crew on file (${all.length}): ` + all.map((s) => `${s.name}|${String(s.phone).startsWith("pending-") ? "pending" : "mobile"}|${s.active === false ? "inactive" : "active"}|${s.role || ""}|${s.createdAt ? String(s.createdAt).slice(0, 16) : ""}`).join("; "));
  }
  const idFor = new Map(); // config name -> staff id (phone or placeholder)
  let added = 0, merged = 0;
  for (const c of cfg.crew || []) {
    const names = [c.name, ...(c.aliases || [])].map(norm);
    let hit = existing.find((s) => names.includes(norm(s.name)));
    if (!hit && c.owner) hit = existing.find((s) => s.role === "owner");
    if (!hit) hit = matchStaff(c.name, existing.filter((s) => !String(s.phone).startsWith("pending-")));
    const fill = {};
    if (c.jobTitle) fill.jobTitle = c.jobTitle;
    if (c.department) fill.department = c.department;
    if (hit) {
      const keep = {}; for (const [k, val] of Object.entries(fill)) if (hit[k] == null || hit[k] === "") keep[k] = val;
      Object.assign(keep, c.set || {});
      if (Object.keys(keep).length) { await staffStore.upsert({ ...hit, ...keep }); Object.assign(hit, keep); }
      idFor.set(c.name, String(hit.phone)); merged++;
    } else {
      const id = c.phone ? String(c.phone).replace(/\D/g, "") : slug(c.name);
      await staffStore.upsert({
        phone: id, tenantId, name: c.name, role: c.role || "staff", active: true, createdAt: new Date().toISOString(),
        ...fill, ...(c.set || {}), ...(c.phone ? {} : { pendingMobile: true }),
      });
      idFor.set(c.name, id); added++; log.log(`[bootstrap] added new crew: ${c.name}`);
    }
  }

  // 3. Shifts (drafts, deduped).
  const shifts = [];
  for (const s of cfg.shifts || []) {
    const workerId = idFor.get(s.name);
    if (workerId) shifts.push({ workerId, date: s.date, start: s.start, end: s.end, role: s.role || null, unpaidBreakMins: s.unpaidBreakMins || 0, published: s.published === true });
  }
  const sh = await commitShifts({ rosterStore, tenantId, shifts, actor: "setup" });

  // 4. Revenue forecasts, one pay week (Monday) at a time. Only empty days are filled.
  let forecastDays = 0, forecastSum = 0;
  // Compact form: forecastFrom (YYYY-MM-DD) + forecastDaily ([$, $, …] one per day).
  if (!cfg.forecast && cfg.forecastFrom && Array.isArray(cfg.forecastDaily)) {
    cfg.forecast = {};
    cfg.forecastDaily.forEach((v, i) => { cfg.forecast[addDays(cfg.forecastFrom, i)] = v; });
  }
  if (cfg.forecast) forecastSum = Object.values(cfg.forecast).reduce((t, v) => t + (Number(v) || 0), 0);
  if (cfg.forecast && extras.readWeek && extras.writeWeek) {
    const byWeek = {};
    for (const [date, amt] of Object.entries(cfg.forecast)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(Number(amt) >= 0)) continue;
      (byWeek[mondayOf(date)] = byWeek[mondayOf(date)] || {})[date] = Math.round(Number(amt));
    }
    for (const [ws, days] of Object.entries(byWeek)) {
      const cur = await extras.readWeek(tenantId, ws);
      const forecast = { ...(cur.forecast || {}) };
      for (const [d, v] of Object.entries(days)) if (forecast[d] == null) { forecast[d] = v; forecastDays++; }
      await extras.writeWeek(tenantId, ws, { forecast, actual: cur.actual || {} });
    }
  }
  // A finance month (financeReport.toStored shape): their actual revenue and payroll by day.
  let financeDays = 0;
  if (cfg.finance && /^\d{4}-\d{2}$/.test(cfg.finance.month || "") && Array.isArray(cfg.finance.days) && extras.saveFinance) {
    financeDays = (await extras.saveFinance(tenantId, { importedAt: new Date().toISOString(), ...cfg.finance })).days;
    log.log(`[bootstrap] finance month ${cfg.finance.month}: ${financeDays} day(s) loaded`);
  }
  if (cfg.payroll && Array.isArray(cfg.payroll.publicHolidays) && extras.writeHolidays) await extras.writeHolidays(tenantId, patch.payroll.publicHolidays);

  await tenantStore.updateSettings(tenantId, patch); // last, so a crash above retries next start
  log.log(`[bootstrap] ${cfg.id}: venue "${patch.name || tenantId}" (${patch.plan || "-"}, limit ${patch.staffLimit || "-"}), crew +${added} (${merged} already there), shifts +${sh.added}, forecast days +${forecastDays} (config total $${Math.round(forecastSum)})`);
  return { ok: true, added, merged, shifts: sh.added, forecastDays };
}

module.exports = { runBootstrap, slug };
