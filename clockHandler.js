"use strict";

const { sendText, sendLocationRequest } = require("./whatsapp");
const { checkGeofence } = require("./geofence");
const { resolveSiteForClockIn, describeResolutionFailure, resolutionLabel } = require("./siteResolver");
const { shiftWindow } = require("./rosterStore");

/** Grace before a clock-in counts as late against the rostered start. */
const LATE_AFTER_MS = 5 * 60 * 1000;

/** An open shift older than this was forgotten, not still being worked. */
const FORGOTTEN_AFTER_MS = 16 * 60 * 60 * 1000;

/**
 * Handles the clock in/out flow, plus mid-shift breaks. Clock in/out is
 * two-step by necessity: WhatsApp can only get a location when the user
 * deliberately shares one (there is no silent background read, unlike a
 * native app) — so "in"/"out" as text triggers a location request, and the
 * actual clock event happens when the location message arrives.
 *
 * Breaks don't need a location share (staff is already on-site) — "break"
 * and "back" act immediately on the text message alone.
 *
 * The geofence comes from the **site** on the rostered shift, resolved by
 * siteResolver.js — a venue with one site never has to think about this;
 * a group with several gets the right building automatically.
 * Clock-in resolves the site and stamps it on the shift; clock-out re-checks
 * against that same stamped site, so the two ends of a shift can never be
 * measured against different buildings.
 *
 * Every function here takes a `sendOpts` param, forwarded straight to the
 * channel dispatcher (whatsapp.js) so replies land on the channel the
 * message came from — Telegram, normally.
 */

async function requestClockAction(from, action, deps, sendOpts = {}) {
  deps.pendingActions.set(from, action);
  const label = action === "clock_in" ? "clock in" : "clock out";
  await sendLocationRequest(from, `Share your location to ${label}.`, sendOpts);
}

async function handleLocationForClockAction(from, staff, location, action, deps, sendOpts = {}) {
  const { shiftsStore, pendingActions } = deps;
  const reported = { lat: location.latitude, lng: location.longitude };

  // The location we were waiting for has arrived — the pending action is spent
  // either way, so clear it before any branch can return early.
  pendingActions.clear(from);

  if (action === "clock_in") {
    await clockIn(from, staff, reported, deps, sendOpts);
    return;
  }
  await clockOut(from, staff, reported, deps, sendOpts);
}

async function clockIn(from, staff, reported, deps, sendOpts) {
  const { shiftsStore } = deps;

  // Already on the clock? A second tap must not open a second shift.
  //  - a normal open shift from today: say so and stop;
  //  - an out-of-range attempt from a few minutes ago: let them try again from closer;
  //  - an open shift from long ago: they forgot to clock out — don't block today's shift.
  const open = await shiftsStore.findOpenShift(from);
  const hhmm = (iso) => new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  const stale = Boolean(open) && Date.now() - new Date(open.clockIn.time).getTime() > FORGOTTEN_AFTER_MS;
  const retry = Boolean(open) && !stale && Boolean(open.clockIn.flaggedForReview);
  if (open && !stale && !retry) {
    await sendText(from, `You're already clocked in since ${hhmm(open.clockIn.time)}. Tap Clock out when you finish.`, sendOpts);
    return;
  }

  const resolution = await resolveSiteForClockIn({ staff: { ...staff, phone: from }, deps });
  if (!resolution.geofence) {
    console.error(
      `[clock] cannot resolve a site for ${from} @ ${staff.tenantId}: ${resolution.reason}`
    );
    await sendText(from, describeResolutionFailure(resolution), sendOpts);
    return;
  }

  const result = checkGeofence(reported, resolution.geofence);
  const site = resolution.site;
  const siteLabel = site ? site.name : "the venue";
  console.log(
    `[clock] in ${from} site=${resolutionLabel(resolution)} via=${resolution.source} ` +
      `dist=${result.distanceMeters}m within=${result.withinRadius}`
  );

  if (!result.withinRadius) {
    if (retry) {
      await sendText(from, `Still about ${result.distanceMeters}m from ${siteLabel}. Your ${hhmm(open.clockIn.time)} clock-in is with your manager to check — or tap Clock in again once you're inside.`, sendOpts);
      return;
    }
    await recordFlaggedAttempt(shiftsStore, staff, from, reported, result, resolution);
    await sendText(
      from,
      `You look to be about ${result.distanceMeters}m from ${siteLabel}, which is outside the clock-in range. ` +
        `I've flagged this for your manager to review — they can approve it if needed.`,
      sendOpts
    );
    return;
  }

  // In range now, after an out-of-range attempt a few minutes ago: that attempt becomes the clock-in.
  if (retry && shiftsStore.reviewFlaggedShift) {
    await shiftsStore.reviewFlaggedShift(open.shiftId, true);
    await sendText(from, `Clocked in at ${siteLabel}, ${staff.name} — counted from ${hhmm(open.clockIn.time)}. Have a good shift!`, sendOpts);
    return;
  }

  // Stamp the role and pay rate now, so payroll never reprices a shift later.
  const pricing = await priceShift(from, staff, deps);

  await shiftsStore.openShift({
    tenantId: staff.tenantId,
    staffPhone: from,
    department: staff.department || null,
    siteId: site ? site.siteId : null,
    siteName: site ? site.name : null,
    role: pricing.role,
    payRate: pricing.payRate,
    clockIn: {
      time: new Date().toISOString(),
      lat: reported.lat,
      lng: reported.lng,
      withinRadius: true,
      distanceMeters: result.distanceMeters,
      siteSource: resolution.source,
    },
  });
  const lateNote = await lateBy(from, staff, deps);
  await sendText(
    from,
    `Clocked in at ${siteLabel}, ${staff.name} — have a good shift!${lateNote}` +
      (stale ? `\n\n⚠️ Your last shift was never clocked out. Tap More, then Fix a timesheet, so those hours are right.` : ""),
    sendOpts
  );
}

/**
 * The role and pay rate for a shift about to be opened. The role comes from the
 * rostered shift when there is one (that's what the person was rostered as);
 * otherwise their own first role or department.
 */
async function priceShift(from, staff, deps) {
  const { rosterStore } = deps;
  let role = null;
  try {
    if (rosterStore && rosterStore.findAssignment) {
      const assignment = await rosterStore.findAssignment(staff.tenantId, localDateIso(), from);
      if (assignment && assignment.role) role = assignment.role;
    }
  } catch (err) {
    console.error("[clock] couldn't read the rostered role:", err.message);
  }
  if (!role) {
    const own = Array.isArray(staff.roles) && staff.roles.length ? staff.roles[0] : staff.department;
    role = own ? String(own).trim().toLowerCase() : null;
  }
  const payRate = Number.isFinite(Number(staff.wageRate)) ? Number(staff.wageRate) : null;
  return { role, payRate };
}

/**
 * " — 12 min after your rostered start" when the person is late against a
 * published shift today; empty otherwise. Best-effort: never costs a clock-in.
 */
async function lateBy(from, staff, deps) {
  const { rosterStore } = deps;
  try {
    if (!rosterStore || !rosterStore.findAssignment) return "";
    const assignment = await rosterStore.findAssignment(staff.tenantId, localDateIso(), from);
    if (!assignment) return "";
    const { startsAt } = shiftWindow(assignment);
    const lateMs = Date.now() - startsAt.getTime();
    if (lateMs <= LATE_AFTER_MS) return "";
    return ` — ${Math.round(lateMs / 60000)} min after your rostered ${assignment.start} start`;
  } catch (err) {
    console.error("[clock] couldn't check lateness:", err.message);
    return "";
  }
}

function localDateIso(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function clockOut(from, staff, reported, deps, sendOpts) {
  const { shiftsStore } = deps;

  const openShift = await shiftsStore.findOpenShift(from);
  if (!openShift) {
    await sendText(from, 'I don\'t see an open shift for you to clock out of. Tap Clock in if you haven\'t clocked in yet.', sendOpts);
    return;
  }

  // Still on a break: finishing the shift ends the break too, rather than making them tap twice.
  let shift = openShift;
  const endedBreak = hasActiveBreak(openShift);
  if (endedBreak) {
    shift = (await shiftsStore.endBreak(openShift.shiftId, new Date().toISOString())) || openShift;
  }

  // Measured against the site stamped on this shift at clock-in, so both ends
  // of a shift are always compared to the same building.
  const resolution = await resolveSiteForClockIn({
    staff: { ...staff, phone: from },
    siteId: openShift.siteId || null,
    deps,
  });

  // A clock-out is never refused. Someone finishing a shift has already worked
  // the hours; losing them because a site was deleted mid-shift would be a
  // worse failure than an unverified location. Record what we know instead.
  const clockOutRecord = {
    time: new Date().toISOString(),
    lat: reported.lat,
    lng: reported.lng,
  };
  if (resolution.geofence) {
    const result = checkGeofence(reported, resolution.geofence);
    clockOutRecord.withinRadius = result.withinRadius;
    clockOutRecord.distanceMeters = result.distanceMeters;
  } else {
    console.warn(
      `[clock] out ${from} shift=${openShift.shiftId} unverified location: ${resolution.reason}`
    );
    clockOutRecord.withinRadius = null;
    clockOutRecord.distanceMeters = null;
    clockOutRecord.geofenceUnavailable = resolution.reason;
  }

  await shiftsStore.closeShift(openShift.shiftId, clockOutRecord);

  const workedMs = shiftDurationMinusBreaks(shift, Date.now());
  const hours = (workedMs / 1000 / 60 / 60).toFixed(1);
  await sendText(from, `Clocked out, ${staff.name} — that was a ${hours}hr shift${endedBreak ? " (your break was ended too)" : ""}. See you next time!`, sendOpts);
}

async function startBreak(from, staff, deps, sendOpts = {}) {
  const { shiftsStore } = deps;
  const openShift = await shiftsStore.findOpenShift(from);
  if (!openShift) {
    await sendText(from, 'You\'re not clocked in right now, so there\'s no shift to take a break from. Tap Clock in first.', sendOpts);
    return;
  }
  if (hasActiveBreak(openShift)) {
    await sendText(from, "You're already on break — tap Back when you're ready to resume.", sendOpts);
    return;
  }
  try {
    await shiftsStore.startBreak(openShift.shiftId, new Date().toISOString());
    await sendText(from, `Break started, ${staff.name} — tap Back when you're back on the floor.`, sendOpts);
  } catch (err) {
    console.error("[break] failed to start break:", err);
    await sendText(from, "Couldn't start your break just now — please try again in a moment.", sendOpts);
  }
}

async function endBreak(from, staff, deps, sendOpts = {}) {
  const { shiftsStore } = deps;
  const openShift = await shiftsStore.findOpenShift(from);
  if (!openShift || !hasActiveBreak(openShift)) {
    await sendText(from, 'You\'re not currently on a break. Tap Break to start one, or Clock out.', sendOpts);
    return;
  }
  try {
    const updated = await shiftsStore.endBreak(openShift.shiftId, new Date().toISOString());
    const breaks = updated.breaks || [];
    const last = breaks[breaks.length - 1];
    const breakMinutes = Math.round((new Date(last.end) - new Date(last.start)) / 1000 / 60);
    await sendText(from, `Welcome back, ${staff.name} — that was a ${breakMinutes} min break.`, sendOpts);
  } catch (err) {
    console.error("[break] failed to end break:", err);
    await sendText(from, "Couldn't end your break just now — please try again in a moment.", sendOpts);
  }
}

function hasActiveBreak(shift) {
  const breaks = shift.breaks || [];
  const last = breaks[breaks.length - 1];
  return Boolean(last && !last.end);
}

function shiftDurationMinusBreaks(shift, nowMs) {
  const totalMs = nowMs - new Date(shift.clockIn.time).getTime();
  const breaks = shift.breaks || [];
  const breakMs = breaks.reduce((sum, b) => {
    if (!b.end) return sum;
    return sum + (new Date(b.end).getTime() - new Date(b.start).getTime());
  }, 0);
  return Math.max(0, totalMs - breakMs);
}

/**
 * An out-of-radius clock-in still becomes a shift, flagged for review. It
 * carries the site it was measured against — without that, a manager looking
 * at "142m away" has no way to know which building the 142m was from.
 */
async function recordFlaggedAttempt(shiftsStore, staff, from, reported, result, resolution) {
  try {
    const site = resolution.site;
    await shiftsStore.openShift({
      tenantId: staff.tenantId,
      staffPhone: from,
      department: staff.department || null,
      siteId: site ? site.siteId : null,
      siteName: site ? site.name : null,
      clockIn: {
        time: new Date().toISOString(),
        lat: reported.lat,
        lng: reported.lng,
        withinRadius: false,
        distanceMeters: result.distanceMeters,
        siteSource: resolution.source,
        flaggedForReview: true,
      },
    });
  } catch (err) {
    console.error("[clock] failed to record flagged attempt:", err);
  }
}

module.exports = { requestClockAction, handleLocationForClockAction, startBreak, endBreak };
