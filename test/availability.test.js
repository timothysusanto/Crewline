"use strict";

/**
 * Availability and the free-today pool — build order step 3 of
 * docs/agencymodelshape.md.
 *
 * The load-bearing claim under test is the three-state model: available,
 * unavailable, and unknown. Silence is never a yes, and it is never a no either.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  blockFor, parseShorthand, expandPattern, patternFromDays, describeDays,
  describeWeek, weekStartOf, weekDates, normalizeBlocks, dayKeyOf,
} = require("../availabilityBlocks");
const {
  InMemoryAvailabilityStore, stateFor, stateForShift, isSubmitted,
  declaredCellCount, STATES,
} = require("../availabilityStore");
const { InMemoryStaffStore } = require("../store");
const { InMemorySiteStore } = require("../siteStore");
const { InMemoryRosterStore } = require("../rosterStore");
const { InMemoryShiftsStore } = require("../shiftsStore");
const { InMemoryTenantStore } = require("../tenantStore");
const {
  sweepWeeklyPings, handleSameAgain, handleNotAvailable,
  handleShorthand, nextWeekStart, buildPing, gridModel, looksLikeAvailabilityReply,
} = require("../availabilityCapture");
const signedLinks = require("../signedLinks");

const HILTON = { lat: -33.8710, lng: 151.2073, radiusMeters: 75 };
const HOURS = 60 * 60 * 1000;

process.env.WHATSAPP_PHONE_NUMBER_ID = "test-number";
process.env.WHATSAPP_TOKEN = "test-token";

function captureMessages() {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    sent.push({ to: payload.to, body: payload.text ? payload.text.body : "(interactive)" });
    return { ok: true, json: async () => ({}) };
  };
  return {
    sent,
    restore() { globalThis.fetch = realFetch; },
    to(phone) { return sent.filter((m) => m.to === phone); },
    lastTo(phone) { return this.to(phone).at(-1); },
  };
}

function buildDeps() {
  const siteStore = new InMemorySiteStore();
  siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  return {
    staffStore: new InMemoryStaffStore(),
    siteStore,
    tenantStore: new InMemoryTenantStore(),
    availabilityStore: new InMemoryAvailabilityStore(),
    rosterStore: new InMemoryRosterStore(),
    shiftsStore: new InMemoryShiftsStore(),
  };
}

function addStaff(deps, phone, name, extra = {}) {
  const record = {
    phone, tenantId: "agency", name, role: "staff", department: "housekeeping", ...extra,
  };
  deps.staffStore.upsert(record);
  return record;
}

/* ------------------------------------------------------- the three blocks */

test("a shift's block is decided by its start, not its span", () => {
  // The design note's own example: a 17:00–23:00 dinner service is simply PM.
  assert.equal(blockFor("2026-08-12T17:00:00").block, "PM");
  assert.equal(blockFor("2026-08-12T06:00:00").block, "AM");
  assert.equal(blockFor("2026-08-12T13:59:00").block, "AM");
  assert.equal(blockFor("2026-08-12T14:00:00").block, "PM");
  assert.equal(blockFor("2026-08-12T21:59:00").block, "PM");
  assert.equal(blockFor("2026-08-12T22:00:00").block, "NIGHT");
});

test("a night belongs to the date it starts on", () => {
  // "Friday night" means Friday into Saturday, because that is what staff mean.
  const lateFriday = blockFor("2026-08-14T22:30:00");
  assert.deepEqual(lateFriday, { block: "NIGHT", dateIso: "2026-08-14" });

  // 01:00 Saturday is still Friday night.
  const earlySaturday = blockFor("2026-08-15T01:00:00");
  assert.deepEqual(earlySaturday, { block: "NIGHT", dateIso: "2026-08-14" });

  // 06:00 Saturday is Saturday AM, not Friday night.
  assert.deepEqual(blockFor("2026-08-15T06:00:00"), { block: "AM", dateIso: "2026-08-15" });
});

test("a week is 7 dates from a Monday, and 21 cells", () => {
  assert.equal(weekStartOf("2026-08-13T12:00:00"), "2026-08-10"); // a Thursday
  assert.equal(weekStartOf("2026-08-16T12:00:00"), "2026-08-10"); // the Sunday
  assert.equal(weekStartOf("2026-08-17T12:00:00"), "2026-08-17"); // the next Monday
  const dates = weekDates("2026-08-10");
  assert.equal(dates.length, 7);
  assert.equal(dates[0], "2026-08-10");
  assert.equal(dates[6], "2026-08-16");
  assert.equal(dayKeyOf("2026-08-10"), "mon");
  assert.equal(dayKeyOf("2026-08-16"), "sun");
});

/* --------------------------------------------------------------- shorthand */

test("the text shorthand reads what people actually type", () => {
  assert.deepEqual(parseShorthand("mon am pm, wed night, fri all").pattern, {
    mon: ["AM", "PM"],
    wed: ["NIGHT"],
    fri: ["AM", "PM", "NIGHT"],
  });
  // A bare day means the whole day.
  assert.deepEqual(parseShorthand("sat").pattern, { sat: ["AM", "PM", "NIGHT"] });
  // Ranges, and the long day names.
  assert.deepEqual(parseShorthand("mon-wed am").pattern, {
    mon: ["AM"], tue: ["AM"], wed: ["AM"],
  });
  assert.deepEqual(parseShorthand("saturday nights").pattern, { sat: ["NIGHT"] });
  // Blocks always come back in AM/PM/NIGHT order, whatever order they arrived.
  assert.deepEqual(parseShorthand("tue night am").pattern, { tue: ["AM", "NIGHT"] });
});

test("shorthand reports what it could not read instead of dropping it", () => {
  const { pattern, unknown } = parseShorthand("mon am, blursday pm");
  assert.deepEqual(pattern, { mon: ["AM"] });
  assert.ok(unknown.includes("blursday"));
  // A block with no day isn't enough to act on.
  assert.deepEqual(parseShorthand("am pm").pattern, {});
});

test("a pattern round-trips through a real week", () => {
  const pattern = { mon: ["AM"], wed: ["AM", "PM"], fri: ["NIGHT"] };
  const days = expandPattern(pattern, "2026-08-10");
  assert.deepEqual(days, {
    "2026-08-10": ["AM"],
    "2026-08-12": ["AM", "PM"],
    "2026-08-14": ["NIGHT"],
  });
  assert.deepEqual(patternFromDays(days), pattern);
  assert.equal(describeDays(days), "Mon AM, Wed AM/PM, Fri Night");
  assert.equal(describeWeek("2026-08-10"), "10–16 Aug");
});

/* ------------------------------------------------ three states, not two */

test("silence is unknown — not a yes, and not a no", async () => {
  const store = new InMemoryAvailabilityStore();

  // Never heard from: unknown.
  assert.equal(stateFor(null, "2026-08-10", "AM"), STATES.UNKNOWN);

  // We asked and they didn't reply. Still unknown — this is the case that
  // sending the weekly ping must not corrupt.
  await store.markAsked("agency", "614001", "2026-08-10", "askedAt");
  const asked = await store.find("agency", "614001", "2026-08-10");
  assert.ok(asked.askedAt, "the ping was recorded");
  assert.equal(isSubmitted(asked), false);
  assert.equal(stateFor(asked, "2026-08-10", "AM"), STATES.UNKNOWN);

  // Chased on Friday, still silent. Still unknown.
  await store.markAsked("agency", "614001", "2026-08-10", "chasedAt");
  const chased = await store.find("agency", "614001", "2026-08-10");
  assert.equal(stateFor(chased, "2026-08-10", "AM"), STATES.UNKNOWN);
});

test("answering makes every unlisted cell a real no", async () => {
  const store = new InMemoryAvailabilityStore();
  await store.submit("agency", "614001", "2026-08-10", { "2026-08-10": ["AM"] }, "grid");
  const doc = await store.find("agency", "614001", "2026-08-10");

  assert.equal(stateFor(doc, "2026-08-10", "AM"), STATES.AVAILABLE);
  // They answered, so the blocks they left off are declined, not unheard-of.
  assert.equal(stateFor(doc, "2026-08-10", "PM"), STATES.UNAVAILABLE);
  assert.equal(stateFor(doc, "2026-08-11", "AM"), STATES.UNAVAILABLE);
  assert.equal(declaredCellCount(doc), 1);
});

test("an explicit none is an answer, distinguishable from silence", async () => {
  const store = new InMemoryAvailabilityStore();
  await store.submitNone("agency", "614001", "2026-08-10", "shorthand");
  const doc = await store.find("agency", "614001", "2026-08-10");

  assert.equal(isSubmitted(doc), true);
  assert.equal(declaredCellCount(doc), 0);
  assert.equal(stateFor(doc, "2026-08-10", "AM"), STATES.UNAVAILABLE);
});

test("a shift is matched against the block its start falls in", async () => {
  const store = new InMemoryAvailabilityStore();
  await store.submit("agency", "614001", "2026-08-10", { "2026-08-14": ["NIGHT"] }, "grid");
  const doc = await store.find("agency", "614001", "2026-08-10");

  // A 22:30 Friday start is Friday NIGHT.
  assert.equal(stateForShift(doc, "2026-08-14T22:30:00"), STATES.AVAILABLE);
  // So is 01:00 on the Saturday — same night.
  assert.equal(stateForShift(doc, "2026-08-15T01:00:00"), STATES.AVAILABLE);
  // Friday morning is not.
  assert.equal(stateForShift(doc, "2026-08-14T07:00:00"), STATES.UNAVAILABLE);
});

test("last week's answer is never reused as this week's", async () => {
  const store = new InMemoryAvailabilityStore();
  await store.submit("agency", "614001", "2026-08-03", { "2026-08-03": ["AM"] }, "grid");

  // A casual with a second job has a different answer every week.
  const thisWeek = await store.find("agency", "614001", "2026-08-10");
  assert.equal(thisWeek, null);
  assert.equal(stateFor(thisWeek, "2026-08-10", "AM"), STATES.UNKNOWN);

  // It is available to copy from, but only on purpose.
  const previous = await store.findPreviousSubmitted("agency", "614001", "2026-08-10");
  assert.equal(previous.weekStart, "2026-08-03");
});

/* ------------------------------------------------------- the wave tiers */

test("\"same\" repeats last week in one word", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Maria");
  const msg = captureMessages();
  try {
    const now = new Date("2026-08-12T10:00:00"); // a Wednesday
    const target = nextWeekStart(now);
    const previousWeek = weekStartOf(now);
    await deps.availabilityStore.submit(
      "agency", staff.phone, previousWeek,
      expandPattern({ mon: ["AM"], wed: ["AM", "PM"], fri: ["AM"] }, previousWeek),
      "grid"
    );

    await handleSameAgain(staff.phone, staff, deps, {}, now);

    const doc = await deps.availabilityStore.find("agency", staff.phone, target);
    assert.equal(isSubmitted(doc), true);
    assert.equal(doc.source, "same-again");
    // Same days of the week, shifted onto the new week's dates.
    assert.deepEqual(patternFromDays(doc.days), { mon: ["AM"], wed: ["AM", "PM"], fri: ["AM"] });
    assert.match(msg.lastTo(staff.phone).body, /Locked in/);
  } finally {
    msg.restore();
  }
});

test("\"same\" falls back to the standing pattern, and refuses to invent one", async () => {
  const deps = buildDeps();
  const withPattern = addStaff(deps, "614001", "Ahmed", {
    standingPattern: { mon: ["AM"], tue: ["AM"], wed: ["AM"], thu: ["AM"], fri: ["AM"] },
  });
  const blank = addStaff(deps, "614002", "New starter");
  const msg = captureMessages();
  try {
    const now = new Date("2026-08-12T10:00:00");
    const target = nextWeekStart(now);

    await handleSameAgain(withPattern.phone, withPattern, deps, {}, now);
    const doc = await deps.availabilityStore.find("agency", withPattern.phone, target);
    assert.equal(doc.source, "standing-pattern");
    assert.equal(declaredCellCount(doc), 5);

    // Nothing to copy: putting somebody on a roster they never agreed to would
    // be worse than asking again.
    await handleSameAgain(blank.phone, blank, deps, {}, now);
    assert.equal(await deps.availabilityStore.find("agency", blank.phone, target), null);
    assert.match(msg.lastTo(blank.phone).body, /don't have a previous week/);
  } finally {
    msg.restore();
  }
});

test("shorthand and \"none\" both record a real answer", async () => {
  const deps = buildDeps();
  const typist = addStaff(deps, "614001", "Typist");
  const busy = addStaff(deps, "614002", "Busy");
  const msg = captureMessages();
  try {
    const now = new Date("2026-08-12T10:00:00");
    const target = nextWeekStart(now);

    assert.equal(await handleShorthand(typist.phone, typist, "mon am pm, fri all", deps, {}, now), true);
    const doc = await deps.availabilityStore.find("agency", typist.phone, target);
    assert.deepEqual(patternFromDays(doc.days), { mon: ["AM", "PM"], fri: ["AM", "PM", "NIGHT"] });

    await handleNotAvailable(busy.phone, busy, deps, {}, now);
    const none = await deps.availabilityStore.find("agency", busy.phone, target);
    assert.equal(isSubmitted(none), true);
    assert.equal(declaredCellCount(none), 0);
    assert.match(msg.lastTo(busy.phone).body, /not available/);
  } finally {
    msg.restore();
  }
});

test("shorthand declines a message it cannot parse rather than guessing", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Maria");
  const msg = captureMessages();
  try {
    const handled = await handleShorthand(staff.phone, staff, "what's my pay rate", deps, {});
    assert.equal(handled, false, "the router must be able to fall through to help");
    assert.equal(msg.sent.length, 0);
  } finally {
    msg.restore();
  }
});

test("the availability words don't shadow the other commands", () => {
  for (const word of ["same", "same again", "none"]) {
    assert.ok(looksLikeAvailabilityReply(word), `"${word}" should be an availability word`);
  }
  for (const other of ["in", "out", "break", "back", "roster", "yes", "no", "spend 420"]) {
    assert.equal(looksLikeAvailabilityReply(other), false, `"${other}" must not be`);
  }
});

/* -------------------------------------------- ask Wednesday, chase Friday */

test("the ping goes out Wednesday and chases Friday, once each", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Maria");
  const msg = captureMessages();
  try {
    const wednesday = new Date("2026-08-12T09:30:00");
    const friday = new Date("2026-08-14T09:30:00");
    const target = nextWeekStart(wednesday);

    // Tuesday: nothing.
    let result = await sweepWeeklyPings("agency", deps, {}, new Date("2026-08-11T09:30:00"));
    assert.deepEqual([result.asked, result.chased], [0, 0]);

    // Wednesday before 9am: still nothing — nobody gets pinged at 3am.
    result = await sweepWeeklyPings("agency", deps, {}, new Date("2026-08-12T06:00:00"));
    assert.equal(result.asked, 0);

    // Wednesday morning: asked.
    result = await sweepWeeklyPings("agency", deps, {}, wednesday);
    assert.equal(result.asked, 1);

    // The tick runs every 30 seconds all Wednesday and must not ping again.
    for (const minutes of [1, 5, 240]) {
      const later = new Date(wednesday.getTime() + minutes * 60000);
      assert.equal((await sweepWeeklyPings("agency", deps, {}, later)).asked, 0);
    }

    // Friday: chased once.
    assert.equal((await sweepWeeklyPings("agency", deps, {}, friday)).chased, 1);
    assert.equal((await sweepWeeklyPings("agency", deps, {}, friday)).chased, 0);
    assert.equal(msg.to(staff.phone).length, 2);

    // And asking never invented an answer.
    const doc = await deps.availabilityStore.find("agency", staff.phone, target);
    assert.ok(doc.askedAt && doc.chasedAt);
    assert.equal(isSubmitted(doc), false);
  } finally {
    msg.restore();
  }
});

test("somebody who has answered is never chased", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Maria");
  const msg = captureMessages();
  try {
    const wednesday = new Date("2026-08-12T09:30:00");
    await sweepWeeklyPings("agency", deps, {}, wednesday);
    await handleShorthand(staff.phone, staff, "mon am", deps, {}, wednesday);

    const chased = await sweepWeeklyPings("agency", deps, {}, new Date("2026-08-14T09:30:00"));
    assert.equal(chased.chased, 0);
  } finally {
    msg.restore();
  }
});

test("the ping is confirm-or-amend, not a blank form", async () => {
  const staff = {
    phone: "614001", tenantId: "agency", name: "Maria",
    standingPattern: { mon: ["AM"], fri: ["AM"] },
  };
  const previous = {
    submittedAt: "2026-08-05T10:00:00.000Z",
    days: { "2026-08-03": ["AM"], "2026-08-05": ["AM", "PM"] },
  };

  const withHistory = buildPing({ staff, weekStart: "2026-08-17", previous, chase: false });
  assert.match(withHistory, /Next week, 17–23 Aug/);
  assert.match(withHistory, /Last week you were free Mon AM, Wed AM\/PM/);
  assert.match(withHistory, /Reply SAME/);

  // No history: fall back to the standing pattern, still one word to confirm.
  const patternOnly = buildPing({ staff, weekStart: "2026-08-17", previous: null, chase: false });
  assert.match(patternOnly, /You normally work Mon AM, Fri AM/);

  // Neither: don't pretend to know anything.
  const blank = buildPing({
    staff: { phone: "614002", tenantId: "agency", name: "New" },
    weekStart: "2026-08-17", previous: null, chase: false,
  });
  assert.doesNotMatch(blank, /Last week|normally work/);
  assert.match(blank, /Reply NONE/);

  assert.match(buildPing({ staff, weekStart: "2026-08-17", previous, chase: true }), /reminder/i);
});

/* --------------------------------------------------------- signed links */

test("a link is scoped to one person and one week, and cannot be edited", () => {
  process.env.LINK_SIGNING_SECRET = "a-test-secret-of-sufficient-length";

  const token = signedLinks.sign({
    scope: "availability", tenantId: "agency", phone: "614001", weekStart: "2026-08-17",
  });
  const check = signedLinks.verify(token);
  assert.equal(check.ok, true);
  assert.equal(check.claims.phone, "614001");
  assert.equal(check.claims.weekStart, "2026-08-17");

  // Editing the payload to point at somebody else breaks the signature.
  const [body] = token.split(".");
  const tampered = Buffer.from(
    JSON.stringify({ s: "availability", t: "agency", p: "614999", w: "2026-08-17", x: Date.now() + 1000 })
  ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(signedLinks.verify(`${tampered}.${body}`).ok, false);
  assert.equal(signedLinks.verify("not-a-token").reason, "MALFORMED");
  assert.equal(signedLinks.verify(`${body}.AAAA`).ok, false);
});

test("an expired link is refused, and a missing secret refuses to sign", () => {
  process.env.LINK_SIGNING_SECRET = "a-test-secret-of-sufficient-length";
  const expired = signedLinks.sign({
    scope: "availability", tenantId: "agency", phone: "614001",
    weekStart: "2026-08-17", ttlMs: -1000,
  });
  assert.equal(signedLinks.verify(expired).reason, "EXPIRED");

  // An unsigned link would let anyone submit anyone's week by editing a URL.
  delete process.env.LINK_SIGNING_SECRET;
  assert.equal(signedLinks.isConfigured(), false);
  assert.throws(() => signedLinks.sign({ scope: "availability", tenantId: "a", phone: "b", weekStart: "c" }), /LINK_SIGNING_SECRET/);
  process.env.LINK_SIGNING_SECRET = "a-test-secret-of-sufficient-length";
});

/* --------------------------------------------------------------- the grid */

test("the grid model gives the page 7 days x 3 blocks with the answer marked", () => {
  const model = gridModel(
    { days: { "2026-08-12": ["AM", "NIGHT"] }, submittedAt: "2026-08-10T10:00:00Z" },
    "2026-08-10"
  );
  assert.equal(model.dates.length, 7);
  assert.equal(model.blocks.length, 3);
  assert.equal(model.dates.length * model.blocks.length, 21);
  const wed = model.dates.find((d) => d.dateIso === "2026-08-12");
  assert.deepEqual(wed.selected, ["AM", "NIGHT"]);
  assert.deepEqual(model.dates.find((d) => d.dateIso === "2026-08-10").selected, []);
  assert.ok(model.submittedAt);
});

test("normalizeBlocks keeps a block list canonical", () => {
  assert.deepEqual(normalizeBlocks(["night", "am", "AM", "rubbish"]), ["AM", "NIGHT"]);
  assert.deepEqual(normalizeBlocks(null), []);
});
