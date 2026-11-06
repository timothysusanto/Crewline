"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../payroll");

const TZ = "Australia/Sydney";
// Mon 2 Nov 2026 → Sun 8 Nov 2026
const WEEK = "2026-11-02";

const casual = { phone: "61400000001", name: "Aarav", employmentType: "casual", level: "L1", department: "kitchen", role: "staff" };
const ftHourly = { phone: "61400000002", name: "Maria", employmentType: "fulltime", level: "L3", department: "kitchen", role: "staff" };
const salaried = { phone: "61400000003", name: "Chef Tim", employmentType: "fulltime", payType: "salary", annualSalary: 78000, department: "kitchen", role: "manager" };
const foh = { phone: "61400000004", name: "Jess", employmentType: "parttime", level: "L2", department: "FOH", hourlyRate: 30, role: "staff" };

const clock = (phone, inLocal, outLocal, breakMins = 0) => ({
  shiftId: `s_${phone}_${inLocal}`, staffPhone: phone,
  clockIn: { time: sydneyIso(inLocal) }, clockOut: { time: sydneyIso(outLocal) },
  breaks: breakMins ? [{ start: sydneyIso(inLocal), end: new Date(new Date(sydneyIso(inLocal)).getTime() + breakMins * 60000).toISOString() }] : [],
});
// Sydney is UTC+11 in November (DST).
function sydneyIso(local) { return new Date(local + ":00+11:00").toISOString(); }

test("weekStartFor finds the Monday, and Sunday weeks when asked", () => {
  assert.equal(P.weekStartFor("2026-11-05", 1), "2026-11-02");
  assert.equal(P.weekStartFor("2026-11-02", 1), "2026-11-02");
  assert.equal(P.weekStartFor("2026-11-08", 1), "2026-11-02");
  assert.equal(P.weekStartFor("2026-11-08", 0), "2026-11-08");
});

test("localDateTime puts a UTC instant on the venue clock", () => {
  const r = P.localDateTime("2026-11-04T13:30:00.000Z", TZ); // 00:30 next day in Sydney (UTC+11)
  assert.equal(r.date, "2026-11-05");
  assert.equal(r.time, "00:30");
  assert.equal(P.localDateTime("2026-11-04T13:30:00.000Z", "Australia/Perth").time, "21:30");
});

test("cycleFor: 4-week cycle counted from the anchor", () => {
  const c = P.cycleFor("2026-11-09", { cycleAnchor: "2026-10-26" });
  assert.equal(c.start, "2026-10-26");
  assert.equal(c.end, "2026-11-22");
  assert.equal(c.hours, 152);
  assert.equal(c.weekIndex, 3);
  // Week after the cycle ends starts a new one.
  assert.equal(P.cycleFor("2026-11-23", { cycleAnchor: "2026-10-26" }).start, "2026-11-23");
  // Weeks before the anchor still land in a cycle.
  assert.equal(P.cycleFor("2026-10-19", { cycleAnchor: "2026-10-26" }).start, "2026-09-28");
});

test("payProfile: award rate unless the venue pays above it; salary → weekly", () => {
  assert.equal(P.payProfile(casual).hourlyRate, 26.44);
  assert.equal(P.payProfile(casual).aboveAward, false);
  assert.equal(P.payProfile(foh).hourlyRate, 30);
  assert.equal(P.payProfile(foh).aboveAward, true);
  assert.equal(P.payProfile(foh).department, "service");
  const s = P.payProfile(salaried);
  assert.equal(s.payType, "salary");
  assert.equal(s.weeklySalary, 1500);
  assert.equal(s.typeLabel, "Salaried");
});

test("attendanceToShift: amended-aware, breaks off, on the venue clock", () => {
  const rec = clock(casual.phone, "2026-11-03T10:00", "2026-11-03T18:30", 30);
  const s = P.attendanceToShift(rec, TZ);
  assert.equal(s.date, "2026-11-03");
  assert.equal(s.start, "10:00");
  assert.equal(s.end, "18:30");
  assert.equal(s.hours, 8);
  rec.amended = { clockOutTime: sydneyIso("2026-11-03T17:30"), breakMinutes: 0 };
  assert.equal(P.attendanceToShift(rec, TZ).hours, 7.5);
  assert.equal(P.attendanceToShift({ ...rec, clockOut: null }, TZ), null);
});

test("casual Saturday costs 1.5× the base under HIGA", () => {
  const line = P.costHourly({ date: "2026-11-07", start: "10:00", end: "18:00", unpaidBreakMins: 0 }, P.payProfile(casual), [], false);
  assert.equal(line.multiplier, 1.5);
  assert.equal(line.wage, Math.round(8 * 26.44 * 1.5 * 100) / 100);
  assert.equal(line.cost, line.wage);
});

test("above-award rate scales the whole shift, super follows", () => {
  const line = P.costHourly({ date: "2026-11-03", start: "09:00", end: "17:00", unpaidBreakMins: 0 }, P.payProfile(foh), [], true);
  assert.equal(line.wage, 240);          // 8h × $30 weekday permanent 1.0×
  assert.equal(line.superCost, 28.8);
  assert.equal(line.cost, 268.8);        // includeSuper
});

test("salaried staff: weekly cost spread over rostered days, accrues as days pass", () => {
  const rostered = [
    { workerId: salaried.phone, date: "2026-11-02", start: "08:00", end: "16:00", unpaidBreakMins: 30 },
    { workerId: salaried.phone, date: "2026-11-03", start: "08:00", end: "16:00", unpaidBreakMins: 30 },
    { workerId: salaried.phone, date: "2026-11-04", start: "08:00", end: "16:00", unpaidBreakMins: 30 },
    { workerId: salaried.phone, date: "2026-11-06", start: "08:00", end: "16:00", unpaidBreakMins: 30 },
  ];
  const w = P.personWeek(P.payProfile(salaried), rostered, [], { weekStart: WEEK, today: "2026-11-05", publicHolidays: [], includeSuper: false, cycle: null });
  assert.equal(w.rosteredCost, 1500);
  assert.equal(w.days[0].rosteredCost, 375);  // 1500 / 4 rostered days
  assert.equal(w.days[3].rosteredCost, 0);    // Thursday not rostered → nothing posted
  assert.equal(w.days[4].rosteredCost, 375);  // Friday rostered, still to come
  assert.equal(w.days[0].actualCost, 375);    // Monday has passed
  assert.equal(w.days[2].actualCost, 375);    // Wednesday has passed
  assert.equal(w.days[3].actualCost, 0);      // Thursday is today — not yet
  assert.equal(w.projectedCost, 1500);        // the week will cost the salary regardless
});

test("salaried with no roster yet spreads Mon–Fri", () => {
  const w = P.personWeek(P.payProfile(salaried), [], [], { weekStart: WEEK, today: "2026-11-02", publicHolidays: [], includeSuper: false, cycle: null });
  assert.equal(w.days[0].rosteredCost, 300);
  assert.equal(w.days[5].rosteredCost, 0);
  assert.equal(w.rosteredCost, 1500);
});

test("hourly: actual replaces rostered for days that have happened", () => {
  const rostered = [
    { workerId: casual.phone, date: "2026-11-02", start: "10:00", end: "18:00", unpaidBreakMins: 0 }, // 8h rostered
    { workerId: casual.phone, date: "2026-11-06", start: "10:00", end: "18:00", unpaidBreakMins: 0 },
  ];
  const worked = [P.attendanceToShift(clock(casual.phone, "2026-11-02T10:00", "2026-11-02T20:00"), TZ)]; // 10h worked
  const w = P.personWeek(P.payProfile(casual), rostered, worked, { weekStart: WEEK, today: "2026-11-04", publicHolidays: [], includeSuper: false, cycle: null });
  assert.equal(w.days[0].projectedHours, 10);
  assert.equal(w.days[4].projectedHours, 8);
  assert.equal(w.projectedHours, 18);
  // 18h at casual weekday 1.25×, plus the HIGA evening loading (+10% of base) for the hour after 7pm on Monday.
  assert.equal(w.projectedCost, Math.round((10 * 26.44 * 1.25 + 8 * 26.44 * 1.25 + 1 * 26.44 * 0.10) * 100) / 100);
});

test("152-hour cycle: overtime lands in the week the 152nd hour is passed", () => {
  const p = P.payProfile(ftHourly);
  const rostered = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((date) =>
    ({ workerId: ftHourly.phone, date, start: "08:00", end: "17:00", unpaidBreakMins: 60 })); // 8h × 5 = 40h
  const ctx = { weekStart: WEEK, today: "2026-11-02", publicHolidays: [], includeSuper: false,
    cycle: { start: "2026-10-12", end: "2026-11-08", weekIndex: 4, weeks: 4, limit: 152, hoursBefore: 118, rosteredAfter: 0 } };
  const w = P.personWeek(p, rostered, [], ctx);
  assert.equal(w.cycle.total, 158);
  assert.equal(w.cycle.over, 6);
  assert.equal(w.cycle.status, "over");
  assert.equal(w.cycle.overtimeHoursThisWeek, 6);
  // 2h at +0.5 and 4h at +1.0 of $27.34
  assert.equal(w.cycle.overtimePremium, Math.round((2 * 27.34 * 0.5 + 4 * 27.34 * 1.0) * 100) / 100);
  assert.equal(w.projectedCost, Math.round((40 * 27.34 + w.cycle.overtimePremium) * 100) / 100);
  assert.ok(w.flags.some((f) => f.level === "over"));
});

test("152-hour cycle: on track when the roster fits", () => {
  const p = P.payProfile(ftHourly);
  const rostered = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].map((date) =>
    ({ workerId: ftHourly.phone, date, start: "08:00", end: "17:00", unpaidBreakMins: 60 })); // 32h
  const w = P.personWeek(p, rostered, [], { weekStart: WEEK, today: "2026-11-02", publicHolidays: [], includeSuper: false,
    cycle: { start: "2026-10-12", end: "2026-11-08", weekIndex: 4, weeks: 4, limit: 152, hoursBefore: 114, rosteredAfter: 0 } });
  assert.equal(w.cycle.total, 146);
  assert.equal(w.cycle.status, "close");
  assert.equal(w.cycle.over, 0);
  assert.equal(w.flags.length, 0);
});

test("salaried full-timer past 152h is flagged, not charged", () => {
  const rostered = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"].map((date) =>
    ({ workerId: salaried.phone, date, start: "07:00", end: "18:00", unpaidBreakMins: 60 })); // 10h × 6 = 60h
  const w = P.personWeek(P.payProfile(salaried), rostered, [], { weekStart: WEEK, today: "2026-11-02", publicHolidays: [], includeSuper: false,
    cycle: { start: "2026-10-12", end: "2026-11-08", weekIndex: 4, weeks: 4, limit: 152, hoursBefore: 100, rosteredAfter: 0 } });
  assert.equal(w.cycle.over, 8);
  assert.equal(w.projectedCost, 1500);
  assert.ok(w.flags.some((f) => /Salaried/.test(f.text)));
});

test("cycleHoursOutsideWeek: worked before today, rostered after, this week excluded", () => {
  const cycle = { start: "2026-10-12", end: "2026-11-08" };
  const attendance = [
    clock(ftHourly.phone, "2026-10-13T08:00", "2026-10-13T16:00"), // 8h, in cycle, before week
    clock(ftHourly.phone, "2026-11-03T08:00", "2026-11-03T16:00"), // in the viewed week → excluded
    clock(ftHourly.phone, "2026-10-05T08:00", "2026-10-05T16:00"), // before cycle → excluded
  ];
  const roster = [
    { workerId: ftHourly.phone, date: "2026-10-14", start: "08:00", end: "16:00", unpaidBreakMins: 0 }, // past, no clock record → 0 (didn't work)
    { workerId: ftHourly.phone, date: "2026-10-27", start: "08:00", end: "16:00", unpaidBreakMins: 0 }, // past but… today is 2026-10-20? see below
  ];
  const r = P.cycleHoursOutsideWeek({ workerId: ftHourly.phone, weekStart: WEEK, cycle, today: "2026-10-20", rosterShifts: roster, attendance, timezone: TZ });
  assert.equal(r.before, 16); // 8 worked on the 13th + 8 rostered on the 27th (future relative to today)
  assert.equal(r.after, 0);
});

test("buildWeek: budgets by department from the revenue forecast", () => {
  const forecast = {};
  P.weekDates(WEEK).forEach((d) => (forecast[d] = 3000)); // $21,000 week
  const rosterShifts = [
    { workerId: casual.phone, date: "2026-11-02", start: "10:00", end: "18:00", unpaidBreakMins: 0 },   // 8h × 26.44 × 1.25 = 264.40
    { workerId: foh.phone, date: "2026-11-02", start: "10:00", end: "18:00", unpaidBreakMins: 0 },      // 8h × 30 = 240
  ];
  const out = P.buildWeek({
    weekStart: WEEK, today: "2026-11-02", settings: { timezone: TZ, targets: { kitchenPct: 22, totalPct: 55 }, cycleAnchor: "2026-10-12" },
    workers: [casual, salaried, foh, { phone: "61400000009", name: "Owner", role: "owner" }],
    rosterShifts, attendance: [], revenue: { forecast },
  });
  assert.equal(out.totals.expectedRevenue, 21000);
  assert.equal(out.departments.total.budget, 11550);
  assert.equal(out.departments.kitchen.budget, 4620);
  assert.equal(out.departments.service.targetPct, 33);
  assert.equal(out.departments.service.budget, 6930);
  assert.equal(out.departments.kitchen.projected, 1500 + 264.4);
  assert.equal(out.departments.service.projected, 240);
  assert.equal(out.totals.projected, 2004.4);
  assert.equal(out.totals.pct, 9.5);
  assert.equal(out.totals.status, "ok");
  assert.equal(out.crew.length, 3); // the owner without pay details is not costed
  assert.equal(out.days[0].kitchen, 264.4 + 300); // Monday: the casual + Chef Tim's salary spread Mon–Fri (no roster for him yet)
});

test("buildWeek: status goes amber then red as payroll passes the target", () => {
  const forecast = { "2026-11-02": 1000 };
  const mk = (rate) => P.buildWeek({
    weekStart: WEEK, today: "2026-11-02", settings: { timezone: TZ, targets: { kitchenPct: 22, totalPct: 55 } },
    workers: [{ ...casual, hourlyRate: rate }],
    rosterShifts: [{ workerId: casual.phone, date: "2026-11-02", start: "10:00", end: "20:00", unpaidBreakMins: 0 }], // 10h × rate × 1.25
    attendance: [], revenue: { forecast },
  });
  assert.equal(mk(40).totals.status, "ok");    // $500 = 50%
  assert.equal(mk(45).totals.status, "warn");  // $562.50 = 56.3%
  assert.equal(mk(50).totals.status, "over");  // $625 = 62.5%
});

test("suggestForecast averages the same weekday over the last 4 weeks, actual preferred", () => {
  const history = [
    { weekStart: "2026-10-05", forecast: { "2026-10-05": 1000 }, actual: { "2026-10-05": 1200 } },
    { weekStart: "2026-10-12", forecast: { "2026-10-12": 1000 } },
    { weekStart: "2026-10-19", forecast: { "2026-10-19": 1400 }, actual: { "2026-10-19": 1600 } },
    { weekStart: "2026-10-26", forecast: { "2026-10-26": 2000 } },
    { weekStart: "2026-11-09", forecast: { "2026-11-09": 9999 } }, // the future never counts
  ];
  const s = P.suggestForecast(WEEK, history);
  assert.equal(s["2026-11-02"], 1450); // (1200 + 1000 + 1600 + 2000) / 4
  assert.equal(s["2026-11-03"], null);
});

test("spreadWeekTotal follows the pattern and lands exactly on the total", () => {
  const pattern = {}; P.weekDates(WEEK).forEach((d, i) => (pattern[d] = i >= 4 ? 2 : 1)); // Fri/Sat/Sun double
  const out = P.spreadWeekTotal(WEEK, 10000, pattern);
  assert.equal(Object.values(out).reduce((a, b) => a + b, 0), 10000);
  assert.equal(out["2026-11-07"], 2000);
  assert.equal(out["2026-11-02"], 1000);
  const even = P.spreadWeekTotal(WEEK, 700, null);
  assert.equal(even["2026-11-02"], 100);
});
