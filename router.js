"use strict";

const { sendText } = require("./whatsapp");
const { requestClockAction, handleLocationForClockAction, startBreak, endBreak } = require("./clockHandler");
const { handleAvailCommand, handleDateException, handleRosterQuery } = require("./availabilityHandler");
const { handleSpendCommand } = require("./foodCostHandler");
const { handleRosterReply, looksLikeRosterReply } = require("./rosterReplyHandler");
const {
  looksLikeAvailabilityReply, handleSameAgain, handleNotAvailable,
  handleShorthand, SAME_RE, NONE_RE,
} = require("./availabilityCapture");

/**
 * Route a single incoming staff message (Telegram or WhatsApp — the webhook
 * has already turned it into { from: phone, type, text|location|image }).
 *
 * Only registered staff get through. Fixed command words are checked first,
 * then the pending-reply hooks (wallet / food safety / training), then the
 * availability words, then roster YES/SWAP, and finally the availability
 * shorthand, which is the only free-form parser and declines what it can't read.
 *
 * @param {object} message
 * @param {object} deps      stores and pendingActions
 * @param {{tenantId: string, phoneNumberId?: string, token?: string|null, channel?: "telegram", chatId?: string}|null} tenantContext
 */
const { handleWalletCommand, handleWalletReply, handleCredentialPhoto } = require("./walletHandler");
const {
  handleTempsCommand, handleFoodSafetyReply, handleCleanCommand,
  handleDeliveryCommand, handleFoodSafetyPhoto,
} = require("./foodSafetyHandler");
const { handleTrainCommand, handleTrainingReply, handleEnrolCommand } = require("./trainingHandler");

async function handleIncoming(message, deps, tenantContext = null) {
  const { staffStore, pendingActions } = deps;
  const from = message.from;
  const type = message.type;

  // sendOpts is passed to every sendText/sendLocationRequest call below so
  // replies go out from the correct venue's WhatsApp number once a venue
  // has one of its own — see whatsapp.js.
  // A Telegram message carries channel + chatId so every reply goes back to
  // the same chat, and photo downloads use Telegram's file API.
  const sendOpts = tenantContext?.channel === "telegram"
    ? { channel: "telegram", chatId: tenantContext.chatId }
    : tenantContext
      ? { phoneNumberId: tenantContext.phoneNumberId, token: tenantContext.token || undefined }
      : {};

  const staff = await staffStore.findByPhone(from);
  const tenantId = tenantContext?.tenantId || (staff && staff.tenantId) || null;

  console.log(`[incoming] from=${from} type=${type} tenant=${tenantId} as=${staff ? `${staff.name}/${staff.role}` : "UNKNOWN"}`);

  if (!staff) {
    await sendText(
      from,
      "Hi! This number isn't registered yet. Ask your manager to add you, then message again.",
      sendOpts
    );
    return;
  }

  if (type === "text") {
    const body = (message.text?.body || "").trim().toLowerCase();

    if (body === "in") {
      await requestClockAction(from, "clock_in", deps, sendOpts);
      return;
    }
    if (body === "out") {
      await requestClockAction(from, "clock_out", deps, sendOpts);
      return;
    }
    if (body === "break") {
      await startBreak(from, staff, deps, sendOpts);
      return;
    }
    if (body === "back") {
      await endBreak(from, staff, deps, sendOpts);
      return;
    }
    if (body === "avail" || body.startsWith("avail ")) {
      await handleAvailCommand(from, staff, body, deps, sendOpts);
      return;
    }
    if (body.startsWith("off ") || body.startsWith("on ")) {
      await handleDateException(from, staff, body, deps, sendOpts);
      return;
    }
    if (body === "roster") {
      await handleRosterQuery(from, staff, deps, sendOpts);
      return;
    }
    if (body === "spend" || body.startsWith("spend ")) {
      await handleSpendCommand(from, staff, body, deps, sendOpts);
      return;
    }
    // Credential wallet — "wallet" lists; and while a photo draft is pending
    // (10-min window), yes/no/corrections belong to it. handleWalletReply
    // returns false when nothing is pending, so it can never shadow the
    // availability words or a shift-offer yes/no.
    if (body === "wallet") {
      await handleWalletCommand(from, staff, tenantId, deps, sendOpts);
      return;
    }
    // Food safety diary (Hospitality Edition) — guided temp runs, cleaning
    // checklist, delivery receiving. Same pattern as the wallet: fixed words
    // first, then pending-gated reply hooks that return false when idle.
    if (body === "temps") {
      await handleTempsCommand(from, staff, tenantId, deps, sendOpts);
      return;
    }
    if (body === "clean" || body.startsWith("clean ")) {
      await handleCleanCommand(from, staff, body, tenantId, deps, sendOpts);
      return;
    }
    if (body.startsWith("delivery")) {
      await handleDeliveryCommand(from, staff, body, tenantId, deps, sendOpts);
      return;
    }
    if (body === "train" || body.startsWith("train ")) {
      await handleTrainCommand(from, staff, body, tenantId, deps, sendOpts);
      return;
    }
    if (body === "enrol" || body === "enroll" || body.startsWith("enrol ") || body.startsWith("enroll ")) {
      await handleEnrolCommand(from, staff, body.replace(/^enroll/, "enrol"), tenantId, deps, sendOpts);
      return;
    }
    if (await handleWalletReply(from, staff, body, tenantId, deps, sendOpts)) return;
    if (await handleFoodSafetyReply(from, staff, body, tenantId, deps, sendOpts)) return;
    if (await handleTrainingReply(from, staff, body, tenantId, deps, sendOpts)) return;
    // The weekly availability words — rungs 1, 2 and 5 of the capture ladder.
    if (looksLikeAvailabilityReply(body)) {
      if (NONE_RE.test(body)) await handleNotAvailable(from, staff, deps, sendOpts);
      else if (SAME_RE.test(body)) await handleSameAgain(from, staff, deps, sendOpts);
      return;
    }
    // Answering a published roster. After the fixed words so it can never
    // shadow a command, and only when the message opens with yes/swap.
    if (looksLikeRosterReply(body)) {
      await handleRosterReply(from, staff, body, deps, sendOpts);
      return;
    }
    // Rung 4 — the shorthand. Last, because it is the only handler that reads a
    // free-form message, and it declines anything it can't parse into days and
    // blocks rather than guessing.
    if (await handleShorthand(from, staff, body, deps, sendOpts)) return;

    await sendText(
      from,
      `Hi ${staff.name} — commands: "in"/"out" to clock in/out, "break"/"back" for breaks, ` +
        `"yes" to confirm your roster or "swap" to ask for a change, "same" to repeat last week's availability, ` +
        `"mon am pm, fri all" to set your week, ` +
        `"roster" to see your shifts, "wallet" to see your credentials (or send a photo of one to file it), ` +
        `"temps" to run temperature checks, "clean" for the cleaning list, "train" for training modules, ` +
        `"spend 420 bidfood" to log a delivery.`,
      sendOpts
    );
    return;
  }

  if (type === "location") {
    const pending = pendingActions.get(from);
    if (!pending) {
      await sendText(from, "Thanks for the location — but I wasn't expecting one right now. Message \"in\" or \"out\" first.", sendOpts);
      return;
    }
    await handleLocationForClockAction(from, staff, message.location, pending, deps, sendOpts);
    return;
  }

  if (type === "image") {
    // A photo within 10 minutes of a diary entry attaches to it (probe
    // readings, delivery dockets); otherwise it's a credential for the wallet.
    if (await handleFoodSafetyPhoto(from, staff, message.image, tenantId, deps, sendOpts)) return;
    await handleCredentialPhoto(from, staff, message.image, tenantId, deps, sendOpts);
    return;
  }

  await sendText(from, `Received a ${type} message — this type isn't handled yet.`, sendOpts);
}

module.exports = { handleIncoming };
