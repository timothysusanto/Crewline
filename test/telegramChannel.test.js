"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { InMemoryStaffStore } = require("../store");
const { InMemoryPendingActions } = require("../pendingActions");
const { InMemorySiteStore } = require("../siteStore");
const { InMemoryRosterStore } = require("../rosterStore");
const { InMemoryTenantStore } = require("../tenantStore");
const { InMemoryShiftsStore } = require("../shiftsStore");
const { pickChannel, setChannelResolver } = require("../whatsapp");
const { handleTelegramUpdate, verifyTelegramSecret, normalizePhone, cleanText } = require("../telegramWebhook");
const { chunk } = require("../telegramClient");

process.env.TELEGRAM_BOT_TOKEN = "123:test";

/** Captures every Telegram Bot API call instead of making it. */
function withTelegramStub(fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = String(url).split("/").pop();
    calls.push({ method, body: options && options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = realFetch;
  });
}

function buildDeps() {
  const staffStore = new InMemoryStaffStore();
  staffStore.upsert({ phone: "61412345678", tenantId: "demo-venue", name: "Sam", role: "staff", department: "kitchen" });
  return {
    staffStore,
    siteStore: new InMemorySiteStore(),
    rosterStore: new InMemoryRosterStore(),
    tenantStore: new InMemoryTenantStore(),
    shiftsStore: new InMemoryShiftsStore(),
    pendingActions: new InMemoryPendingActions(),
  };
}

const dm = (extra) => ({
  message: { chat: { id: 555, type: "private" }, from: { id: 555, is_bot: false }, ...extra },
});

test("pickChannel: explicit telegram hint wins", async () => {
  setChannelResolver(null);
  assert.deepEqual(await pickChannel("6141", { channel: "telegram", chatId: 9 }), { channel: "telegram", chatId: "9" });
});

test("pickChannel: resolver sends proactive messages to the linked Telegram chat", async () => {
  setChannelResolver(async (phone) => (phone === "6141" ? "777" : null));
  assert.deepEqual(await pickChannel("6141", {}), { channel: "telegram", chatId: "777" });
  setChannelResolver(null);
});

test("pickChannel: unlinked + no WhatsApp configured is undeliverable, not a crash", async () => {
  const saved = [process.env.WHATSAPP_TOKEN, process.env.WHATSAPP_PHONE_NUMBER_ID];
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  setChannelResolver(async () => null);
  assert.equal(await pickChannel("6141", {}), null);
  setChannelResolver(null);
  [process.env.WHATSAPP_TOKEN, process.env.WHATSAPP_PHONE_NUMBER_ID] = saved;
  if (saved[0] === undefined) delete process.env.WHATSAPP_TOKEN;
  if (saved[1] === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

test("pickChannel: unlinked falls back to WhatsApp when it is configured", async () => {
  process.env.WHATSAPP_TOKEN = "t";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "n";
  setChannelResolver(async () => null);
  assert.deepEqual(await pickChannel("6141", {}), { channel: "whatsapp" });
  setChannelResolver(null);
});

test("verifyTelegramSecret", () => {
  assert.equal(verifyTelegramSecret("abc", "abc"), true);
  assert.equal(verifyTelegramSecret("abd", "abc"), false);
  assert.equal(verifyTelegramSecret("", "abc"), false);
  assert.equal(verifyTelegramSecret("abc", ""), false);
});

test("normalizePhone and cleanText", () => {
  assert.equal(normalizePhone("+61 412 345 678"), "61412345678");
  assert.equal(cleanText("/in"), "in");
  assert.equal(cleanText("/in@crewline_bot"), "in");
  assert.equal(cleanText("/start"), "hi");
  assert.equal(cleanText("roster"), "roster");
});

test("chunk splits long text under Telegram's limit", () => {
  const parts = chunk("word ".repeat(3000), 4096);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 4096));
});

test("unlinked chat is asked to share its phone number", () =>
  withTelegramStub(async (calls) => {
    const deps = buildDeps();
    assert.equal(await handleTelegramUpdate(dm({ text: "hello" }), deps), "prompted_link");
    assert.equal(calls[0].body.reply_markup.keyboard[0][0].request_contact, true);
  }));

test("sharing your own registered number links the chat", () =>
  withTelegramStub(async (calls) => {
    const deps = buildDeps();
    const out = await handleTelegramUpdate(
      dm({ contact: { phone_number: "+61412345678", user_id: 555 } }),
      deps
    );
    assert.equal(out, "linked");
    assert.equal((await deps.staffStore.findByTelegramChatId("555")).phone, "61412345678");
    assert.match(calls[0].body.text, /connected, Sam/);
  }));

test("someone else's contact card does not link", () =>
  withTelegramStub(async () => {
    const deps = buildDeps();
    const out = await handleTelegramUpdate(
      dm({ contact: { phone_number: "61412345678", user_id: 999 } }),
      deps
    );
    assert.equal(out, "spoofed_contact");
    assert.equal(await deps.staffStore.findByTelegramChatId("555"), null);
  }));

test("an unregistered number is not linked", () =>
  withTelegramStub(async (calls) => {
    const deps = buildDeps();
    const out = await handleTelegramUpdate(
      dm({ contact: { phone_number: "61499999999", user_id: 555 } }),
      deps
    );
    assert.equal(out, "not_registered");
    assert.match(calls[0].body.text, /isn't registered/);
  }));

test("group chats and bots are ignored", () =>
  withTelegramStub(async (calls) => {
    const deps = buildDeps();
    const group = { message: { chat: { id: 1, type: "group" }, from: { id: 1, is_bot: false }, text: "in" } };
    assert.equal(await handleTelegramUpdate(group, deps), "ignored");
    assert.equal(calls.length, 0);
  }));

test("a linked chat's 'in' reaches the clock handler and asks for location via Telegram", () =>
  withTelegramStub(async (calls) => {
    const deps = buildDeps();
    await deps.staffStore.linkTelegramChatId("61412345678", "555");
    const out = await handleTelegramUpdate(dm({ text: "/in" }), deps);
    assert.equal(out, "routed");
    const ask = calls.find((c) => c.body && c.body.reply_markup && c.body.reply_markup.keyboard);
    assert.ok(ask, "expected a share-location keyboard");
    assert.equal(ask.body.chat_id, "555");
    assert.equal(ask.body.reply_markup.keyboard[0][0].request_location, true);
  }));

test("buttons: every reply carries the main menu, and its keys mean the commands", () =>
  withTelegramStub(async (calls) => {
    const { normalise } = require("../router");
    const { MAIN_MENU } = require("../telegramClient");
    const keys = MAIN_MENU.keyboard.flat().map((k) => normalise(k.text));
    assert.deepEqual(keys, ["in", "out", "break", "back", "roster", "menu"]);
    assert.equal(normalise("mon am pm, fri all"), "mon am pm, fri all"); // free text is untouched

    const deps = buildDeps();
    await deps.staffStore.linkTelegramChatId("61412345678", "555");
    // "☰ More" opens the menu: tap buttons under the message, not words to type.
    assert.equal(await handleTelegramUpdate(dm({ text: "☰ More" }), deps), "routed");
    const menu = calls.find((c) => c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard);
    assert.ok(menu, "expected inline buttons");
    const data = menu.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(data.includes("m:wallet") && data.includes("m:fix") && data.includes("m:availability"));
    assert.ok(!data.includes("m:invite"), "crew don't get the manager's invite button");

    // A plain reply (nothing on the roster yet) carries the main menu so it never disappears.
    calls.length = 0;
    await handleTelegramUpdate(dm({ text: "📋 My roster" }), deps);
    const plain = calls.find((c) => c.method === "sendMessage");
    assert.equal(plain.body.reply_markup.is_persistent, true);
  }));

test("buttons: a tap is routed like the typed word, the spinner is stopped and the buttons are removed", () =>
  withTelegramStub(async (calls) => {
    const deps = buildDeps();
    await deps.staffStore.linkTelegramChatId("61412345678", "555");
    await deps.rosterStore.addShift({ tenantId: "demo-venue", workerId: "61412345678", date: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10), start: "15:00", end: "22:30", published: true });
    const tap = (data) => ({ callback_query: { id: "cb1", data, from: { id: 9, is_bot: false }, message: { message_id: 77, chat: { id: 555, type: "private" } } } });
    assert.equal(await handleTelegramUpdate(tap("yes"), deps), "button");
    assert.ok(calls.some((c) => c.method === "answerCallbackQuery" && c.body.callback_query_id === "cb1"));
    assert.ok(calls.some((c) => c.method === "editMessageReplyMarkup" && c.body.message_id === 77));
    assert.ok(calls.some((c) => c.method === "sendMessage" && /Confirmed — 1 shift/.test(c.body.text)));
    const [shift] = await deps.rosterStore.listByRange("demo-venue", "2000-01-01", "2999-01-01");
    assert.ok(shift.confirmedAt, "the tap confirmed the shift");

    // Menu items ("m:…") keep their buttons so the menu can be used again.
    calls.length = 0;
    await handleTelegramUpdate(tap("m:roster"), deps);
    assert.ok(!calls.some((c) => c.method === "editMessageReplyMarkup"));
    const roster = calls.find((c) => c.method === "sendMessage");
    assert.deepEqual(roster.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["swap"]); // already confirmed: no Confirm button
    assert.match(roster.body.text, /✓ /);

    // A tap from a chat that isn't linked does nothing.
    const stranger = tap("yes"); stranger.callback_query.message.chat.id = 999;
    assert.equal(await handleTelegramUpdate(stranger, deps), "ignored");
  }));

test("clock in: a second tap doesn't open a second shift; clocking out on a break ends the break; chat isn't read as availability", () =>
  withTelegramStub(async (calls) => {
    const { InMemoryAvailabilityStore } = require("../availabilityStore");
    const deps = buildDeps();
    deps.pendingActions = new InMemoryPendingActions();
    deps.availabilityStore = new InMemoryAvailabilityStore();
    await deps.staffStore.linkTelegramChatId("61412345678", "555");
    const said = () => calls.filter((c) => c.method === "sendMessage").at(-1).body.text;
    // Someone is on shift since an hour ago.
    await deps.shiftsStore.openShift({ tenantId: "demo-venue", staffPhone: "61412345678", clockIn: { time: new Date(Date.now() - 3600e3).toISOString(), withinRadius: true } });
    await handleTelegramUpdate(dm({ text: "🟢 Clock in" }), deps);
    await handleTelegramUpdate(dm({ location: { latitude: -31.95, longitude: 115.86 } }), deps);
    assert.match(said(), /already clocked in since/);
    assert.equal((await deps.shiftsStore.listByTenant("demo-venue")).length, 1);

    await handleTelegramUpdate(dm({ text: "☕ Break" }), deps);
    await handleTelegramUpdate(dm({ text: "🔴 Clock out" }), deps);
    await handleTelegramUpdate(dm({ location: { latitude: -31.95, longitude: 115.86 } }), deps);
    assert.match(said(), /Clocked out.*break was ended too/);
    const [shift] = await deps.shiftsStore.listByTenant("demo-venue");
    assert.ok(shift.clockOut && shift.breaks[0].end);

    // Ordinary chat that happens to name a day is not saved as availability.
    await handleTelegramUpdate(dm({ text: "see you friday" }), deps);
    assert.match(said(), /didn't catch that/);
    await handleTelegramUpdate(dm({ text: "on my way" }), deps);
    assert.match(said(), /didn't catch that/);
    // ...but a message that is only days and shifts still is.
    await handleTelegramUpdate(dm({ text: "mon am pm, fri all" }), deps);
    assert.match(said(), /Saved for/);
  }));
