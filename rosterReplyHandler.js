"use strict";

const { sendText, sendButtons } = require("./whatsapp");
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

const YES_RE = /^(yes|yep|yeah|ok|okay|confirm|confirmed|👍)(\b|$)/i;
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

const RANGE_DAYS = 14; // the same window "My roster" shows

async function handleRosterReply(from, staff, body, deps, sendOpts = {}) {
  const { rosterStore, staffStore } = deps;
  const shifts = await upcoming(staff, from, deps);

  if (YES_RE.test(body)) {
    if (!shifts.length) {
      await sendText(from, "Nothing to confirm yet — I'll send your shifts as soon as the roster is published.", sendOpts);
      return true;
    }
    const todo = shifts.filter((s) => !s.confirmedAt && !s.swapRequestedAt); // a shift they asked to change stays flagged
    if (!todo.length) {
      const waiting = shifts.filter((s) => s.swapRequestedAt).length;
      await sendText(from, waiting ? `Nothing to confirm — ${waiting} shift${waiting === 1 ? " is" : "s are"} with your manager for a change.` : "All your shifts are already confirmed 👍", sendOpts);
      return true;
    }
    const at = new Date().toISOString();
    await Promise.all(todo.map((s) => rosterStore.update(staff.tenantId, s.id, { confirmedAt: at })));
    await sendText(from, `Confirmed — ${todo.length} shift${todo.length === 1 ? "" : "s"}. See you there, ${staff.name}.`, sendOpts);
    return true;
  }

  // NEED A CHANGE — for one shift, not the whole fortnight.
  if (!shifts.length) {
    await sendText(from, "You don't have any published shifts to change right now.", sendOpts);
    return true;
  }
  const rest = body.replace(SWAP_RE, "").trim();
  if (rest === "none") {
    await sendText(from, "Okay — nothing changed.", sendOpts);
    return true;
  }
  let picked = shifts.find((s) => String(s.id).toLowerCase() === rest); // a tapped shift button
  let note = picked ? "" : rest;
  if (!picked && shifts.length === 1) picked = shifts[0];
  if (!picked) {
    const rows = shifts.slice(0, 10).map((s) => [{ text: `${fmt(s)}${s.swapRequestedAt ? " ⇄" : ""}`, data: `swap ${s.id}` }]);
    rows.push([{ text: "✖️ Never mind", data: "swap none" }]);
    await sendButtons(from, "Which shift do you need changed?", rows, sendOpts);
    return true;
  }

  const at = new Date().toISOString();
  await rosterStore.update(staff.tenantId, picked.id, { swapRequestedAt: at, swapNote: note || null });

  // Tell the managers who can hear us.
  let told = 0;
  if (staffStore && staffStore.listByTenant) {
    const everyone = await staffStore.listByTenant(staff.tenantId);
    const managers = everyone.filter((p) => (p.role === "manager" || p.role === "owner") && p.phone !== from);
    for (const m of managers) {
      const r = await sendText(m.phone, `🔁 ${staff.name} needs a change: ${fmt(picked)}${note ? ` — "${note}"` : ""}. Open the roster to change it.`, sendOpts.channel ? {} : sendOpts);
      if (!r || r.ok !== false) told++;
    }
  }
  await sendText(
    from,
    `Got it — ${fmt(picked)} is ${told ? "sent to your manager" : "flagged on the roster for your manager"}. Keep the shift until they confirm a change.`,
    sendOpts
  );
  return true;
}

module.exports = { handleRosterReply, looksLikeRosterReply, YES_RE, SWAP_RE, addDays };
