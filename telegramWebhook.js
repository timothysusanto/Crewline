"use strict";

const crypto = require("crypto");
const tg = require("./telegramClient");
const { handleIncoming } = require("./router");

/**
 * Telegram webhook handling, kept out of server.js so it can be tested without
 * booting the server.
 *
 * Identity: everywhere else in this codebase a person IS their phone number.
 * Telegram only gives us a numeric chat ID, so a chat is linked to an existing
 * staff record once, by the person tapping "Share my phone number". After that
 * every incoming message is translated into the same shape the WhatsApp webhook
 * produces (`from` = phone) and handed to the router untouched.
 */

/** Constant-time check of the X-Telegram-Bot-Api-Secret-Token header. */
function verifyTelegramSecret(headerValue, expected = process.env.TELEGRAM_WEBHOOK_SECRET) {
  if (!headerValue || !expected) return false;
  const a = Buffer.from(String(headerValue));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** "+61 412 345 678" -> "61412345678" (staff records are keyed digits-only). */
function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/** "/in", "/in@crewline_bot" -> "in". "/start" is just the first hello. */
function cleanText(raw) {
  return String(raw || "")
    .trim()
    .replace(/^\/([a-z_]+)(@\w+)?/i, (_m, cmd) => (cmd.toLowerCase() === "start" ? "hi" : cmd));
}

/** Telegram message -> the WhatsApp-shaped message the router expects. */
function toRouterMessage(msg, phone) {
  const base = { from: phone };
  if (msg.location) {
    return { ...base, type: "location", location: { latitude: msg.location.latitude, longitude: msg.location.longitude } };
  }
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return { ...base, type: "image", image: { id: largest.file_id } };
  }
  if (msg.voice || msg.audio) {
    const v = msg.voice || msg.audio;
    return { ...base, type: "voice", voice: { id: v.file_id, duration: v.duration || 0 } };
  }
  if (msg.document && /^image\//.test(msg.document.mime_type || "")) {
    return { ...base, type: "image", image: { id: msg.document.file_id } };
  }
  if (msg.document && (/\.(xlsx|xlsm|xls|csv|pdf)$/i.test(msg.document.file_name || "") || /pdf|spreadsheet|excel|csv/i.test(msg.document.mime_type || ""))) {
    return { ...base, type: "document", caption: msg.caption || "", document: { id: msg.document.file_id, name: msg.document.file_name || "", mime: msg.document.mime_type || "" } };
  }
  if (typeof msg.text === "string") {
    return { ...base, type: "text", text: { body: cleanText(msg.text) } };
  }
  return { ...base, type: "unsupported" };
}

/**
 * Process one Telegram update.
 * @returns {Promise<string>} what happened — for logs and tests:
 *   "ignored" | "prompted_link" | "linked" | "not_registered" | "spoofed_contact" | "routed"
 */
async function handleTelegramUpdate(update, deps) {
  if (update && update.callback_query) return handleButtonTap(update.callback_query, deps);
  const msg = update && update.message;
  // Private chats only — the bot is for one-to-one use, never a group.
  if (!msg || !msg.chat || msg.chat.type !== "private" || !msg.from || msg.from.is_bot) return "ignored";

  const chatId = String(msg.chat.id);
  const { staffStore } = deps;
  const send = (body) => tg.sendText(chatId, body, { menu: false });

  const staff = await staffStore.findByTelegramChatId(chatId);

  if (!staff) {
    // The one-time link. Only accept a contact the sender shared about THEMSELVES —
    // otherwise anyone could forward someone else's contact card and become them.
    if (msg.contact) {
      if (msg.contact.user_id !== msg.from.id) {
        await send("Please tap the button to share your own number — not someone else's contact.");
        return "spoofed_contact";
      }
      const phone = normalizePhone(msg.contact.phone_number);
      const record = phone ? await staffStore.findByPhone(phone) : null;
      if (!record) {
        await send(
          "Thanks — but that number isn't registered yet. Ask your manager to add you, then message me again."
        );
        return "not_registered";
      }
      await staffStore.linkTelegramChatId(phone, chatId);
      await tg.sendText(chatId, 
        `You're connected, ${record.name}. Use the buttons below: Clock in, Clock out, My roster — and More for everything else.`
      );
      return "linked";
    }
    await tg.sendContactRequest(
      chatId,
      "Hi! To connect you, tap the button below to share your phone number. " +
        "It must match the number your manager registered for you."
    );
    return "prompted_link";
  }

  const message = toRouterMessage(msg, staff.phone);
  const tenantContext = { tenantId: staff.tenantId, channel: "telegram", chatId };
  await handleIncoming(message, deps, tenantContext);
  return "routed";
}

/**
 * A tap on a button under a message. The button's data is the word the person would have typed
 * ("yes", "swap", "add", "train 1 en"…), so it goes to the router exactly like a text message.
 * Data starting with "m:" is a menu item — its buttons stay so the menu can be used again.
 */
async function handleButtonTap(cq, deps) {
  const msg = cq.message;
  tg.answerCallback(cq.id).catch(() => {}); // stop the spinner straight away
  if (!msg || !msg.chat || msg.chat.type !== "private" || !cq.data) return "ignored";
  const chatId = String(msg.chat.id);
  const staff = await deps.staffStore.findByTelegramChatId(chatId);
  if (!staff) return "ignored";
  const keep = cq.data.startsWith("m:");
  const word = keep ? cq.data.slice(2) : cq.data;
  if (!keep) tg.clearButtons(chatId, msg.message_id).catch(() => {});
  await handleIncoming({ from: staff.phone, type: "text", text: { body: word } }, deps, { tenantId: staff.tenantId, channel: "telegram", chatId });
  return "button";
}

module.exports = { handleButtonTap, handleTelegramUpdate, verifyTelegramSecret, normalizePhone, cleanText, toRouterMessage };
