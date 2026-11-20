"use strict";

/**
 * Minimal Telegram Bot API client. Node 18+ native fetch, no dependencies.
 *
 * Docs: https://core.telegram.org/bots/api
 *
 * Telegram bots cannot start a conversation: until a person has messaged the
 * bot once, nothing can be sent to their chat ID. Every function here takes a
 * numeric chat ID (as a string or number), never a phone number — whatsapp.js
 * is what maps a staff phone number onto a chat ID.
 */

const API = "https://api.telegram.org";
const MAX_LEN = 4096; // Telegram's hard limit per message

function token(options = {}) {
  const t = options.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  return t;
}

async function call(method, payload, options = {}) {
  const res = await fetch(`${API}/bot${token(options)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    // Log and carry on — a failed reply must not take the webhook down.
    console.error(`Telegram ${method} failed:`, res.status, JSON.stringify(json));
  }
  return json;
}

/** Split on newlines/spaces so a long reply isn't cut mid-word. */
function chunk(text, max = MAX_LEN) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The always-there menu under the message box: the things people do every day are one tap.
 * Tapping a key sends its label as a normal message; router.js maps the label to the command.
 */
const MAIN_MENU = {
  keyboard: [
    [{ text: "🟢 Clock in" }, { text: "🔴 Clock out" }],
    [{ text: "☕ Break" }, { text: "▶️ Back" }],
    [{ text: "📋 My roster" }, { text: "☰ More" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

/**
 * Plain-text message (no parse_mode, so staff names/amounts never need escaping).
 * Carries the main menu so it is always one tap away; pass { menu: false } for someone not linked yet.
 */
async function sendText(chatId, body, options = {}) {
  let last = {};
  const markup = options.menu === false ? { remove_keyboard: true } : MAIN_MENU;
  for (const part of chunk(body)) {
    last = await call("sendMessage", { chat_id: chatId, text: part, reply_markup: markup }, options);
  }
  return last;
}

/**
 * A message with tap buttons right under it. rows: [[{ text, data }, …], …] — tapping sends `data`
 * back as a callback, which telegramWebhook.js hands to the router as if the person had typed it.
 */
async function sendButtons(chatId, body, rows, options = {}) {
  const parts = chunk(body);
  for (const part of parts.slice(0, -1)) await call("sendMessage", { chat_id: chatId, text: part }, options);
  return call(
    "sendMessage",
    {
      chat_id: chatId,
      text: parts[parts.length - 1] || "",
      reply_markup: {
        inline_keyboard: rows.map((r) => (Array.isArray(r) ? r : [r]).map((b) => ({ text: b.text, callback_data: String(b.data).slice(0, 64) }))),
      },
    },
    options
  );
}

/** Stop the spinner on a tapped button (must be called for every tap). */
function answerCallback(callbackId, text, options = {}) {
  return call("answerCallbackQuery", text ? { callback_query_id: callbackId, text } : { callback_query_id: callbackId }, options);
}

/** Take the buttons off a message once one has been tapped, so it can't be tapped twice. */
function clearButtons(chatId, messageId, options = {}) {
  return call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }, options);
}

/** The "/" command list Telegram shows next to the message box. */
function setCommands(options = {}) {
  return call("setMyCommands", {
    commands: [
      { command: "in", description: "Clock in" },
      { command: "out", description: "Clock out" },
      { command: "break", description: "Start a break" },
      { command: "back", description: "Back from break" },
      { command: "roster", description: "My shifts" },
      { command: "menu", description: "Everything else" },
    ],
  }, options);
}

/** One-tap "share my location" button (reply keyboard, hides after use). */
function sendLocationRequest(chatId, body, options = {}) {
  return call(
    "sendMessage",
    {
      chat_id: chatId,
      text: body,
      reply_markup: {
        keyboard: [[{ text: "📍 Share my location", request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    },
    options
  );
}

/** Forward a voice note (by file_id, which works in any chat with this bot) with a caption. */
function sendVoice(chatId, fileId, caption, options = {}) {
  return call("sendVoice", { chat_id: chatId, voice: fileId, caption: String(caption || "").slice(0, 1000) }, options);
}

/** Tap-to-reply buttons: rows of labels; tapping one sends that label back as a normal message. */
function sendChoices(chatId, body, rows, options = {}) {
  return call(
    "sendMessage",
    {
      chat_id: chatId,
      text: body,
      reply_markup: {
        keyboard: rows.map((r) => (Array.isArray(r) ? r : [r]).map((text) => ({ text }))),
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    },
    options
  );
}

/** A message with a tap-to-open link button (always clickable, survives forwarding). */
function sendLinkButton(chatId, body, label, url, options = {}) {
  return call(
    "sendMessage",
    {
      chat_id: chatId,
      text: body,
      reply_markup: { inline_keyboard: [[{ text: label, url }]] },
    },
    options
  );
}

/** One-tap "share my phone number" button — used once to link a chat to a staff record. */
function sendContactRequest(chatId, body, options = {}) {
  return call(
    "sendMessage",
    {
      chat_id: chatId,
      text: body,
      reply_markup: {
        keyboard: [[{ text: "📱 Share my phone number", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    },
    options
  );
}

/**
 * Download a photo by Telegram file_id. Two steps: getFile resolves a path,
 * then the binary is fetched from the file endpoint.
 * @returns {Promise<{buffer: Buffer, mimeType: string}|null>} null on any failure
 */
async function fetchMediaBinary(fileId, options = {}) {
  try {
    const meta = await call("getFile", { file_id: fileId }, options);
    const filePath = meta?.result?.file_path;
    if (!filePath) return null;
    const binRes = await fetch(`${API}/file/bot${token(options)}/${filePath}`);
    if (!binRes.ok) {
      console.error("[media] telegram download failed:", binRes.status);
      return null;
    }
    const ext = filePath.split(".").pop().toLowerCase();
    const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return { buffer: Buffer.from(await binRes.arrayBuffer()), mimeType };
  } catch (err) {
    console.error("[media] telegram error:", err.message);
    return null;
  }
}

/**
 * A person's current Telegram profile picture (small JPEG), or null if they
 * have none, hide it from bots, or the call fails. For a private chat the chat
 * ID is the user ID.
 */
async function fetchProfilePhoto(chatId, options = {}) {
  try {
    const r = await call("getUserProfilePhotos", { user_id: Number(chatId), limit: 1 }, options);
    const sizes = r?.result?.photos?.[0];
    if (!sizes || !sizes.length) return null;
    const pick = sizes.find((x) => x.width >= 160) || sizes[sizes.length - 1];
    const meta = await call("getFile", { file_id: pick.file_id }, options);
    const filePath = meta?.result?.file_path;
    if (!filePath) return null;
    const bin = await fetch(`${API}/file/bot${token(options)}/${filePath}`);
    if (!bin.ok) return null;
    return { buffer: Buffer.from(await bin.arrayBuffer()), mimeType: "image/jpeg" };
  } catch (err) {
    console.error("[avatar] telegram error:", err.message);
    return null;
  }
}

/** Register the webhook. `secret` is echoed back on every update in a header. */
function setWebhook(url, secret, options = {}) {
  return call(
    "setWebhook",
    { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false },
    options
  );
}

module.exports = { sendText, sendButtons, answerCallback, clearButtons, setCommands, MAIN_MENU, sendLinkButton, sendLocationRequest, sendChoices, sendVoice, sendContactRequest, fetchMediaBinary, fetchProfilePhoto, setWebhook, chunk };
