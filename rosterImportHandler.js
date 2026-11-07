"use strict";

/**
 * rosterImportHandler.js — a manager sends the roster file to the bot
 * (Excel, CSV or PDF). The bot reads it, says what it found, and waits for
 * ADD (save as drafts) or CANCEL. Nothing reaches the crew until the roster
 * is published from the Roster page.
 */
const { sendText, fetchMediaBinary } = require("./whatsapp");
const { importRoster, commitShifts, parseHeader, mondayOf } = require("./rosterImport");

const PENDING_TTL_MS = 15 * 60 * 1000;
const pending = new Map(); // phone -> { at, tenantId, shifts, filename }

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(iso) { const d = new Date(iso + "T12:00:00Z"); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; }
const hours = (s) => { const t = (x) => +x.slice(0, 2) * 60 + +x.slice(3); let m = t(s.end) - t(s.start); if (m <= 0) m += 1440; return Math.max(0, m - (s.unpaidBreakMins || 0)) / 60; };

/** A summary a manager can read in one glance. Also used by the tests. */
function describe(r) {
  const by = new Map();
  for (const s of r.shifts) { const e = by.get(s.name) || { n: 0, h: 0 }; e.n++; e.h += hours(s); by.set(s.name, e); }
  const total = r.shifts.reduce((a, s) => a + hours(s), 0);
  const lines = [`📋 Found a roster: ${fmtDay(r.from || r.weekStart)}${r.to && r.to !== r.from ? " – " + fmtDay(r.to) : ""}`,
    `${r.shifts.length} shifts · ${by.size} people · ${Math.round(total * 10) / 10} hrs`, ""];
  for (const [name, e] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`• ${name} — ${e.n} shift${e.n === 1 ? "" : "s"}, ${Math.round(e.h * 10) / 10} h`);
  if (r.unmatched.length) lines.push("", `⚠️ Not on your crew list, skipped: ${r.unmatched.map((u) => `${u.name} (${u.count})`).join(", ")}. Add them under More → Crew, then send the file again.`);
  if (r.skipped.length) lines.push("", `⚠️ Couldn't read ${r.skipped.length} cell${r.skipped.length === 1 ? "" : "s"}: ${r.skipped.slice(0, 3).map((x) => `${x.who} "${x.text}"`).join(", ")}${r.skipped.length > 3 ? "…" : ""}`);
  if (r.shifts.length) lines.push("", "30 min unpaid break is assumed on shifts over 5½ h.", "Reply ADD to save these as drafts, or CANCEL.");
  return lines.join("\n");
}

async function handleRosterFile(from, staff, doc, caption, tenantId, deps, sendOpts) {
  if (!["manager", "owner", "admin"].includes(staff.role)) {
    await sendText(from, "Only a manager can send in a roster. If you need a shift changed, reply SWAP to your roster.", sendOpts);
    return;
  }
  await sendText(from, "📄 Got your roster — reading it…", sendOpts);
  const media = await fetchMediaBinary(doc.id, sendOpts);
  if (!media) { await sendText(from, "I couldn't download that file. Try sending it again.", sendOpts); return; }

  // A caption like "16 Nov" says which week it's for when the file only has Mon, Tue…
  let weekStart;
  const h = caption && parseHeader(caption, new Date().toISOString().slice(0, 10));
  if (h && h.date) weekStart = mondayOf(h.date);

  const crew = (await deps.staffStore.listByTenant(tenantId)).filter((s) => s.active !== false);
  const r = await importRoster(media.buffer, { filename: doc.name, mime: doc.mime, staff: crew, weekStart });
  if (!r.ok) { await sendText(from, `😕 ${r.error}\n\nA roster with the days along the top (Mon, Tue… or dates), names down the side and times like 10:00-18:30 in the boxes works best.`, sendOpts); return; }
  if (!r.shifts.length) { await sendText(from, describe(r), sendOpts); return; }
  pending.set(from, { at: Date.now(), tenantId, shifts: r.shifts, filename: doc.name });
  await sendText(from, describe(r) + `\n\nWrong week? Send the file again with the date as the caption, e.g. "16 Nov".`, sendOpts);
}

/** ADD / CANCEL while a roster is waiting. Returns true if it handled the message. */
async function handleImportReply(from, body, tenantId, deps, sendOpts) {
  const p = pending.get(from);
  if (!p) return false;
  if (Date.now() - p.at > PENDING_TTL_MS) { pending.delete(from); return false; }
  const word = body.trim().toLowerCase().replace(/[!.]+$/, "");
  if (word === "cancel" || word === "no") { pending.delete(from); await sendText(from, "Cancelled — nothing was added.", sendOpts); return true; }
  if (word === "add" || word === "add it" || word === "add roster") {
    pending.delete(from);
    const r = await commitShifts({ rosterStore: deps.rosterStore, tenantId: p.tenantId, shifts: p.shifts, actor: from });
    await sendText(from, `✅ Added ${r.added} shift${r.added === 1 ? "" : "s"} as drafts${r.skipped ? ` (${r.skipped} already on the roster)` : ""}.\nOpen Roster in Crewline to check it, then tap Publish to send it to the crew.`, sendOpts);
    return true;
  }
  return false;
}

module.exports = { handleRosterFile, handleImportReply, describe };
