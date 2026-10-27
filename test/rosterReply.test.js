"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { InMemoryStaffStore } = require("../store");
const { InMemoryRosterStore, localDateIso, addDays, shiftWindow, mondayOf } = require("../rosterStore");
const { handleRosterReply, looksLikeRosterReply } = require("../rosterReplyHandler");
const { setChannelResolver } = require("../whatsapp");

process.env.TELEGRAM_BOT_TOKEN = "123:test";

function withTelegramStub(fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ method: String(url).split("/").pop(), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = realFetch;
    setChannelResolver(null);
  });
}

function deps() {
  const staffStore = new InMemoryStaffStore();
  staffStore.upsert({ phone: "61411111111", tenantId: "cafe", name: "Sam", role: "staff", telegramChatId: "100" });
  staffStore.upsert({ phone: "61422222222", tenantId: "cafe", name: "Mothy", role: "manager", telegramChatId: "200" });
  staffStore.upsert({ phone: "61433333333", tenantId: "cafe", name: "Unlinked Boss", role: "owner" });
  const rosterStore = new InMemoryRosterStore();
  setChannelResolver(async (phone) => (await staffStore.findByPhone(phone))?.telegramChatId || null);
  return { staffStore, rosterStore };
}

const today = localDateIso();
const sam = { phone: "61411111111", tenantId: "cafe", name: "Sam", role: "staff" };
const tg = { channel: "telegram", chatId: "100" };

test("looksLikeRosterReply", () => {
  for (const w of ["yes", "YES please", "ok", "confirm", "swap", "Swap Tuesday", "can't do friday"]) assert.ok(looksLikeRosterReply(w), w);
  for (const w of ["in", "roster", "same", "none", "temps", "wallet"]) assert.equal(looksLikeRosterReply(w), false, w);
});

test("YES confirms every upcoming published shift", () =>
  withTelegramStub(async (calls) => {
    const d = deps();
    await d.rosterStore.addShift({ tenantId: "cafe", workerId: sam.phone, date: addDays(today, 1), start: "09:00", end: "17:00", published: true });
    await d.rosterStore.addShift({ tenantId: "cafe", workerId: sam.phone, date: addDays(today, 2), start: "09:00", end: "17:00", published: true });
    await d.rosterStore.addShift({ tenantId: "cafe", workerId: sam.phone, date: addDays(today, 3), start: "09:00", end: "17:00", published: false });
    await handleRosterReply(sam.phone, sam, "yes", d, tg);
    const mine = await d.rosterStore.listByWorker("cafe", sam.phone, today, addDays(today, 10));
    assert.equal(mine.filter((s) => s.confirmedAt).length, 2);
    assert.match(calls.at(-1).body.text, /Confirmed — 2 shifts/);
    assert.equal(calls.at(-1).body.chat_id, "100");
  }));

test("YES with nothing published still answers", () =>
  withTelegramStub(async (calls) => {
    const d = deps();
    await handleRosterReply(sam.phone, sam, "yes", d, tg);
    assert.match(calls[0].body.text, /Nothing to confirm yet/);
  }));

test("SWAP flags the shifts and tells reachable managers only", () =>
  withTelegramStub(async (calls) => {
    const d = deps();
    await d.rosterStore.addShift({ tenantId: "cafe", workerId: sam.phone, date: addDays(today, 1), start: "09:00", end: "17:00", published: true });
    await handleRosterReply(sam.phone, sam, "swap can't do it", d, tg);
    const mine = await d.rosterStore.listByWorker("cafe", sam.phone, today, addDays(today, 10));
    assert.ok(mine[0].swapRequestedAt);
    assert.equal(mine[0].swapNote, "can't do it");
    const toManager = calls.find((c) => c.body.chat_id === "200");
    assert.ok(toManager, "manager with a linked chat is told");
    assert.match(toManager.body.text, /Sam wants to swap/);
    assert.match(calls.at(-1).body.text, /your manager has been told/);
    assert.equal(calls.at(-1).body.chat_id, "100");
  }));

test("rosterStore: findAssignment picks the earliest published shift; shiftWindow handles overnight", async () => {
  const r = new InMemoryRosterStore();
  await r.addShift({ tenantId: "cafe", workerId: "p", date: "2026-11-02", start: "15:00", end: "23:00", published: true });
  await r.addShift({ tenantId: "cafe", workerId: "p", date: "2026-11-02", start: "07:00", end: "11:00", published: true });
  await r.addShift({ tenantId: "cafe", workerId: "p", date: "2026-11-02", start: "05:00", end: "09:00", published: false });
  const a = await r.findAssignment("cafe", "2026-11-02", "p");
  assert.equal(a.start, "07:00");
  const w = shiftWindow({ date: "2026-11-02", start: "22:00", end: "06:00" });
  assert.equal(w.endsAt - w.startsAt, 8 * 3600 * 1000);
  assert.equal(mondayOf(new Date("2026-11-05T12:00:00")), "2026-11-02");
});
