"use strict";

const { sendText, sendButtons } = require("./whatsapp");
const { mondayOf } = require("./rosterStore");

/**
 * "My roster" — the person's published shifts for the next two weeks.
 * (The old "avail …", "off 3/8" and "on 3/8" commands are gone: nothing read what they saved,
 * and "on my way" was being read as a date. Weekly availability lives in availabilityCapture.js.)
 */

const SLOT_LABELS = { AM: "AM", PM: "PM", ALL: "all day" };

/** Handles "roster" — shows this week + next week's published assignments. */
async function handleRosterQuery(from, staff, deps, sendOpts) {
  const { rosterStore, siteStore } = deps;
  const shifts = await rosterStore.listUpcomingForWorker(staff.tenantId, from, undefined, 14); // same window Confirm covers

  if (shifts.length === 0) {
    await sendText(from, "No upcoming published shifts for you yet — check back once your manager publishes the roster.", sendOpts);
    return true;
  }

  const siteNames = new Map();
  if (siteStore && shifts.some((s) => s.siteId)) {
    const sites = await siteStore.listByTenant(staff.tenantId, { includeInactive: true });
    for (const site of sites) siteNames.set(site.siteId, site.name);
  }

  const lines = shifts.map((s) => {
    const label = new Date(s.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
    const site = s.siteId ? siteNames.get(s.siteId) : null;
    const mark = s.swapRequestedAt ? "⇄ " : s.confirmedAt ? "✓ " : "• ";
    return `${mark}${label} — ${s.start}–${s.end}${s.role ? ` (${s.role})` : ""}${site ? ` @ ${site}` : ""}`;
  });
  const buttons = [{ text: "🔁 Need a change", data: "swap" }];
  const open = shifts.some((s) => !s.confirmedAt);
  if (open) buttons.unshift({ text: "✅ Confirm", data: "yes" });
  await sendButtons(from, `📋 Your shifts, next 2 weeks:\n${lines.join("\n")}${open ? "" : "\n\nAll confirmed ✓"}`, [buttons], sendOpts);
  return true;
}

module.exports = { handleRosterQuery, mondayOf, SLOT_LABELS };
