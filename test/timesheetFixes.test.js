"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const TF = require("../timesheetFixes");

const TZ = "Australia/Perth";
const staff = [
  { phone: "61400000001", name: "Rita M", payType: "hourly", active: true },
  { phone: "61400000002", name: "Sal Chef", payType: "salary", active: true },
  { phone: "61400000003", name: "Leave Lee", payType: "hourly", active: true, onLeave: true },
];
const at = (date, time) => TF.zonedToIso(date, time, TZ);

test("zonedToIso reads Perth wall-clock time (UTC+8)", () => {
  assert.equal(at("2026-11-09", "17:00"), "2026-11-09T09:00:00.000Z");
  assert.equal(at("2026-11-09", "00:30"), "2026-11-08T16:30:00.000Z");
});

const clock = (phone, date, inT, outT, extra = {}) => ({ shiftId: "s_" + phone + date + inT, staffPhone: phone, clockIn: { time: at(date, inT) }, clockOut: outT ? { time: at(date, outT) } : null, breaks: [], ...extra });

test("venue that has never clocked in gets no fix cards", () => {
  const r = TF.detect({ roster: [{ id: "r1", workerId: "61400000001", date: "2026-11-08", start: "07:00", end: "12:00" }], attendance: [], staff, now: new Date(at("2026-11-09", "10:00")), timezone: TZ, windowStart: "2026-11-06" });
  assert.equal(r.active, false);
  assert.equal(r.fixes.length, 0);
});

test("forgot to clock in: finished shift, no record, others did clock in", () => {
  const roster = [
    { id: "r1", workerId: "61400000001", date: "2026-11-08", start: "07:00", end: "12:00", unpaidBreakMins: 0 },
    { id: "r2", workerId: "61400000002", date: "2026-11-08", start: "09:00", end: "17:00" }, // salaried: ignored
    { id: "r3", workerId: "61400000003", date: "2026-11-08", start: "09:00", end: "17:00" }, // on leave: ignored
  ];
  const attendance = [clock("61400000099", "2026-11-08", "07:00", "12:00")];
  const r = TF.detect({ roster, attendance, staff: [...staff, { phone: "61400000099", name: "Other", payType: "hourly", active: true }], now: new Date(at("2026-11-09", "10:00")), timezone: TZ, windowStart: "2026-11-06" });
  assert.equal(r.fixes.length, 1);
  assert.equal(r.fixes[0].type, "no_in");
  assert.equal(r.fixes[0].proposal.inIso, at("2026-11-08", "07:00"));
  assert.equal(r.fixes[0].proposal.outIso, at("2026-11-08", "12:00"));
});

test("a shift that has not finished yet is not flagged", () => {
  const roster = [{ id: "r1", workerId: "61400000001", date: "2026-11-09", start: "07:00", end: "15:00" }];
  const attendance = [clock("61400000099", "2026-11-09", "07:00", null)];
  const r = TF.detect({ roster, attendance, staff, now: new Date(at("2026-11-09", "12:00")), timezone: TZ, windowStart: "2026-11-06" });
  assert.equal(r.fixes.filter((f) => f.type === "no_in").length, 0);
});

test("forgot to clock out: open record past rostered end proposes the rostered end", () => {
  const roster = [{ id: "r1", workerId: "61400000001", date: "2026-11-08", start: "14:30", end: "22:30", unpaidBreakMins: 30 }];
  const attendance = [clock("61400000001", "2026-11-08", "14:28", null)];
  const r = TF.detect({ roster, attendance, staff, now: new Date(at("2026-11-09", "08:00")), timezone: TZ, windowStart: "2026-11-06" });
  assert.equal(r.fixes.length, 1);
  assert.equal(r.fixes[0].type, "no_out");
  assert.equal(r.fixes[0].proposal.outIso, at("2026-11-08", "22:30"));
  assert.equal(r.fixes[0].proposal.breakMins, 30);
});

test("an open clock-in inside the rostered window is left alone", () => {
  const roster = [{ id: "r1", workerId: "61400000001", date: "2026-11-09", start: "14:30", end: "22:30" }];
  const attendance = [clock("61400000001", "2026-11-09", "14:28", null)];
  const r = TF.detect({ roster, attendance, staff, now: new Date(at("2026-11-09", "19:00")), timezone: TZ, windowStart: "2026-11-06" });
  assert.equal(r.fixes.length, 0);
});

test("overnight shift: out lands the next morning", () => {
  const roster = [{ id: "r1", workerId: "61400000001", date: "2026-11-08", start: "17:00", end: "00:00", unpaidBreakMins: 30 }];
  const attendance = [clock("61400000001", "2026-11-08", "16:58", null)];
  const r = TF.detect({ roster, attendance, staff, now: new Date(at("2026-11-09", "09:00")), timezone: TZ, windowStart: "2026-11-06" });
  assert.equal(r.fixes[0].proposal.outIso, at("2026-11-09", "00:00"));
});

test("no break recorded on an 8h shift proposes the rostered unpaid break; a recorded break does not", () => {
  const roster = [{ id: "r1", workerId: "61400000001", date: "2026-11-08", start: "14:30", end: "22:30", unpaidBreakMins: 30 }];
  const noBreak = clock("61400000001", "2026-11-08", "14:30", "22:30");
  const withBreak = { ...clock("61400000001", "2026-11-08", "14:30", "22:30"), shiftId: "x", breaks: [{ start: at("2026-11-08", "18:00"), end: at("2026-11-08", "18:30") }] };
  const a = TF.detect({ roster, attendance: [noBreak], staff, now: new Date(at("2026-11-09", "09:00")), timezone: TZ, windowStart: "2026-11-06" });
  assert.deepEqual(a.fixes.map((f) => f.type), ["no_break"]);
  assert.equal(a.fixes[0].proposal.breakMins, 30);
  const b = TF.detect({ roster, attendance: [withBreak], staff, now: new Date(at("2026-11-09", "09:00")), timezone: TZ, windowStart: "2026-11-06" });
  assert.equal(b.fixes.length, 0);
});

test("apply: no_in creates a closed record with the break; no_out closes at the rostered end", async () => {
  const { InMemoryShiftsStore } = require("../shiftsStore");
  const shiftsStore = new InMemoryShiftsStore();
  const roster = [{ id: "r1", workerId: "61400000001", date: "2026-11-08", start: "07:00", end: "15:00", unpaidBreakMins: 30 }];
  const other = clock("61400000099", "2026-11-08", "07:00", "12:00");
  const r = TF.detect({ roster, attendance: [other], staff: [...staff, { phone: "61400000099", name: "Other", payType: "hourly", active: true }], now: new Date(at("2026-11-09", "10:00")), timezone: TZ, windowStart: "2026-11-06" });
  const msg = await TF.apply(r.fixes[0], { out: "14:30" }, { shiftsStore }, { tenantId: "t1", timezone: TZ, staff });
  assert.match(msg, /07:00–14:30/);
  const all = await shiftsStore.listByTenant("t1");
  assert.equal(all.length, 1);
  assert.equal(all[0].clockIn.time, at("2026-11-08", "07:00"));
  assert.equal(all[0].clockOut.time, at("2026-11-08", "14:30"));
  assert.equal(all[0].amended.breakMinutes, 30);
});
