"use strict";

/**
 * demoSeed.js — fills the in-memory stores with a believable week so the
 * pages can be looked at without Firestore. Only runs when DEMO_SEED=1 and
 * the backend is in-memory; never touches real data.
 */
const P = require("./payroll");

async function seedDemo({ staffStore, rosterStore, shiftsStore, tenantStore, siteStore }, tenantId = "demo-venue") {
  const tz = "Australia/Sydney";
  const today = P.todayIn(tz);
  const weekStart = P.weekStartFor(today, 1);
  const crew = [
    { phone: "61400000001", name: "Aarav Sharma", role: "staff", department: "kitchen", employmentType: "casual", level: "L1", awardCode: "MA000009" },
    { phone: "61400000002", name: "Maria Gomez", role: "manager", department: "kitchen", employmentType: "fulltime", level: "L4", awardCode: "MA000009", hourlyRate: 31.5 },
    { phone: "61400000003", name: "Tim Susanto", role: "owner", department: "kitchen", employmentType: "fulltime", payType: "salary", annualSalary: 85000, level: "L6", awardCode: "MA000009" },
    { phone: "61400000004", name: "Jess Kim", role: "staff", department: "service", employmentType: "parttime", level: "L2", awardCode: "MA000009", hourlyRate: 29 },
    { phone: "61400000005", name: "Binod Thapa", role: "staff", department: "service", employmentType: "casual", level: "L1", awardCode: "MA000009" },
    { phone: "61400000006", name: "Lee Kwan", role: "staff", department: "service", employmentType: "casual", level: "L2", awardCode: "MA000009", telegramChatId: "9001" },
    { phone: "61400000007", name: "Priya Nair", role: "staff" }, // added from the bot's list only: no pay details yet
  ];
  for (const c of crew) await staffStore.upsert({ ...c, tenantId, active: true, telegramChatId: c.telegramChatId || (c.phone.endsWith("1") || c.phone.endsWith("2") || c.phone.endsWith("4") ? "9" + c.phone.slice(-3) : null) });

  await tenantStore.updateSettings(tenantId, { payroll: { weekStartsOn: 1, timezone: tz, targets: { kitchenPct: 22, totalPct: 55 }, cycleAnchor: P.addDays(weekStart, -21), cycleWeeks: 4, publicHolidays: [] } });

  // Roster: this week and the three before (for the 152h cycle).
  const plan = {
    "61400000001": [[0, "10:00", "18:30"], [3, "10:00", "18:30"], [4, "15:00", "23:30"], [5, "11:00", "19:30"]],
    "61400000002": [[0, "07:00", "15:30"], [1, "07:00", "15:30"], [2, "07:00", "15:30"], [3, "07:00", "15:30"], [5, "08:00", "17:00"]],
    "61400000003": [[0, "08:00", "17:00"], [1, "08:00", "17:00"], [2, "08:00", "17:00"], [4, "08:00", "17:00"], [5, "08:00", "17:00"]],
    "61400000004": [[1, "09:00", "14:00"], [2, "09:00", "14:00"], [4, "17:00", "23:00"], [5, "11:00", "19:00"], [6, "11:00", "16:00"]],
    "61400000005": [[4, "17:00", "23:30"], [5, "11:00", "21:00"], [6, "11:00", "18:00"]],
    "61400000006": [[5, "17:00", "23:00"], [6, "11:00", "17:00"]],
  };
  for (let w = -3; w <= 0; w++) {
    const ws = P.addDays(weekStart, w * 7);
    for (const [workerId, days] of Object.entries(plan)) {
      for (const [off, start, end] of days) {
        if (w < 0 && workerId === "61400000005" && off === 6) continue;
        await rosterStore.addShift({ tenantId, workerId, date: P.addDays(ws, off), start, end, unpaidBreakMins: 30, role: workerId.endsWith("1") || workerId.endsWith("2") || workerId.endsWith("3") ? "Pass" : "FOH", published: w < 0 || off < 3, confirmedAt: w < 0 || off < 2 ? "demo" : null, swapRequestedAt: workerId.endsWith("4") && off === 5 && w === 0 ? "demo" : null });
      }
    }
  }

  // Attendance: clock records for rostered days that have passed (roughly on time; one long day for Maria).
  const site = { siteId: "demo-venue-main", siteName: "Harbour Café" };
  for (let w = -3; w <= 0; w++) {
    const ws = P.addDays(weekStart, w * 7);
    for (const [workerId, days] of Object.entries(plan)) {
      if (workerId === "61400000003") continue; // salaried: spot clock-ins only
      for (const [off, start, end] of days) {
        const date = P.addDays(ws, off);
        if (date >= today) continue;
        if (w < 0 && workerId === "61400000005" && off === 6) continue;
        const late = workerId.endsWith("1") && off === 0 ? 14 : 0;
        const extra = workerId.endsWith("2") && off === 2 ? 90 : 0;
        const inIso = sydney(date, start, late), outIso = sydney(date, end, extra);
        const { shiftId } = await shiftsStore.openShift({ tenantId, staffPhone: workerId, department: null, ...site, clockIn: { time: inIso, lat: -33.8568, lng: 151.2153, withinRadius: true, distanceMeters: 12 } });
        await shiftsStore.startBreak(shiftId, sydney(date, start, 240));
        await shiftsStore.endBreak(shiftId, sydney(date, start, 270));
        await shiftsStore.closeShift(shiftId, { time: outIso, lat: -33.8568, lng: 151.2153, withinRadius: true, distanceMeters: 9 });
      }
    }
  }
  // Someone on now, and one flagged clock-in.
  const nowIso = new Date().toISOString();
  await shiftsStore.openShift({ tenantId, staffPhone: "61400000002", department: null, ...site, clockIn: { time: new Date(Date.now() - 3.2 * 3600e3).toISOString(), lat: -33.8568, lng: 151.2153, withinRadius: true, distanceMeters: 8 } });
  await shiftsStore.openShift({ tenantId, staffPhone: "61400000004", department: null, ...site, clockIn: { time: new Date(Date.now() - 0.4 * 3600e3).toISOString(), lat: -33.86, lng: 151.22, withinRadius: false, distanceMeters: 412, flaggedForReview: true } });
  void nowIso;
  return { weekStart };
}

/** A local Sydney time on a date → ISO instant (DST-aware via Intl). */
function sydney(date, hhmm, plusMins = 0) {
  const [h, m] = hhmm.split(":").map(Number);
  let mins = h * 60 + m + plusMins;
  let d = date;
  if (mins >= 1440) { mins -= 1440; d = P.addDays(date, 1); }
  const guess = new Date(`${d}T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00Z`);
  // Find the UTC offset Sydney has at that instant.
  const local = P.localDateTime(guess.toISOString(), "Australia/Sydney");
  const localMins = local.minutes + (local.date > d ? 1440 : local.date < d ? -1440 : 0);
  const offset = localMins - mins;
  return new Date(guess.getTime() - offset * 60000).toISOString();
}

module.exports = { seedDemo };
