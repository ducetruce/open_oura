// Yalla Masri — core: state, storage + cloud sync, speech, DOM helpers,
// the quiz runner and the on-screen Arabic keyboard.
(function () {
  const APP = (window.APP = {});
  const E = window.ENGINE;
  const LEVELS = (APP.LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"]);
  APP.LEVEL_NAMES = { A1: "Beginner", A2: "Elementary", B1: "Intermediate", B2: "Upper intermediate", C1: "Advanced", C2: "Mastery" };
  APP.UNITS = window.COURSE;
  APP.UNIT = Object.fromEntries(APP.UNITS.map((u) => [u.id, u]));
  APP.unitsOf = (lv) => APP.UNITS.filter((u) => u.level === lv);
  APP.BANK = Object.fromEntries((window.WORDBANK || []).map((d) => [d.id, d]));
  APP.bankIds = (d) => d.words.map((_, k) => "w:" + d.id + ":" + k);

  // ---------- state ----------
  const KEY = "yalla-masri-v2";
  const blank = () => ({
    v: 2, updatedAt: 0, units: {}, script: {}, srs: {}, custom: [],
    stats: { streak: 0, lastDay: "", today: 0, xp: 0, reviews: 0 },
    placement: null, settings: { franco: "show", rate: 0.85, newPerDay: 15 },
  });
  let S = blank();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) S = merge(blank(), JSON.parse(raw));
  } catch (e) {}
  function merge(base, o) {
    for (const k in o) {
      if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) && base[k] && typeof base[k] === "object") base[k] = merge(base[k], o[k]);
      else base[k] = o[k];
    }
    return base;
  }
  APP.state = () => S;
  APP.replaceState = (n) => { S = merge(blank(), n); saveLocal(); };
  function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  let syncTimer = null;
  APP.save = function () {
    S.updatedAt = Date.now();
    saveLocal();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushRemote, 2500);
  };
  APP.reset = function () { S = blank(); APP.save(); };

  // ---------- cloud sync (db + user capabilities, when the viewer has them) ----------
  let progressDoc = null, syncing = false;
  APP.sync = { status: "local" };
  async function initSync() {
    if (!window.claude || !window.claude.use) return;
    try {
      const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
      if (!db || !user) return;
      const uid = await user.id();
      if (!uid) return;
      progressDoc = db.doc("data/users/" + uid + "/progress");
      const snap = await progressDoc.get();
      if (snap.exists) {
        const remote = snap.data();
        const r = remote && remote.state ? JSON.parse(remote.state) : null;
        if (r && (r.updatedAt || 0) > (S.updatedAt || 0)) { S = merge(blank(), r); saveLocal(); APP.emit("state"); }
        else if ((S.updatedAt || 0) > ((r && r.updatedAt) || 0)) pushRemote();
      } else if (S.updatedAt) pushRemote();
      APP.sync.status = "synced";
      APP.emit("sync");
    } catch (e) { APP.sync.status = "local"; }
  }
  async function pushRemote() {
    if (!progressDoc || syncing) return;
    syncing = true;
    try {
      await progressDoc.set({ state: JSON.stringify(S), updatedAt: S.updatedAt });
      APP.sync.status = "synced";
    } catch (e) {
      APP.sync.status = "local";
    } finally { syncing = false; APP.emit("sync"); }
  }

  // ---------- events ----------
  const handlers = {};
  APP.on = (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); };
  APP.emit = (ev, d) => (handlers[ev] || []).forEach((fn) => { try { fn(d); } catch (e) { console.error(e); } });

  // ---------- stats ----------
  const DAY = 864e5;
  const dayKey = (t) => { const d = new Date(t || Date.now()); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };
  APP.addXP = function (n) {
    const st = S.stats, today = dayKey();
    if (st.lastDay !== today) {
      st.streak = st.lastDay === dayKey(Date.now() - DAY) ? st.streak + 1 : 1;
      st.lastDay = today; st.today = 0;
    }
    st.today += n; st.xp += n;
  };
  APP.streak = () => { const st = S.stats; return st.lastDay === dayKey() || st.lastDay === dayKey(Date.now() - DAY) ? st.streak : 0; };
  APP.todayXP = () => (S.stats.lastDay === dayKey() ? S.stats.today : 0);

  // ---------- units progress ----------
  APP.unitState = (id) => (S.units[id] = S.units[id] || {});
  APP.unitProgress = function (id) {
    const u = S.units[id] || {};
    if (u.done) return 1;
    let p = 0;
    if (u.lesson) p += 0.2; if (u.dialogue) p += 0.15; if (u.words) p += 0.15; if ((u.practice || 0) >= 70) p += 0.2; if ((u.test || 0) >= 80) p += 0.3;
    return Math.min(1, p);
  };
  APP.levelProgress = (lv) => { const us = APP.unitsOf(lv); return us.reduce((a, u) => a + APP.unitProgress(u.id), 0) / us.length; };
  APP.currentLevel = function () {
    for (const lv of LEVELS) if (APP.levelProgress(lv) < 1 && (!S.placement || LEVELS.indexOf(lv) >= LEVELS.indexOf(S.placement))) return lv;
    return "C2";
  };
  APP.nextUnit = function () {
    const start = S.placement ? LEVELS.indexOf(S.placement) : 0;
    for (const u of APP.UNITS) if (LEVELS.indexOf(u.level) >= start && !(S.units[u.id] || {}).done) return u;
    return null;
  };

  // ---------- vocabulary cards + SRS ----------
  // card ids: "<unitId>:<index>" or "c:<index>" (custom words from AI readings)
  APP.card = function (id) {
    if (id.startsWith("w:")) {
      const [, deck, k] = id.split(":"), d = APP.BANK[deck], raw = d && d.words[+k];
      if (!raw) return null;
      const [war, wtr, wen] = raw.split("|");
      return { id, ar: war, tr: wtr, en: wen, note: "", src: "Word bank · " + d.title };
    }
    if (id.startsWith("c:")) { const w = S.custom[+id.slice(2)]; return w ? { id, ar: w.ar, tr: w.tr, en: w.en, note: w.note || "", src: "Your words" } : null; }
    const i = id.lastIndexOf(":"), u = APP.UNIT[id.slice(0, i)];
    const w = u && u.vocab[+id.slice(i + 1)];
    return w ? { id, ar: w[0], tr: w[1], en: w[2], note: w[3] || "", src: u.title, unit: u.id } : null;
  };
  APP.unitCardIds = (u) => u.vocab.map((_, i) => u.id + ":" + i);
  APP.addCards = function (ids) { let n = 0; for (const id of ids) if (!S.srs[id]) { S.srs[id] = [0, 0, 1]; n++; } return n; };
  // srs entry: [box, dueTimestamp, isNew]
  const IVL = [0, 1, 3, 7, 16, 35, 80];
  APP.IVL = IVL;
  APP.srsNext = function (id, g) {
    const s = S.srs[id] || [0, 0, 1];
    let box = s[2] ? 0 : s[0], days;
    if (g === 0) { box = 0; days = 0; }
    else if (g === 1) { box = Math.max(1, box); days = IVL[box] / 2; }
    else if (g === 2) { box = Math.min(6, box + 1); days = IVL[box]; }
    else { box = Math.min(6, box + 2); days = IVL[box] * 1.3; }
    return { box, days, due: Date.now() + days * DAY };
  };
  APP.srsRate = function (id, g) { const n = APP.srsNext(id, g); S.srs[id] = [n.box, n.due, 0]; };
  APP.srsMiss = function (id) { if (S.srs[id]) S.srs[id] = [0, Date.now(), 0]; };
  APP.cardStatus = function (id) { const s = S.srs[id]; if (!s) return "unseen"; if (s[2]) return "new"; return s[0] >= 4 ? "known" : "learning"; };
  APP.dueCards = function () {
    const now = Date.now();
    return Object.keys(S.srs).filter((id) => !S.srs[id][2] && S.srs[id][1] <= now && APP.card(id)).sort((a, b) => S.srs[a][1] - S.srs[b][1]);
  };
  APP.newCards = () => Object.keys(S.srs).filter((id) => S.srs[id][2] && APP.card(id));
  APP.knownCount = () => Object.keys(S.srs).filter((id) => APP.cardStatus(id) === "known").length;
  APP.fmtDays = (d) => (d === 0 ? "now" : d < 1 ? Math.max(1, Math.round(d * 24)) + "h" : Math.round(d) + "d");

  // ---------- speech ----------
  let voice = null;
  APP.tts = "speechSynthesis" in window;
  function pickVoice() {
    if (!APP.tts) return;
    const vs = speechSynthesis.getVoices();
    voice = vs.find((v) => /^ar[-_]EG/i.test(v.lang)) || vs.find((v) => /^ar/i.test(v.lang)) || null;
    APP.voice = voice;
    APP.emit("voice");
  }
  if (APP.tts) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  APP.speak = function (text, onend) {
    if (!APP.tts || !text) { if (onend) onend(); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/\.\.\.|…/g, "").replace(/\s*\/\s*/g, "، "));
      u.lang = voice ? voice.lang : "ar-EG"; if (voice) u.voice = voice;
      u.rate = S.settings.rate || 0.85;
      if (onend) { u.onend = onend; u.onerror = onend; }
      speechSynthesis.speak(u);
    } catch (e) { if (onend) onend(); }
  };
  APP.stopSpeech = () => { try { speechSynthesis.cancel(); } catch (e) {} };

  // ---------- DOM helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("aria-") && v != null) { el.setAttribute(k, String(v)); continue; }
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
    return el;
  }
  APP.h = h;
  APP.ar = (t, cls) => h("span", { class: "ar " + (cls || ""), lang: "ar", dir: "rtl" }, t);
  APP.tr = (t, cls) => h("span", { class: "tr " + (cls || "") }, t);
  APP.auto = (t, cls) => (E.hasArabic(t) ? APP.ar(t, cls) : h("span", { class: cls || "" }, t));
  APP.shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  APP.pick = (a) => a[Math.floor(Math.random() * a.length)];
  const SPK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  APP.speakBtn = function (text, label) {
    const b = h("button", { class: "speak", type: "button", "aria-label": label || "Play audio", title: "Play audio" });
    b.innerHTML = SPK;
    b.hidden = !APP.tts;
    b.addEventListener("click", (e) => { e.stopPropagation(); APP.speak(text); });
    return b;
  };
  APP.toast = function (msg) {
    let t = document.getElementById("toast");
    if (!t) { t = h("div", { id: "toast", role: "status" }); document.body.append(t); }
    t.textContent = msg; t.classList.add("on");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 2600);
  };
  APP.pct = (x) => Math.round(x * 100) + "%";

  // ---------- on-screen Arabic keyboard ----------
  const KB = [
    ["ض", "ص", "ث", "ق", "ف", "غ", "ع", "ه", "خ", "ح", "ج", "د"],
    ["ش", "س", "ي", "ب", "ل", "ا", "ت", "ن", "م", "ك", "ط"],
    ["ذ", "ء", "ؤ", "ر", "ى", "ة", "و", "ز", "ظ", "أ", "إ", "آ", "ئ"],
  ];
  APP.keyboard = function (input) {
    const wrap = h("div", { class: "kb", role: "group", "aria-label": "Arabic keyboard" });
    const ins = (ch) => {
      const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, s) + ch + input.value.slice(e);
      input.focus(); input.setSelectionRange(s + ch.length, s + ch.length);
      input.dispatchEvent(new Event("input"));
    };
    KB.forEach((row) => wrap.append(h("div", { class: "kb-row" }, row.map((k) => h("button", { type: "button", class: "kb-k ar", onclick: () => ins(k) }, k)))));
    wrap.append(h("div", { class: "kb-row" },
      h("button", { type: "button", class: "kb-k wide", onclick: () => ins(" ") }, "space"),
      h("button", { type: "button", class: "kb-k wide", onclick: () => {
        const s = input.selectionStart ?? input.value.length;
        if (s > 0) { input.value = input.value.slice(0, s - 1) + input.value.slice(s); input.focus(); input.setSelectionRange(s - 1, s - 1); }
      } }, "⌫ delete")));
    return wrap;
  };

  // ---------- AI (sample capability) ----------
  APP.ai = null; // the sample function, when the viewer offers it
  APP.aiState = "checking"; // checking | ready | off
  async function initAI() {
    if (!window.claude || !window.claude.use) { APP.aiState = "off"; APP.emit("ai"); return; }
    try {
      const s = await window.claude.use("sample");
      APP.ai = s || null; APP.aiState = s ? "ready" : "off";
    } catch (e) { APP.aiState = "off"; }
    APP.emit("ai");
  }
  APP.aiError = function (e) {
    const c = e && e.code;
    if (["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"].includes(c)) {
      APP.aiState = "off"; APP.emit("ai");
      return "The AI tutor isn't available in this view (permission was declined or Claude isn't enabled for this account).";
    }
    if (c === "rate_limited") return "Too many requests right now. Wait a minute and try again.";
    if (c === "session_expired") return "Your session expired. Sign in again to use the tutor.";
    if (c === "refused") return "The tutor declined that request. Try rephrasing it.";
    if (c === "invalid_json") return "The tutor's answer came back in the wrong format. Try again.";
    if (c === "cancelled") return "";
    return "Something went wrong reaching the tutor. Try again.";
  };

  // ---------- quiz runner ----------
  // Question kinds:
  //  mc:    {kind, label, prompt:{text?, ar?, tr?, en?, speak?}, options:[{text?, ar?, tr?}], answer, explain?, card?}
  //  type:  {kind, label, prompt, expect:{ar, tr}, explain?, card?, digits?}
  //  order: {kind, label, ar, tr, en}
  APP.runQuiz = function (root, questions, opts) {
    opts = opts || {};
    let i = 0, score = 0, answered = false;
    const missed = [];
    root.replaceChildren();
    const head = h("div", { class: "qz-head" });
    const bar = h("div", { class: "pbar" }, h("i", {}));
    const body = h("div", { class: "qz-body" });
    const foot = h("div", { class: "qz-foot" });
    root.append(head, bar, body, foot);
    let keyHandler = null;
    const cleanup = () => { if (keyHandler) document.removeEventListener("keydown", keyHandler); };
    root._cleanup = cleanup;

    function showPrompt(p, reveal) {
      const box = h("div", { class: "qz-prompt" });
      if (p.label) box.append(h("div", { class: "label" }, p.label));
      if (p.ar) {
        const row = h("div", { class: "row center" }, APP.ar(p.ar, "q-ar"));
        if (p.speak !== false) row.append(APP.speakBtn(p.speakText || p.ar));
        box.append(row);
        if (p.tr && (S.settings.franco === "show" || reveal)) box.append(APP.tr(p.tr, "q-tr"));
      } else if (p.listen) {
        const b = h("button", { class: "btn primary big-listen", type: "button", onclick: () => APP.speak(p.listen) }, "▶ Play again");
        box.append(b);
        setTimeout(() => APP.speak(p.listen), 250);
      }
      if (p.text) box.append(h("div", { class: "q-text" }, APP.auto(p.text)));
      if (p.en) box.append(h("div", { class: "q-en" }, p.en));
      return box;
    }
    function optLabel(o, reveal) {
      const wrap = h("span", { class: "opt-l" });
      if (o.ar) { wrap.append(APP.ar(o.ar)); if (o.tr && (S.settings.franco === "show" || reveal)) wrap.append(APP.tr(o.tr)); }
      else wrap.append(APP.auto(o.text));
      return wrap;
    }

    function render() {
      answered = false;
      keyHandler = null;
      const q = questions[i];
      head.replaceChildren(h("span", { class: "label" }, (opts.title || "Practice") + " · " + (i + 1) + " / " + questions.length), h("span", { class: "label" }, "Score " + score));
      bar.firstChild.style.width = (i / questions.length) * 100 + "%";
      body.replaceChildren();
      foot.replaceChildren();
      if (q.kind === "mc") renderMC(q);
      else if (q.kind === "type") renderType(q);
      else if (q.kind === "order") renderOrder(q);
    }

    function renderMC(q) {
      body.append(showPrompt(Object.assign({ label: q.label }, q.prompt)));
      const grid = h("div", { class: "opts" });
      q.options.forEach((o, k) => {
        const b = h("button", { class: "opt", type: "button", onclick: () => choose(k) }, h("kbd", {}, k + 1), optLabel(o));
        grid.append(b);
      });
      body.append(grid);
      function choose(k) {
        if (answered) return;
        const ok = k === q.answer;
        [...grid.children].forEach((b, j) => {
          b.disabled = true;
          if (j === q.answer) b.classList.add("right"); else if (j === k) b.classList.add("wrong");
          b.replaceChild(optLabel(q.options[j], true), b.lastChild);
        });
        const right = q.options[q.answer];
        finish(ok, q, right.ar ? { ar: right.ar, tr: right.tr } : { text: right.text });
      }
      keyHandler = (e) => { if (!answered && /^[1-9]$/.test(e.key) && +e.key <= q.options.length && !e.target.matches("input,textarea")) choose(+e.key - 1); };
    }

    function renderType(q) {
      body.append(showPrompt(Object.assign({ label: q.label }, q.prompt)));
      const inp = h("input", { type: "text", class: "type-in", id: "type-answer", autocomplete: "off", autocapitalize: "off", spellcheck: "false", dir: "auto",
        placeholder: q.digits ? "Type the number in digits" : "Type in Arabic script or Franco (e.g. 3aayiz)", "aria-label": "Your answer" });
      const kbBtn = h("button", { type: "button", class: "btn ghost small", onclick: () => { kbWrap.hidden = !kbWrap.hidden; kbBtn.textContent = kbWrap.hidden ? "Arabic keyboard" : "Hide keyboard"; } }, "Arabic keyboard");
      const kbWrap = APP.keyboard(inp); kbWrap.hidden = true;
      const check = h("button", { class: "btn primary", type: "button", onclick: submit }, "Check");
      const skip = h("button", { class: "btn ghost", type: "button", onclick: () => submit(true) }, "I don't know");
      body.append(inp, q.digits ? null : h("div", { class: "row" }, kbBtn), kbWrap);
      foot.append(skip, check);
      setTimeout(() => inp.focus(), 50);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !answered) { e.preventDefault(); e.stopPropagation(); submit(); } });
      function submit(gaveUp) {
        if (answered) return;
        const v = inp.value;
        let ok = false;
        if (gaveUp !== true) ok = q.digits ? String(parseInt(v.replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)), 10)) === String(q.expect.num) : E.check(v, q.expect);
        inp.disabled = true; kbWrap.hidden = true;
        inp.classList.add(ok ? "ok" : "bad");
        finish(ok, q, q.digits ? { text: String(q.expect.num), ar: q.expect.ar, tr: q.expect.tr } : { ar: q.expect.ar, tr: q.expect.tr }, v);
      }
    }

    function renderOrder(q) {
      const toks = q.ar.split(" ");
      const trToks = q.tr.split(" ");
      const paired = toks.length === trToks.length;
      body.append(showPrompt({ label: q.label || "Build the sentence", en: q.en }));
      const line = h("div", { class: "tiles line", dir: "rtl", "aria-label": "Your sentence" });
      const pool = h("div", { class: "tiles pool", dir: "rtl" });
      const order = APP.shuffle(toks.map((t, k) => k));
      const mk = (k) => h("button", { type: "button", class: "tile", "data-k": k, onclick: (e) => move(e.currentTarget) },
        APP.ar(toks[k]), paired && S.settings.franco === "show" ? h("small", { class: "tr" }, trToks[k]) : null);
      order.forEach((k) => pool.append(mk(k)));
      function move(b) { if (answered) return; (b.parentNode === pool ? line : pool).append(b); }
      body.append(line, pool);
      const check = h("button", { class: "btn primary", type: "button", onclick: submit }, "Check");
      foot.append(h("button", { class: "btn ghost", type: "button", onclick: () => { [...line.children].forEach((b) => pool.append(b)); } }, "Clear"), check);
      function submit() {
        if (answered) return;
        const got = [...line.children].map((b) => toks[+b.dataset.k]).join(" ");
        const ok = E.normAr(got) === E.normAr(q.ar);
        line.classList.add(ok ? "ok" : "bad");
        finish(ok, q, { ar: q.ar, tr: q.tr });
      }
    }

    function finish(ok, q, right, given) {
      answered = true;
      if (ok) score++;
      else { missed.push(q); if (q.card) APP.srsMiss(q.card); }
      if (q.card && ok && opts.srs !== false && S.srs[q.card] && S.srs[q.card][2]) { /* stays new until reviewed */ }
      const fb = h("div", { class: "feedback " + (ok ? "good" : "bad"), role: "status" },
        h("b", {}, ok ? APP.pick(["Sa7 (correct)!", "Tamaam!", "Brafo!", "Mumtaaz!", "Correct!"]) : "Not quite."),
        !ok || q.kind !== "mc" ? h("div", { class: "fb-ans" }, right.text && !right.ar ? APP.auto(right.text) : null,
          right.ar ? APP.ar(right.ar) : null, right.ar ? APP.speakBtn(right.ar) : null, right.tr ? APP.tr(right.tr) : null) : null,
        q.prompt && q.prompt.en && q.kind !== "mc" && !ok ? null : null,
        q.explain ? h("p", { class: "note" }, q.explain) : null);
      if (!ok && APP.aiState === "ready") {
        const out = h("p", { class: "note ai-out" });
        const btn = h("button", { class: "btn ghost small", type: "button", onclick: async () => {
          btn.disabled = true; out.textContent = "Thinking…";
          try {
            const prompt = `You are an Egyptian Arabic (Cairene) teacher. A learner answered a question wrong. Explain briefly (max 90 words, plain English, no markdown headings) why the correct answer is right and what the learner's mistake shows, with one extra example in Arabic script plus Franco-Arabic (2=hamza/qaf, 3=ein, 7=Haa, kh, gh, sh, long vowels doubled).\n\nQuestion: ${describeQ(q)}\nCorrect answer: ${[right.text, right.ar, right.tr].filter(Boolean).join(" / ")}\nLearner's answer: ${given || "(chose a wrong option)"}`;
            await APP.ai(prompt, { modelTier: "quick", onText: ({ text }) => { out.textContent = text; } });
          } catch (e) { out.textContent = APP.aiError(e); btn.disabled = false; }
        } }, "Why? Ask the tutor");
        fb.append(btn, out);
      }
      body.append(fb);
      foot.replaceChildren(h("button", { class: "btn primary", type: "button", id: "qz-next", onclick: next }, i + 1 < questions.length ? "Continue" : "See results"));
      setTimeout(() => { const n = document.getElementById("qz-next"); if (n) n.focus(); }, 30);
      if (right.ar && !(q.prompt && q.prompt.listen)) APP.speak(right.ar);
    }
    function describeQ(q) {
      if (q.kind === "order") return "Put the words in order to say: " + q.en;
      const p = q.prompt || {};
      const o = q.options ? " Options: " + q.options.map((x) => [x.text, x.ar, x.tr].filter(Boolean).join(" ")).join(" | ") : "";
      return [q.label, p.text, p.ar, p.tr, p.en, p.listen ? "(listening) " + p.listen : ""].filter(Boolean).join(" — ") + o;
    }
    function next() {
      i++;
      if (i < questions.length) { render(); return; }
      cleanup();
      const pct = Math.round((score / questions.length) * 100);
      APP.addXP(score * 2 + 5);
      APP.save();
      bar.firstChild.style.width = "100%";
      head.replaceChildren(h("span", { class: "label" }, (opts.title || "Practice") + " · results"));
      body.replaceChildren(h("div", { class: "result" },
        h("div", { class: "score" }, pct + "%"),
        h("p", {}, `${score} of ${questions.length} correct. `, opts.pass ? (pct >= opts.pass ? h("b", { class: "good-t" }, "Passed.") : h("b", { class: "bad-t" }, `You need ${opts.pass}% to pass. Review the missed items and try again.`)) : null),
        missed.length ? h("div", { class: "missed" }, h("h3", {}, "Review these"), missed.map((q) => h("div", { class: "miss-row" }, missedLine(q)))) : null));
      foot.replaceChildren();
      if (opts.onDone) opts.onDone(pct, score, missed, foot);
    }
    function missedLine(q) {
      if (q.kind === "order") return [APP.ar(q.ar), APP.tr(q.tr), h("span", {}, q.en)];
      if (q.kind === "type") return [h("span", {}, (q.prompt.text || q.prompt.en || "")), APP.ar(q.expect.ar || ""), APP.tr(q.expect.tr || "")];
      const r = q.options[q.answer], p = q.prompt;
      return [h("span", {}, p.text || p.en || p.tr || p.listen || ""), p.ar ? APP.ar(p.ar) : null, " → ", r.ar ? APP.ar(r.ar) : APP.auto(r.text), r.tr ? APP.tr(r.tr) : null];
    }
    keyHandler = null;
    const globalKeys = (e) => {
      if (e.key === "Enter" && answered && !e.target.matches("textarea")) { const n = document.getElementById("qz-next"); if (n && document.activeElement !== n) { e.preventDefault(); n.click(); } }
    };
    const wrapKey = (e) => { if (!root.isConnected) { document.removeEventListener("keydown", wrapKey); return; } globalKeys(e); if (keyHandler) keyHandler(e); };
    document.addEventListener("keydown", wrapKey);
    root._cleanup = () => document.removeEventListener("keydown", wrapKey);
    render();
  };

  // ---------- boot of async capabilities ----------
  APP.initCaps = function () { initAI(); initSync(); };
})();
