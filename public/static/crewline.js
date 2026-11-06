/* =====================================================================
   Crewline — shared page runtime for the manager pages.
   Key handling, API calls, the login gate, tab bar, bottom sheets, toast,
   formatting, and the one crew form every page uses.
   ===================================================================== */
(function () {
  const KEY_NAME = "crewline_key";
  const legacy = ["hos_dashboard_key", "dwos_key"];
  let key = new URLSearchParams(location.search).get("key") || "";
  try {
    if (!key) key = localStorage.getItem(KEY_NAME) || legacy.map((k) => localStorage.getItem(k)).find(Boolean) || "";
    if (key) localStorage.setItem(KEY_NAME, key);
  } catch { /* private mode: the key lives in the URL only */ }

  const CL = {
    key: () => key,
    setKey(k) { key = k; try { localStorage.setItem(KEY_NAME, k); } catch {} },
    venue: null,

    /** fetch wrapper: JSON in/out, key header, friendly errors. 401 → gate. */
    async api(path, opts = {}) {
      const res = await fetch(path, {
        method: opts.method || "GET",
        headers: { "X-Dashboard-Key": key, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 401) { CL.showGate("That key doesn't open the pass — check it and try again."); throw Object.assign(new Error("unauthorised"), { status: 401 }); }
      const text = await res.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status, body: json });
      return json;
    },
    /** URL with the key for downloads. */
    url(path) { return path + (path.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(key); },

    // ---------- gate ----------
    showGate(msg) {
      let g = document.getElementById("cl-gate");
      if (!g) {
        g = document.createElement("div");
        g.id = "cl-gate"; g.className = "gate";
        g.innerHTML = `<div class="mark">Crew<b>line</b></div><p>Manager key to open the pass.</p>
          <label class="field"><input id="cl-key" type="password" placeholder="Manager key" autocomplete="current-password" autocapitalize="off"></label>
          <button class="btn primary" id="cl-key-go">Open</button><p class="err" id="cl-key-err"></p>`;
        document.body.prepend(g);
        const go = () => { const v = g.querySelector("#cl-key").value.trim(); if (!v) return; CL.setKey(v); g.remove(); document.querySelectorAll(".cl-app").forEach((el) => (el.style.display = "")); if (CL.onKey) CL.onKey(); };
        g.querySelector("#cl-key-go").onclick = go;
        g.querySelector("#cl-key").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      }
      g.querySelector("#cl-key-err").textContent = msg || "";
      document.querySelectorAll(".cl-app").forEach((el) => (el.style.display = "none"));
      setTimeout(() => g.querySelector("#cl-key").focus(), 50);
    },
    /** Call once a page has booted: hides the app until a key is present. */
    requireKey(onKey) {
      CL.onKey = onKey;
      if (!key) { CL.showGate(""); return false; }
      onKey();
      return true;
    },
    async venueName() {
      if (CL.venue) return CL.venue;
      try { const me = await CL.api("/api/me"); CL.venue = me; return me; } catch { return null; }
    },

    // ---------- chrome ----------
    tabbar(active) {
      const tabs = [
        ["today", "/dashboard", "Today", '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'],
        ["roster", "/roster", "Roster", '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
        ["pay", "/pay", "Pay", '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>'],
        ["diary", "/foodsafety", "Diary", '<path d="M14 4v9a3 3 0 1 1-4 0V4a2 2 0 1 1 4 0z"/><path d="M12 10v6"/>'],
        ["more", "/more", "More", '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'],
      ];
      const el = document.createElement("div");
      el.className = "tabbar";
      el.innerHTML = `<nav>${tabs.map(([id, href, label, icon]) =>
        `<a href="${CL.url(href)}" class="${id === active ? "on" : ""}" id="tab-${id}"><svg viewBox="0 0 24 24">${icon}</svg><span class="dot"></span>${label}</a>`).join("")}</nav>`;
      document.body.appendChild(el);
    },
    topbar() {
      const tb = document.querySelector(".topbar");
      if (!tb) return;
      let last = false;
      const onScroll = () => { const c = window.scrollY > 36; if (c !== last) { last = c; tb.classList.toggle("compact", c); } };
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    },

    // ---------- sheets ----------
    sheet(id) {
      const el = document.getElementById(id);
      let bg = document.getElementById("cl-sheet-bg");
      if (!bg) { bg = document.createElement("div"); bg.id = "cl-sheet-bg"; bg.className = "sheet-bg"; document.body.appendChild(bg); bg.onclick = () => CL.closeSheets(); }
      return {
        open() { CL.closeSheets(); bg.classList.add("open"); el.classList.add("open"); document.body.style.overflow = "hidden"; const f = el.querySelector("input,select,textarea"); if (f && !("ontouchstart" in window)) setTimeout(() => f.focus(), 120); },
        close() { el.classList.remove("open"); bg.classList.remove("open"); document.body.style.overflow = ""; },
      };
    },
    closeSheets() { document.querySelectorAll(".sheet.open").forEach((s) => s.classList.remove("open")); const bg = document.getElementById("cl-sheet-bg"); if (bg) bg.classList.remove("open"); document.body.style.overflow = ""; },
    /** Build a sheet element: { id, title, body (html), foot (html) } */
    makeSheet({ id, title, body, foot }) {
      let el = document.getElementById(id);
      if (!el) { el = document.createElement("div"); el.id = id; el.className = "sheet"; document.body.appendChild(el); }
      el.innerHTML = `<div class="handle"></div><div class="head"><h3>${title}</h3><button class="x" aria-label="Close" type="button">✕</button></div><div class="body">${body}</div>${foot ? `<div class="foot">${foot}</div>` : ""}`;
      el.querySelector(".x").onclick = () => CL.closeSheets();
      return el;
    },

    toast(msg, ms = 3000) {
      let t = document.getElementById("cl-toast");
      if (!t) { t = document.createElement("div"); t.id = "cl-toast"; t.className = "toast"; document.body.appendChild(t); }
      t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
    },
    confirm(msg) { return window.confirm(msg); },

    // ---------- formatting ----------
    esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },
    money(n, dec = 0) { if (n == null || isNaN(n)) return "—"; const neg = n < 0; const s = Math.abs(n).toLocaleString("en-AU", { minimumFractionDigits: dec, maximumFractionDigits: dec }); return (neg ? "−$" : "$") + s; },
    hrs(n) { return n == null ? "—" : (Math.round(n * 10) / 10).toFixed(1) + "h"; },
    pct(n) { return n == null ? "—" : (Math.round(n * 10) / 10) + "%"; },
    day(d) { return new Date(d + "T12:00:00").toLocaleDateString("en-AU", { weekday: "short" }); },
    dayNum(d) { return new Date(d + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" }); },
    dayLong(d) { return new Date(d + "T12:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }); },
    range(a, b) { const A = new Date(a + "T12:00:00"), B = new Date(b + "T12:00:00"); const sameM = A.getMonth() === B.getMonth(); return `${A.getDate()}${sameM ? "" : " " + A.toLocaleDateString("en-AU", { month: "short" })} – ${B.getDate()} ${B.toLocaleDateString("en-AU", { month: "short" })}`; },
    clock(iso) { return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" }); },
    dur(ms) { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; },
    today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; },
    addDays(ds, n) { const d = new Date(ds + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; },
    mondayOf(ds) { const d = new Date(ds + "T12:00:00"); const back = (d.getDay() + 6) % 7; return CL.addDays(ds, -back); },
    initials(name) { return String(name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase(); },

    // ---------- the crew form (one form, every page) ----------
    _awards: null,
    async awards() {
      if (CL._awards) return CL._awards;
      try { CL._awards = (await CL.api("/api/core/awards")).awards; } catch {
        CL._awards = [{ code: "MA000009", name: "Hospitality Industry (General) Award 2020 (HIGA)", levels: [
          { key: "INTRO", label: "Introductory", base: 25.85 }, { key: "L1", label: "Level 1 — F&B/Kitchen Att.", base: 26.44 }, { key: "L2", label: "Level 2 — Cook Gr1/HK", base: 26.95 },
          { key: "L3", label: "Level 3 — Cook Gr2/Senior", base: 27.34 }, { key: "L4", label: "Level 4 — Cook Gr3 (trade)", base: 28.80 }, { key: "L5", label: "Level 5 — Cook Gr4/Sup.", base: 30.61 }, { key: "L6", label: "Level 6 — Cook Gr5", base: 31.41 }] }];
      }
      return CL._awards;
    },
    /**
     * Opens the crew sheet. worker = null to add. onSaved(result) after save.
     * Saves through /api/core/workers (POST / PUT). Deactivate through PUT active:false.
     */
    async crewSheet(worker, onSaved) {
      const awards = await CL.awards();
      const w = worker || {};
      const et = w.employmentType || "casual";
      const kind = et === "fulltime" && w.payType === "salary" ? "salary" : et;
      const el = CL.makeSheet({
        id: "cl-crew-sheet",
        title: worker ? `Edit — ${CL.esc(w.name)}` : "Add crew member",
        body: `
          <label class="field"><span class="lbl">Name</span><input id="cw-name" type="text" value="${CL.esc(w.name || "")}" autocapitalize="words"></label>
          <label class="field"><span class="lbl">Mobile (the number they use on Telegram)</span>
            <input id="cw-phone" type="tel" inputmode="tel" placeholder="614XXXXXXXX — no + or spaces" value="${CL.esc(w.phone || w.id || "")}" ${worker ? "readonly" : ""}>
            ${worker ? '<div class="help">The number is the record — add a new person to change it.</div>' : ""}
          </label>
          <div class="field"><span class="lbl">Department</span>
            <div class="seg" id="cw-dept"><button type="button" data-v="kitchen">Kitchen</button><button type="button" data-v="service">Service</button></div>
            <div class="help">Kitchen counts against the kitchen payroll %; service makes up the rest of the total.</div>
          </div>
          <div class="field"><span class="lbl">Employment</span>
            <div class="seg" id="cw-kind"><button type="button" data-v="casual">Casual</button><button type="button" data-v="parttime">Part-time</button><button type="button" data-v="fulltime">Full-time</button><button type="button" data-v="salary">Salaried</button></div>
          </div>
          <div class="frow">
            <label class="field"><span class="lbl">Award level</span><select id="cw-level"></select></label>
            <label class="field" id="cw-rate-wrap"><span class="lbl">Hourly rate $</span><input id="cw-rate" type="number" inputmode="decimal" step="0.01" min="0" placeholder="award"><div class="help" id="cw-rate-help"></div></label>
          </div>
          <label class="field" id="cw-salary-wrap" style="display:none"><span class="lbl">Annual salary $ (before super)</span><input id="cw-salary" type="number" inputmode="numeric" step="100" min="0" placeholder="e.g. 78000" value="${w.annualSalary || ""}"><div class="help" id="cw-salary-help">Costed at salary ÷ 52 each week, spread over the days rostered.</div></label>
          <label class="field"><span class="lbl">Access</span>
            <select id="cw-role"><option value="staff">Staff</option><option value="manager">Manager — gets swap requests, can open the dashboard</option><option value="owner">Owner</option></select>
          </label>
          <p class="err" id="cw-err"></p>`,
        foot: `${worker ? '<button class="btn danger" id="cw-deact" type="button">Deactivate</button>' : ""}<button class="btn primary" id="cw-save" type="button">Save</button>`,
      });
      const $ = (id) => el.querySelector("#" + id);
      const award = awards.find((a) => a.code === (w.awardCode || "MA000009")) || awards[0];
      $("cw-level").innerHTML = award.levels.map((l) => `<option value="${l.key}" ${l.key === (w.level || "L1") ? "selected" : ""}>${CL.esc(l.label)} · $${l.base.toFixed(2)}</option>`).join("");
      $("cw-role").value = w.role || "staff";
      $("cw-rate").value = w.hourlyRate != null ? w.hourlyRate : (w.wageRate != null ? w.wageRate : "");
      const segSet = (segId, v) => el.querySelectorAll(`#${segId} button`).forEach((b) => b.classList.toggle("on", b.dataset.v === v));
      const segGet = (segId) => (el.querySelector(`#${segId} button.on`) || {}).dataset?.v || null;
      segSet("cw-dept", w.department || "kitchen"); segSet("cw-kind", kind);
      const refresh = () => {
        const k = segGet("cw-kind");
        $("cw-salary-wrap").style.display = k === "salary" ? "" : "none";
        $("cw-rate-wrap").style.display = k === "salary" ? "none" : "";
        const lvl = award.levels.find((l) => l.key === $("cw-level").value);
        const base = lvl ? lvl.base : 0;
        const casual = k === "casual";
        $("cw-rate").placeholder = (casual ? base * 1.25 : base).toFixed(2);
        $("cw-rate-help").textContent = casual ? `Award min. $${base.toFixed(2)} + 25% casual loading = $${(base * 1.25).toFixed(2)}. Leave blank to use the award.` : `Award min. $${base.toFixed(2)}. Leave blank to use the award, or enter what you pay.`;
      };
      el.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => { segSet(b.parentElement.id, b.dataset.v); refresh(); }));
      $("cw-level").addEventListener("change", refresh);
      refresh();
      const s = CL.sheet("cl-crew-sheet"); s.open();

      $("cw-save").onclick = async () => {
        const k = segGet("cw-kind");
        const body = {
          name: $("cw-name").value.trim(),
          phone: $("cw-phone").value.replace(/\D/g, ""),
          role: $("cw-role").value,
          department: segGet("cw-dept"),
          employmentType: k === "salary" ? "fulltime" : k,
          payType: k === "salary" ? "salary" : "hourly",
          awardCode: award.code, level: $("cw-level").value,
          hourlyRate: k === "salary" ? null : ($("cw-rate").value === "" ? null : Number($("cw-rate").value)),
          annualSalary: k === "salary" ? ($("cw-salary").value === "" ? null : Number($("cw-salary").value)) : null,
        };
        if (!body.name || !body.phone) { $("cw-err").textContent = "Name and mobile are both needed."; return; }
        if (k === "salary" && !body.annualSalary) { $("cw-err").textContent = "Enter the annual salary so the week can be costed."; return; }
        $("cw-save").disabled = true;
        try {
          if (worker) { delete body.phone; await CL.api(`/api/core/workers/${encodeURIComponent(w.id || w.phone)}`, { method: "PUT", body }); }
          else await CL.api("/api/core/workers", { method: "POST", body });
          s.close(); CL.toast(worker ? "Saved" : "Added — ask them to message the bot and share their number");
          if (onSaved) onSaved();
        } catch (e) { $("cw-err").textContent = e.message; }
        $("cw-save").disabled = false;
      };
      if (worker) $("cw-deact").onclick = async () => {
        if (!CL.confirm(`Deactivate ${w.name}? They stay in past records but leave the roster and the pay page.`)) return;
        try { await CL.api(`/api/core/workers/${encodeURIComponent(w.id || w.phone)}`, { method: "PUT", body: { active: false } }); s.close(); CL.toast("Deactivated"); if (onSaved) onSaved(); }
        catch (e) { $("cw-err").textContent = e.message; }
      };
    },
  };
  window.CL = CL;
})();
