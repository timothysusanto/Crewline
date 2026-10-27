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
- Commands: `in`, `out`, `break`, `back`, `roster`, `yes` / `swap` (answering a published
  roster), `avail`, `wallet`, `temps`, `clean`, `delivery`, `train`, `spend`. Typing them with a
  slash also works (`/in`). Location and photos use Telegram's native share-location button
  and photo upload.
- **One people list.** The roster page's crew list and the bot's staff list are the same
  Firestore records (`staff/{phone}`). Add someone once, on the Roster page, with the mobile
  number they use on Telegram; that number is how they're matched when they message the bot.
- **Roster → Telegram.** Publishing on the Roster page sends each person their week. `YES`
  marks the shifts confirmed; `SWAP` (optionally with a note) flags them on the roster and
  messages every manager/owner who has linked Telegram. Anyone who hasn't messaged the bot yet
  is listed as "not yet reachable" on publish.

## The one real limitation

Telegram bots **cannot start a conversation**. Until someone has messaged the bot and shared
their number, nothing can be sent to them — no shift offers, no roster pushes. Staff onboarding
(everyone sends the bot one message) is the critical path, not the technical setup. The
dispatcher logs `[channel] no way to reach …` for anyone not yet linked.

## Firestore quota

The server creates the composite indexes in `firestore.indexes.json` itself on boot
(`ensureIndexes.js`, via the Firestore Admin API with the same service account). Look for
`[indexes] creating …` or `[indexes] all … present` in the deploy log. If it logs a 403, grant the
service account **Cloud Datastore Index Admin** in IAM once, or create the indexes in the console.
Without them the dashboard reads the whole attendance collection on every load, which is what
used up the free tier.

## Venues (multi-tenant)

Each Pro member is a **venue** with its own dashboard key. `MANAGER_DASHBOARD_PASSWORD` is the
admin key: it opens the original venue (`ADMIN_TENANT_ID`, default `demo-venue`) and the admin
routes. One bot serves every venue — a person is matched to their venue by the phone number they
share, so a number can only be on one venue's list.

Create a venue when a Pro order lands (admin key, copy-paste):

```
curl -X POST "https://<host>/api/admin/tenants?key=<ADMIN KEY>" \
  -H "content-type: application/json" \
  -d '{"name":"Blue Door Cafe","ownerName":"Dani","ownerPhone":"61400111222","ownerEmail":"dani@example.com"}'
```

The response holds the venue's `dashboardKey`, the roster and dashboard links, and a ready-to-send
`welcome` message for the member. `GET /api/admin/tenants` lists every venue with staff and
linked counts; `POST /api/admin/tenants/:id/active {"active":false}` pauses one (lapsed
subscription) — its key stops working immediately, nothing is deleted.

Limits: `staffLimit` per venue (default 15, owner not counted); the roster page and the
dashboard both refuse the 16th with a plan message. Records addressed by id (shifts, sites,
purchases) are checked against the caller's venue and answer 404 for anyone else's.
