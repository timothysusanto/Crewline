"use strict";

/**
 * trainingHandler.js — Multilingual micro-training over WhatsApp
 * (Hospitality Edition, Core OS Phase 3).
 *
 *   Worker: train           → module list + languages
 *   Worker: train 1 ne      → three lessons arrive in Nepali, then the quiz
 *   Worker: a / b / c       → answers; pass mark 2 of 3
 *   Bot:    🎓 Passed — recorded in your wallet.
 *
 * Completions land in tenants/{t}/trainingRecords and surface in the
 * worker's credential wallet ("wallet" command and the /roster wallet view
 * read the same store via the API).
 *
 * KNOWN LIMITATION: quiz state is in-memory (same trade-off as the wallet
 * drafts) — a redeploy mid-quiz means retaking three questions.
 */

const { sendText, sendButtons } = require("./whatsapp");
const { getFirestoreDb } = require("./firebase");
const { MODULES, LANGS } = require("./trainingContent");

/**
 * Accredited course catalog — the RTO connection is a loop, not an API:
 * gap → enrol link → worker completes the external course → photographs the
 * certificate into WhatsApp → wallet → roster guard lifts. Links live in
 * tenants/{t}/settings/training so affiliate/partner URLs can be swapped in
 * without a deploy. Defaults point at official directories, not providers.
 */
const DEFAULT_COURSES = [
  { id: "rsa",   label: "RSA / RCG (accredited)",            credentialType: "rsa",
    url: "https://www.liquorandgaming.nsw.gov.au", note: "NSW requires an approved provider — interstate online RSAs are not valid in NSW." },
  { id: "fss",   label: "Food Safety Supervisor (accredited)", credentialType: "fss",
    url: "https://www.foodauthority.nsw.gov.au",  note: "Must be an approved FSS provider; cert renews 5-yearly." },
  { id: "white", label: "White Card (construction)",          credentialType: "white_card",
    url: "https://www.safework.nsw.gov.au",       note: "Delivery rules vary by state." },
  { id: "firstaid", label: "First aid (HLTAID011)",           credentialType: "first_aid",
    url: "https://www.allenstraining.com.au",     note: "" },
];

async function getCourses(tenantId) {
  const db = getFirestoreDb();
  const ref = db.collection("tenants").doc(tenantId).collection("settings").doc("training");
  const doc = await ref.get();
  if (!doc.exists) { await ref.set({ courses: DEFAULT_COURSES, requiredCredentials: [] }); return DEFAULT_COURSES; }
  return doc.data().courses || DEFAULT_COURSES;
}

const QUIZ_TTL_MS = 30 * 60 * 1000;
/** @type {Map<string, object>} phone → active quiz */
const quizzes = new Map();

async function handleEnrolCommand(from, staff, body, tenantId, deps, sendOpts) {
  const db = getFirestoreDb();
  if (!db) { await sendText(from, "Course enrolment isn't switched on yet — ask your manager.", sendOpts); return; }
  const courses = await getCourses(tenantId);
  const arg = body.replace(/^enrol\s*/, "").trim();
  if (arg) {
    const c = courses.find((x) => x.id === arg || x.label.toLowerCase().includes(arg));
    if (!c) { await sendText(from, `Couldn't find that course. Tap More, then Courses for the list.`, sendOpts); return; }
    await sendText(from,
      `🎓 *${c.label}*\n${c.url}${c.note ? "\n⚠ " + c.note : ""}\n\n` +
      `When you finish, send me a photo of the certificate and it goes straight into your wallet — your manager sees it and your roster status updates.`, sendOpts);
    return;
  }
  const lines = courses.map((c) => `• ${c.label}`);
  await sendButtons(from, `🎓 Accredited courses:\n${lines.join("\n")}\n\nTap one for the link. These are external certified courses — the certificate lands in your wallet when you photo it to me.`,
    courses.map((c) => [{ text: c.label.slice(0, 40), data: `m:enrol ${c.id}` }]), sendOpts);
}

async function handleTrainCommand(from, staff, body, tenantId, deps, sendOpts) {
  const db = getFirestoreDb();
  if (!db) { await sendText(from, "Training isn't switched on yet — ask your manager.", sendOpts); return; }

  const m = body.match(/^train\s+(\d+)\s*([a-z]{2})?$/);
  if (!m) {
    const mods = Object.values(MODULES);
    const list = mods.map((mod) => `${mod.id}. ${mod.title.en}`).join("\n");
    // One row per module: tap the language to start.
    const rows = mods.map((mod) => [
      { text: `${mod.id} · English`, data: `m:train ${mod.id} en` },
      { text: `${mod.id} · ${LANGS.ne}`, data: `m:train ${mod.id} ne` },
      { text: `${mod.id} · ${LANGS.zh}`, data: `m:train ${mod.id} zh` },
    ]);
    await sendButtons(from, `🎓 Training modules:\n${list}\n\nTap a language to start.`, rows, sendOpts);
    return;
  }

  const mod = MODULES[parseInt(m[1], 10)];
  const lang = m[2] && mod && mod.lessons[m[2]] ? m[2] : "en";
  if (!mod) { await sendText(from, `No module ${m[1]} yet. Tap More, then Training for the list.`, sendOpts); return; }

  // Lessons — one message each, then question 1.
  for (const lesson of mod.lessons[lang]) await sendText(from, lesson, sendOpts);
  quizzes.set(from, { moduleId: mod.id, lang, qIdx: 0, correct: 0, startedAt: Date.now(), byName: staff.name });
  await sendQuestion(from, mod, lang, 0, sendOpts);
}

async function sendQuestion(from, mod, lang, qIdx, sendOpts) {
  const q = mod.quiz[lang][qIdx];
  await sendButtons(from,
    `❓ ${qIdx + 1}/${mod.quiz[lang].length}: ${q.q}\n\na) ${q.a}\nb) ${q.b}\nc) ${q.c}`,
    [[{ text: "A", data: "a" }, { text: "B", data: "b" }, { text: "C", data: "c" }], [{ text: "Stop", data: "stop" }]], sendOpts);
}

/** Returns true when the message belonged to an active quiz. */
async function handleTrainingReply(from, staff, body, tenantId, deps, sendOpts) {
  const quiz = quizzes.get(from);
  if (!quiz) return false;
  if (Date.now() - quiz.startedAt > QUIZ_TTL_MS) { quizzes.delete(from); return false; }

  if (body === "stop" || body === "cancel") {
    quizzes.delete(from);
    await sendText(from, `Training stopped. Tap More, then Training to start again.`, sendOpts);
    return true;
  }
  const ans = body.trim().toLowerCase().replace(/[).]/g, "");
  if (!["a", "b", "c"].includes(ans)) {
    await sendText(from, "Tap A, B or C under the question (or Stop).", sendOpts);
    return true;
  }

  const mod = MODULES[quiz.moduleId];
  const questions = mod.quiz[quiz.lang];
  const q = questions[quiz.qIdx];
  const right = ans === q.correct;
  if (right) quiz.correct++;

  quiz.qIdx++;
  if (quiz.qIdx < questions.length) {
    await sendText(from, right ? "✅ Correct." : `❌ Not quite — the answer was ${q.correct}) ${q[q.correct]}.`, sendOpts);
    await sendQuestion(from, mod, quiz.lang, quiz.qIdx, sendOpts);
    return true;
  }

  // Finished
  quizzes.delete(from);
  const passed = quiz.correct >= mod.passMark;
  const db = getFirestoreDb();
  await db.collection("tenants").doc(tenantId).collection("trainingRecords").add({
    workerId: staff.id || null, workerPhone: from, workerName: staff.name || null,
    moduleId: mod.id, moduleTitle: mod.title.en, lang: quiz.lang,
    score: quiz.correct, outOf: questions.length, passed,
    completedAt: new Date().toISOString(),
  });
  await sendText(from, passed
    ? `🎓 *${mod.title[quiz.lang]}* — passed, ${quiz.correct}/${questions.length}. Recorded against your name — your manager can see it. Nice work, ${firstName(staff.name)}.`
    : `You scored ${quiz.correct}/${questions.length} — pass mark is ${mod.passMark}. Read the lessons again and retake any time: "train ${mod.id} ${quiz.lang}".`, sendOpts);
  return true;
}

function firstName(n) { return (n || "chef").split(" ")[0]; }

module.exports = { handleTrainCommand, handleTrainingReply, handleEnrolCommand, getCourses, DEFAULT_COURSES };
