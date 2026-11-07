"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../rosterImport");
const { buildStores } = require("../stores");
const { handleIncoming } = require("../router");

const staff = [
  { name: "Aarav Sharma", phone: "61400000001" }, { name: "Maria Gomez", phone: "61400000002" },
  { name: "Tim Susanto", phone: "61400000003" }, { name: "Jess Kim", phone: "61400000004" },
];
const fx = (f) => fs.readFileSync(path.join(__dirname, "fixtures", f));
const today = "2026-11-07";

test("times: 12h, 24h, bare and overnight", () => {
  const t = (s) => R.parseTimes(s).ranges.map((r) => `${r.start}-${r.end}`);
  assert.deepEqual(t("10am-6:30pm"), ["10:00-18:30"]);
  assert.deepEqual(t("7:00-15:30"), ["07:00-15:30"]);
  assert.deepEqual(t("7-3"), ["07:00-15:00"]);
  assert.deepEqual(t("5-11pm"), ["17:00-23:00"]);
  assert.deepEqual(t("10-6pm"), ["10:00-18:00"]);
  assert.deepEqual(t("22:00-02:00"), ["22:00-02:00"]);
  assert.deepEqual(t("10-2, 5-10pm"), ["10:00-14:00", "17:00-22:00"]);
  assert.deepEqual(t("OFF"), []);
});

test("Excel and PDF versions of the same roster give the same shifts", async () => {
  const x = await R.importRoster(fx("roster.xlsx"), { filename: "roster.xlsx", staff, today });
  const p = await R.importRoster(fx("roster.pdf"), { filename: "roster.pdf", staff, today });
  for (const r of [x, p]) {
    assert.equal(r.ok, true);
    assert.equal(r.weekStart, "2026-11-09");
    assert.equal(r.shifts.length, 19);
    assert.deepEqual(r.unmatched, [{ name: "Sam Unknown", count: 1 }]);
    assert.ok(r.shifts.find((s) => s.name === "Tim Susanto" && s.date === "2026-11-09" && s.start === "08:00" && s.end === "17:00"), "first-name match + 8-5");
    assert.ok(!r.shifts.find((s) => s.name === "Aarav Sharma" && s.date === "2026-11-10"), "OFF is not a shift");
  }
  const key = (r) => r.shifts.map((s) => `${s.workerId}|${s.date}|${s.start}|${s.end}`).sort().join();
  assert.equal(key(x), key(p));
});

test("weekday-only headers use the chosen week; days down the side also work", async () => {
  const csv = Buffer.from("Name,Mon,Tue,Wed\nJess Kim,9-5,,10am-4pm\nMaria,OFF,7-3,\n");
  const r = await R.importRoster(csv, { filename: "r.csv", staff, today, weekStart: "2026-11-16" });
  assert.equal(r.weekStart, "2026-11-16");
  assert.deepEqual(r.shifts.map((s) => `${s.name} ${s.date} ${s.start}-${s.end}`).sort(), ["Jess Kim 2026-11-16 09:00-17:00", "Jess Kim 2026-11-18 10:00-16:00", "Maria Gomez 2026-11-17 07:00-15:00"]);
  const side = Buffer.from("Day,Jess Kim,Maria Gomez\nMon,9-5,\nTue,,7-3\nWed,10-4,\n");
  const t = await R.importRoster(side, { filename: "r.csv", staff, today, weekStart: "2026-11-16" });
  assert.equal(t.shifts.length, 3);
});

test("a two-week roster with repeated weekdays counts forward", async () => {
  const csv = Buffer.from("Name,Mon,Tue,Mon,Tue\nJess Kim,9-5,9-5,9-5,9-5\n");
  const r = await R.importRoster(csv, { filename: "r.csv", staff, today, weekStart: "2026-11-09" });
  assert.deepEqual(r.shifts.map((s) => s.date), ["2026-11-09", "2026-11-10", "2026-11-16", "2026-11-17"]);
});

test("unreadable files fail kindly", async () => {
  assert.equal((await R.importRoster(Buffer.from("hello"), { filename: "x.txt", staff })).ok, false);
  assert.match((await R.importRoster(Buffer.from("a"), { filename: "old.xls", staff })).error, /xlsx/);
  assert.match((await R.importRoster(Buffer.from("Name,Notes\nJess,hi\n"), { filename: "r.csv", staff })).error, /days/);
});

test("commit saves drafts once; sending the same file twice adds nothing", async () => {
  const { rosterStore } = buildStores();
  const r = await R.importRoster(fx("roster.xlsx"), { filename: "r.xlsx", staff, today });
  const a = await R.commitShifts({ rosterStore, tenantId: "v", shifts: r.shifts });
  const b = await R.commitShifts({ rosterStore, tenantId: "v", shifts: r.shifts });
  assert.deepEqual([a.added, a.skipped, b.added, b.skipped], [19, 0, 0, 19]);
  assert.ok((await rosterStore.listByRange("v", "2026-11-09", "2026-11-15")).every((s) => s.published === false));
});

test("Telegram: a manager sends the file, replies ADD; a crew member is refused", async () => {
  const tg = require("../telegramClient");
    const sent = [];
  // The handler goes through ./whatsapp, which routes Telegram chats to telegramClient; stub that layer.
  const stores = buildStores();
  for (const s of staff) await stores.staffStore.upsert({ ...s, tenantId: "v", role: s.name === "Maria Gomez" ? "manager" : "staff", active: true });
  const orig = { send: tg.sendText, fetch: tg.fetchMediaBinary };
  tg.sendText = async (_c, body) => { sent.push(body); return { ok: true }; };
  tg.fetchMediaBinary = async () => ({ buffer: fx("roster.pdf"), mimeType: "application/pdf" });
  try {
    const ctx = { tenantId: "v", channel: "telegram", chatId: "1" };
    const doc = { type: "document", document: { id: "f1", name: "roster.pdf", mime: "application/pdf" }, caption: "" };
    await handleIncoming({ from: "61400000001", ...doc }, stores, ctx);
    assert.match(sent.pop(), /Only a manager/);
    await handleIncoming({ from: "61400000002", ...doc }, stores, ctx);
    assert.match(sent.join("\n"), /Found a roster: Mon 9 Nov – Sun 15 Nov/);
    assert.match(sent.join("\n"), /Reply ADD/);
    await handleIncoming({ from: "61400000002", type: "text", text: { body: "add" } }, stores, ctx);
    assert.match(sent.pop(), /Added 19 shifts as drafts/);
    assert.equal((await stores.rosterStore.listByRange("v", "2026-11-09", "2026-11-15")).length, 19);
  } finally { tg.sendText = orig.send; tg.fetchMediaBinary = orig.fetch; }
});

test("compact 24-hour times (0530-1336, 1700-0000) and rows of RDO", async () => {
  const t = (s) => R.parseTimes(s).ranges.map((r) => `${r.start}-${r.end}`);
  assert.deepEqual(t("0530-1336"), ["05:30-13:36"]);
  assert.deepEqual(t("1700-0000"), ["17:00-00:00"]);
  assert.deepEqual(t("1430-2230"), ["14:30-22:30"]);
  assert.deepEqual(t("RDO"), []); assert.deepEqual(t("Requested Day Off"), []);
  assert.deepEqual(t("DDP 40 PAX + 25PAX"), []); assert.deepEqual(t("0/34"), []);
  const csv = Buffer.from("Date,Role,9-Nov-26,10-Nov-26,11-Nov-26\nDay,Role,Monday,Tuesday,Wednesday\nNitin D,CDP,RDO,0530-1336,1500-2230\nEvents,,374,409,419\n");
  const r = await R.importRoster(csv, { filename: "r.csv", staff: [{ name: "Nitin D", phone: "1" }], today: "2026-11-07" });
  assert.deepEqual(r.shifts.map((s) => `${s.date} ${s.start}-${s.end}`), ["2026-11-10 05:30-13:36", "2026-11-11 15:00-22:30"]);
  assert.deepEqual(r.unmatched, []);
});
