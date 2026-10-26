"use strict";

/**
 * Channel dispatcher. Every handler already calls
 * `sendText(to, body, sendOpts)` where `to` is the person's phone number (the
 * identity everywhere in this codebase). This module decides whether that lands
 * on Telegram or WhatsApp, so no handler needed to change.
 *
 * Order of decision for each send:
 *   1. sendOpts.channel === "telegram" (set by the Telegram webhook for replies)
 *      -> Telegram, to sendOpts.chatId.
 *   2. A channel resolver is registered (server.js does this) and the recipient
 *      has a linked Telegram chat -> Telegram. This is what makes proactive
 *      messages (shift offers, reminders, nudges) go to Telegram.
 *   3. WhatsApp credentials are configured -> WhatsApp (legacy / fallback).
 *   4. Otherwise the message can't be delivered: logged and dropped. Typically
 *      the person hasn't messaged the bot yet — Telegram bots can't initiate.
 *
 * Without a resolver and without sendOpts.channel (e.g. the existing unit
 * tests) behaviour is exactly the original WhatsApp behaviour.
 */

const wa = require("./whatsappCloudApi");
const tg = require("./telegramClient");

/** @type {((phone: string) => Promise<string|null>)|null} */
let channelResolver = null;

/** server.js registers: phone -> linked Telegram chat ID (or null). */
function setChannelResolver(fn) {
  channelResolver = fn;
}

function whatsappConfigured(options = {}) {
  return Boolean(
    (options.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID) &&
      (options.token || process.env.WHATSAPP_TOKEN)
  );
}

/** @returns {Promise<{channel: "telegram", chatId: string}|{channel: "whatsapp"}|null>} */
async function pickChannel(to, options = {}) {
  if (options.channel === "telegram" && options.chatId) {
    return { channel: "telegram", chatId: String(options.chatId) };
  }
  if (channelResolver) {
    try {
      const chatId = await channelResolver(to);
      if (chatId) return { channel: "telegram", chatId: String(chatId) };
    } catch (err) {
      console.error("[channel] resolver failed:", err.message);
    }
  }
  if (options.channel === "whatsapp" || whatsappConfigured(options)) return { channel: "whatsapp" };
  return null;
}

function undeliverable(to) {
  console.warn(
    `[channel] no way to reach ${to} — not linked to Telegram and WhatsApp isn't configured. ` +
      "They need to message the bot once and share their phone number."
  );
  return { ok: false, reason: "no_channel" };
}

async function sendText(to, body, options = {}) {
  const pick = await pickChannel(to, options);
  if (!pick) return undeliverable(to);
  return pick.channel === "telegram" ? tg.sendText(pick.chatId, body) : wa.sendText(to, body, options);
}

async function sendLocationRequest(to, body, options = {}) {
  const pick = await pickChannel(to, options);
  if (!pick) return undeliverable(to);
  return pick.channel === "telegram"
    ? tg.sendLocationRequest(pick.chatId, body)
    : wa.sendLocationRequest(to, body, options);
}

/** Photo download. `options.channel` says whose file ID this is. */
async function fetchMediaBinary(mediaId, options = {}) {
  return options.channel === "telegram" ? tg.fetchMediaBinary(mediaId) : wa.fetchMediaBinary(mediaId, options);
}

module.exports = { sendText, sendLocationRequest, fetchMediaBinary, setChannelResolver, pickChannel };
