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
