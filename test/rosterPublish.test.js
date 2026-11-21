"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { planPublish, signature } = require("../rosterPublish");

const sh = (date, start, end, published = true, role) => ({ date, start, end, published, role });

test("publish only messages the people whose roster changed", () => {
  const week = { ana: [sh("2026-11-24", "15:00", "23:00")], ben: [sh("2026-11-24", "07:00", "12:00"), sh("2026-11-25", "07:00", "12:00")] };
  // First publish of a new week: drafts, nobody told yet -> everyone.
  const drafts = { ana: [sh("2026-11-24", "15:00", "23:00", false)], ben: week.ben.map((s) => ({ ...s, published: false })) };
  assert.deepEqual(planPublish(drafts, {}).changed.sort(), ["ana", "ben"]);

  const told = { ana: { sig: signature(week.ana) }, ben: { sig: signature(week.ben) } };
  // Nothing changed -> nobody.
  assert.deepEqual(planPublish(week, told).changed, []);
  // Ben's Wednesday moves an hour -> only Ben.
  const moved = { ...week, ben: [week.ben[0], sh("2026-11-25", "08:00", "12:00", false)] };
  const p = planPublish(moved, told);
  assert.deepEqual([p.changed, p.unchanged], [["ben"], ["ana"]]);
  // A task label change counts; a new person counts; someone with no shifts left is told too.
  assert.deepEqual(planPublish({ ana: [sh("2026-11-24", "15:00", "23:00", true, "Fryer")] }, told).changed, ["ana"]);
  const q = planPublish({ ana: week.ana, cy: [sh("2026-11-26", "17:00", "22:30", false)] }, told);
  assert.deepEqual([q.changed, q.unchanged, q.cleared], [["cy"], ["ana"], ["ben"]]);
});

test("a week published before tracking existed: only people with an un-published shift are messaged", () => {
  const week = { ana: [sh("2026-11-24", "15:00", "23:00")], ben: [sh("2026-11-24", "07:00", "12:00"), sh("2026-11-25", "08:00", "12:00", false)] };
  const p = planPublish(week, {});
  assert.deepEqual([p.changed, p.unchanged], [["ben"], ["ana"]]);
});
