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
 */
const { matchStaff, commitShifts } = require("./rosterImport");

const slug = (n) => "pending-" + String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

async function runBootstrap({ staffStore, tenantStore, rosterStore }, tenantId, raw = process.env.BOOTSTRAP_VENUE, log = console) {
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
  if (cfg.payroll) patch.payroll = { ...(tenant && tenant.payroll), ...cfg.payroll };

  // 2. Crew. Match people already on the list before adding anyone.
  const existing = (await staffStore.listByTenant(tenantId)).filter((s) => s.active !== false);
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
      if (Object.keys(keep).length) await staffStore.upsert({ ...hit, ...keep });
      idFor.set(c.name, String(hit.phone)); merged++;
    } else {
      const id = c.phone ? String(c.phone).replace(/\D/g, "") : slug(c.name);
      await staffStore.upsert({
        phone: id, tenantId, name: c.name, role: c.role || "staff", active: true, createdAt: new Date().toISOString(),
        ...fill, ...(c.phone ? {} : { pendingMobile: true }),
      });
      idFor.set(c.name, id); added++;
    }
  }

  // 3. Shifts (drafts, deduped).
  const shifts = [];
  for (const s of cfg.shifts || []) {
    const workerId = idFor.get(s.name);
    if (workerId) shifts.push({ workerId, date: s.date, start: s.start, end: s.end, role: s.role || null, unpaidBreakMins: s.unpaidBreakMins || 0 });
  }
  const sh = await commitShifts({ rosterStore, tenantId, shifts, actor: "setup" });

  await tenantStore.updateSettings(tenantId, patch); // last, so a crash above retries next start
  log.log(`[bootstrap] ${cfg.id}: venue "${patch.name || tenantId}" (${patch.plan || "-"}, limit ${patch.staffLimit || "-"}), crew +${added} (${merged} already there), shifts +${sh.added}`);
  return { ok: true, added, merged, shifts: sh.added };
}

module.exports = { runBootstrap, slug };
