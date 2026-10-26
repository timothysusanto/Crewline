# Telegram — primary staff channel

Crewline talks to staff over Telegram. No Meta business verification, no ABN
documents, no approval queue, free messages. WhatsApp still works as an optional
fallback if its env vars are set.

## Go live (about 5 minutes)

1. Telegram → **@BotFather** → `/newbot` → pick a display name and a username ending in `bot`. Copy the token.
   *A bot username is publicly searchable — choose it with that in mind.*
2. On Railway set two variables:
   - `TELEGRAM_BOT_TOKEN` — from BotFather
   - `TELEGRAM_WEBHOOK_SECRET` — any random string you invent
3. Deploy. On boot the server registers its own webhook (`<public url>/webhook/telegram`)
   using `PUBLIC_BASE_URL`, or `RAILWAY_PUBLIC_DOMAIN` which Railway sets automatically.
   Check the logs for `[startup] Telegram webhook registered`.
4. Message your bot. It asks you to tap **Share my phone number**; the number must match a
   staff record. After that you're linked for good.

## How it works

- A person **is** their phone number everywhere in the code. Telegram only gives a numeric
  chat ID, so a chat is linked once to an existing staff record (`telegramChatId` on the same
  document). Only a contact the sender shares about **themselves** is accepted — a forwarded
  contact card is rejected.
- `whatsapp.js` is the channel dispatcher. Replies go back on the channel the message arrived
  on. Proactive messages (shift offers, reminders, credential nudges) look up the recipient's
  linked chat and go to Telegram; if they aren't linked, WhatsApp is used only when configured.
- `POST /webhook/telegram` is authenticated by the secret token (`X-Telegram-Bot-Api-Secret-Token`),
  acknowledges immediately, then processes. Private chats only; groups are ignored.
- Commands are unchanged (`in`, `out`, `break`, `back`, `roster`, `wallet`, `temps`, …).
  Typing them with a slash also works (`/in`). Location and photos use Telegram's native
  share-location button and photo upload.

## The one real limitation

Telegram bots **cannot start a conversation**. Until someone has messaged the bot and shared
their number, nothing can be sent to them — no shift offers, no roster pushes. Staff onboarding
(everyone sends the bot one message) is the critical path, not the technical setup. The
dispatcher logs `[channel] no way to reach …` for anyone not yet linked.

## Not covered yet

Hotel/client ordering (the `intakeHandler` flow) identifies requesters by phone number and is
not linked to Telegram yet — clients still need WhatsApp, or a Telegram link flow for requesters.
