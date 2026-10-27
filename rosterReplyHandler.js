"use strict";

const { sendText } = require("./whatsapp");
const { localDateIso, addDays } = require("./rosterStore");

/**
 * What happens when a staff member answers a published roster.
 *
 *   YES  — confirms every upcoming published shift (next 14 days).
 *   SWAP — flags those shifts as "swap requested" so the manager sees it on
 *          the roster page, and tells every manager who is reachable on chat.
 *
 * Both are deliberately forgiving about wording ("yes please", "swap tue")
 * and both reply even when there's nothing to act on, because silence reads
 * as the bot being broken.
 */

const YES_RE = /^(yes|yep|yeah|ok|okay|confirm|confirmed|👍)\b/i;
const SWAP_RE = /^(swap|change|cant|can't|cannot)\b/i;

function looksLikeRosterReply(body) {
  return YES_RE.test(body) || SWAP_RE.test(body);
}

async function upcoming(staff, from, deps) {
  const { rosterStore } = deps;
  if (!rosterStore || !rosterStore.listUpcomingForWorker) return [];
  return rosterStore.listUpcomingForWorker(staff.tenantId, from, localDateIso(), 14);
}

function fmt(s) {
  const label = new Date(s.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  return `${label} ${s.start}–${s.end}`;
}

async function handleRosterReply(from, staff, body, deps, sendOpts = {}) {
  const { rosterStore, staffStore } = deps;
  const shifts = await upcoming(staff, from, deps);

  if (YES_RE.test(body)) {
    if (!shifts.length) {
      await sendText(from, "Nothing to confirm yet — I'll send your shifts as soon as the roster is published.", sendOpts);
      return true;
    }
    const at = new Date().toISOString();
    await Promise.all(shifts.map((s) => rosterStore.update(staff.tenantId, s.id, { confirmedAt: at, swapRequestedAt: null })));
    await sendText(from, `Confirmed — ${shifts.length} shift${shifts.length === 1 ? "" : "s"}. See you there, ${staff.name}.`, sendOpts);
    return true;
  }

  // SWAP
  if (!shifts.length) {
    await sendText(from, "You don't have any published shifts to swap right now.", sendOpts);
    return true;
  }
  const at = new Date().toISOString();
  const note = body.replace(SWAP_RE, "").trim();
  await Promise.all(shifts.map((s) => rosterStore.update(staff.tenantId, s.id, { swapRequestedAt: at, swapNote: note || null })));

  // Tell the managers who can hear us.
  let told = 0;
  if (staffStore && staffStore.listByTenant) {
    const everyone = await staffStore.listByTenant(staff.tenantId);
    const managers = everyone.filter((p) => (p.role === "manager" || p.role === "owner") && p.phone !== from);
    const list = shifts.map(fmt).join(", ");
    for (const m of managers) {
      const r = await sendText(m.phone, `🔁 ${staff.name} wants to swap: ${list}${note ? ` — "${note}"` : ""}. Open the roster to change it.`, sendOpts.channel ? {} : sendOpts);
      if (!r || r.ok !== false) told++;
    }
  }
  await sendText(
    from,
    told
      ? "Got it — your manager has been told. Keep the shift until they confirm a change."
      : "Got it — it's flagged on the roster for your manager. Keep the shift until they confirm a change.",
    sendOpts
  );
  return true;
}

module.exports = { handleRosterReply, looksLikeRosterReply, YES_RE, SWAP_RE, addDays };
