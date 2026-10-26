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

/** Plain-text message (no parse_mode, so staff names/amounts never need escaping). */
async function sendText(chatId, body, options = {}) {
  let last = {};
  for (const part of chunk(body)) {
    last = await call(
      "sendMessage",
      { chat_id: chatId, text: part, reply_markup: { remove_keyboard: true } },
      options
    );
  }
  return last;
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

/** Register the webhook. `secret` is echoed back on every update in a header. */
function setWebhook(url, secret, options = {}) {
  return call(
    "setWebhook",
    { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false },
    options
  );
}

module.exports = { sendText, sendLocationRequest, sendContactRequest, fetchMediaBinary, setWebhook, chunk };
