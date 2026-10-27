"use strict";

/**
 * The roster — one source of truth, shared by the manager roster page
 * (core-os-routes.js writes it), the clock-in flow (which site, which role,
 * was this person late) and the staff bot ("roster" command, YES/SWAP replies).
 *
 * Data model (Firestore):
 *   tenants/{tenantId}/shifts/{shiftId}: {
 *     workerId,        // the person's phone number — same key as staff/{phone}
 *     date,            // YYYY-MM-DD
 *     start, end,      // "HH:MM" local time; end may be <= start for an overnight shift
 *     role?, siteId?, unpaidBreakMins?,
 *     published,       // staff only see published shifts
 *     confirmedAt?,    // set when the person replies YES to the published roster
 *     swapRequestedAt? // set when they reply SWAP; the manager sees it on the roster page
 *   }
 *
 * The in-memory twin exists for tests and for running without Firestore.
 */

/** @typedef {{ id: string, tenantId: string, workerId: string, date: string, start: string, end: string, role?: string|null, siteId?: string|null, published?: boolean, confirmedAt?: string|null, swapRequestedAt?: string|null }} Shift */

function pad(n) {
  return String(n).padStart(2, "0");
}

function localDateIso(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Monday of the week containing `date`, as YYYY-MM-DD (local time). */
function mondayOf(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() - ((day + 6) % 7));
  return localDateIso(d);
}

function addDays(dateIso, n) {
  const d = new Date(dateIso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return localDateIso(d);
}

/** Local Date for "HH:MM" on a given day. */
function atTime(dateIso, hhmm) {
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  return new Date(`${dateIso}T${pad(h || 0)}:${pad(m || 0)}:00`);
}

/** When a shift starts and ends, as Dates — overnight shifts end the next day. */
function shiftWindow(shift) {
  const startsAt = atTime(shift.date, shift.start);
  let endsAt = atTime(shift.date, shift.end);
  if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
  return { startsAt, endsAt };
}

function normalizeShift(id, tenantId, data) {
  return {
    id,
    tenantId,
    workerId: String(data.workerId || ""),
    date: data.date,
    start: data.start,
    end: data.end,
    role: data.role || null,
    siteId: data.siteId || null,
    unpaidBreakMins: data.unpaidBreakMins || 0,
    published: data.published === true,
    confirmedAt: data.confirmedAt || null,
    swapRequestedAt: data.swapRequestedAt || null,
  };
}

/** Shared read-side helpers over a "list this tenant's shifts" primitive. */
class BaseRosterStore {
  /**
   * The published shift this person has on a date (the earliest if several).
   * Used by clock-in to find the site, the role and the rostered start.
   */
  async findAssignment(tenantId, dateIso, phone) {
    const shifts = await this.listByWorker(tenantId, phone, dateIso, dateIso);
    const published = shifts.filter((s) => s.published);
    if (!published.length) return null;
    published.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    return published[0];
  }

  /** Published shifts from `fromDateIso` onwards, soonest first. */
  async listUpcomingForWorker(tenantId, phone, fromDateIso = localDateIso(), days = 21) {
    const shifts = await this.listByWorker(tenantId, phone, fromDateIso, addDays(fromDateIso, days));
    return shifts
      .filter((s) => s.published)
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  }
}

class InMemoryRosterStore extends BaseRosterStore {
  constructor() {
    super();
    /** @type {Map<string, Shift>} */
    this._shifts = new Map();
    this._seq = 0;
  }

  async addShift(shift) {
    const id = shift.id || `shift-${++this._seq}`;
    const rec = normalizeShift(id, shift.tenantId, shift);
    this._shifts.set(id, rec);
    return rec;
  }

  async listByWorker(tenantId, phone, fromDateIso, toDateIso) {
    return [...this._shifts.values()].filter(
      (s) => s.tenantId === tenantId && s.workerId === phone && s.date >= fromDateIso && s.date <= toDateIso
    );
  }

  async listByRange(tenantId, fromDateIso, toDateIso) {
    return [...this._shifts.values()].filter(
      (s) => s.tenantId === tenantId && s.date >= fromDateIso && s.date <= toDateIso
    );
  }

  async update(tenantId, shiftId, patch) {
    const s = this._shifts.get(shiftId);
    if (!s || s.tenantId !== tenantId) return null;
    Object.assign(s, patch);
    return s;
  }
}

class FirestoreRosterStore extends BaseRosterStore {
  constructor(db) {
    super();
    this.db = db;
  }

  _col(tenantId) {
    return this.db.collection("tenants").doc(tenantId).collection("shifts");
  }

  async addShift(shift) {
    const { tenantId, id, ...data } = shift;
    const col = this._col(tenantId);
    const ref = id ? col.doc(id) : col.doc();
    await ref.set({ ...data, published: data.published === true }, { merge: true });
    return normalizeShift(ref.id, tenantId, data);
  }

  /**
   * Equality on workerId plus a range on date: this needs a composite index
   * (workerId ASC, date ASC) on the `shifts` collection group. Without it the
   * query throws and we fall back to the date-range-only query, which is what
   * the roster page already uses, then filter in memory.
   */
  async listByWorker(tenantId, phone, fromDateIso, toDateIso) {
    try {
      const snap = await this._col(tenantId)
        .where("workerId", "==", phone)
        .where("date", ">=", fromDateIso)
        .where("date", "<=", toDateIso)
        .get();
      return snap.docs.map((d) => normalizeShift(d.id, tenantId, d.data()));
    } catch (err) {
      if (!/index/i.test(err.message || "")) throw err;
      const all = await this.listByRange(tenantId, fromDateIso, toDateIso);
      return all.filter((s) => s.workerId === phone);
    }
  }

  async listByRange(tenantId, fromDateIso, toDateIso) {
    const snap = await this._col(tenantId)
      .where("date", ">=", fromDateIso)
      .where("date", "<=", toDateIso)
      .get();
    return snap.docs.map((d) => normalizeShift(d.id, tenantId, d.data()));
  }

  async update(tenantId, shiftId, patch) {
    const ref = this._col(tenantId).doc(shiftId);
    await ref.update(patch);
    const doc = await ref.get();
    return doc.exists ? normalizeShift(doc.id, tenantId, doc.data()) : null;
  }
}

module.exports = {
  InMemoryRosterStore,
  FirestoreRosterStore,
  mondayOf,
  addDays,
  localDateIso,
  shiftWindow,
};
