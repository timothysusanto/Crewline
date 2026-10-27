# Crewline

Telegram-first staff app for small venues — a café, a restaurant, a bar with 5–30 people.
Staff message a Telegram bot to clock in and out (GPS-checked), see their roster, confirm it
or ask for a swap, set availability, file their certificates, run the food-safety checks and
log deliveries. Managers get a roster page with award-rate costing, a dashboard with attendance
review, hours, sites and the weekly P&L, a food-safety diary and payroll CSV.

No Meta business verification: Telegram is the primary channel, WhatsApp is an optional
fallback. Setup is in `docs/telegram-channel.md`.

## What's in the box

| Area | Where | What |
|---|---|---|
| Staff bot | `router.js`, `telegramWebhook.js`, `*Handler.js` | clock in/out, breaks, roster, YES/SWAP, availability, wallet, food safety, training, deliveries |
| Roster | `/roster`, `core-os-routes.js`, `rosterStore.js`, `award-engine.js` | crew list, shift builder, award costing, publish to Telegram, credential wallet, training gaps, payroll CSV |
| Dashboard | `/dashboard`, `server.js` | on shift now, flagged clock-ins, amendments, sites/geofence, penalty settings, week numbers, reports |
| Food safety | `/foodsafety`, `foodSafety*.js` | temperature runs, cleaning list, deliveries, scheduled prompts |

One people list: `staff/{phone}` is used by the bot and the roster page alike.
One roster: `tenants/{tenant}/shifts`. Attendance (actual clock-ins) is the top-level `shifts`.

## Run it

```
npm install
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON, MANAGER_DASHBOARD_PASSWORD
npm start
npm test
```

On Railway: push to `main`, set the same variables, done — the server registers its own Telegram
webhook on boot. Deploy `firestore.indexes.json` once (see `docs/telegram-channel.md`).

## History

The original build notes (WhatsApp-first, build steps 1–5) and the labour-hire/agency model
that was removed in Oct 2026 are under `docs/` and `docs/archive/`.
