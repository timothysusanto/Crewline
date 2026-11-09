"use strict";

/**
 * timesheetFixes.js — finds clock records that need a manager's one-tap fix and
 * works out what the fix should be, using the roster as the source of truth.
 *
 *   no_in     rostered shift finished, no clock record at all   → add it as rostered
 *   no_out    clocked in, never clocked out                     → out at the rostered end
 *   no_break  8h shift with no break recorded                   → apply the rostered unpaid break
 *
 * Pure functions (no I/O) so they are easy to test; payroll-routes.js wires them to the stores.
 * Salaried staff are skipped: their cost is a daily salary, not clock hours.
 */

const P = require("./payroll");

const LATE_MINS = 20;          // a shift is "finished" this long after its rostered end
const OPEN_MAX_HOURS = 14;     // an open clock-in older than this is always a forgotten "out"
const BREAK_AFTER_HOURS = 5.5; // matches the roster import default
const DEFAULT_BREAK = 30;

/** "2026-11-09" + "17:00" on the venue's clock → ISO instant. */
function zonedToIso(date, time, timezone) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const l = P.localDateTime(new Date(guess).toISOString(), timezone);
    const [ly, lm, ld] = l.date.split("-").map(Number);
    const asUtc = Date.UTC(ly, lm - 1, ld, Math.floor(l.minutes / 60), l.minutes % 60);
    const diff = Date.UTC(y, m - 1, d, hh, mm) - asUtc;
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

/** A roster shift as instants (end rolls to the next day for overnight shifts). */
function rosterInstants(s, timezone) {
  const startIso = zonedToIso(s.date, s.start, timezone);
  let endDate = s.date;
  if (s.end <= s.start) endDate = P.addDays(s.date, 1);
  return { startIso, endIso: zonedToIso(endDate, s.end, timezone) };
}

const ms = (iso) => new Date(iso).getTime();
const hoursBetween = (a, b) => (ms(b) - ms(a)) / 3600000;

/**
 * @param {object} i
 *   roster      [{id, workerId, date, start, end, unpaidBreakMins}]   shifts for the window
 *   attendance  clock records (open and closed), staffPhone/clockIn/clockOut/breaks/amended
 *   staff       [{phone, name, payType, active, onLeave}]
 *   now         Date
 *   timezone    IANA zone
 *   windowStart YYYY-MM-DD  earliest day to look at
 * @returns {{ active: boolean, fixes: object[] }}
 *   active=false when nobody has clocked in lately (the venue isn't using clock-in yet), so we don't
 *   bury a manager in "missing clock-in" cards for a roster that was never meant to be clocked.
 */
function detect({ roster = [], attendance = [], staff = [], now = new Date(), timezone, windowStart }) {
  const byPhone = new Map(staff.map((s) => [String(s.phone), s]));
  const clocked = attendance.filter((r) => r.clockIn && r.clockIn.time && !(r.clockIn.flaggedForReview && !r.clockOut));
  if (!clocked.length) return { active: false, fixes: [] };

  const wants = (phone) => {
    const s = byPhone.get(String(phone));
    return s && s.active !== false && s.payType !== "salary" && !s.onLeave;
  };
  const nameOf = (phone) => (byPhone.get(String(phone)) || {}).name || String(phone);
  const fixes = [];

  // Pair roster shifts with clock records on the same person, starting within 4h either side.
  const used = new Set();
  const pair = (rs) => {
    const { startIso } = rosterInstants(rs, timezone);
    let best = null;
    for (const rec of clocked) {
      if (String(rec.staffPhone) !== String(rs.workerId) || used.has(rec.shiftId)) continue;
      const gap = Math.abs(ms(rec.clockIn.time) - ms(startIso));
      if (gap <= 4 * 3600000 && (!best || gap < best.gap)) best = { rec, gap };
    }
    if (best) used.add(best.rec.shiftId);
    return best && best.rec;
  };

  const rosterSorted = [...roster].filter((s) => s.date >= windowStart).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const pairedRoster = new Map(); // shiftId → roster shift
  for (const rs of rosterSorted) {
    if (!wants(rs.workerId)) continue;
    const { startIso, endIso } = rosterInstants(rs, timezone);
    const rec = pair(rs);
    if (rec) { pairedRoster.set(rec.shiftId, rs); continue; }
    if (ms(endIso) + LATE_MINS * 60000 > now.getTime()) continue; // not over yet
    fixes.push({
      key: `no_in|${rs.workerId}|${rs.date}|${rs.id || rs.start}`,
      type: "no_in", workerId: String(rs.workerId), name: nameOf(rs.workerId), date: rs.date,
      title: "No clock-in",
      text: `Rostered ${rs.start}–${rs.end}, no clock-in or clock-out.`,
      action: "Worked as rostered",
      proposal: { inIso: startIso, outIso: endIso, breakMins: rs.unpaidBreakMins || 0 },
      hint: { in: rs.start, out: rs.end, breakMins: rs.unpaidBreakMins || 0 },
    });
  }

  for (const rec of clocked) {
    if (!wants(rec.staffPhone)) continue;
    const local = P.localDateTime(rec.clockIn.time, timezone);
    if (local.date < windowStart) continue;
    const rs = pairedRoster.get(rec.shiftId);
    const eff = (rec.amended && rec.amended.clockInTime) || rec.clockIn.time;

    if (!rec.clockOut) {
      const planned = rs ? rosterInstants(rs, timezone).endIso : null;
      const late = planned ? ms(planned) + LATE_MINS * 60000 < now.getTime() : false;
      const stale = hoursBetween(eff, now.toISOString()) > OPEN_MAX_HOURS;
      if (!late && !stale) continue;
      const out = planned || new Date(ms(eff) + 8 * 3600000).toISOString();
      const outLocal = P.localDateTime(out, timezone);
      fixes.push({
        key: `no_out|${rec.staffPhone}|${local.date}|${rec.shiftId}`,
        type: "no_out", workerId: String(rec.staffPhone), name: nameOf(rec.staffPhone), date: local.date, shiftId: rec.shiftId,
        title: "No clock-out",
        text: `In at ${local.time}${planned ? `, rostered to ${rs.end}` : ""}. Still open.`,
        action: planned ? `Out at ${rs.end}` : `Out at ${outLocal.time} (8h)`,
        proposal: { outIso: out, breakMins: rs ? (rs.unpaidBreakMins || 0) : null },
        hint: { in: local.time, out: outLocal.time, breakMins: rs ? (rs.unpaidBreakMins || 0) : DEFAULT_BREAK },
      });
      continue;
    }

    // Closed shift: no break recorded on a long shift.
    if (rec.clockOut.denied || (rec.amended && rec.amended.breakMinutes != null)) continue;
    const { inIso, outIso } = { inIso: eff, outIso: (rec.amended && rec.amended.clockOutTime) || rec.clockOut.time };
    const worked = hoursBetween(inIso, outIso);
    const hasBreak = (rec.breaks || []).some((b) => b.end);
    if (worked > BREAK_AFTER_HOURS && !hasBreak) {
      const mins = rs ? (rs.unpaidBreakMins || 0) : DEFAULT_BREAK;
      if (!mins) continue; // the roster says this shift has no unpaid break
      fixes.push({
        key: `no_break|${rec.staffPhone}|${local.date}|${rec.shiftId}`,
        type: "no_break", workerId: String(rec.staffPhone), name: nameOf(rec.staffPhone), date: local.date, shiftId: rec.shiftId,
        title: "No break",
        text: `${worked.toFixed(1)}h shift, no break recorded.`,
        action: `${mins} min unpaid break`,
        proposal: { breakMins: mins },
        hint: { in: local.time, out: P.localDateTime(outIso, timezone).time, breakMins: mins },
      });
    }
  }
  fixes.sort((a, b) => (a.date + a.type).localeCompare(b.date + b.type) || a.name.localeCompare(b.name));
  return { active: true, fixes };
}

/**
 * Apply one fix (optionally with the manager's own times). Returns a short description.
 * stores: { shiftsStore }; ctx: { tenantId, timezone, staff }
 */
async function apply(fix, override, { shiftsStore }, { tenantId, timezone, staff, by }) {
  const o = override || {};
  const p = fix.proposal;
  const toIso = (t, base) => (t ? zonedToIso(base, t, timezone) : null);
  const breakMins = o.breakMins != null && o.breakMins !== "" ? Number(o.breakMins) : p.breakMins;
  if (breakMins != null && (!isFinite(breakMins) || breakMins < 0 || breakMins > 240)) throw new Error("Break must be 0–240 minutes.");
  const note = { fixedBy: by || "manager", fixedAt: new Date().toISOString(), fixType: fix.type };

  if (fix.type === "no_in") {
    const inIso = toIso(o.in, fix.date) || p.inIso;
    let outIso = toIso(o.out, fix.date) || p.outIso;
    if (ms(outIso) <= ms(inIso)) outIso = new Date(ms(outIso) + 86400000).toISOString();
    if (hoursBetween(inIso, outIso) > 20) throw new Error("That shift is longer than 20 hours. Check the times.");
    const who = (staff || []).find((s) => String(s.phone) === fix.workerId) || {};
    const { shiftId } = await shiftsStore.openShift({
      tenantId, staffPhone: fix.workerId, department: who.department || null, role: who.role || null,
      clockIn: { time: inIso, addedByManager: true, ...note },
    });
    await shiftsStore.closeShift(shiftId, { time: outIso, forcedByManager: true, ...note });
    if (breakMins) await shiftsStore.amendShift(shiftId, { clockInTime: null, clockOutTime: null, breakMinutes: breakMins });
    return `${fix.name}: added ${P.localDateTime(inIso, timezone).time}–${P.localDateTime(outIso, timezone).time}`;
  }

  const shift = await shiftsStore.findById(fix.shiftId);
  if (!shift || shift.tenantId !== tenantId) throw new Error("That shift isn't in this venue.");

  if (fix.type === "no_out") {
    const inIso = (shift.amended && shift.amended.clockInTime) || shift.clockIn.time;
    let outIso = toIso(o.out, P.localDateTime(inIso, timezone).date) || p.outIso;
    if (ms(outIso) <= ms(inIso)) outIso = new Date(ms(outIso) + 86400000).toISOString();
    if (hoursBetween(inIso, outIso) > 20) throw new Error("That shift is longer than 20 hours. Check the times.");
    await shiftsStore.closeShift(fix.shiftId, { time: outIso, forcedByManager: true, ...note });
    if (breakMins) await shiftsStore.amendShift(fix.shiftId, { clockInTime: null, clockOutTime: null, breakMinutes: breakMins });
    return `${fix.name}: clocked out ${P.localDateTime(outIso, timezone).time}`;
  }

  if (fix.type === "no_break") {
    await shiftsStore.amendShift(fix.shiftId, {
      clockInTime: (shift.amended && shift.amended.clockInTime) || null,
      clockOutTime: (shift.amended && shift.amended.clockOutTime) || null,
      breakMinutes: breakMins,
    });
    return `${fix.name}: ${breakMins} min break`;
  }
  throw new Error("Unknown fix.");
}

module.exports = { detect, apply, zonedToIso, rosterInstants, LATE_MINS };
