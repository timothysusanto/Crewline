/**
 * core-os-routes.js — Core OS API: rostering, credential wallet, payroll & compliance exports
 * Deskless Workforce OS — mounts onto the existing Express app in one line (see WIRING.md).
 *
 * Firestore layout (extends the existing tenants/{tenant} structure):
 *   staff/{phone}                          { tenantId, name, role, employmentType, level, awardCode, active,
 *                                            telegramChatId? } — the SAME list the bot uses; workerId == phone
 *   tenants/{t}/shifts/{shiftId}           { workerId, date, start, end, unpaidBreakMins, role,
 *                                            published, createdAt, updatedAt, audit: [...] }
 *   tenants/{t}/credentials/{credId}       { workerId, type, label, number, expiryDate,
 *                                            fileUrl, verifiedBy, createdAt }
 *   tenants/{t}/settings/publicHolidays    { dates: ["YYYY-MM-DD", ...] }
 *
 * Wire-in:
 *   const coreOS = require("./core-os-routes");
 *   app.use("/api", requireDashboardKey, coreOS({ db, sendMessage, tenantStore }));
 *   Every request carries req.tenantId (set by requireDashboardKey).
 */

const express = require("express");

const DEFAULT_STAFF_LIMIT = 15;
const { costShift, costRoster, getAward, listUnverifiedRates, listAwards } = require("./award-engine");

const { CREDENTIAL_TYPES } = require("./credentialTypes");

module.exports = function coreOS({ db, sendMessage, tenantStore }) {
  const router = express.Router();

  // Firestore not configured (in-memory dev mode) → fail clearly, don't crash.
  if (!db) {
    router.use((_req, res) => res.status(503).json({
      error: "Core OS needs Firestore. Set FIREBASE_SERVICE_ACCOUNT_JSON (Railway → Variables) and redeploy.",
    }));
    return router;
  }

  const T = (req) => db.collection("tenants").doc(req.tenantId);

  // Workers are the bot's staff list: top-level staff/{phone}, one record per
  // person, filtered by tenant. This shim gives it the small Firestore-ish
  // surface the routes below use, so the roster page, the wallet, payroll and
  // the chat bot all read one list. workerId is the phone number.
  const staffCol = db.collection("staff");
  const asDoc = (d) => ({ id: d.id, exists: d.exists, data: () => ({ phone: d.id, ...d.data() }) });
  const W = (req) => ({
    where: () => W(req),
    async get() {
      const snap = await staffCol.where("tenantId", "==", req.tenantId).get();
      return { docs: snap.docs.map(asDoc) };
    },
    doc: (id) => ({
      async get() {
        const d = await staffCol.doc(String(id)).get();
        return d.exists && d.data().tenantId === req.tenantId ? asDoc(d) : { id, exists: false, data: () => ({}) };
      },
      async update(patch) {
        const d = await staffCol.doc(String(id)).get();
        if (!d.exists || d.data().tenantId !== req.tenantId) throw new Error("NOT_FOUND");
        return staffCol.doc(String(id)).update(patch);
      },
    }),
    async add(data) {
      const phone = String(data.phone || "").replace(/\D/g, "");
      if (!phone) throw new Error("PHONE_REQUIRED");
      const { phone: _p, ...rest } = data;
      // One person, one venue: a number already on another venue's list can't
      // be silently moved. Same-venue re-adds are updates.
      const cur = await staffCol.doc(phone).get();
      if (cur.exists && cur.data().tenantId && cur.data().tenantId !== req.tenantId) throw new Error("PHONE_IN_OTHER_VENUE");
      // Staff cap per venue (plan limit).
      if (!cur.exists) {
        const tenant = tenantStore ? await tenantStore.findById(req.tenantId) : null;
        const limit = (tenant && tenant.staffLimit) || DEFAULT_STAFF_LIMIT;
        const snap = await staffCol.where("tenantId", "==", req.tenantId).get();
        const active = snap.docs.filter((d) => d.data().active !== false && d.data().role !== "owner").length;
        if (active >= limit) throw new Error(`STAFF_LIMIT:${limit}`);
      }
      await staffCol.doc(phone).set({ ...rest, tenantId: req.tenantId, role: rest.role || "staff" }, { merge: true });
      return { id: phone };
    },
  });

  const getHolidays = async (req) => {
    const s = await T(req).collection("settings").doc("publicHolidays").get();
    return s.exists ? s.data().dates || [] : [];
  };

  // ---------- Workers ----------
  router.get("/workers", async (req, res) => {
    try {
      const snap = await W(req).get();
      const workers = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((w) => w.active !== false);
      // Attach credential status summary to each worker
      const credsSnap = await T(req).collection("credentials").get();
      const creds = credsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const today = new Date().toISOString().slice(0, 10);
      const soon = addDays(today, 30);
      for (const w of workers) {
        const mine = creds.filter((c) => c.workerId === w.id || (c.workerPhone && w.phone && c.workerPhone === w.phone));
        w.credentialStatus =
          mine.some((c) => c.expiryDate && c.expiryDate < today && (CREDENTIAL_TYPES[c.type] || {}).blocking) ? "expired"
          : mine.some((c) => c.expiryDate && c.expiryDate < soon) ? "expiring"
          : "ok";
      }
      res.json({ workers });
    } catch (e) { err(res, e); }
  });

  router.post("/workers", async (req, res) => {
    try {
      const { name, phone, awardCode, role } = req.body;
      const employmentType = req.body.employmentType || "casual";
      const level = req.body.level || "L1";
      if (!name) return res.status(400).json({ error: "name is required" });
      if (!String(phone || "").replace(/\D/g, "")) return res.status(400).json({ error: "phone is required — it's how the person is matched when they message the bot" });
      if (role && !["owner", "manager", "staff"].includes(role)) return res.status(400).json({ error: 'role must be "owner", "manager", or "staff"' });
      if (!getAward(awardCode || "MA000009").levels[level]) {
        return res.status(400).json({ error: "Unknown classification level for that award" });
      }
      const pay = payFields(req.body, { employmentType });
      if (pay.error) return res.status(400).json({ error: pay.error });
      let ref;
      try {
        ref = await W(req).add({
          name, phone, employmentType, level, role: role || "staff",
          awardCode: awardCode || "MA000009", active: true, createdAt: now(), ...pay.patch,
        });
      } catch (e) {
        if (e.message === "PHONE_IN_OTHER_VENUE") return res.status(409).json({ error: "That number is already registered at another venue." });
        if (e.message.startsWith("STAFF_LIMIT:")) return res.status(402).json({ error: `Your plan includes ${e.message.split(":")[1]} staff. Deactivate someone or upgrade to add more.` });
        throw e;
      }
      res.json({ id: ref.id });
    } catch (e) { err(res, e); }
  });

  router.put("/workers/:id", async (req, res) => {
    try {
      const ref = W(req).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: "Worker not found" });
      const allowed = ["name", "employmentType", "level", "awardCode", "active", "role"];
      const patch = {};
      for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
      const merged0 = { ...doc.data(), ...patch };
      const pay = payFields(req.body, merged0);
      if (pay.error) return res.status(400).json({ error: pay.error });
      Object.assign(patch, pay.patch);
      if (!Object.keys(patch).length) return res.status(400).json({ error: `Nothing to update. Allowed: ${allowed.join(", ")}, department, payType, hourlyRate, annualSalary` });
      const merged = { ...doc.data(), ...patch };
      if (!getAward(merged.awardCode || "MA000009").levels[merged.level]) {
        return res.status(400).json({ error: "Unknown classification level for that award" });
      }
      await ref.update({ ...patch, updatedAt: now() });
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  router.get("/awards", (req, res) => {
    try { res.json({ awards: listAwards() }); } catch (e) { err(res, e); }
  });

  // ---------- Roster ----------
  // GET /api/roster?weekStart=YYYY-MM-DD  → shifts + live costing + guard flags
  router.get("/roster", async (req, res) => {
    try {
      const weekStart = req.query.weekStart;
      if (!weekStart) return res.status(400).json({ error: "weekStart (YYYY-MM-DD, a Monday) is required" });
      const weekEnd = addDays(weekStart, 6);
      const [shiftSnap, workerSnap, holidays] = await Promise.all([
        T(req).collection("shifts").where("date", ">=", weekStart).where("date", "<=", weekEnd).get(),
        W(req).get(),
        getHolidays(req),
      ]);
      const shifts = shiftSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const workersById = {};
      workerSnap.docs.forEach((d) => (workersById[d.id] = { id: d.id, ...d.data() }));
      const costing = costRoster(shifts, workersById, { publicHolidays: holidays });
      // Salaried full-timers cost their weekly salary, not hours × rate. Zero
      // their hourly lines and add the salaries as one block so the docket
      // matches the Pay page.
      let salaryWeekly = 0;
      const salaried = new Set();
      for (const w of Object.values(workersById)) {
        if (w.active === false || w.payType !== "salary" || w.employmentType !== "fulltime") continue;
        salaried.add(w.id);
        salaryWeekly += Number(w.annualSalary) > 0 ? Number(w.annualSalary) / 52 : 0;
      }
      if (salaried.size) {
        for (const l of costing.lines) if (salaried.has(l.workerId)) { l.salary = true; l.wageCost = 0; l.superCost = 0; l.totalCost = 0; l.otCost = 0; }
        costing.totals.wage = round2(costing.lines.reduce((t, l) => t + l.wageCost, 0));
        costing.totals.super = round2(costing.lines.reduce((t, l) => t + l.superCost, 0));
        costing.totals.total = round2(costing.totals.wage + costing.totals.super);
      }
      costing.totals.salaries = round2(salaryWeekly);
      costing.totals.salariesSuper = round2(salaryWeekly * 0.12);
      res.json({ weekStart, weekEnd, shifts, costing, unverifiedRates: listUnverifiedRates() });
    } catch (e) { err(res, e); }
  });

  // POST /api/roster/shift — create (roster guard runs here)
  router.post("/roster/shift", async (req, res) => {
    try {
      const { workerId, date, start, end, unpaidBreakMins, role } = req.body;
      if (!workerId || !date || !start || !end) return res.status(400).json({ error: "workerId, date, start and end are required" });
      const wDoc = await W(req).doc(workerId).get();
      if (!wDoc.exists) return res.status(404).json({ error: "Worker not found" });
      const worker = wDoc.data();

      // Roster guard: blocking credential expired on shift date?
      const credSnap = await T(req).collection("credentials").where("workerId", "==", workerId).get();
      const warnings = [];
      credSnap.docs.forEach((d) => {
        const c = d.data();
        const meta = CREDENTIAL_TYPES[c.type] || { label: c.type, blocking: false };
        if (c.expiryDate && c.expiryDate < date) {
          warnings.push({ severity: meta.blocking ? "blocking" : "warning", credential: meta.label, expired: c.expiryDate });
        }
      });
      const hasBlocking = warnings.some((w) => w.severity === "blocking");
      if (hasBlocking && !req.body.overrideGuard) {
        return res.status(409).json({ error: "Credential expired for this worker on this date", warnings, overridable: true });
      }

      const shift = {
        workerId, date, start, end,
        unpaidBreakMins: unpaidBreakMins || 0, role: role || null, published: false,
        createdAt: now(), updatedAt: now(),
        audit: [{ at: now(), action: "created", by: req.body.actor || "dashboard", guardWarnings: warnings }],
      };
      const ref = await T(req).collection("shifts").add(shift);
      const holidays = await getHolidays(req);
      const cost = costShift(shift, worker, { publicHolidays: holidays });
      res.json({ id: ref.id, cost, warnings });
    } catch (e) { err(res, e); }
  });

  // PUT /api/core/roster/shift/:id — change times, break or role. Keeps the
  // audit trail; a published shift goes back to unpublished so the crew get
  // the new version on the next publish.
  router.put("/roster/shift/:id", async (req, res) => {
    try {
      const ref = T(req).collection("shifts").doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: "Shift not found" });
      const cur = doc.data();
      const patch = {};
      for (const k of ["start", "end", "role"]) if (req.body[k] !== undefined) patch[k] = req.body[k] || null;
      if (req.body.unpaidBreakMins !== undefined) patch.unpaidBreakMins = Math.max(0, parseInt(req.body.unpaidBreakMins, 10) || 0);
      if (req.body.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) patch.date = req.body.date;
      if (!patch.start && !cur.start || !patch.end && !cur.end) return res.status(400).json({ error: "start and end are required" });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to change" });
      const changed = Object.keys(patch).filter((k) => patch[k] !== cur[k]);
      if (!changed.length) return res.json({ id: doc.id, unchanged: true });
      patch.updatedAt = now();
      if (cur.published) { patch.published = false; patch.confirmedAt = null; patch.swapRequestedAt = null; }
      patch.audit = [...(cur.audit || []), { at: now(), action: "edited", by: req.body.actor || "dashboard", from: Object.fromEntries(changed.map((k) => [k, cur[k] ?? null])), to: Object.fromEntries(changed.map((k) => [k, patch[k]])) }];
      await ref.update(patch);
      res.json({ id: doc.id, ok: true, republish: Boolean(cur.published) });
    } catch (e) { err(res, e); }
  });

  router.delete("/roster/shift/:id", async (req, res) => {
    try {
      const ref = T(req).collection("shifts").doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: "Shift not found" });
      // Audit-safe delete: keep a tombstone in the audit trail collection
      await T(req).collection("shiftAudit").add({ ...doc.data(), shiftId: doc.id, deletedAt: now(), deletedBy: req.query.actor || "dashboard" });
      await ref.delete();
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // POST /api/roster/publish — mark week published, push each shift to WhatsApp
  router.post("/roster/publish", async (req, res) => {
    try {
      const { weekStart } = req.body;
      if (!weekStart) return res.status(400).json({ error: "weekStart is required" });
      const weekEnd = addDays(weekStart, 6);
      const snap = await T(req).collection("shifts").where("date", ">=", weekStart).where("date", "<=", weekEnd).get();
      const workerSnap = await W(req).get();
      const workersById = {};
      workerSnap.docs.forEach((d) => (workersById[d.id] = { id: d.id, ...d.data() }));

      const byWorker = {};
      snap.docs.forEach((d) => {
        const s = d.data();
        (byWorker[s.workerId] = byWorker[s.workerId] || []).push({ id: d.id, ...s });
      });

      let sent = 0;
      const unreachable = [];
      for (const [workerId, shifts] of Object.entries(byWorker)) {
        const w = workersById[workerId];
        await Promise.all(shifts.map((s) => T(req).collection("shifts").doc(s.id).update({ published: true, updatedAt: now(), confirmedAt: null, swapRequestedAt: null })));
        if (sendMessage && w && w.phone) {
          const lines = shifts
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((s) => `• ${fmtDay(s.date)} ${s.start}–${s.end}${s.role ? " (" + s.role + ")" : ""}`);
          const r = await sendMessage(w.phone, `📋 Your roster ${fmtDay(weekStart)}–${fmtDay(weekEnd)}:\n${lines.join("\n")}\n\nReply YES to confirm or SWAP if you need a change.`);
          // The dispatcher returns { ok:false, reason:"no_channel" } for someone
          // who has never messaged the bot — they can't be reached yet.
          if (r && r.ok === false) unreachable.push(w.name || workerId); else sent++;
        } else if (w) {
          unreachable.push(w.name || workerId);
        }
      }
      res.json({ ok: true, workersNotified: sent, workersOnRoster: Object.keys(byWorker).length, unreachable });
    } catch (e) { err(res, e); }
  });

  // ---------- Credential wallet ----------
  router.get("/wallet/:workerId", async (req, res) => {
    try {
      const wDoc = await W(req).doc(req.params.workerId).get();
      const phone = wDoc.exists ? wDoc.data().phone : null;
      const [byId, byPhone] = await Promise.all([
        T(req).collection("credentials").where("workerId", "==", req.params.workerId).get(),
        phone ? T(req).collection("credentials").where("workerPhone", "==", phone).get() : { docs: [] },
      ]);
      const seen = new Map();
      [...byId.docs, ...byPhone.docs].forEach((d) => seen.set(d.id, { id: d.id, ...d.data() }));
      res.json({ credentials: [...seen.values()], types: CREDENTIAL_TYPES });
    } catch (e) { err(res, e); }
  });

  router.post("/wallet/:workerId/credential", async (req, res) => {
    try {
      const { type, number, expiryDate, fileUrl } = req.body;
      if (!type || !CREDENTIAL_TYPES[type]) return res.status(400).json({ error: "Valid credential type is required", types: Object.keys(CREDENTIAL_TYPES) });
      const wDoc = await W(req).doc(req.params.workerId).get();
      const w = wDoc.exists ? wDoc.data() : {};
      const ref = await T(req).collection("credentials").add({
        workerId: req.params.workerId, workerPhone: w.phone || null, workerName: w.name || null,
        type, label: CREDENTIAL_TYPES[type].label,
        number: number || null, expiryDate: expiryDate || null, fileUrl: fileUrl || null,
        verifiedBy: req.body.actor || null, source: "dashboard", nudgesSent: {}, createdAt: now(),
      });
      res.json({ id: ref.id });
    } catch (e) { err(res, e); }
  });

  // GET /api/wallet-alerts — everything expired or expiring inside 60 days
  router.get("/wallet-alerts", async (req, res) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const horizon = addDays(today, 60);
      const [credSnap, workerSnap] = await Promise.all([
        T(req).collection("credentials").get(), W(req).get(),
      ]);
      const names = {}, phoneNames = {};
      workerSnap.docs.forEach((d) => { const w = d.data(); names[d.id] = w.name; if (w.phone) phoneNames[w.phone] = w.name; });
      const alerts = credSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((c) => c.expiryDate && c.expiryDate <= horizon)
        .map((c) => ({
          workerId: c.workerId, worker: names[c.workerId] || phoneNames[c.workerPhone] || c.workerName || "Unknown",
          credential: c.label || c.type, expiryDate: c.expiryDate,
          status: c.expiryDate < today ? "expired" : "expiring",
          blocking: (CREDENTIAL_TYPES[c.type] || {}).blocking || false,
        }))
        .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
      res.json({ alerts });
    } catch (e) { err(res, e); }
  });

  // ---------- Accredited training loop ----------
  // Gap report: required credentials (settings/training.requiredCredentials)
  // each active worker is missing or holds expired.
  router.get("/training-gaps", async (req, res) => {
    try {
      const { getCourses } = require("./trainingHandler");
      const tDoc = await T(req).collection("settings").doc("training").get();
      const required = tDoc.exists ? (tDoc.data().requiredCredentials || []) : [];
      const courses = await getCourses(req.tenantId);
      const [workerSnap, credSnap] = await Promise.all([
        W(req).get(), T(req).collection("credentials").get(),
      ]);
      const creds = credSnap.docs.map((d) => d.data());
      const today = new Date().toISOString().slice(0, 10);
      const gaps = [];
      for (const d of workerSnap.docs) {
        const w = d.data();
        if (w.active === false) continue;
        for (const type of required) {
          const held = creds.filter((c) =>
            c.type === type && (c.workerId === d.id || (c.workerPhone && w.phone && c.workerPhone === w.phone)));
          const current = held.some((c) => c.expiryDate && c.expiryDate >= today);
          if (!current) {
            const course = courses.find((c) => c.credentialType === type) || null;
            gaps.push({
              workerId: d.id, worker: w.name, phone: w.phone || null,
              credentialType: type,
              credential: (CREDENTIAL_TYPES[type] || { label: type }).label,
              status: held.length ? "expired" : "missing",
              courseId: course ? course.id : null,
            });
          }
        }
      }
      res.json({ required, gaps });
    } catch (e) { err(res, e); }
  });

  // One-tap: WhatsApp the enrol link for a course to a worker.
  router.post("/send-enrol", async (req, res) => {
    try {
      const { workerId, courseId } = req.body;
      if (!workerId || !courseId) return res.status(400).json({ error: "workerId and courseId are required" });
      const wDoc = await W(req).doc(workerId).get();
      if (!wDoc.exists || !wDoc.data().phone) return res.status(400).json({ error: "Worker has no phone number on file" });
      const { getCourses } = require("./trainingHandler");
      const course = (await getCourses(req.tenantId)).find((c) => c.id === courseId);
      if (!course) return res.status(404).json({ error: "Course not found in catalog" });
      if (!sendMessage) return res.status(503).json({ error: "Messaging not configured" });
      const w = wDoc.data();
      await sendMessage(w.phone,
        `🎓 Hi ${(w.name || "there").split(" ")[0]} — your manager has asked you to complete *${course.label}*.\n` +
        `${course.url}${course.note ? "\n⚠ " + course.note : ""}\n\n` +
        `When you finish, send me a photo of the certificate and it goes straight into your wallet.`);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // Catalog + required-credentials settings (swap in affiliate links here).
  router.get("/training-settings", async (req, res) => {
    try {
      const { getCourses, DEFAULT_COURSES } = require("./trainingHandler");
      const courses = await getCourses(req.tenantId);
      const tDoc = await T(req).collection("settings").doc("training").get();
      res.json({
        courses, defaults: DEFAULT_COURSES,
        requiredCredentials: tDoc.exists ? (tDoc.data().requiredCredentials || []) : [],
        credentialTypes: Object.keys(CREDENTIAL_TYPES),
      });
    } catch (e) { err(res, e); }
  });
  router.put("/training-settings", async (req, res) => {
    try {
      const patch = {};
      if (req.body.courses !== undefined) patch.courses = req.body.courses;
      if (req.body.requiredCredentials !== undefined) {
        const bad = req.body.requiredCredentials.filter((t) => !CREDENTIAL_TYPES[t]);
        if (bad.length) return res.status(400).json({ error: `Unknown credential types: ${bad.join(", ")}` });
        patch.requiredCredentials = req.body.requiredCredentials;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update. Allowed: courses, requiredCredentials" });
      await T(req).collection("settings").doc("training").set(patch, { merge: true });
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // ---------- Exports ----------
  // GET /api/export/payroll.csv?weekStart=YYYY-MM-DD — Xero-style timesheet import
  router.get("/export/payroll.csv", async (req, res) => {
    try {
      const weekStart = req.query.weekStart;
      if (!weekStart) return res.status(400).json({ error: "weekStart is required" });
      const weekEnd = addDays(weekStart, 6);
      const [shiftSnap, workerSnap, holidays] = await Promise.all([
        T(req).collection("shifts").where("date", ">=", weekStart).where("date", "<=", weekEnd).get(),
        W(req).get(),
        getHolidays(req),
      ]);
      const workersById = {};
      workerSnap.docs.forEach((d) => (workersById[d.id] = { id: d.id, ...d.data() }));
      const rows = [["EmployeeName", "Date", "DayType", "Start", "End", "UnpaidBreakMins", "PaidHours", "OrdinaryHours", "OTHours", "Classification", "BaseRate", "Multiplier", "LoadingAmt", "WageCost", "Super", "TotalCost"]];
      for (const d of shiftSnap.docs) {
        const s = d.data();
        const w = workersById[s.workerId];
        if (!w) continue;
        const c = costShift(s, w, { publicHolidays: holidays });
        rows.push([
          w.name, s.date, c.dayType, s.start, s.end, s.unpaidBreakMins || 0,
          c.hours, c.ordinaryHours, c.otHours, `${w.awardCode || "MA000009"}/${w.level}`,
          c.baseRate, c.multiplier, c.loadings.reduce((t, l) => t + l.amount, 0).toFixed(2),
          c.wageCost, c.superCost, c.totalCost,
        ]);
      }
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=payroll_${weekStart}.csv`);
      res.send(rows.map((r) => r.map(csvCell).join(",")).join("\n"));
    } catch (e) { err(res, e); }
  });

  // GET /api/export/compliance-pack?from&to — the "keep the director out of court" export
  router.get("/export/compliance-pack", async (req, res) => {
    try {
      const { from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: "from and to (YYYY-MM-DD) are required" });
      const [shiftSnap, auditSnap, workerSnap] = await Promise.all([
        T(req).collection("shifts").where("date", ">=", from).where("date", "<=", to).get(),
        T(req).collection("shiftAudit").get(),
        W(req).get(),
      ]);
      const names = {};
      workerSnap.docs.forEach((d) => (names[d.id] = d.data().name));
      const rows = [["RecordType", "Worker", "Date", "Start", "End", "BreakMins", "Published", "AuditTrail"]];
      shiftSnap.docs.forEach((d) => {
        const s = d.data();
        rows.push(["shift", names[s.workerId] || s.workerId, s.date, s.start, s.end, s.unpaidBreakMins || 0, s.published ? "yes" : "no",
          (s.audit || []).map((a) => `${a.at} ${a.action} by ${a.by}`).join(" | ")]);
      });
      auditSnap.docs.forEach((d) => {
        const s = d.data();
        if (s.date >= from && s.date <= to)
          rows.push(["deleted-shift", names[s.workerId] || s.workerId, s.date, s.start, s.end, s.unpaidBreakMins || 0, "-", `deleted ${s.deletedAt} by ${s.deletedBy}`]);
      });
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=compliance_pack_${from}_${to}.csv`);
      res.send(rows.map((r) => r.map(csvCell).join(",")).join("\n"));
    } catch (e) { err(res, e); }
  });

  return router;
};

// ---------- helpers ----------
/**
 * The pay fields a crew form can send: department, payType, hourlyRate,
 * annualSalary. Returns { patch } with only the fields present, or { error }.
 */
function payFields(body, merged) {
  const patch = {};
  if (body.department !== undefined) {
    const d = String(body.department || "").trim().toLowerCase();
    if (d && !["kitchen", "service"].includes(d)) return { error: 'department must be "kitchen" or "service"' };
    patch.department = d || null;
  }
  if (body.payType !== undefined) {
    const t = body.payType === "salary" ? "salary" : "hourly";
    const et = body.employmentType !== undefined ? body.employmentType : merged.employmentType;
    if (t === "salary" && et !== "fulltime") return { error: "Only full-time staff can be salaried" };
    patch.payType = t;
  }
  if (body.hourlyRate !== undefined) {
    if (body.hourlyRate === null || body.hourlyRate === "") patch.hourlyRate = null;
    else {
      const n = Number(body.hourlyRate);
      if (!isFinite(n) || n < 0 || n > 500) return { error: "hourlyRate must be a number between 0 and 500" };
      patch.hourlyRate = Math.round(n * 100) / 100;
    }
  }
  if (body.annualSalary !== undefined) {
    if (body.annualSalary === null || body.annualSalary === "") patch.annualSalary = null;
    else {
      const n = Number(body.annualSalary);
      if (!isFinite(n) || n < 0 || n > 5000000) return { error: "annualSalary must be a number (per year, before super)" };
      patch.annualSalary = Math.round(n);
    }
  }
  return { patch };
}
function round2(n) { return Math.round(n * 100) / 100; }
function now() { return new Date().toISOString(); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDay(dateStr) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function err(res, e) {
  console.error("[core-os]", e);
  res.status(500).json({ error: e.message });
}
