"use strict";

/**
 * payroll.js — the weekly pay view, in pure functions.
 *
 * What a manager wants to know every day:
 *   1. "Am I inside my payroll budget this week?"  (rostered + actual vs % of revenue)
 *   2. "Is anyone heading for overtime?"           (full-timers on the 152-hour / 4-week cycle)
 *   3. "What do I pay on Monday?"                   (hours × HIGA rates, per person)
 *
 * Rules, in plain words (these are what the pages explain to the manager):
 *   - The pay week runs 7 days from `weekStartsOn` (Monday by default).
 *   - Hourly staff (casual, part-time, full-time hourly) cost hours × rate × HIGA
 *     penalty for the day (weekday / Sat / Sun / public holiday), plus evening
 *     loadings, via award-engine.js. The rate is the award minimum for their
 *     level unless the venue pays above award (worker.hourlyRate).
 *   - Salaried full-timers cost the same every week: annual ÷ 52. That weekly
 *     amount is posted as a DAILY cost across the days they are rostered (or
 *     Mon–Fri when nothing is rostered yet), so a day's labour % still adds up.
 *   - Full-timers work 38 hours a week averaged over 4 weeks = 152 hours a
 *     cycle. Hours past 152 in the cycle are overtime: 1.5× for the first 2,
 *     2× after. For salaried staff the hours are tracked and flagged (HIGA
 *     annualised wages must be reconciled against the award each year).
 *   - Budget: kitchen payroll ≤ kitchenPct of revenue; kitchen + service
 *     ≤ totalPct. Service's own target is the difference.
 *
 * No Firestore, no Express — payroll-routes.js feeds this and serves the result.
 */

const { costShift, getAward, dayType } = require("./award-engine");

const DEFAULT_SETTINGS = Object.freeze({
  weekStartsOn: 1,                 // 0 Sun … 6 Sat. Hospitality pay weeks mostly start Monday.
  timezone: "Australia/Sydney",
  targets: Object.freeze({ kitchenPct: 22, totalPct: 55 }),
  includeSuper: false,             // count the 12% SG in payroll cost? Budgets often exclude it.
  cycleAnchor: null,               // YYYY-MM-DD, a week start the 152-hour cycle counts from
  cycleWeeks: 4,
  publicHolidays: Object.freeze([]),
});

const DEPARTMENTS = ["kitchen", "service"];
const CYCLE_HOURS_PER_WEEK = 38;

// ---------------------------------------------------------------------------
// Dates

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr) {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}

function diffDays(a, b) {
  return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000);
}

/** The pay-week start (YYYY-MM-DD) that contains dateStr. */
function weekStartFor(dateStr, weekStartsOn = 1) {
  const back = (dayOfWeek(dateStr) - weekStartsOn + 7) % 7;
  return addDays(dateStr, -back);
}

function weekDates(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Today's date in the venue's timezone. */
function todayIn(timezone, now = new Date()) {
  return localDateTime(now.toISOString(), timezone).date;
}

/** ISO instant → { date, time, minutes } on the venue's clock. */
function localDateTime(iso, timezone) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || DEFAULT_SETTINGS.timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const hh = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hh}:${get("minute")}`,
    minutes: Number(hh) * 60 + Number(get("minute")),
  };
}

/**
 * The 4-week cycle containing weekStart. Cycles are counted from cycleAnchor;
 * without one, the first week of the month-ish is as good as anything, so we
 * anchor on the week itself (cycle = this week + the next 3).
 */
function cycleFor(weekStart, settings = {}) {
  const weeks = settings.cycleWeeks || DEFAULT_SETTINGS.cycleWeeks;
  const anchor = settings.cycleAnchor || weekStart;
  const span = weeks * 7;
  let offset = diffDays(anchor, weekStart);
  offset = ((offset % span) + span) % span;
  const start = addDays(weekStart, -offset);
  return { start, end: addDays(start, span - 1), weeks, hours: weeks * CYCLE_HOURS_PER_WEEK, weekIndex: Math.floor(offset / 7) + 1 };
}

// ---------------------------------------------------------------------------
// Workers

function normalizeDepartment(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (/kitchen|boh|chef|cook|pastry|larder|pass/.test(s)) return "kitchen";
  if (/service|foh|front|floor|bar|wait|host|barista|cafe|café/.test(s)) return "service";
  return s === "kitchen" || s === "service" ? s : "other";
}

const ET_LABEL = { casual: "Casual", parttime: "Part-time", fulltime: "Full-time" };

/** What the costing needs to know about one person, normalised from the staff record. */
function payProfile(worker) {
  const employmentType = ["casual", "parttime", "fulltime"].includes(worker.employmentType) ? worker.employmentType : "casual";
  const payType = employmentType === "fulltime" && worker.payType === "salary" ? "salary" : "hourly";
  const awardCode = worker.awardCode || "MA000009";
  const award = getAward(awardCode);
  const level = award.levels[worker.level] ? worker.level : "L1";
  const awardRate = award.levels[level].base;
  const override = Number(worker.hourlyRate != null ? worker.hourlyRate : worker.wageRate);
  const hourlyRate = isFinite(override) && override > 0 ? override : awardRate;
  const annualSalary = Number(worker.annualSalary);
  const salaryOk = isFinite(annualSalary) && annualSalary > 0;
  // "Needs setup": the manager hasn't told us enough to cost this person properly.
  const needsSetup = !worker.employmentType || (payType === "hourly" && !award.levels[worker.level]) || (payType === "salary" && !salaryOk) || !normalizeDepartment(worker.department);
  return {
    needsSetup,
    id: worker.id || worker.phone,
    name: worker.name, avatar: Number.isInteger(worker.avatar) ? worker.avatar : null,
    department: normalizeDepartment(worker.department),
    employmentType, payType, awardCode, level, awardRate,
    hourlyRate, aboveAward: hourlyRate > awardRate,
    annualSalary: payType === "salary" && isFinite(annualSalary) && annualSalary > 0 ? annualSalary : null,
    weeklySalary: payType === "salary" && isFinite(annualSalary) && annualSalary > 0 ? round2(annualSalary / 52) : null,
    typeLabel: payType === "salary" ? "Salaried" : ET_LABEL[employmentType],
    superRate: award.superRate,
  };
}

// ---------------------------------------------------------------------------
// Attendance → something the award engine can cost

/** Effective (amended-aware) in/out/break for a clock record. */
function effectiveTimes(rec) {
  const inIso = (rec.amended && rec.amended.clockInTime) || (rec.clockIn && rec.clockIn.time);
  const outIso = (rec.amended && rec.amended.clockOutTime) || (rec.clockOut && rec.clockOut.time);
  const breakMs = rec.amended && rec.amended.breakMinutes != null
    ? rec.amended.breakMinutes * 60000
    : (rec.breaks || []).reduce((sum, b) => (b.end ? sum + (new Date(b.end) - new Date(b.start)) : sum), 0);
  return { inIso, outIso, breakMs };
}

/**
 * A closed clock record → { workerId, date, start, end, unpaidBreakMins, hours }
 * on the venue's clock. Open or denied records return null.
 */
function attendanceToShift(rec, timezone) {
  if (!rec || !rec.clockOut || rec.clockOut.denied) return null;
  const { inIso, outIso, breakMs } = effectiveTimes(rec);
  if (!inIso || !outIso) return null;
  const a = localDateTime(inIso, timezone), b = localDateTime(outIso, timezone);
  const breakMins = Math.round(breakMs / 60000);
  const totalMins = Math.max(0, (new Date(outIso) - new Date(inIso)) / 60000);
  return {
    id: rec.shiftId || rec.id || null,
    workerId: rec.staffPhone,
    date: a.date, start: a.time, end: b.time,
    unpaidBreakMins: breakMins,
    hours: round2(Math.max(0, totalMins - breakMins) / 60),
    source: "worked",
    amended: Boolean(rec.amended),
    forcedByManager: Boolean(rec.clockOut.forcedByManager),
  };
}

function rosterShiftHours(s) {
  const [sh, sm] = s.start.split(":").map(Number);
  const [eh, em] = s.end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 1440;
  return round2(Math.max(0, mins - (s.unpaidBreakMins || 0)) / 60);
}

// ---------------------------------------------------------------------------
// Costing one person for one week

/**
 * Cost an hourly shift under the award, with the venue's above-award rate if any.
 * Returns the award-engine line plus `wage` (what the budget counts) and `cost`
 * (wage, or wage + super when the venue counts super).
 */
function costHourly(shift, profile, publicHolidays, includeSuper) {
  const worker = { employmentType: profile.employmentType, level: profile.level, awardCode: profile.awardCode, hourlyRate: profile.hourlyRate };
  const line = costShift(shift, worker, { publicHolidays });
  return { ...line, wage: line.wageCost, cost: includeSuper ? line.totalCost : line.wageCost };
}

/** Which dates a salaried person's weekly cost is spread over. */
function salaryDays(weekStart, rosteredDates) {
  if (rosteredDates.length) return [...rosteredDates].sort();
  return weekDates(weekStart).filter((d) => { const w = dayOfWeek(d); return w >= 1 && w <= 5; });
}

/**
 * The week for one person.
 * @param {object} p   payProfile()
 * @param {object[]} rostered  roster shifts for this person in the week (date/start/end/unpaidBreakMins)
 * @param {object[]} worked    attendanceToShift() results for this person in the week
 * @param {object} ctx { weekStart, today, publicHolidays, includeSuper, cycle: { hoursBefore, rosteredAfter, limit } }
 */
function personWeek(p, rostered, worked, ctx) {
  const { weekStart, today, publicHolidays, includeSuper } = ctx;
  const dates = weekDates(weekStart);
  const byDate = {};
  for (const d of dates) byDate[d] = { date: d, rosteredHours: 0, rosteredCost: 0, workedHours: 0, workedCost: 0, actualCost: 0, lines: [] };

  const flags = [];
  let rosteredHours = 0, rosteredCost = 0, workedHours = 0, workedCost = 0, superCost = 0;

  if (p.payType === "salary") {
    const weekly = p.weeklySalary || 0;
    if (!p.weeklySalary) flags.push({ level: "warn", text: `${p.name} is salaried but has no annual salary entered — costing $0.` });
    const days = salaryDays(weekStart, [...new Set(rostered.map((s) => s.date))]);
    const daily = days.length ? round2(weekly / days.length) : 0;
    for (const d of days) {
      if (!byDate[d]) continue;
      byDate[d].rosteredCost = daily;
      // Salary accrues whether or not they clocked in: every day that has passed is a cost.
      if (d < today) byDate[d].actualCost = daily;
    }
    for (const s of rostered) { const h = rosterShiftHours(s); rosteredHours += h; if (byDate[s.date]) byDate[s.date].rosteredHours += h; }
    for (const s of worked) { workedHours += s.hours; if (byDate[s.date]) byDate[s.date].workedHours += s.hours; }
    rosteredCost = days.reduce((t, d) => t + (byDate[d] ? byDate[d].rosteredCost : 0), 0);
    workedCost = dates.reduce((t, d) => t + byDate[d].actualCost, 0);
    superCost = round2(rosteredCost * p.superRate);
  } else {
    for (const s of rostered) {
      const c = costHourly(s, p, publicHolidays, includeSuper);
      rosteredHours += c.hours; rosteredCost += c.cost;
      if (byDate[s.date]) { byDate[s.date].rosteredHours += c.hours; byDate[s.date].rosteredCost += c.cost; }
    }
    for (const s of worked) {
      const c = costHourly(s, p, publicHolidays, includeSuper);
      workedHours += c.hours; workedCost += c.cost; superCost += c.superCost;
      if (byDate[s.date]) {
        byDate[s.date].workedHours += c.hours; byDate[s.date].workedCost += c.cost; byDate[s.date].actualCost += c.cost;
        byDate[s.date].lines.push({ ...s, dayType: c.dayType, multiplier: c.multiplier, rate: p.hourlyRate, wage: c.wage, cost: c.cost, loadings: c.loadings, otHours: c.otHours });
      }
    }
  }

  // Actual-to-date for hourly staff: worked for past days, rostered for today onward.
  // That is the number a manager compares to budget mid-week.
  let projectedCost = 0, projectedHours = 0;
  for (const d of dates) {
    const row = byDate[d];
    const useWorked = p.payType === "salary" ? d < today : (d < today || row.workedHours > 0);
    row.projectedCost = useWorked ? round2(row.actualCost) : round2(row.rosteredCost);
    row.projectedHours = useWorked ? round2(row.workedHours) : round2(row.rosteredHours);
    projectedCost += row.projectedCost; projectedHours += row.projectedHours;
    row.rosteredCost = round2(row.rosteredCost); row.workedCost = round2(row.workedCost); row.actualCost = round2(row.actualCost);
  }

  // Full-timers: the 152-hour cycle.
  let cycle = null;
  if (p.employmentType === "fulltime" && ctx.cycle) {
    const { hoursBefore = 0, rosteredAfter = 0, limit, start, end, weekIndex, weeks } = ctx.cycle;
    const thisWeek = projectedHours;
    const total = round2(hoursBefore + thisWeek + rosteredAfter);
    const over = round2(Math.max(0, total - limit));
    const status = over > 0 ? "over" : total >= limit - 8 ? "close" : "ok";
    cycle = { start, end, weekIndex, weeks, limit, hoursBefore: round2(hoursBefore), thisWeek: round2(thisWeek), rosteredAfter: round2(rosteredAfter), total, over, status };
    if (over > 0) {
      if (p.payType === "salary") {
        flags.push({ level: "warn", text: `${p.name} is heading for ${total}h this cycle (${over}h over 152). Salaried: check the annual salary still covers it.` });
      } else {
        // Price the overflow that lands in THIS week: everything after the 152nd hour.
        const overThisWeek = round2(Math.max(0, hoursBefore + thisWeek - limit) - Math.max(0, hoursBefore - limit));
        if (overThisWeek > 0) {
          const ot = getAward(p.awardCode).overtime;
          const first = Math.min(overThisWeek, ot.firstBlockHours), then = Math.max(0, overThisWeek - ot.firstBlockHours);
          // Premium on top of ordinary pay already counted (ordinary ≈ 1.0× on weekdays).
          const premium = round2(first * p.hourlyRate * (ot.firstBlockMult - 1) + then * p.hourlyRate * (ot.thenMult - 1));
          cycle.overtimeHoursThisWeek = overThisWeek; cycle.overtimePremium = premium;
          projectedCost += premium;
          flags.push({ level: "over", text: `${p.name} passes 152h this cycle: ${overThisWeek}h overtime this week (+$${premium.toFixed(0)}).` });
        } else {
          flags.push({ level: "warn", text: `${p.name} is rostered past 152h for the cycle (${total}h). Overtime will land in a later week.` });
        }
      }
    }
  }
  if (p.employmentType !== "fulltime" && rosteredHours > CYCLE_HOURS_PER_WEEK) {
    flags.push({ level: "warn", text: `${p.name} (${p.typeLabel.toLowerCase()}) is rostered ${rosteredHours}h — over 38. Overtime applies past 38 in a week.` });
  }

  return {
    id: p.id, name: p.name, avatar: p.avatar, department: p.department, typeLabel: p.typeLabel, payType: p.payType, employmentType: p.employmentType, needsSetup: p.needsSetup,
    level: p.level, hourlyRate: p.hourlyRate, awardRate: p.awardRate, aboveAward: p.aboveAward, weeklySalary: p.weeklySalary,
    rosteredHours: round2(rosteredHours), rosteredCost: round2(rosteredCost),
    workedHours: round2(workedHours), workedCost: round2(workedCost),
    projectedHours: round2(projectedHours), projectedCost: round2(projectedCost),
    superCost: round2(superCost),
    shiftsRostered: rostered.length, shiftsWorked: worked.length,
    days: dates.map((d) => byDate[d]),
    cycle, flags,
  };
}

// ---------------------------------------------------------------------------
// The whole week

function statusFor(pct, target) {
  if (pct == null || target == null) return "none";
  if (pct <= target) return "ok";
  if (pct <= target + 3) return "warn";
  return "over";
}

/**
 * @param {object} input
 *   weekStart, settings, workers (raw staff records), rosterShifts (this week),
 *   attendance (closed clock records, this week), revenue: { forecast: {date:$}, actual: {date:$} },
 *   today (YYYY-MM-DD in venue tz), cycleHours: { [workerId]: { before, after } } hours outside this week
 */
function buildWeek(input) {
  const settings = { ...DEFAULT_SETTINGS, ...(input.settings || {}), targets: { ...DEFAULT_SETTINGS.targets, ...((input.settings || {}).targets || {}) } };
  const weekStart = input.weekStart;
  const dates = weekDates(weekStart);
  const today = input.today || todayIn(settings.timezone);
  const publicHolidays = settings.publicHolidays || [];
  const cycle = cycleFor(weekStart, settings);

  // Owners are on the staff list so the bot knows them; they only cost money
  // if they have been given pay details (a working owner-chef on a salary).
  const profiles = (input.workers || [])
    .filter((w) => w.active !== false && (w.role !== "owner" || w.employmentType || w.annualSalary))
    .map(payProfile);
  const byWorkerRoster = {}, byWorkerWorked = {};
  for (const s of input.rosterShifts || []) (byWorkerRoster[s.workerId] = byWorkerRoster[s.workerId] || []).push(s);
  for (const rec of input.attendance || []) {
    const s = attendanceToShift(rec, settings.timezone);
    if (!s || s.date < weekStart || s.date > dates[6]) continue;
    (byWorkerWorked[s.workerId] = byWorkerWorked[s.workerId] || []).push(s);
  }

  const crew = profiles.map((p) => {
    const ch = (input.cycleHours || {})[p.id] || { before: 0, after: 0 };
    return personWeek(p, byWorkerRoster[p.id] || [], byWorkerWorked[p.id] || [], {
      weekStart, today, publicHolidays, includeSuper: settings.includeSuper,
      cycle: p.employmentType === "fulltime" ? { ...cycle, limit: cycle.hours, hoursBefore: ch.before, rosteredAfter: ch.after } : null,
    });
  }).sort((a, b) => (a.department || "zz").localeCompare(b.department || "zz") || b.projectedCost - a.projectedCost);

  // Revenue: actual where entered, forecast otherwise.
  const forecast = (input.revenue && input.revenue.forecast) || {};
  const actualRev = (input.revenue && input.revenue.actual) || {};
  const days = dates.map((d) => {
    const f = num(forecast[d]), a = num(actualRev[d]);
    const expected = a != null ? a : f;
    const row = { date: d, dow: dayOfWeek(d), dayType: dayType(d, publicHolidays), forecast: f, actual: a, expected, isPast: d < today, isToday: d === today,
      rostered: 0, worked: 0, projected: 0, kitchen: 0, service: 0, hours: 0 };
    for (const c of crew) {
      const cd = c.days.find((x) => x.date === d);
      row.rostered += cd.rosteredCost; row.worked += cd.actualCost; row.projected += cd.projectedCost; row.hours += cd.projectedHours;
      if (c.department === "kitchen") row.kitchen += cd.projectedCost; else if (c.department === "service") row.service += cd.projectedCost;
    }
    for (const k of ["rostered", "worked", "projected", "kitchen", "service", "hours"]) row[k] = round2(row[k]);
    row.pct = expected > 0 ? round1((row.projected / expected) * 100) : null;
    row.status = statusFor(row.pct, settings.targets.totalPct);
    return row;
  });

  const sum = (arr, k) => round2(arr.reduce((t, x) => t + (x[k] || 0), 0));
  const expectedRevenue = days.some((d) => d.expected != null) ? sum(days.filter((d) => d.expected != null), "expected") : null;
  const forecastRevenue = days.some((d) => d.forecast != null) ? sum(days.filter((d) => d.forecast != null), "forecast") : null;
  const t = settings.targets;
  const servicePct = round1(Math.max(0, t.totalPct - t.kitchenPct));

  const dept = (key, targetPct) => {
    const members = key === "total" ? crew : crew.filter((c) => c.department === key);
    const rostered = sum(members, "rosteredCost"), projected = sum(members, "projectedCost"), worked = sum(members, "workedCost");
    const budget = expectedRevenue != null ? round2(expectedRevenue * targetPct / 100) : null;
    const pct = expectedRevenue > 0 ? round1((projected / expectedRevenue) * 100) : null;
    return {
      key, targetPct, budget, rostered, projected, worked, hours: sum(members, "projectedHours"), headcount: members.length,
      pct, status: statusFor(pct, targetPct), variance: budget != null ? round2(budget - projected) : null,
    };
  };
  const departments = { kitchen: dept("kitchen", t.kitchenPct), service: dept("service", servicePct), total: dept("total", t.totalPct) };
  const other = crew.filter((c) => !c.department || c.department === "other");

  const flags = crew.flatMap((c) => c.flags);
  const needsSetup = crew.filter((c) => c.needsSetup);
  if (needsSetup.length) flags.unshift({ level: "warn", code: "setup", text: `${needsSetup.length === 1 ? needsSetup[0].name + " has" : needsSetup.length + " people have"} no pay details yet — costed as casual Level 1 until you set them.` });
  if (expectedRevenue == null) flags.unshift({ level: "info", code: "forecast", text: "Enter a revenue forecast to see payroll as a % of revenue." });
  if (other.length) flags.push({ level: "info", text: `${other.map((c) => c.name).join(", ")}: no department set — counted in the total only.` });
  const unverified = crew.some((c) => !c.aboveAward && getAward("MA000009").levels[c.level] && !getAward("MA000009").levels[c.level].verified);
  if (unverified) flags.push({ level: "info", text: "Some award rates are 2026/27 estimates — check fairwork.gov.au before the first pay run." });

  return {
    weekStart, weekEnd: dates[6], today, settings: { ...settings, targets: { ...t, servicePct } },
    cycle, days, departments, crew,
    totals: {
      rostered: departments.total.rostered, projected: departments.total.projected, worked: departments.total.worked,
      hours: departments.total.hours, super: sum(crew, "superCost"),
      expectedRevenue, forecastRevenue, budget: departments.total.budget,
      pct: departments.total.pct, status: departments.total.status, variance: departments.total.variance,
    },
    flags,
  };
}

/**
 * Hours a full-timer has in the rest of the cycle (outside the week being viewed):
 * worked for dates before today, rostered for today onward. Both lists span the cycle.
 */
function cycleHoursOutsideWeek({ workerId, weekStart, cycle, today, rosterShifts, attendance, timezone }) {
  const weekEnd = addDays(weekStart, 6);
  let before = 0, after = 0;
  const workedByDate = {};
  for (const rec of attendance || []) {
    const s = attendanceToShift(rec, timezone);
    if (!s || s.workerId !== workerId || s.date < cycle.start || s.date > cycle.end) continue;
    workedByDate[s.date] = (workedByDate[s.date] || 0) + s.hours;
  }
  const rosteredByDate = {};
  for (const s of rosterShifts || []) {
    if (s.workerId !== workerId || s.date < cycle.start || s.date > cycle.end) continue;
    rosteredByDate[s.date] = (rosteredByDate[s.date] || 0) + rosterShiftHours(s);
  }
  for (let d = cycle.start; d <= cycle.end; d = addDays(d, 1)) {
    if (d >= weekStart && d <= weekEnd) continue;
    const h = d < today || workedByDate[d] ? (workedByDate[d] || 0) : (rosteredByDate[d] || 0);
    if (d < weekStart) before += h; else after += h;
  }
  return { before: round2(before), after: round2(after) };
}

/**
 * Suggested forecast for each day of the week: the average of the same weekday
 * over the last 4 weeks that have a figure (actual preferred, else forecast).
 * history: [{ weekStart, forecast:{date:$}, actual:{date:$} }]
 */
function suggestForecast(weekStart, history) {
  const out = {};
  for (const d of weekDates(weekStart)) {
    const dow = dayOfWeek(d);
    const vals = [];
    for (const h of history || []) {
      if (h.weekStart >= weekStart) continue;
      for (const [date, v] of Object.entries({ ...(h.forecast || {}), ...(h.actual || {}) })) {
        if (dayOfWeek(date) === dow && num(v) != null) vals.push(num(v));
      }
    }
    const last4 = vals.slice(-4);
    out[d] = last4.length ? Math.round(last4.reduce((a, b) => a + b, 0) / last4.length) : null;
  }
  return out;
}

/** Spread a weekly total across the days using last weeks' pattern (or evenly). */
function spreadWeekTotal(weekStart, total, pattern) {
  const dates = weekDates(weekStart);
  const weights = dates.map((d) => (pattern && num(pattern[d]) != null ? num(pattern[d]) : null));
  const usable = weights.every((w) => w != null && w > 0) ? weights : dates.map(() => 1);
  const sumW = usable.reduce((a, b) => a + b, 0);
  const out = {};
  let acc = 0;
  dates.forEach((d, i) => {
    const v = i === 6 ? Math.round(total - acc) : Math.round(total * usable[i] / sumW);
    out[d] = v; acc += v;
  });
  return out;
}

function num(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return isFinite(n) ? n : null; }
function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }

module.exports = {
  DEFAULT_SETTINGS, DEPARTMENTS, CYCLE_HOURS_PER_WEEK,
  addDays, weekStartFor, weekDates, todayIn, localDateTime, cycleFor,
  normalizeDepartment, payProfile, attendanceToShift, effectiveTimes, rosterShiftHours,
  costHourly, personWeek, buildWeek, cycleHoursOutsideWeek, suggestForecast, spreadWeekTotal,
};
