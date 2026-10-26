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
  if (msg.document && /^image\//.test(msg.document.mime_type || "")) {
    return { ...base, type: "image", image: { id: msg.document.file_id } };
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
  const msg = update && update.message;
  // Private chats only — the bot is for one-to-one use, never a group.
  if (!msg || !msg.chat || msg.chat.type !== "private" || !msg.from || msg.from.is_bot) return "ignored";

  const chatId = String(msg.chat.id);
  const { staffStore } = deps;
  const send = (body) => tg.sendText(chatId, body);

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
      await send(
        `You're connected, ${record.name}. Type "in" to clock in, "roster" to see your shifts, ` +
          `or "hi" for the full command list.`
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

module.exports = { handleTelegramUpdate, verifyTelegramSecret, normalizePhone, cleanText, toRouterMessage };
