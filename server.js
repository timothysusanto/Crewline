"use strict";

/**
 * Crewline — webhook skeleton (build step 1 of backend-build-scope.md).
 *
 * Proves the pipe: WhatsApp message -> Meta Cloud API -> this webhook ->
 * sender lookup -> reply through the Send API. Nothing else.
 */

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { verifyMetaSignature } = require("./verifySignature");
const { sendText, setChannelResolver } = require("./whatsapp");
const { handleTelegramUpdate, verifyTelegramSecret } = require("./telegramWebhook");
const telegramClient = require("./telegramClient");
const { handleIncoming } = require("./router");
const { buildStores } = require("./stores");
const { InMemoryPendingActions } = require("./pendingActions");
const { normalizeGeofence, slugifySiteId, MIN_RADIUS_METERS, MAX_RADIUS_METERS } = require("./siteStore");
const { verify: verifyLink, isConfigured: linksConfigured } = require("./signedLinks");
const { gridModel, nextWeekStart } = require("./availabilityCapture");
const { normalizeDays, declaredCellCount, isSubmitted } = require("./availabilityStore");
const { weekStartOf, weekDates, BLOCKS, DAY_KEYS, normalizeBlocks } = require("./availabilityBlocks");

// Multi-venue: every dashboard request carries req.tenantId, resolved from
// the dashboard key by requireDashboardKey. MANAGER_DASHBOARD_PASSWORD is the
// admin key: it opens the original venue below AND the /api/admin routes that
// create new venues. Each new venue gets its own random key.
const ADMIN_TENANT_ID = process.env.ADMIN_TENANT_ID || "demo-venue";
const DEFAULT_STAFF_LIMIT = 15;

const app = express();
const {
  staffStore, tenantStore, siteStore, availabilityStore,
  shiftsStore, rosterStore, purchasesStore, backend,
} = buildStores();
const pendingActions = new InMemoryPendingActions();
const deps = {
  staffStore, tenantStore, siteStore, availabilityStore,
  shiftsStore, rosterStore, purchasesStore, pendingActions,
};

console.log(`[startup] data backend: ${backend}`);

// Telegram is the primary channel: any message addressed to a phone number goes
// to that person's linked Telegram chat; WhatsApp is only the fallback (see
// whatsapp.js). Bots can't initiate, so someone who hasn't linked yet is
// unreachable until they message the bot once.
setChannelResolver(async (phone) => (await staffStore.findByPhone(phone))?.telegramChatId || null);

// Weekly availability pings ("what can you work next week?") — checked hourly.
// This used to ride on the staffing-request engine's 30-second tick; hourly is
// plenty and keeps Firestore reads well inside the free tier.
const { sweepWeeklyPings } = require("./availabilityCapture");
if (process.env.AVAILABILITY_PINGS_DISABLED === "1") {
  console.warn("[startup] AVAILABILITY_PINGS_DISABLED=1 — weekly availability pings are off");
} else {
  const pingTick = async () => {
    try {
      for (const t of await tenantStore.listAll()) {
        await sweepWeeklyPings(t.tenantId, deps, {}).catch((err) => console.error(`[pings] sweep failed for ${t.tenantId}:`, err.message));
      }
    } catch (err) { console.error("[pings] couldn't list venues:", err.message); }
  };
  setTimeout(pingTick, 60 * 1000);
  setInterval(pingTick, 60 * 60 * 1000).unref();
}

// Capture the raw body — Meta's signature is computed over raw bytes,
// so verification must happen against them, not the parsed object.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 * GET /webhook/whatsapp — Meta's one-time verification handshake.
 * Configured in the Meta App dashboard: Webhooks -> Callback URL + Verify Token.
 */
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[webhook] verification handshake OK");
    return res.status(200).send(challenge);
  }
  console.warn("[webhook] verification handshake FAILED");
  return res.sendStatus(403);
});

/**
 * POST /webhook/whatsapp — all incoming events.
 * Always 200 fast; process asynchronously. Meta retries on non-2xx and
 * slow responses, which causes duplicate processing.
 */
app.post("/webhook/whatsapp", (req, res) => {
  const signature = req.get("X-Hub-Signature-256");
  const appSecret = process.env.META_APP_SECRET;

  if (!verifyMetaSignature(req.rawBody, signature, appSecret)) {
    console.warn("[webhook] BAD SIGNATURE — rejecting");
    return res.sendStatus(403);
  }

  // Acknowledge immediately.
  res.sendStatus(200);

  // Then process. WhatsApp payload shape:
  // { entry: [ { changes: [ { value: { messages?: [...], statuses?: [...] } } ] } ] }
  const entries = req.body?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      // Delivery/read receipts arrive as `statuses` — ignore in the skeleton.
      if (value.statuses) continue;

      // Which WhatsApp number this message arrived on. In a single-venue
      // deployment this is irrelevant (everything uses the env-var number).
      // In a multi-tenant setup, this is how we know which venue owns the
      // conversation *before* even looking up the sender as staff.
      const incomingPhoneNumberId = value.metadata?.phone_number_id || null;

      for (const message of value.messages ?? []) {
        resolveTenantAndHandle(message, incomingPhoneNumberId).catch((err) =>
          console.error("[handler] error:", err)
        );
      }
    }
  }
});

/**
 * POST /webhook/telegram — Telegram bot updates.
 * Authenticated by the secret token registered with setWebhook, echoed back in
 * X-Telegram-Bot-Api-Secret-Token. Always 200 fast, then process.
 */
app.post("/webhook/telegram", (req, res) => {
  if (!verifyTelegramSecret(req.get("X-Telegram-Bot-Api-Secret-Token"))) {
    console.warn("[telegram] BAD SECRET — rejecting");
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  handleTelegramUpdate(req.body, deps)
    .then((outcome) => console.log(`[telegram] update handled: ${outcome}`))
    .catch((err) => console.error("[telegram] handler error:", err));
});

/**
 * Resolves which venue (tenant) owns the WhatsApp number a message arrived
 * on, then hands off to the router with that context attached. If no
 * matching tenant is found (e.g. phoneNumberId is missing, or this tenant
 * hasn't been given its own number yet), tenantContext is null — router.js
 * and clockHandler.js then fall back to the single-venue env vars, exactly
 * as before this change. This makes multi-tenant support additive, not a
 * breaking change to the existing single-venue deployment.
 */
async function resolveTenantAndHandle(message, incomingPhoneNumberId) {
  let tenantContext = null;
  if (incomingPhoneNumberId) {
    const tenant = await tenantStore.findByPhoneNumberId(incomingPhoneNumberId);
    if (tenant) {
      tenantContext = {
        tenantId: tenant.tenantId,
        phoneNumberId: tenant.phoneNumberId,
        token: tenant.whatsappToken || null,
      };
    }
  }
  await handleIncoming(message, deps, tenantContext);
}

/**
 * Availability, rung 3 of the capture ladder (docs/agencymodelshape.md step 3).
 *
 * GET /a/:token — the 7 × 3 chip grid. Twenty seconds, no login, no password:
 * the signed link IS the credential. See signedLinks.js for what that token
 * does and does not grant.
 *
 * Deliberately NOT behind requireDashboardKey — the whole point is that a casual
 * can answer from a WhatsApp message without an account. The token restricts it
 * to one person, one week.
 */
app.get("/a/:token", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "availability.html"));
});

/**
 * GET /api/availability/:token — the week to render. The client fetches this
 * rather than having it templated in, so the page is a static file the CDN can
 * cache and the token is only ever validated server-side.
 */
app.get("/api/availability/:token", async (req, res) => {
  try {
    const check = verifyLink(req.params.token);
    if (!check.ok) return res.status(401).json({ error: linkError(check.reason) });
    const { tenantId, phone, weekStart, scope } = check.claims;
    if (scope !== "availability") return res.status(403).json({ error: "That link isn't for this page." });

    const [staff, doc] = await Promise.all([
      staffStore.findByPhone(phone),
      availabilityStore.findOrEmpty(tenantId, phone, weekStart),
    ]);
    if (!staff || staff.tenantId !== tenantId) {
      return res.status(404).json({ error: "We can't find your record — please ask your manager." });
    }

    res.json({ name: staff.name, ...gridModel(doc, weekStart) });
  } catch (err) {
    console.error("[availability] failed to load grid:", err);
    res.status(500).json({ error: "Couldn't load your week — please try again." });
  }
});

/**
 * POST /api/availability/:token — the grid submitting.
 * Body: { days: { "YYYY-MM-DD": ["AM","PM","NIGHT"] } }
 *
 * An empty `days` is a real answer, not a mistake: it means "I can't work next
 * week". The three-state model depends on that being distinguishable from never
 * having replied, which is why submitting always sets `submittedAt`.
 */
app.post("/api/availability/:token", async (req, res) => {
  try {
    const check = verifyLink(req.params.token);
    if (!check.ok) return res.status(401).json({ error: linkError(check.reason) });
    const { tenantId, phone, weekStart, scope } = check.claims;
    if (scope !== "availability") return res.status(403).json({ error: "That link isn't for this page." });

    const staff = await staffStore.findByPhone(phone);
    if (!staff || staff.tenantId !== tenantId) {
      return res.status(404).json({ error: "We can't find your record — please ask your manager." });
    }

    const days = normalizeDays((req.body || {}).days, weekStart);
    const doc = await availabilityStore.submit(tenantId, phone, weekStart, days, "grid");
    res.json({ ok: true, cells: declaredCellCount(doc), submittedAt: doc.submittedAt });
  } catch (err) {
    console.error("[availability] failed to submit:", err);
    res.status(500).json({ error: "Couldn't save that — please try again." });
  }
});

/** Staff-facing wording for a link that didn't verify. */
function linkError(reason) {
  switch (reason) {
    case "EXPIRED":
      return "This link has expired. Message us and we'll send a fresh one.";
    case "NOT_CONFIGURED":
      return "Links aren't set up on this deployment yet — please tell your manager.";
    default:
      return "This link doesn't look right. Message us and we'll send a fresh one.";
  }
}

/**
 * GET /api/availability?week=YYYY-MM-DD — the supply side of the supply-vs-demand
 * grid: declared headcount per day-block for the whole tenant, plus who hasn't
 * answered. Shows you're twelve Night people short on Saturday before you fail
 * to fill it.
 */
app.get("/api/availability", requireDashboardKey, async (req, res) => {
  try {
    const weekStart = req.query.week
      ? weekStartOf(`${String(req.query.week)}T12:00:00`)
      : nextWeekStart();
    const [docs, staff] = await Promise.all([
      availabilityStore.listByWeek(req.tenantId, weekStart),
      staffStore.listByTenant(req.tenantId),
    ]);

    const byPhone = new Map(docs.map((d) => [d.phone, d]));
    // 7 × 3 counts of people who said yes.
    const grid = {};
    for (const dateIso of weekDates(weekStart)) {
      grid[dateIso] = Object.fromEntries(BLOCKS.map((b) => [b, 0]));
    }
    for (const doc of docs) {
      if (!isSubmitted(doc)) continue;
      for (const [dateIso, blocks] of Object.entries(doc.days || {})) {
        if (!grid[dateIso]) continue;
        for (const block of blocks) if (grid[dateIso][block] !== undefined) grid[dateIso][block] += 1;
      }
    }

    // Three states, reported apart. Silence is not a no.
    const answered = staff.filter((s) => isSubmitted(byPhone.get(s.phone)));
    const silent = staff.filter((s) => !isSubmitted(byPhone.get(s.phone)));
    const unavailable = answered.filter((s) => declaredCellCount(byPhone.get(s.phone)) === 0);

    res.json({
      weekStart,
      grid,
      poolSize: staff.length,
      answered: answered.length,
      unavailable: unavailable.length,
      unknown: silent.map((s) => ({ phone: s.phone, name: s.name })),
      freeTodayNow: (await freeTodayStore.listLive(req.tenantId)).length,
    });
  } catch (err) {
    console.error("[availability] failed to load week:", err);
    res.status(500).json({ error: "Failed to load availability." });
  }
});

/**
 * Manager dashboard (build step 3) — a page served directly by this server,
 * reading real data through the same admin Firestore connection the bot
 * already uses. No separate client-side Firebase config or security rules
 * needed: the browser never talks to Firestore directly, only to this
 * server's own API, which is gated by a shared key below.
 */
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

/**
 * Gate for everything under /api — requires a shared secret set as
 * MANAGER_DASHBOARD_PASSWORD in Railway's Variables tab. Accepts the key as
 * either a query param (?key=...) or an X-Dashboard-Key header.
 * If the env var isn't set at all, every request is rejected — safer than
 * silently allowing open access.
 */
const keyCache = new Map(); // key -> { tenantId, name, at }
const KEY_CACHE_MS = 60 * 1000;

async function requireDashboardKey(req, res, next) {
  const adminKey = process.env.MANAGER_DASHBOARD_PASSWORD;
  if (!adminKey) {
    return res.status(500).json({ error: "MANAGER_DASHBOARD_PASSWORD is not set on the server." });
  }
  const provided = req.query.key || req.get("X-Dashboard-Key");
  if (!provided) return res.status(401).json({ error: "Invalid or missing dashboard key." });

  if (provided === adminKey) {
    req.tenantId = ADMIN_TENANT_ID;
    req.isAdmin = true;
    return next();
  }
  try {
    const cached = keyCache.get(provided);
    if (cached && Date.now() - cached.at < KEY_CACHE_MS) {
      req.tenantId = cached.tenantId;
      req.tenantName = cached.name;
      return next();
    }
    const tenant = await tenantStore.findByDashboardKey(provided);
    if (!tenant || tenant.active === false) {
      return res.status(401).json({ error: "Invalid or missing dashboard key." });
    }
    keyCache.set(provided, { tenantId: tenant.tenantId, name: tenant.name, at: Date.now() });
    req.tenantId = tenant.tenantId;
    req.tenantName = tenant.name;
    return next();
  } catch (err) {
    console.error("[auth] key lookup failed:", err.message);
    return res.status(500).json({ error: "Couldn't verify the dashboard key — try again." });
  }
}

/**
 * Cross-venue guard for routes addressed by record id: a manager's key must
 * only ever touch records that belong to their venue. Responds 404 (not 403)
 * so an id from another venue looks the same as a missing one.
 */
async function owned(req, res, record) {
  if (record && record.tenantId === req.tenantId) return true;
  res.status(404).json({ error: "Not found." });
  return false;
}

/** Admin-only (the MANAGER_DASHBOARD_PASSWORD key). */
function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: "Admin key required." });
  next();
}

/**
 * GET /api/dashboard — everything the dashboard page needs in one call:
 * the venue's staff list and every shift record for this tenant. Sorting
 * into "on shift now" / "needs review" / "history" happens client-side in
 * dashboard.html, not here — keeps this endpoint a single simple query per
 * collection (no compound Firestore indexes required).
 */
app.get("/api/dashboard", requireDashboardKey, async (req, res) => {
  try {
    // Scale discipline: never ship the whole shift history to the browser.
    // The dashboard only renders open shifts + a recent window (history table
    // caps at 25, hours/variance use 7 days), so 14 days covers everything.
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const [staff, openShifts, recentShifts, venue, sites] = await Promise.all([
      staffStore.listByTenant(req.tenantId),
      shiftsStore.listOpenByTenant(req.tenantId),
      shiftsStore.listRecentByTenant(req.tenantId, since),
      tenantStore.findById(req.tenantId),
      siteStore.listByTenant(req.tenantId, { includeInactive: true }),
    ]);
    const seen = new Set();
    const shifts = [...openShifts, ...recentShifts].filter((s) => {
      if (seen.has(s.shiftId)) return false;
      seen.add(s.shiftId);
      return true;
    });
    res.json({ staff, shifts, venue, sites });
  } catch (err) {
    console.error("[dashboard] failed to load data:", err);
    res.status(500).json({ error: "Failed to load dashboard data." });
  }
});

/**
 * POST /api/shifts/:id/review — Approve or Deny a flagged out-of-radius
 * clock-in. Body: { approve: boolean }.
 */
app.post("/api/shifts/:id/review", requireDashboardKey, async (req, res) => {
  try {
    const approve = Boolean(req.body?.approve);
    if (!(await owned(req, res, await shiftsStore.findById(req.params.id)))) return;
    const updated = await shiftsStore.reviewFlaggedShift(req.params.id, approve);
    res.json({ ok: true, shift: updated });
  } catch (err) {
    console.error("[dashboard] failed to review shift:", err);
    res.status(500).json({ error: "Failed to update that shift." });
  }
});

/**
 * POST /api/staff — add or update a staff member for this venue.
 * Body: { phone, name, role, department }. `phone` is the Firestore
 * document ID (international format, no "+"), same convention as manual
 * setup — this just does it through the dashboard instead of by hand.
 */
app.post("/api/staff", requireDashboardKey, async (req, res) => {
  try {
    const { phone, name, role, department } = req.body || {};
    if (!phone || !name) {
      return res.status(400).json({ error: "phone and name are required." });
    }
    if (!["owner", "manager", "staff"].includes(role)) {
      return res.status(400).json({ error: 'role must be "owner", "manager", or "staff".' });
    }
    const wageRate = req.body.wageRate != null ? Number(req.body.wageRate) : null;
    if (wageRate != null && (!isFinite(wageRate) || wageRate < 0)) {
      return res.status(400).json({ error: "wageRate must be a non-negative number." });
    }

    // The jobs this person can be sent to do — matched against a request's role.
    // Distinct from `role` above, which is their access level.
    const roles = Array.isArray(req.body.roles)
      ? [...new Set(req.body.roles.map((r) => String(r).trim().toLowerCase()).filter(Boolean))]
      : undefined;

    // Rung 2 of the capture ladder: "normally free AM Mon–Fri", captured once,
    // which turns the weekly ping into confirm-or-amend.
    let standingPattern;
    if (req.body.standingPattern && typeof req.body.standingPattern === "object") {
      standingPattern = {};
      for (const day of DAY_KEYS) {
        const blocks = normalizeBlocks(req.body.standingPattern[day]);
        if (blocks.length) standingPattern[day] = blocks;
      }
    }

    const cleanPhone = String(phone).replace(/\D/g, "");
    if (!cleanPhone) return res.status(400).json({ error: "phone must be digits, international format (e.g. 61412345678)." });
    const existing = await staffStore.findByPhone(cleanPhone);
    if (existing && existing.tenantId && existing.tenantId !== req.tenantId) {
      return res.status(409).json({ error: "That number is already registered at another venue." });
    }
    if (!existing) {
      const tenant = await tenantStore.findById(req.tenantId);
      const limit = (tenant && tenant.staffLimit) || DEFAULT_STAFF_LIMIT;
      const current = (await staffStore.listByTenant(req.tenantId)).filter((p) => p.active !== false && p.role !== "owner").length;
      if (current >= limit) {
        return res.status(402).json({ error: `Your plan includes ${limit} staff. Deactivate someone or upgrade to add more.` });
      }
    }

    await staffStore.upsert({
      phone: cleanPhone,
      tenantId: req.tenantId,
      name: String(name).trim(),
      role,
      department: department ? String(department).trim() : null,
      wageRate,
      ...(roles ? { roles } : {}),
      ...(standingPattern ? { standingPattern } : {}),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[dashboard] failed to add staff:", err);
    res.status(500).json({ error: "Failed to add staff member." });
  }
});


/**
 * Sites — the buildings staff get sent to, and where the clock-in geofence
 * now lives (docs/agencymodelshape.md, build order step 1).
 *
 * GET /api/sites — every site for this tenant, inactive ones included so the
 * dashboard can show them greyed rather than silently losing them. Also
 * reports whether the tenant is still leaning on its pre-sites `geofence`
 * field, which is the one thing an operator needs prompting to fix.
 */
app.get("/api/sites", requireDashboardKey, async (req, res) => {
  try {
    const [sites, venue] = await Promise.all([
      siteStore.listByTenant(req.tenantId, { includeInactive: true }),
      tenantStore.findById(req.tenantId),
    ]);
    res.json({
      sites,
      // True while clock-ins are still being checked against the tenant-level
      // radius because no site exists yet — see siteResolver.js step 4.
      usingLegacyTenantGeofence: sites.length === 0 && Boolean(venue && venue.geofence),
      legacyTenantGeofence: (venue && venue.geofence) || null,
    });
  } catch (err) {
    console.error("[sites] failed to list:", err);
    res.status(500).json({ error: "Failed to load sites." });
  }
});

/**
 * POST /api/sites — create or update a site.
 * Body: { siteId?, name, address?, geofence: {lat, lng, radiusMeters},
 *       }
 *
 * `siteId` is a slug derived from the name when not supplied, so it reads
 * usefully on a shift record. It is never regenerated on update — renaming
 * "Hilton Sydney" must not orphan the shifts that reference hilton-sydney.
 */
app.post("/api/sites", requireDashboardKey, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required." });

    // Site ids are global, so a new site's id is prefixed with the venue id —
    // two venues can both have a "Main Kitchen" without colliding. Editing an
    // existing site keeps its id (and must belong to this venue).
    let siteId;
    if (body.siteId) {
      siteId = slugifySiteId(body.siteId);
      const existing = siteId ? await siteStore.findById(siteId) : null;
      if (existing && existing.tenantId !== req.tenantId) return res.status(404).json({ error: "Not found." });
      if (!existing) siteId = `${req.tenantId}-${siteId}`;
    } else {
      const slug = slugifySiteId(name);
      siteId = slug ? `${req.tenantId}-${slug}` : null;
    }
    if (!siteId) {
      return res.status(400).json({ error: "name must contain at least one letter or number." });
    }

    // A site without coordinates can't validate a clock-in, so refuse the
    // half-configured version rather than storing a site that silently flags
    // everyone sent to it.
    const geofence = normalizeGeofence(body.geofence);
    if (!geofence) {
      return res.status(400).json({
        error:
          "geofence must be {lat, lng, radiusMeters} with a valid latitude and longitude. " +
          `radiusMeters is clamped to ${MIN_RADIUS_METERS}-${MAX_RADIUS_METERS}m.`,
      });
    }


    const site = await siteStore.upsert(siteId, {
      tenantId: req.tenantId,
      name,
      address: body.address,
      geofence,
      active: body.active !== false,
    });
    res.json({ ok: true, site });
  } catch (err) {
    console.error("[sites] failed to save:", err);
    res.status(500).json({ error: "Failed to save site." });
  }
});

/**
 * POST /api/sites/:id/active — deactivate or reactivate a site.
 * Body: { active: boolean }. Sites are never hard-deleted: shifts reference
 * them by id, and an invoice from three months ago still has to name the
 * building it was worked at.
 */
app.post("/api/sites/:id/active", requireDashboardKey, async (req, res) => {
  try {
    if (!(await owned(req, res, await siteStore.findById(req.params.id)))) return;
    const site = await siteStore.setActive(req.params.id, Boolean(req.body?.active));
    res.json({ ok: true, site });
  } catch (err) {
    if (err.message === "SITE_NOT_FOUND") {
      return res.status(404).json({ error: "No site with that id." });
    }
    console.error("[sites] failed to change active state:", err);
    res.status(500).json({ error: "Failed to update site." });
  }
});

/**
 * Penalty-rate settings — a configurable cost-estimation engine, NOT award
 * interpretation. The AU/US presets in the dashboard pre-fill these fields
 * as editable starting points; the venue owner confirms them against their
 * own award / state law. Numbers here feed roster costing only, never pay.
 */
app.get("/api/settings/penalties", requireDashboardKey, async (req, res) => {
  try {
    const venue = await tenantStore.findById(req.tenantId);
    res.json({ penaltyRules: (venue && venue.penaltyRules) || null });
  } catch (err) {
    console.error("[settings] failed to load penalties:", err);
    res.status(500).json({ error: "Failed to load penalty settings." });
  }
});

app.post("/api/settings/penalties", requireDashboardKey, async (req, res) => {
  try {
    const r = req.body || {};
    const num = (v, min, max) => {
      const n = Number(v);
      return isFinite(n) && n >= min && n <= max ? n : null;
    };
    const penaltyRules = {
      saturday: num(r.saturday, 0.5, 5) ?? 1,
      sunday: num(r.sunday, 0.5, 5) ?? 1,
      publicHoliday: num(r.publicHoliday, 0.5, 5) ?? 1,
      overtimeWeeklyHours: num(r.overtimeWeeklyHours, 1, 168) ?? 40,
      overtimeMultiplier: num(r.overtimeMultiplier, 1, 5) ?? 1.5,
      publicHolidays: Array.isArray(r.publicHolidays)
        ? r.publicHolidays.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).slice(0, 60)
        : [],
      preset: ["AU", "US", "custom"].includes(r.preset) ? r.preset : "custom",
      slotHours: {
        AM: num(r.slotHours && r.slotHours.AM, 0.5, 24) ?? 5,
        PM: num(r.slotHours && r.slotHours.PM, 0.5, 24) ?? 6,
        ALL: num(r.slotHours && r.slotHours.ALL, 0.5, 24) ?? 10,
      },
    };
    await tenantStore.updateSettings(req.tenantId, { penaltyRules });
    res.json({ ok: true, penaltyRules });
  } catch (err) {
    console.error("[settings] failed to save penalties:", err);
    res.status(500).json({ error: "Failed to save penalty settings." });
  }
});


/**
 * GET /api/purchases?week=YYYY-MM-DD — the week's purchases (Mon..Sun),
 * newest first, plus the week total. Date filtering in JS: single-field
 * Firestore query keeps us index-free (same discipline as elsewhere).
 */
app.get("/api/purchases", requireDashboardKey, async (req, res) => {
  try {
    const weekStart = String(req.query.week || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: "week must be YYYY-MM-DD (a Monday)." });
    }
    const end = new Date(weekStart + "T12:00:00");
    end.setDate(end.getDate() + 7);
    const weekEnd = end.toISOString().slice(0, 10);
    const all = await purchasesStore.listByTenant(req.tenantId);
    const purchases = all
      .filter((p) => p.date >= weekStart && p.date < weekEnd)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const total = purchases.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    res.json({ purchases, total });
  } catch (err) {
    console.error("[purchases] failed to list:", err);
    res.status(500).json({ error: "Failed to load purchases." });
  }
});

/**
 * POST /api/purchases — log a purchase from the dashboard.
 * Body: { date: "YYYY-MM-DD", amount, supplier }.
 */
app.post("/api/purchases", requireDashboardKey, async (req, res) => {
  try {
    const { date, amount, supplier } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD." });
    }
    const amt = Number(amount);
    if (!isFinite(amt) || amt <= 0 || amt > 1000000) {
      return res.status(400).json({ error: "amount must be a positive number." });
    }
    const record = await purchasesStore.add({
      tenantId: req.tenantId,
      date,
      amount: amt,
      supplier: supplier ? String(supplier).trim().slice(0, 80) : null,
      source: "manual",
      loggedBy: null,
    });
    res.json({ ok: true, purchase: record });
  } catch (err) {
    console.error("[purchases] failed to add:", err);
    res.status(500).json({ error: "Failed to log that purchase." });
  }
});

/** DELETE /api/purchases/:id — remove a mis-entered purchase. */
app.delete("/api/purchases/:id", requireDashboardKey, async (req, res) => {
  try {
    if (!(await owned(req, res, await purchasesStore.findById(req.params.id)))) return;
    await purchasesStore.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[purchases] failed to delete:", err);
    res.status(500).json({ error: "Failed to remove that purchase." });
  }
});


/**
 * POST /api/shifts/:id/close — manager force clock-out for forgotten
 * "out" texts (a nightly reality in kitchens). Closes the shift now with
 * no location, marked forcedByManager so reports can tell it apart.
 */
app.post("/api/shifts/:id/close", requireDashboardKey, async (req, res) => {
  try {
    if (!(await owned(req, res, await shiftsStore.findById(req.params.id)))) return;
    const updated = await shiftsStore.closeShift(req.params.id, {
      time: new Date().toISOString(),
      forcedByManager: true,
    });
    res.json({ ok: true, shift: updated });
  } catch (err) {
    console.error("[dashboard] failed to force-close shift:", err);
    res.status(500).json({ error: "Failed to close that shift." });
  }
});


/**
 * POST /api/shifts/:id/amend — timesheet correction with audit trail.
 * Body: { clockInTime, clockOutTime, breakMinutes } (ISO strings / number).
 * Originals stay untouched on the shift document; reports flag amended
 * rows and include the original values.
 */
app.post("/api/shifts/:id/amend", requireDashboardKey, async (req, res) => {
  try {
    const { clockInTime, clockOutTime, breakMinutes } = req.body || {};
    const validIso = (v) => !v || !isNaN(new Date(v).getTime());
    if (!validIso(clockInTime) || !validIso(clockOutTime)) {
      return res.status(400).json({ error: "clockInTime/clockOutTime must be valid times." });
    }
    const bm = breakMinutes != null ? Number(breakMinutes) : null;
    if (bm != null && (!isFinite(bm) || bm < 0 || bm > 1440)) {
      return res.status(400).json({ error: "breakMinutes must be 0–1440." });
    }
    if (!(await owned(req, res, await shiftsStore.findById(req.params.id)))) return;
    const updated = await shiftsStore.amendShift(req.params.id, {
      clockInTime, clockOutTime, breakMinutes: bm,
    });
    res.json({ ok: true, shift: updated });
  } catch (err) {
    console.error("[dashboard] failed to amend shift:", err);
    res.status(500).json({ error: "Failed to amend that shift." });
  }
});

/** Effective (amended-aware) times for a shift. Shared by both reports. */
function effectiveShift(s) {
  const inIso = (s.amended && s.amended.clockInTime) || s.clockIn.time;
  const outIso = (s.amended && s.amended.clockOutTime) || (s.clockOut && s.clockOut.time);
  const breakMs = s.amended && s.amended.breakMinutes != null
    ? s.amended.breakMinutes * 60000
    : (s.breaks || []).reduce((sum, b) => (b.end ? sum + (new Date(b.end) - new Date(b.start)) : sum), 0);
  return { inIso, outIso, breakMs };
}

function reportDayMultiplier(dateIso, rules) {
  if (!rules) return 1;
  if ((rules.publicHolidays || []).includes(dateIso)) return rules.publicHoliday || 1;
  const dow = new Date(dateIso + "T12:00:00").getDay();
  if (dow === 6) return rules.saturday || 1;
  if (dow === 0) return rules.sunday || 1;
  return 1;
}

function reportMondayOf(dateIso) {
  const d = new Date(dateIso + "T12:00:00");
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/reports/payroll?from=YYYY-MM-DD&to=YYYY-MM-DD
 * The finance payment run: every closed shift in range with effective times,
 * paid hours, rate, day multiplier and pay; weekly overtime lines per staff;
 * per-staff and grand totals. Amended rows carry their originals — the
 * audit trail finance requires.
 */
app.get("/api/reports/payroll", requireDashboardKey, async (req, res) => {
  try {
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "from and to must be YYYY-MM-DD." });
    }
    const [staff, venue, shiftsRaw] = await Promise.all([
      staffStore.listByTenant(req.tenantId),
      tenantStore.findById(req.tenantId),
      shiftsStore.listRecentByTenant(req.tenantId, from),
    ]);
    const rules = venue && venue.penaltyRules;
    const endExclusive = new Date(to + "T12:00:00");
    endExclusive.setDate(endExclusive.getDate() + 1);
    const endIso = endExclusive.toISOString().slice(0, 10);

    const rows = [];
    const weekHours = {}; // `${phone}|${weekStart}` -> hours
    for (const s of shiftsRaw) {
      if (!s.clockOut || s.clockOut.denied) continue;
      const eff = effectiveShift(s);
      if (!eff.outIso) continue;
      const dateIso = eff.inIso.slice(0, 10);
      if (dateIso < from || dateIso >= endIso) continue;
      const person = staff.find((x) => x.phone === s.staffPhone);
      const rate = person && person.wageRate != null ? Number(person.wageRate) : null;
      const hours = Math.max(0, (new Date(eff.outIso) - new Date(eff.inIso) - eff.breakMs) / 3600000);
      const mult = reportDayMultiplier(dateIso, rules);
      const pay = rate != null ? hours * rate * mult : null;
      const key = `${s.staffPhone}|${reportMondayOf(dateIso)}`;
      weekHours[key] = (weekHours[key] || 0) + hours;
      rows.push({
        staffPhone: s.staffPhone,
        name: person ? person.name : s.staffPhone,
        date: dateIso,
        clockIn: eff.inIso,
        clockOut: eff.outIso,
        breakMinutes: Math.round(eff.breakMs / 60000),
        hours: Number(hours.toFixed(2)),
        rate,
        multiplier: mult,
        pay: pay != null ? Number(pay.toFixed(2)) : null,
        amended: Boolean(s.amended),
        originalClockIn: s.amended ? s.clockIn.time : null,
        originalClockOut: s.amended && s.clockOut ? s.clockOut.time : null,
        forcedByManager: Boolean(s.clockOut && s.clockOut.forcedByManager),
      });
    }

    // Weekly overtime premium lines (base-rate premium, matching the dashboard).
    const otRows = [];
    if (rules && rules.overtimeWeeklyHours) {
      for (const [key, hours] of Object.entries(weekHours)) {
        const over = hours - rules.overtimeWeeklyHours;
        if (over <= 0) continue;
        const [phone, weekStart] = key.split("|");
        const person = staff.find((x) => x.phone === phone);
        const rate = person && person.wageRate != null ? Number(person.wageRate) : null;
        if (rate == null) continue;
        otRows.push({
          staffPhone: phone,
          name: person ? person.name : phone,
          weekStart,
          overtimeHours: Number(over.toFixed(2)),
          premium: Number((over * rate * ((rules.overtimeMultiplier || 1) - 1)).toFixed(2)),
        });
      }
    }

    const perStaff = {};
    for (const r of rows) {
      const t = (perStaff[r.staffPhone] = perStaff[r.staffPhone] || { name: r.name, hours: 0, pay: 0, missingRate: false });
      t.hours += r.hours;
      if (r.pay != null) t.pay += r.pay; else t.missingRate = true;
    }
    for (const o of otRows) {
      const t = perStaff[o.staffPhone];
      if (t) t.pay += o.premium;
    }
    const grand = Object.values(perStaff).reduce(
      (g, t) => ({ hours: g.hours + t.hours, pay: g.pay + t.pay }), { hours: 0, pay: 0 }
    );
    res.json({ from, to, rows, otRows, perStaff, grand, rulesApplied: Boolean(rules) });
  } catch (err) {
    console.error("[reports] payroll failed:", err);
    res.status(500).json({ error: "Failed to build the payroll report." });
  }
});

/**
 * POST /api/weeks/:week — the week's revenue forecast and stocktake, used by
 * the P&L. Body: { revenueForecast?, openingStock?, closingStock? } (numbers
 * or null). Stored as tenant.weeks[week].
 */
app.post("/api/weeks/:week", requireDashboardKey, async (req, res) => {
  try {
    const week = String(req.params.week || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      return res.status(400).json({ error: "week must be YYYY-MM-DD (a Monday)." });
    }
    const venue = (await tenantStore.findById(req.tenantId)) || {};
    const weeks = { ...(venue.weeks || {}) };
    const cur = { ...(weeks[week] || {}) };
    for (const k of ["revenueForecast", "openingStock", "closingStock"]) {
      if (!(k in (req.body || {}))) continue;
      const v = req.body[k];
      if (v === null || v === "") { cur[k] = null; continue; }
      const n = Number(v);
      if (!isFinite(n) || n < 0) return res.status(400).json({ error: `${k} must be a non-negative number.` });
      cur[k] = n;
    }
    weeks[week] = cur;
    await tenantStore.updateSettings(req.tenantId, { weeks });
    res.json({ ok: true, week, ...cur });
  } catch (err) {
    console.error("[weeks] failed to save:", err);
    res.status(500).json({ error: "Failed to save the week's numbers." });
  }
});

/**
 * GET /api/reports/pnl?week=YYYY-MM-DD — the weekly P&L summary: revenue,
 * actual labour (amended-aware), food purchases / COGS, and the three
 * percentages management steers by.
 */
app.get("/api/reports/pnl", requireDashboardKey, async (req, res) => {
  try {
    const week = String(req.query.week || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      return res.status(400).json({ error: "week must be YYYY-MM-DD (a Monday)." });
    }
    const endD = new Date(week + "T12:00:00");
    endD.setDate(endD.getDate() + 7);
    const weekEnd = endD.toISOString().slice(0, 10);

    const [staff, venue, shiftsRaw, purchasesAll] = await Promise.all([
      staffStore.listByTenant(req.tenantId),
      tenantStore.findById(req.tenantId),
      shiftsStore.listRecentByTenant(req.tenantId, week),
      purchasesStore.listByTenant(req.tenantId),
    ]);
    // Revenue forecast and stocktake for the week, entered on the dashboard's
    // "Numbers" panel (POST /api/weeks/:week). Lives on the tenant doc.
    const roster = (venue && venue.weeks && venue.weeks[week]) || {};
    const rules = venue && venue.penaltyRules;

    let labour = 0;
    const wh = {};
    for (const s of shiftsRaw) {
      if (!s.clockOut || s.clockOut.denied) continue;
      const eff = effectiveShift(s);
      if (!eff.outIso) continue;
      const dateIso = eff.inIso.slice(0, 10);
      if (dateIso < week || dateIso >= weekEnd) continue;
      const person = staff.find((x) => x.phone === s.staffPhone);
      if (!person || person.wageRate == null) continue;
      const hours = Math.max(0, (new Date(eff.outIso) - new Date(eff.inIso) - eff.breakMs) / 3600000);
      labour += hours * Number(person.wageRate) * reportDayMultiplier(dateIso, rules);
      wh[s.staffPhone] = (wh[s.staffPhone] || 0) + hours;
    }
    if (rules && rules.overtimeWeeklyHours) {
      for (const [phone, hours] of Object.entries(wh)) {
        const over = hours - rules.overtimeWeeklyHours;
        if (over <= 0) continue;
        const person = staff.find((x) => x.phone === phone);
        if (person && person.wageRate != null) {
          labour += over * Number(person.wageRate) * ((rules.overtimeMultiplier || 1) - 1);
        }
      }
    }

    const purchases = purchasesAll
      .filter((p) => p.date >= week && p.date < weekEnd)
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const hasStocktake = roster.openingStock != null && roster.closingStock != null;
    const cogs = hasStocktake ? Number(roster.openingStock) + purchases - Number(roster.closingStock) : purchases;
    const revenue = roster.revenueForecast != null ? Number(roster.revenueForecast) : null;

    const pct = (x) => (revenue > 0 ? Number(((x / revenue) * 100).toFixed(2)) : null);
    res.json({
      week, weekEnd,
      revenue,
      labourCost: Number(labour.toFixed(2)),
      purchases: Number(purchases.toFixed(2)),
      openingStock: roster.openingStock,
      closingStock: roster.closingStock,
      cogs: Number(cogs.toFixed(2)),
      cogsBasis: hasStocktake ? "stocktake" : "purchases",
      labourPct: pct(labour),
      foodPct: pct(cogs),
      primePct: revenue > 0 ? Number((((labour + cogs) / revenue) * 100).toFixed(2)) : null,
    });
  } catch (err) {
    console.error("[reports] pnl failed:", err);
    res.status(500).json({ error: "Failed to build the P&L report." });
  }
});

/** GET /api/me — which venue this key opens (the pages show the name). */
app.get("/api/me", requireDashboardKey, async (req, res) => {
  try {
    const tenant = await tenantStore.findById(req.tenantId);
    res.json({ tenantId: req.tenantId, name: (tenant && tenant.name) || req.tenantId, isAdmin: Boolean(req.isAdmin), staffLimit: (tenant && tenant.staffLimit) || DEFAULT_STAFF_LIMIT });
  } catch (err) {
    res.status(500).json({ error: "Couldn't load venue." });
  }
});

/**
 * Venue provisioning — admin key only. This is what happens when a Pro
 * member joins: one call creates their venue, their owner login for the bot,
 * a dashboard key of their own, and returns the welcome text to send them.
 *
 * POST /api/admin/tenants
 * Body: { name, ownerName, ownerPhone, ownerEmail?, staffLimit? }
 */
app.post("/api/admin/tenants", requireDashboardKey, requireAdmin, async (req, res) => {
  try {
    const { name, ownerName, ownerEmail, staffLimit } = req.body || {};
    const ownerPhone = String((req.body || {}).ownerPhone || "").replace(/\D/g, "");
    if (!name || !ownerName || !ownerPhone) {
      return res.status(400).json({ error: "name, ownerName and ownerPhone are required." });
    }
    const existingOwner = await staffStore.findByPhone(ownerPhone);
    if (existingOwner && existingOwner.tenantId) {
      return res.status(409).json({ error: `${ownerPhone} is already registered at venue "${existingOwner.tenantId}".` });
    }
    const base = slugifySiteId(name) || "venue";
    let tenantId = base;
    for (let n = 2; await tenantStore.findById(tenantId); n++) tenantId = `${base}-${n}`;
    const dashboardKey = crypto.randomBytes(12).toString("base64url");

    const tenant = await tenantStore.create(tenantId, {
      name: String(name).trim(),
      plan: "pro",
      staffLimit: Number(staffLimit) > 0 ? Number(staffLimit) : DEFAULT_STAFF_LIMIT,
      dashboardKey,
      ownerPhone,
      ownerName: String(ownerName).trim(),
      ownerEmail: ownerEmail || null,
      active: true,
      createdAt: new Date().toISOString(),
      fixedCosts: [],
    });
    await staffStore.upsert({
      phone: ownerPhone, tenantId, name: String(ownerName).trim(), role: "owner",
      department: null, wageRate: null, active: true, createdAt: new Date().toISOString(),
    });

    const base_url = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `${req.protocol}://${req.get("host")}`);
    const bot = process.env.TELEGRAM_BOT_USERNAME || "CrewLine_SuperApps_bot";
    const welcome =
      `Hi ${String(ownerName).trim()}, your Crewline venue "${String(name).trim()}" is ready.\n\n` +
      `1. Roster + crew list: ${base_url}/roster?key=${dashboardKey}\n` +
      `2. Dashboard (attendance, numbers, sites): ${base_url}/dashboard?key=${dashboardKey}\n` +
      `   Your dashboard key is ${dashboardKey} — keep it private, it's your login.\n` +
      `3. Add your staff on the Roster page with the mobile they use on Telegram (up to ${tenant.staffLimit}).\n` +
      `4. Everyone (you too) opens Telegram, messages @${bot}, taps "Share my phone number" — done. ` +
      `From then on: "in"/"out" to clock in, "roster" to see shifts, "temps" for food-safety checks.\n` +
      `5. On the Dashboard, add your site (address + radius) so clock-ins are location-checked.\n\n` +
      `Reply to this message if anything is unclear.`;

    console.log(`[admin] venue created: ${tenantId} (${tenant.name}) owner=${ownerPhone}`);
    res.json({ ok: true, tenantId, name: tenant.name, dashboardKey, ownerPhone, rosterUrl: `${base_url}/roster?key=${dashboardKey}`, dashboardUrl: `${base_url}/dashboard?key=${dashboardKey}`, welcome });
  } catch (err) {
    console.error("[admin] failed to create venue:", err);
    res.status(500).json({ error: "Failed to create the venue." });
  }
});

/** GET /api/admin/tenants — every venue, with staff counts. Admin key only. */
app.get("/api/admin/tenants", requireDashboardKey, requireAdmin, async (_req, res) => {
  try {
    const tenants = await tenantStore.listAll();
    const out = [];
    for (const t of tenants) {
      const staff = await staffStore.listByTenant(t.tenantId);
      out.push({
        tenantId: t.tenantId, name: t.name, plan: t.plan || null, active: t.active !== false,
        staffLimit: t.staffLimit || DEFAULT_STAFF_LIMIT, staff: staff.filter((p) => p.active !== false).length,
        linked: staff.filter((p) => p.telegramChatId).length, ownerPhone: t.ownerPhone || null, createdAt: t.createdAt || null,
      });
    }
    res.json({ tenants: out });
  } catch (err) {
    console.error("[admin] failed to list venues:", err);
    res.status(500).json({ error: "Failed to list venues." });
  }
});

/** POST /api/admin/tenants/:id/active — pause or resume a venue (e.g. subscription lapsed). */
app.post("/api/admin/tenants/:id/active", requireDashboardKey, requireAdmin, async (req, res) => {
  try {
    const t = await tenantStore.findById(req.params.id);
    if (!t) return res.status(404).json({ error: "No venue with that id." });
    await tenantStore.updateSettings(req.params.id, { active: Boolean(req.body?.active) });
    keyCache.clear();
    res.json({ ok: true, tenantId: req.params.id, active: Boolean(req.body?.active) });
  } catch (err) {
    res.status(500).json({ error: "Failed to update the venue." });
  }
});

// Simple liveness probe for the host / uptime checks.
app.get("/health", (_req, res) => res.json({ ok: true, service: "crewline", step: 2, backend }));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Core OS (Deskless Workforce OS) — Phase 1: rostering v2 with award-engine
// costing, credential wallet + roster guard, payroll CSV and compliance-pack
// exports. Mounted under /api/core so it can't collide with the existing
// /api/roster endpoint above. Gated by the same dashboard key as everything
// else. Uses the admin Firestore connection directly (null-safe: returns 503
// until FIREBASE_SERVICE_ACCOUNT_JSON is set).
const coreOSRoutes = require("./core-os-routes");
const { getFirestoreDb } = require("./firebase");
// Hospitality Edition: food safety diary API + page. Mounted before /api/core
// so its 503 guard (when Firestore is absent) speaks for itself.
const foodSafetyRoutes = require("./foodSafetyRoutes");
app.use("/api/core/foodsafety", requireDashboardKey, foodSafetyRoutes({
  db: getFirestoreDb(),
}));
app.get("/foodsafety", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "foodsafety.html"));
});
app.use("/api/core", requireDashboardKey, coreOSRoutes({
  db: getFirestoreDb(),
  staffStore,
  tenantStore,
  sendMessage: (phone, text) => sendText(phone, text),
}));
app.get("/roster", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "roster.html"));
});

// Credential expiry nudges (Phase 2) — 60/30/7-day and expired reminders to
// workers on WhatsApp. No-ops without Firestore; WALLET_NUDGES_DISABLED=1 off.
const { startWalletNudges } = require("./walletNudges");
startWalletNudges({
  db: getFirestoreDb(),
  listTenantIds: async () => (await tenantStore.listAll()).map((t) => t.tenantId),
  send: (phone, text) => sendText(phone, text),
});

// Scheduled food-safety check prompts (Phase 3) — off until promptPhones is
// configured; FOOD_SAFETY_PROMPTS_DISABLED=1 for debug instances.
const { startFoodSafetyPrompts } = require("./foodSafetyPrompts");
startFoodSafetyPrompts({
  db: getFirestoreDb(),
  listTenantIds: async () => (await tenantStore.listAll()).map((t) => t.tenantId),
  send: (phone, text) => sendText(phone, text),
});

// Fail fast on missing configuration rather than failing weirdly later.
// Telegram is the primary channel; the WhatsApp variables are only needed if
// you also want the WhatsApp fallback.
const telegramRequired = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"];
const telegramMissing = telegramRequired.filter((k) => !process.env[k]);
if (telegramMissing.length) {
  console.warn(`[startup] WARNING — missing env vars: ${telegramMissing.join(", ")}`);
  console.warn("[startup] The Telegram channel will not work until these are set.");
}
const whatsappVars = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "META_APP_SECRET"];
if (whatsappVars.every((k) => !process.env[k])) {
  console.log("[startup] WhatsApp not configured — running Telegram-only (this is fine).");
}
if (!process.env.MANAGER_DASHBOARD_PASSWORD) {
  console.warn("[startup] MANAGER_DASHBOARD_PASSWORD is not set — /dashboard will load but its data API will reject all requests until it's set.");
}

app.listen(PORT, () => {
  console.log(`Crewline listening on :${PORT}`);
  console.log(`Webhook URL paths: /webhook/telegram (primary), /webhook/whatsapp (optional)`);

  // Create any missing Firestore composite indexes (firestore.indexes.json).
  // Without them the dashboard reads the whole attendance collection per load.
  // Retries every 30 minutes while any index is still missing (e.g. until the
  // service account is granted "Cloud Datastore Index Admin"), then stops.
  const { getServiceAccount } = require("./firebase");
  if (getServiceAccount()) {
    const { ensureIndexes } = require("./ensureIndexes");
    const tryIndexes = async () => {
      try {
        const r = await ensureIndexes({ serviceAccount: getServiceAccount() });
        if (r.failed.length) setTimeout(tryIndexes, 30 * 60 * 1000).unref();
      } catch (err) {
        console.error("[indexes] failed:", err.message);
        setTimeout(tryIndexes, 30 * 60 * 1000).unref();
      }
    };
    tryIndexes();
  }

  // Self-register the Telegram webhook so there is no manual setWebhook step.
  // PUBLIC_BASE_URL wins; on Railway RAILWAY_PUBLIC_DOMAIN is provided automatically.
  const base =
    process.env.PUBLIC_BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
  if (!telegramMissing.length && base) {
    const url = `${base.replace(/\/+$/, "")}/webhook/telegram`;
    telegramClient
      .setWebhook(url, process.env.TELEGRAM_WEBHOOK_SECRET)
      .then((r) => console.log(`[startup] Telegram webhook ${r && r.ok ? "registered" : "registration FAILED"}: ${url}`))
      .catch((err) => console.error("[startup] Telegram webhook registration error:", err.message));
  } else if (!telegramMissing.length) {
    console.warn("[startup] Set PUBLIC_BASE_URL (or deploy on Railway with a public domain) to auto-register the Telegram webhook.");
  }
});
