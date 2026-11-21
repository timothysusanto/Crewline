"use strict";

const { sendText, sendButtons } = require("./whatsapp");
const { availabilityLink, isConfigured: linksConfigured } = require("./signedLinks");
const {
  BLOCKS, BLOCK_LABEL, weekStartOf, weekDates, parseShorthand, expandPattern,
  patternFromDays, describeDays, describePattern, describeWeek, normalizeBlocks,
} = require("./availabilityBlocks");
const { isSubmitted } = require("./availabilityStore");

/**
 * Capture — nobody in the office types availability.
 *
 * The ladder from docs/agencymodelshape.md, in order of leverage. Each rung
 * catches most of whoever is left:
 *
 *   1. "same"           — one word repeats last week. Should resolve the clear
 *                         majority of a settled pool, and is the highest-leverage
 *                         thing in the whole design.
 *   2. standing pattern — captured once at onboarding, turns the weekly ping
 *                         into confirm-or-amend.
 *   3. the grid         — a signed one-tap link, twenty seconds, no login.
 *   4. shorthand        — "mon am pm, wed night, fri all", for the typists.
 *                         Costs nothing to keep, will always be a minority.
 *   5. "today"          — the free-today pool, the same-day answer.
 *
 * Weekly cycle: **ask Wednesday, chase Friday, expire with the week** — so
 * supply is on the board before the hotels' requests land.
 */

/** Local day-of-week for the two ping days. 3 = Wednesday, 5 = Friday. */
const ASK_DAY = 3;
const CHASE_DAY = 5;
/** Not before this hour, so nobody is pinged at 3am. */
const PING_HOUR = 9;

/** The week the weekly ping is about: always the one after the current week. */
function nextWeekStart(now = new Date()) {
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + 7);
  return weekStartOf(next);
}

/* ------------------------------------------------------------- the ping text */

function linkLine(tenantId, phone, weekStart) {
  if (!linksConfigured()) {
    // Degrade to shorthand rather than sending a broken link. The operator sees
    // why in the logs; the staff member still has a way to answer.
    return 'Or type it, e.g. "mon am pm, wed night, fri all".';
  }
  return `Or tap to change it: ${availabilityLink(tenantId, phone, weekStart)}`;
}

/**
 * The Wednesday ping. Shape depends on what we already know about this person,
 * which is what turns it from a form into a one-tap confirmation:
 *
 *   - answered before   -> "Last week you were free X. Reply SAME."
 *   - standing pattern  -> "You normally work X. Reply SAME."
 *   - neither           -> the link and the shorthand hint.
 */
function buildPing({ staff, weekStart, previous, chase }) {
  const lines = [];
  lines.push(`${chase ? "Quick reminder — n" : "N"}ext week, ${describeWeek(weekStart)}.`);

  const previousDays = previous && isSubmitted(previous) ? previous.days : null;
  const standing = staff.standingPattern;

  if (previousDays && Object.keys(previousDays).length) {
    lines.push(`Last week you were free ${describeDays(previousDays)}.`);
    lines.push('Tap Same again to repeat it, or Can\'t work if you\'re not available.');
  } else if (standing && Object.keys(standing).length) {
    lines.push(`You normally work ${describePattern(standing)}.`);
    lines.push('Tap Same again to confirm that, or Can\'t work if you\'re not available.');
  } else {
    lines.push("Tell us which shifts you can work so your manager can roster you.");
    lines.push('Tap Can\'t work if you\'re not available next week.');
  }

  lines.push(linkLine(staff.tenantId, staff.phone, weekStart));
  return lines.join("\n");
}

/**
 * Sends the weekly ping and the Friday chase.
 *
 * Idempotent on `askedAt` / `chasedAt`, so the dispatcher's 30-second tick can
 * call this all Wednesday without pinging anybody twice. Marking asked never
 * touches `submittedAt`: sending a question must not turn silence into an
 * answer.
 *
 * @returns {Promise<{asked: number, chased: number, weekStart: string}>}
 */
async function sweepWeeklyPings(tenantId, deps, sendOpts = {}, now = new Date()) {
  const { staffStore, availabilityStore } = deps;
  const weekStart = nextWeekStart(now);
  const result = { asked: 0, chased: 0, weekStart };
  if (!availabilityStore) return result;

  const day = now.getDay();
  const isAskDay = day === ASK_DAY;
  const isChaseDay = day === CHASE_DAY;
  if ((!isAskDay && !isChaseDay) || now.getHours() < PING_HOUR) return result;

  // Casuals only. Permanent staff are rostered on their contract and managers build the roster —
  // asking them every Wednesday what they can work is noise.
  const pool = (await staffStore.listByTenant(tenantId)).filter(wantsAvailabilityPing);

  for (const staff of pool) {
    const doc = await availabilityStore.find(tenantId, staff.phone, weekStart);

    // Already answered: never chase somebody who has replied.
    if (isSubmitted(doc)) continue;

    if (isAskDay && (!doc || !doc.askedAt)) {
      await sendPing(staff, weekStart, deps, sendOpts, false);
      await availabilityStore.markAsked(tenantId, staff.phone, weekStart, "askedAt");
      result.asked += 1;
      continue;
    }

    // Friday: only chase people who were actually asked and stayed silent.
    if (isChaseDay && doc && doc.askedAt && !doc.chasedAt) {
      await sendPing(staff, weekStart, deps, sendOpts, true);
      await availabilityStore.markAsked(tenantId, staff.phone, weekStart, "chasedAt");
      result.chased += 1;
    }
  }

  if (result.asked || result.chased) {
    console.log(
      `[availability] week ${weekStart}: asked ${result.asked}, chased ${result.chased}`
    );
  }
  return result;
}

async function sendPing(staff, weekStart, deps, sendOpts, chase) {
  const { availabilityStore } = deps;
  try {
    const previous = await availabilityStore.findPreviousSubmitted(
      staff.tenantId, staff.phone, weekStart
    );
    const hasPattern = (previous && isSubmitted(previous) && Object.keys(previous.days || {}).length) || (staff.standingPattern && Object.keys(staff.standingPattern).length);
    const row = hasPattern ? [{ text: "🔁 Same again", data: "same" }, { text: "🚫 Can't work", data: "none" }] : [{ text: "🚫 Can't work", data: "none" }];
    await sendButtons(staff.phone, buildPing({ staff, weekStart, previous, chase }), [row], sendOpts);
  } catch (err) {
    // One unreachable number must not stop the other 299 pings.
    console.error(`[availability] ping to ${staff.phone} failed:`, err.message);
  }
}

/** Who the weekly "what can you work?" goes to: active casual crew, never managers or permanent staff. */
function wantsAvailabilityPing(staff) {
  if (!staff || staff.active === false) return false;
  if (["owner", "manager", "admin"].includes(staff.role)) return false;
  return !["fulltime", "parttime"].includes(staff.employmentType);
}

/**
 * "Next week's availability" from the More menu: what they've said so far, and the ways to change it.
 * Nothing is saved by opening it — the two buttons do that.
 */
async function handleAvailabilityMenu(from, staff, deps, sendOpts = {}, now = new Date()) {
  const { availabilityStore } = deps;
  const weekStart = nextWeekStart(now);
  const doc = availabilityStore ? await availabilityStore.find(staff.tenantId, from, weekStart) : null;
  const said = !isSubmitted(doc) ? "You haven't answered yet."
    : Object.keys(doc.days || {}).length ? `You said: ${describeDays(doc.days)}.` : "You said you can't work that week.";
  await sendButtons(
    from,
    `🗓 Next week, ${describeWeek(weekStart)}.\n${said}\n${linkLine(staff.tenantId, from, weekStart)}`,
    [[{ text: "🔁 Same as last time", data: "same" }, { text: "🚫 Can't work that week", data: "none" }]],
    sendOpts
  );
  return true;
}

/* ------------------------------------------------------- the staff-side words */

const SAME_RE = /^(same|same again|as usual|usual|repeat)\b/;
const NONE_RE = /^(none|nothing|not available|unavailable|no shifts)\b/;

/** Whether a message is one of the availability words. */
function looksLikeAvailabilityReply(body) {
  return SAME_RE.test(body) || NONE_RE.test(body);
}

/**
 * "same" — rung 1. Repeats the most recent week they answered for, or their
 * standing pattern if they have never answered. Refuses rather than guessing
 * when there is neither, because inventing an answer here would put somebody on
 * a roster they never agreed to.
 */
async function handleSameAgain(from, staff, deps, sendOpts = {}, now = new Date()) {
  const { availabilityStore } = deps;
  const weekStart = nextWeekStart(now);

  const previous = await availabilityStore.findPreviousSubmitted(staff.tenantId, from, weekStart);
  let days = null;
  let source = null;

  if (previous && Object.keys(previous.days || {}).length) {
    days = expandPattern(patternFromDays(previous.days), weekStart);
    source = "same-again";
  } else if (staff.standingPattern && Object.keys(staff.standingPattern).length) {
    days = expandPattern(staff.standingPattern, weekStart);
    source = "standing-pattern";
  }

  if (!days || !Object.keys(days).length) {
    await sendText(
      from,
      "I don't have a previous week to copy yet. Tell me which shifts you can work — " +
        'e.g. "mon am pm, wed night, fri all" — and "same" will work from then on.',
      sendOpts
    );
    return true;
  }

  await availabilityStore.submit(staff.tenantId, from, weekStart, days, source);
  await sendText(
    from,
    `Saved for ${describeWeek(weekStart)}: ${describeDays(days)}.\nYour manager sees this when building the roster.`,
    sendOpts
  );
  return true;
}

/**
 * "none" — an explicit no for the week. Recorded as a real answer, not silence,
 * so the blast engine stops offering them shifts instead of treating them as
 * merely unheard-from.
 */
async function handleNotAvailable(from, staff, deps, sendOpts = {}, now = new Date()) {
  const { availabilityStore } = deps;
  const weekStart = nextWeekStart(now);
  await availabilityStore.submitNone(staff.tenantId, from, weekStart, "shorthand");
  await sendText(
    from,
    `Noted — you're down as not available for ${describeWeek(weekStart)}. ` +
      'Tap More, then Next week\'s availability, any time if that changes.',
    sendOpts
  );
  return true;
}


/**
 * Rung 4 — the text shorthand. Also the fallback for anything that parses as
 * days and blocks, so somebody who types their week out longhand is understood
 * without having to learn the exact format.
 *
 * Returns false when nothing readable was found, so the router can fall through
 * to the help text rather than claiming to have understood.
 */
async function handleShorthand(from, staff, body, deps, sendOpts = {}, now = new Date()) {
  const { availabilityStore } = deps;
  const { pattern, unknown } = parseShorthand(body);
  // Only when the WHOLE message is days and shifts. "see you friday" is a chat message, not availability.
  if (!Object.keys(pattern).length || unknown.length) return false;

  const weekStart = nextWeekStart(now);
  const days = expandPattern(pattern, weekStart);
  await availabilityStore.submit(staff.tenantId, from, weekStart, days, "shorthand");

  await sendText(from, `Saved for ${describeWeek(weekStart)}: ${describeDays(days)}.`, sendOpts);
  return true;
}

/** Everything the availability grid page needs to render one person's week. */
function gridModel(doc, weekStart) {
  const days = (doc && doc.days) || {};
  return {
    weekStart,
    weekLabel: describeWeek(weekStart),
    blocks: BLOCKS.map((block) => ({ key: block, label: BLOCK_LABEL[block] })),
    dates: weekDates(weekStart).map((dateIso) => ({
      dateIso,
      label: new Date(`${dateIso}T12:00:00`).toLocaleDateString("en-AU", {
        weekday: "short", day: "numeric", month: "short",
      }),
      selected: normalizeBlocks(days[dateIso]),
    })),
    submittedAt: (doc && doc.submittedAt) || null,
  };
}

module.exports = {
  sweepWeeklyPings,
  buildPing,
  nextWeekStart,
  looksLikeAvailabilityReply,
  handleSameAgain,
  handleNotAvailable,
  handleShorthand,
  handleAvailabilityMenu,
  wantsAvailabilityPing,
  gridModel,
  SAME_RE,
  NONE_RE,
  ASK_DAY,
  CHASE_DAY,
  PING_HOUR,
};
