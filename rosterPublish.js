"use strict";

/**
 * Who needs a message when the manager taps Publish.
 *
 * Publishing used to message everyone on the week and wipe their confirmations, even when one
 * person's shift changed. Now only the people whose roster is different from what they were last
 * sent get a message; everyone else keeps their roster and their "confirmed" tick.
 *
 * "What they were last sent" is a signature of their shifts for the week, stored at publish time.
 * A week published before signatures existed has none: there, someone is "changed" only if one of
 * their shifts is not published (editing a shift in the dashboard un-publishes it).
 */

/** The week's shifts for one person as one comparable string. */
function signature(shifts) {
  return shifts.map((s) => `${s.date}|${s.start}|${s.end}|${s.role || ""}`).sort().join(";");
}

/**
 * @param {Object<string, object[]>} byWorker  workerId -> their shifts this week
 * @param {Object<string, {sig: string}>} notices  workerId -> what they were last sent this week
 * @returns {{ changed: string[], unchanged: string[], cleared: string[], sigs: Object<string,string> }}
 *   changed   — send the roster again (and reset their confirmation)
 *   unchanged — leave alone
 *   cleared   — had shifts when last told, now has none: tell them the week is empty
 */
function planPublish(byWorker, notices = {}) {
  const changed = [], unchanged = [], cleared = [], sigs = {};
  for (const [workerId, shifts] of Object.entries(byWorker)) {
    const sig = (sigs[workerId] = signature(shifts));
    const prev = notices[workerId];
    const same = prev ? prev.sig === sig : shifts.every((s) => s.published === true);
    (same ? unchanged : changed).push(workerId);
  }
  for (const [workerId, n] of Object.entries(notices)) {
    if (!byWorker[workerId] && n && n.sig) cleared.push(workerId);
  }
  return { changed, unchanged, cleared, sigs };
}

module.exports = { planPublish, signature };
