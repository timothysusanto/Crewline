"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// Capture bot output instead of calling Telegram.
const sent = [];
const wa = require("../whatsapp");
wa.sendText = async (to, body) => { sent.push({ to, body }); return { ok: true }; };
wa.sendChoices = async (to, body, rows) => { sent.push({ to, body, rows }); return { ok: true }; };
const TR = require("../timesheetRequests");
const { buildStores } = require("../stores");
const P = require("../payroll");

test("parseTimes reads the ways people type a shift", () => {
  assert.deepEqual(TR.parseTimes("14:30-22:30 break 30"), { start: "14:30", end: "22:30", breakMins: 30 });
  assert.deepEqual(TR.parseTimes("2.30pm to 10.30pm no break"), { start: "14:30", end: "22:30", breakMins: 0 });
  assert.deepEqual(TR.parseTimes("1430-2230 b30"), { start: "14:30", end: "22:30", breakMins: 30 });
  assert.deepEqual(TR.parseTimes("14:30 – 22:30 break 18:00-18:30"), { start: "14:30", end: "22:30", breakMins: 30 });
  assert.equal(TR.parseTimes("I forgot sorry"), null);
});

test("parseDate: d/m, weekday, yesterday; never the future", () => {
  assert.equal(TR.parseDate("8/11", "2026-11-09"), "2026-11-08");
  assert.equal(TR.parseDate("yesterday", "2026-11-09"), "2026-11-08");
  assert.equal(TR.parseDate("sat", "2026-11-09"), "2026-11-07");
  assert.equal(TR.parseDate("20/11/2026", "2026-11-09"), null);
});

test("the tap-through: fix → shift → forgot to clock out → yes → reason → saved and manager told", async () => {
  sent.length = 0;
  const stores = buildStores();
  const tz = P.DEFAULT_SETTINGS.timezone;
  const yesterday = P.addDays(P.todayIn(tz), -1);
  await stores.tenantStore.upsert?.({ tenantId: "t1", name: "Test" });
  await stores.staffStore.upsert({ phone: "61400000001", tenantId: "t1", name: "Rita M", role: "staff", active: true });
  await stores.staffStore.upsert({ phone: "61400000009", tenantId: "t1", name: "Boss", role: "manager", active: true, telegramChatId: "999" });
  await stores.rosterStore.addShift({ tenantId: "t1", workerId: "61400000001", date: yesterday, start: "14:30", end: "22:30", unpaidBreakMins: 30, published: true });
  const staff = await stores.staffStore.findByPhone("61400000001");
  const say = (t) => TR.handleFixMessage("61400000001", staff, t, "t1", stores, {});

  assert.equal(await say("fix"), true);
  const shiftBtn = sent.at(-1).rows[0][0];
  assert.match(shiftBtn, /14:30–22:30/);
  await say(shiftBtn);
  assert.match(sent.at(-1).body, /What happened/);
  await say("Forgot to clock out");
  assert.match(sent.at(-1).body, /Worked as rostered: 14:30–22:30 with a 30 min break/);
  await say("Yes, as rostered");
  assert.match(sent.at(-1).body, /Reason/);
  await say("phone was flat");
  assert.match(sent.find((m) => m.to === "61400000001" && /Sent to your manager/.test(m.body)).body, /14:30–22:30, a 30 min break/);
  assert.ok(sent.some((m) => m.to === "61400000009" && /Rita M asked for a timesheet fix/.test(m.body)));
  const pending = await TR.listPending("t1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].in, "14:30"); assert.equal(pending[0].out, "22:30"); assert.equal(pending[0].breakMins, 30);
  assert.equal(pending[0].reason, "phone was flat");
  // A normal message afterwards is no longer captured.
  assert.equal(await say("roster"), false);
});

test("different times: typed times are used; cancel sends nothing", async () => {
  sent.length = 0; TR._mem.clear();
  const stores = buildStores();
  await stores.staffStore.upsert({ phone: "61400000002", tenantId: "t2", name: "Sam", role: "staff", active: true });
  const staff = await stores.staffStore.findByPhone("61400000002");
  const say = (t) => TR.handleFixMessage("61400000002", staff, t, "t2", stores, {});
  await say("forgot");
  await say("Another day");
  await say("yesterday");
  await say("Times were different");
  await say("15:00-21:00 break 20");
  await say("Skip");
  const p = await TR.listPending("t2");
  assert.equal(p[0].in, "15:00"); assert.equal(p[0].out, "21:00"); assert.equal(p[0].breakMins, 20);
  await say("fix"); await say("cancel");
  assert.equal((await TR.listPending("t2")).length, 1);
});

test("a voice note becomes a request the manager sets times for", async () => {
  sent.length = 0; TR._mem.clear();
  const stores = buildStores();
  await stores.staffStore.upsert({ phone: "61400000003", tenantId: "t3", name: "Vee", role: "staff", active: true });
  const staff = await stores.staffStore.findByPhone("61400000003");
  await TR.handleFixVoice("61400000003", staff, { id: "voice123", duration: 9 }, "t3", stores, {});
  const p = await TR.listPending("t3");
  assert.equal(p.length, 1);
  assert.equal(p[0].voiceFileId, "voice123");
  assert.equal(p[0].in, null);
  assert.match(sent.at(-1).body, /voice note/);
});
