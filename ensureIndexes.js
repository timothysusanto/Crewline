"use strict";

/**
 * Creates the Firestore composite indexes in firestore.indexes.json on boot,
 * so nobody has to click links in the Firebase console. Idempotent: existing
 * indexes are skipped, and an index that is still building is left alone.
 *
 * Uses the same service account firebase-admin runs on
 * (FIREBASE_SERVICE_ACCOUNT_JSON). It needs the datastore.indexes.create
 * permission — the default Firebase Admin SDK service account has it. If it
 * doesn't, the log says so and gives the console link instead of crashing.
 *
 * Firestore Admin API: https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.collectionGroups.indexes
 */

const path = require("path");

const SCOPES = ["https://www.googleapis.com/auth/datastore"];

function sameIndex(a, b) {
  if ((a.queryScope || "COLLECTION") !== (b.queryScope || "COLLECTION")) return false;
  const fa = (a.fields || []).filter((f) => f.fieldPath !== "__name__");
  const fb = (b.fields || []).filter((f) => f.fieldPath !== "__name__");
  if (fa.length !== fb.length) return false;
  return fa.every((f, i) => f.fieldPath === fb[i].fieldPath && (f.order || f.arrayConfig) === (fb[i].order || fb[i].arrayConfig));
}

/**
 * @param {object} opts
 * @param {object} opts.serviceAccount  parsed FIREBASE_SERVICE_ACCOUNT_JSON
 * @param {string} [opts.indexesFile]   defaults to ./firestore.indexes.json
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => Promise<string>} [opts.getToken]  test hook
 * @returns {Promise<{created: string[], existing: string[], failed: string[]}>}
 */
async function ensureIndexes({ serviceAccount, indexesFile, fetchImpl = fetch, getToken } = {}) {
  const result = { created: [], existing: [], failed: [] };
  if (!serviceAccount || !serviceAccount.project_id) return result;

  const spec = require(indexesFile || path.join(__dirname, "firestore.indexes.json"));
  const wanted = spec.indexes || [];
  if (!wanted.length) return result;

  let token;
  try {
    if (getToken) token = await getToken();
    else {
      const { GoogleAuth } = require("google-auth-library");
      const auth = new GoogleAuth({ credentials: serviceAccount, scopes: SCOPES });
      token = await (await auth.getClient()).getAccessToken().then((t) => t.token || t);
    }
  } catch (err) {
    console.error("[indexes] couldn't get a Google access token:", err.message);
    return result;
  }

  const base = `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}/databases/(default)/collectionGroups`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const label = (ix) => `${ix.collectionGroup}(${(ix.fields || []).map((f) => `${f.fieldPath} ${f.order || f.arrayConfig}`).join(", ")})`;

  // One list call per collection group, then diff.
  const groups = [...new Set(wanted.map((ix) => ix.collectionGroup))];
  const existingByGroup = {};
  for (const g of groups) {
    try {
      const res = await fetchImpl(`${base}/${g}/indexes`, { headers });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`[indexes] list failed for ${g}:`, res.status, JSON.stringify(json.error || json).slice(0, 300));
        if (res.status === 403) {
          console.error("[indexes] the service account can't manage indexes. Grant it 'Cloud Datastore Index Admin' in IAM, or create them once at " +
            `https://console.firebase.google.com/project/${serviceAccount.project_id}/firestore/indexes`);
          return result;
        }
      }
      existingByGroup[g] = json.indexes || [];
    } catch (err) {
      console.error(`[indexes] list error for ${g}:`, err.message);
      existingByGroup[g] = null;
    }
  }

  for (const ix of wanted) {
    const existing = existingByGroup[ix.collectionGroup];
    if (existing === null) { result.failed.push(label(ix)); continue; }
    if (existing.some((e) => sameIndex(e, ix))) { result.existing.push(label(ix)); continue; }
    try {
      const res = await fetchImpl(`${base}/${ix.collectionGroup}/indexes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ queryScope: ix.queryScope || "COLLECTION", fields: ix.fields }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok || res.status === 409) {
        result.created.push(label(ix));
        console.log(`[indexes] creating ${label(ix)} — Firestore builds it in the background (a few minutes)`);
      } else {
        result.failed.push(label(ix));
        console.error(`[indexes] create failed for ${label(ix)}:`, res.status, JSON.stringify(json.error || json).slice(0, 300));
        if (res.status === 403) {
          console.error(`[indexes] grant ${serviceAccount.client_email} the role "Cloud Datastore Index Admin" at ` +
            `https://console.cloud.google.com/iam-admin/iam?project=${serviceAccount.project_id} — the server retries every 30 min.`);
        }
      }
    } catch (err) {
      result.failed.push(label(ix));
      console.error(`[indexes] create error for ${label(ix)}:`, err.message);
    }
  }

  if (result.existing.length && !result.created.length && !result.failed.length) {
    console.log(`[indexes] all ${result.existing.length} composite indexes present`);
  }
  return result;
}

module.exports = { ensureIndexes, sameIndex };
