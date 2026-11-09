"use strict";

/**
 * timesheetRequests.js — staff ask for a timesheet fix in the bot, a manager approves it on Today.
 *
 * Replaces the paper "Timesheet change request" form (date worked, start, end, break, reason)
 * with a few taps in Telegram:
 *
 *   Staff:  fix
 *   Bot:    Which shift?            [Sat 8 Nov · 14:30–22:30] [Fri 7 Nov · 15:00–22:30] [Another day]
 *   Staff:  (taps Sat)
 *   Bot:    What happened?          [Forgot to clock in] [Forgot to clock out] [Forgot my break] [Times were different]
 *   Staff:  (taps Forgot to clock out)
 *   Bot:    Worked as rostered, 14:30–22:30 with a 30 min break?   [Yes] [No, different times]
 *   Staff:  (taps Yes)
 *   Bot:    Reason? One line.       [Skip]
 *   Staff:  phone was flat
 *   Bot:    ✅ Sent to your manager.
 *   Manager gets a Telegram note, and the request sits on Today → Timesheet fixes with Approve / Decline.
 *
 * Requests live in tenants/{t}/timesheetRequests (in-memory without Firestore).
 * The chat state is in-memory with a 15-minute life, same trade-off as the roster import.
 */

const { sendText, sendChoices } = require("./whatsapp");
const { getFirestoreDb } = require("./firebase");
const P = require("./payroll");

const TTL = 15 * 60 * 1000;
const flows = new Map(); // phone → { step, at, ... }
const mem = new Map();   // in-memory requests: id → doc

const START_RE = /^(fix|fix timesheet|timesheet|forgot|change|adjust|adjustment)\b/;
const WHAT = ["Forgot to clock in", "Forgot to clock out", "Forgot my break", "Times were different"];
const ANOTHER = "Another day";
const CANCEL = "Cancel";

// ---------- storage ----------
function col(tenantId) {
  const db = getFirestoreDb();
  return db ? db.collection("tenants").doc(tenantId).collection("timesheetRequests") : null;
}
async function saveRequest(tenantId, doc) {
  const c = col(tenantId);
  if (c) { const ref = await c.add(doc); return { id: ref.id, ...doc }; }
  const id = "tr_" + (mem.size + 1) + "_" + Date.now().toString(36);
  mem.set(id, { id, ...doc });
  return { id, ...doc };
}
async function listPending(tenantId) {
  const c = col(tenantId);
  if (c) {
    const snap = await c.where("status", "==", "pending").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return [...mem.values()].filter((r) => r.tenantId === tenantId && r.status === "pending");
}
async function getRequest(tenantId, id) {
  const c = col(tenantId);
  if (c) { const d = await c.doc(id).get(); return d.exists ? { id: d.id, ...d.data() } : null; }
  const r = mem.get(id);
  return r && r.tenantId === tenantId ? r : null;
}
async function updateRequest(tenantId, id, patch) {
  const c = col(tenantId);
  if (c) return c.doc(id).set(patch, { merge: true });
  Object.assign(mem.get(id) || {}, patch);
}

// ---------- parsing ----------
const hm = (t) => {
  const m = String(t).trim().match(/^(\d{1,2})[:.h]?(\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2] || 0);
  if (m[3]) { const pm = /pm/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
};
/** "14:30-22:30 break 30" · "2.30pm to 10.30pm" · "1430-2230 b30" · "14:30-22:30 break 18:00-18:30" */
function parseTimes(text) {
  const s = String(text).toLowerCase().replace(/–|—/g, "-");
  const T = "(\\d{1,2}(?:[:.h]?\\d{2})?\\s*(?:am|pm)?)";
  const m = s.match(new RegExp(`${T}\\s*(?:-|to)\\s*${T}`));
  if (!m) return null;
  const start = hm(m[1]), end = hm(m[2]);
  if (!start || !end) return null;
  let breakMins = null;
  const rest = s.slice(m.index + m[0].length);
  const br = rest.match(new RegExp(`(?:break|brk|b)\\s*${T}\\s*(?:-|to)\\s*${T}`));
  if (br) {
    const a = hm(br[1]), b = hm(br[2]);
    if (a && b) { let d = (Number(b.slice(0, 2)) * 60 + Number(b.slice(3))) - (Number(a.slice(0, 2)) * 60 + Number(a.slice(3))); if (d < 0) d += 1440; breakMins = d; }
  } else {
    const bm = rest.match(/(?:break|brk|b)\s*(\d{1,3})\s*(?:m|min|mins|minutes)?\b/) || rest.match(/(\d{1,3})\s*(?:m|min|mins|minutes)\s*break/);
    if (bm) breakMins = Number(bm[1]);
    else if (/no break/.test(rest)) breakMins = 0;
  }
  if (breakMins != null && (breakMins < 0 || breakMins > 240)) return null;
  return { start, end, breakMins };
}
/** "8/11", "08/11/2026", "sat", "yesterday", "today" → YYYY-MM-DD (within the last 14 days). */
function parseDate(text, today) {
  const s = String(text).trim().toLowerCase();
  if (s === "today") return today;
  if (s === "yesterday") return P.addDays(today, -1);
  const dm = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (dm) {
    const y = dm[3] ? (dm[3].length === 2 ? "20" + dm[3] : dm[3]) : today.slice(0, 4);
    let d = `${y}-${String(dm[2]).padStart(2, "0")}-${String(dm[1]).padStart(2, "0")}`;
    if (d > today && !dm[3]) d = `${Number(y) - 1}${d.slice(4)}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today ? d : null;
  }
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const i = days.findIndex((d) => s.startsWith(d));
  if (i >= 0) {
    for (let k = 0; k < 7; k++) { const d = P.addDays(today, -k); if (new Date(d + "T12:00:00Z").getUTCDay() === i) return d; }
  }
  return null;
}
const label = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const breakText = (m) => (m ? `a ${m} min break` : "no break");

// ---------- the chat ----------
async function tz(deps, tenantId) {
  const t = deps.tenantStore ? await deps.tenantStore.findById(tenantId) : null;
  return ((t && t.payroll) || {}).timezone || P.DEFAULT_SETTINGS.timezone;
}

/** Recent shifts for the person: roster first, then any clock record with no roster shift. */
async function recentShifts(staff, tenantId, deps, timezone) {
  const today = P.todayIn(timezone);
  const from = P.addDays(today, -6);
  const out = [];
  if (deps.rosterStore && deps.rosterStore.listByWorker) {
    const r = await deps.rosterStore.listByWorker(tenantId, String(staff.phone), from, today);
    for (const s of r) out.push({ date: s.date, start: s.start, end: s.end, breakMins: s.unpaidBreakMins || 0 });
  }
  if (deps.shiftsStore && deps.shiftsStore.listRecentByTenant) {
    const recs = await deps.shiftsStore.listRecentByTenant(tenantId, new Date(Date.now() - 7 * 86400000).toISOString());
    for (const rec of recs.filter((x) => String(x.staffPhone) === String(staff.phone))) {
      const a = P.localDateTime(rec.clockIn.time, timezone);
      if (!out.some((o) => o.date === a.date)) {
        const b = rec.clockOut ? P.localDateTime(rec.clockOut.time, timezone).time : null;
        out.push({ date: a.date, start: a.time, end: b, breakMins: null, clocked: true });
      }
    }
  }
  const now = P.localDateTime(new Date().toISOString(), timezone);
  return out
    .filter((s) => s.date < today || (s.date === today && s.start <= now.time))
    .sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start))
    .slice(0, 4);
}
const shiftLabel = (s) => `${label(s.date)} · ${s.start}–${s.end || "?"}`;

async function startFix(from, staff, tenantId, deps, sendOpts) {
  const timezone = await tz(deps, tenantId);
  const shifts = await recentShifts(staff, tenantId, deps, timezone);
  flows.set(from, { step: "shift", at: Date.now(), tenantId, timezone, shifts });
  const rows = shifts.map((s) => [shiftLabel(s)]);
  rows.push([ANOTHER], [CANCEL]);
  await sendChoices(from, "📝 Timesheet fix. Which shift?\n🎤 Easier to talk? Hold the mic and tell me what happened.", rows, sendOpts);
}

async function ask(from, f, sendOpts) {
  if (f.step === "date") return sendText(from, 'Which day? Type the date, like 8/11, or "yesterday".', sendOpts);
  if (f.step === "what") return sendChoices(from, `${label(f.date)}. What happened?`, WHAT.map((w) => [w]).concat([[CANCEL]]), sendOpts);
  if (f.step === "confirm") {
    return sendChoices(from, `Worked as rostered: ${f.start}–${f.end} with ${breakText(f.breakMins)}?`, [["Yes, as rostered"], ["No, different times"], [CANCEL]], sendOpts);
  }
  if (f.step === "times") return sendText(from, 'Type your start and finish, and your break. For example:\n14:30-22:30 break 30\n(or "no break")\n\n🎤 Or just hold the mic and say it.', sendOpts);
  if (f.step === "reason") return sendChoices(from, "Reason? One line, e.g. phone was flat. 🎤 Or send a voice note.", [["Skip"]], sendOpts);
}

/** @returns {Promise<boolean>} true when the message was part of a fix conversation. */
async function handleFixMessage(from, staff, body, tenantId, deps, sendOpts) {
  const raw = String(body || "").trim();
  const low = raw.toLowerCase();
  let f = flows.get(from);
  if (f && Date.now() - f.at > TTL) { flows.delete(from); f = null; }

  if (!f) {
    if (!START_RE.test(low)) return false;
    await startFix(from, staff, tenantId, deps, sendOpts);
    return true;
  }
  f.at = Date.now();
  if (low === "cancel" || low === "stop") {
    flows.delete(from);
    await sendText(from, "Okay, nothing sent.", sendOpts);
    return true;
  }

  if (f.step === "shift") {
    if (low === ANOTHER.toLowerCase()) { f.step = "date"; await ask(from, f, sendOpts); return true; }
    const pick = f.shifts.find((s) => shiftLabel(s).toLowerCase() === low);
    const date = pick ? pick.date : parseDate(raw, P.todayIn(f.timezone));
    if (!date) { await sendText(from, 'Tap one of the shifts, or "Another day".', sendOpts); return true; }
    Object.assign(f, { date, rostered: pick && !pick.clocked ? pick : null, start: pick ? pick.start : null, end: pick ? pick.end : null, breakMins: pick ? pick.breakMins : null });
    f.step = "what"; await ask(from, f, sendOpts); return true;
  }
  if (f.step === "date") {
    const date = parseDate(raw, P.todayIn(f.timezone));
    if (!date) { await sendText(from, "I couldn't read that date. Try 8/11 (day/month), within the last two weeks.", sendOpts); return true; }
    Object.assign(f, { date, rostered: null, start: null, end: null, breakMins: null });
    f.step = "what"; await ask(from, f, sendOpts); return true;
  }
  if (f.step === "what") {
    const what = WHAT.find((w) => w.toLowerCase() === low);
    if (!what) { await ask(from, f, sendOpts); return true; }
    f.what = what;
    f.step = f.rostered && what !== WHAT[3] && f.end ? "confirm" : "times";
    await ask(from, f, sendOpts); return true;
  }
  if (f.step === "confirm") {
    if (/^yes/.test(low)) { f.step = "reason"; await ask(from, f, sendOpts); return true; }
    if (/^no/.test(low)) { f.step = "times"; await ask(from, f, sendOpts); return true; }
    await ask(from, f, sendOpts); return true;
  }
  if (f.step === "times") {
    const t = parseTimes(raw);
    if (!t) { await sendText(from, "I couldn't read that. Try: 14:30-22:30 break 30", sendOpts); return true; }
    Object.assign(f, { start: t.start, end: t.end, breakMins: t.breakMins != null ? t.breakMins : (f.breakMins != null ? f.breakMins : 0) });
    f.step = "reason"; await ask(from, f, sendOpts); return true;
  }
  if (f.step === "reason") {
    const reason = low === "skip" ? "" : raw.slice(0, 200);
    flows.delete(from);
    const doc = await saveRequest(tenantId, {
      tenantId, workerId: String(staff.phone), name: staff.name || String(staff.phone),
      date: f.date, in: f.start, out: f.end, breakMins: f.breakMins || 0,
      what: f.what, reason, status: "pending", createdAt: new Date().toISOString(),
    });
    await sendText(from, `✅ Sent to your manager: ${label(f.date)}, ${f.start}–${f.end}, ${breakText(f.breakMins)}. You'll get a message when it's approved.`, sendOpts);
    await tellManagers(tenantId, deps, `📝 ${doc.name} asked for a timesheet fix: ${label(f.date)}, ${f.start}–${f.end}, ${breakText(f.breakMins)} (${f.what.toLowerCase()})${reason ? ` — "${reason}"` : ""}. Approve it on Today → Timesheet fixes.`);
    return true;
  }
  flows.delete(from);
  return false;
}

/**
 * A voice note. Inside a fix conversation it becomes the reason (or replaces typing the times);
 * on its own it starts a request "see voice note". Either way the manager gets the voice note itself.
 * No transcription: the manager listens and sets the times with one tap on Today.
 */
async function handleFixVoice(from, staff, voice, tenantId, deps, sendOpts) {
  let f = flows.get(from);
  if (f && Date.now() - f.at > TTL) { flows.delete(from); f = null; }
  const timezone = f ? f.timezone : await tz(deps, tenantId);
  const date = f && f.date ? f.date : P.todayIn(timezone);
  const haveTimes = f && f.start && f.end && (f.step === "reason" || f.step === "confirm");
  flows.delete(from);
  const doc = await saveRequest(tenantId, {
    tenantId, workerId: String(staff.phone), name: staff.name || String(staff.phone),
    date, in: haveTimes ? f.start : null, out: haveTimes ? f.end : null, breakMins: haveTimes ? (f.breakMins || 0) : null,
    what: (f && f.what) || "Voice note", reason: "🎤 voice note", voiceFileId: voice.id, voiceSecs: voice.duration || 0,
    datePicked: Boolean(f && f.date), status: "pending", createdAt: new Date().toISOString(),
  });
  await sendText(from, "🎤 Got your voice note. It's gone to your manager, who will fix your timesheet and let you know.", sendOpts);
  const what = haveTimes ? `${label(date)}, ${f.start}–${f.end}` : (f && f.date ? label(date) : "day not picked");
  await tellManagers(tenantId, deps, `🎤 ${doc.name} sent a voice note about a timesheet fix (${what}). Set the times on Today → Timesheet fixes.`, voice.id);
  return true;
}

async function tellManagers(tenantId, deps, text, voiceId) {
  if (!deps.staffStore || !deps.staffStore.listByTenant) return;
  const crew = await deps.staffStore.listByTenant(tenantId);
  const bosses = crew.filter((s) => ["manager", "owner", "admin"].includes(s.role) && s.active !== false && s.telegramChatId);
  const tg = require("./telegramClient");
  for (const b of bosses) {
    if (voiceId) await tg.sendVoice(b.telegramChatId, voiceId, text).catch(() => sendText(String(b.phone), text, { channel: "telegram", chatId: b.telegramChatId }).catch(() => {}));
    else await sendText(String(b.phone), text, { channel: "telegram", chatId: b.telegramChatId }).catch(() => {});
  }
}

module.exports = {
  handleFixMessage, handleFixVoice, parseTimes, parseDate, listPending, getRequest, updateRequest, saveRequest, tellManagers,
  _flows: flows, _mem: mem,
};
