"use strict";

/**
 * payPrivacy.js — what a manager link (req.isTeam) is not allowed to see.
 *
 * A venue has two keys: the owner link, and an optional manager link for a sous
 * chef or 2IC. The manager link runs the same roster and sees the same payroll
 * totals, but no individual salary: salaried people's pay is stripped here, on the
 * server, before anything is sent to that browser, and shown as one combined
 * "Salaried staff" line instead.
 *
 * Why every salaried person and not just the owner: the week's total is still
 * shown, so hiding one person while itemising everyone else would let anyone
 * subtract their way to the hidden figure. With the salaried group combined, the
 * only number on show is the group's sum. (A venue with a single salaried person
 * can't be protected this way — the combined line is that person.)
 *
 * Hourly staff keep their rate and cost: award levels aren't private, and a
 * manager needs them to roster to a budget.
 */

const LOCKED = "Salaried staff can only be changed from the owner link.";

const round2 = (n) => Math.round(n * 100) / 100;

/** Same test the costing uses (payroll.payProfile): only a full-timer can be salaried. */
const isSalaried = (w) => Boolean(w) && w.employmentType === "fulltime" && w.payType === "salary";

/** A staff record without its salary. Hourly people come back unchanged. */
function redactWorker(w) {
  if (!isSalaried(w)) return w;
  const { annualSalary, weeklySalary, ...rest } = w;
  return { ...rest, payHidden: true };
}

/** Would this save read or change a salary? `existing` is the record being edited (or null for a new person). */
function touchesSalary(existing, body) {
  const b = body || {};
  return isSalaried(existing) || b.payType === "salary" || (b.annualSalary != null && b.annualSalary !== "");
}

/** The Pay page's week (payroll.buildWeek) with salaried pay removed and summed into `week.salaried`. */
function redactWeek(week) {
  if (!week || !Array.isArray(week.crew)) return week;
  const group = { headcount: 0, wages: 0, projected: 0, byDate: {} };
  const crew = week.crew.map((c) => {
    if (c.payType !== "salary") return c;
    const load = c.load || 1;
    group.headcount++;
    group.wages += c.projectedCost || 0;
    group.projected += (c.projectedCost || 0) * load;
    const days = (c.days || []).map((d) => {
      group.byDate[d.date] = (group.byDate[d.date] || 0) + (d.projectedCost || 0) * load;
      return { ...d, rosteredCost: null, workedCost: null, actualCost: null, projectedCost: null };
    });
    return { ...c, weeklySalary: null, rosteredCost: null, workedCost: null, projectedCost: null, oncostCost: null, payHidden: true, days };
  });
  if (!group.headcount) return week;
  // The list is sorted by cost; a hidden person's place in it would rank the salaries.
  const dept = (c) => c.department || "zz";
  crew.sort((a, b) => dept(a).localeCompare(dept(b)) || Number(Boolean(a.payHidden)) - Number(Boolean(b.payHidden))
    || (a.payHidden ? String(a.name).localeCompare(String(b.name)) : (b.projectedCost || 0) - (a.projectedCost || 0)));
  for (const d of Object.keys(group.byDate)) group.byDate[d] = round2(group.byDate[d]);
  return { ...week, crew, salaried: { headcount: group.headcount, wages: round2(group.wages), projected: round2(group.projected), byDate: group.byDate } };
}

/** financeReport.collectMonth() output with the salaried people folded into one line per department. */
function redactPeople(collected) {
  if (!collected || !Array.isArray(collected.people)) return collected;
  const out = [], groups = new Map();
  for (const p of collected.people) {
    if (p.typeLabel !== "Salaried") { out.push(p); continue; }
    let g = groups.get(p.department);
    if (!g) { g = { name: "", department: p.department, cls: p.cls, typeLabel: "Salaried", byDate: {}, total: 0, hours: 0, n: 0 }; groups.set(p.department, g); out.push(g); }
    g.n++; g.total = round2(g.total + p.total); g.hours = round2(g.hours + p.hours);
    for (const [d, v] of Object.entries(p.byDate || {})) g.byDate[d] = round2((g.byDate[d] || 0) + v);
  }
  for (const g of groups.values()) { g.name = `Salaried staff (${g.n})`; delete g.n; }
  return { ...collected, people: out };
}

module.exports = { LOCKED, isSalaried, redactWorker, touchesSalary, redactWeek, redactPeople };
