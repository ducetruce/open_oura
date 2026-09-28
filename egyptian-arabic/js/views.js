// Yalla Masri — views and router.
(function () {
  const APP = window.APP, E = window.ENGINE, Q = APP.Q, T = APP.T;
  const { h, ar, tr, speakBtn, shuffle, pick } = APP;
  const main = () => document.getElementById("main");
  let route = "home", param = null, sub = null;

  // ---------- router ----------
  APP.go = function (r, p, s) {
    const m = main();
    m.querySelectorAll(".qz").forEach((x) => x._cleanup && x._cleanup());
    APP.stopSpeech();
    route = r; param = p || null; sub = s || null;
    const token = [r, p, s].filter(Boolean).join("-").replace(/[^A-Za-z0-9._~-]/g, "");
    try { history.replaceState(null, "", "#" + token); } catch (e) {}
    try { localStorage.setItem("yalla-route", token); } catch (e) {}
    render();
    window.scrollTo(0, 0);
  };
  function parseToken(t) {
    if (!t) return ["home"];
    const unit = t.match(/^unit-([abc][12]-\d\d)(?:-(\w+))?$/);
    if (unit) return ["unit", unit[1], unit[2]];
    const scr = t.match(/^script-(s\d)$/);
    if (scr) return ["script", scr[1]];
    const lv = t.match(/^course-([ABC][12])$/);
    if (lv) return ["course", lv[1]];
    const tut = t.match(/^tutor-(\w+)$/);
    if (tut) return ["tutor", tut[1]];
    if (["home", "course", "script", "review", "practice", "verbs", "tutor", "placement", "settings", "words", "bank"].includes(t)) return [t];
    return ["home"];
  }
  function render() {
    document.querySelectorAll("[data-nav]").forEach((b) => b.setAttribute("aria-current", navFor(route) === b.dataset.nav ? "page" : "false"));
    const m = main();
    m.replaceChildren();
    const V = VIEWS[route] || VIEWS.home;
    V(m);
    renderHeaderStats();
  }
  const navFor = (r) => ({ unit: "course", verbs: "practice", placement: "home", words: "review", bank: "review" }[r] || r);

  function renderHeaderStats() {
    const el = document.getElementById("hdr-stats"); if (!el) return;
    el.replaceChildren(
      h("span", { class: "hstat streak", title: "Day streak" }, "🔥 ", h("b", {}, APP.streak())),
      h("span", { class: "hstat", title: "Reviews due" }, "↻ ", h("b", {}, APP.dueCards().length)),
      h("span", { class: "hstat sync " + APP.sync.status, title: APP.sync.status === "synced" ? "Progress saved to your account" : "Progress saved in this browser" }, APP.sync.status === "synced" ? "☁ synced" : "● local"));
  }
  APP.on("sync", renderHeaderStats);
  APP.on("state", () => render());
  APP.on("ai", () => { if (route === "tutor" || route === "home") render(); });

  const back = (label, fn) => h("button", { class: "back", type: "button", onclick: fn }, "‹ " + label);
  const meter = (p, cls) => h("div", { class: "meter " + (cls || ""), role: "img", "aria-label": APP.pct(p) + " complete" }, h("i", { style: `width:${Math.round(p * 100)}%` }));

  // ---------- views ----------
  const VIEWS = {};

  VIEWS.home = function (m) {
    const S = APP.state();
    const next = APP.nextUnit();
    const lv = APP.currentLevel();
    const due = APP.dueCards().length, fresh = APP.newCards().length;
    const firstTime = !Object.keys(S.units).length && !Object.keys(S.script).length;
    const hero = h("section", { class: "hero" },
      h("div", {}, h("div", { class: "label" }, firstTime ? "Welcome" : "Your level: " + lv + " · " + APP.LEVEL_NAMES[lv]),
        h("h1", {}, firstTime ? "Learn Egyptian Arabic, from your first word to mastery." : next ? "Keep going: " + next.title : "You've finished the course."),
        h("p", { class: "lead" }, firstTime
          ? "50 units across six CEFR levels, a full alphabet course, verb and number trainers, spaced-repetition review and an AI conversation partner, all in the Arabic that Cairo actually speaks."
          : next ? `${next.level} · ${APP.pct(APP.unitProgress(next.id))} done. Lesson, dialogue, words, practice, then the unit test.` : "Use the tutor and trainers to stay sharp, and follow your immersion plan in the last unit."),
        h("div", { class: "row" },
          next ? h("button", { class: "btn primary", type: "button", onclick: () => APP.go("unit", next.id) }, firstTime ? "Start unit 1" : "Continue") : null,
          firstTime ? h("button", { class: "btn", type: "button", onclick: () => APP.go("placement") }, "I already know some: take the placement test") : null,
          firstTime ? h("button", { class: "btn ghost", type: "button", onclick: () => APP.go("script") }, "Learn the alphabet first") : null)),
      h("div", { class: "hero-ar", "aria-hidden": "true" }, ar("يلا نتعلم", "kufi")));

    const plan = h("section", { class: "panel" }, h("h2", {}, "Today"),
      h("div", { class: "plan" },
        planItem("Review", due ? `${due} words due${fresh ? ` + ${Math.min(fresh, S.settings.newPerDay)} new` : ""}` : fresh ? `${Math.min(fresh, S.settings.newPerDay)} new words to learn` : "Nothing due. Open a unit to add words.", due || fresh ? "↻" : "✓", () => APP.go("review"), !(due || fresh)),
        next ? planItem("Next unit", `${next.level} · ${next.title}`, "▶", () => APP.go("unit", next.id)) : null,
        planItem("Talk", APP.aiState === "ready" ? "A role-play with your AI partner" : "Needs Claude: open this page on claude.ai", "💬", () => APP.go("tutor"), APP.aiState !== "ready"),
        planItem("Drill", "Verbs, numbers and time", "⚡", () => APP.go("practice"))),
      h("p", { class: "note" }, `Today: ${APP.todayXP()} points · streak ${APP.streak()} day${APP.streak() === 1 ? "" : "s"} · ${APP.knownCount()} words known`));

    const ladder = h("section", { class: "panel" }, h("h2", {}, "Your path to C2"),
      h("div", { class: "ladder" }, APP.LEVELS.map((L) => {
        const p = APP.levelProgress(L);
        return h("button", { class: "rung" + (L === lv ? " current" : ""), type: "button", onclick: () => APP.go("course", L) },
          h("span", { class: "rung-lv" }, L), h("span", { class: "rung-name" }, APP.LEVEL_NAMES[L]), meter(p), h("span", { class: "rung-pct" }, APP.pct(p)));
      })));
    m.append(hero, h("div", { class: "grid2" }, plan, ladder));
  };
  function planItem(title, text, icon, fn, dim) {
    return h("button", { class: "plan-item" + (dim ? " dim" : ""), type: "button", onclick: fn }, h("span", { class: "pi-ic", "aria-hidden": "true" }, icon), h("span", {}, h("b", {}, title), h("small", {}, text)));
  }

  VIEWS.course = function (m) {
    const lv = param || APP.currentLevel();
    const tabs = h("div", { class: "lvtabs", role: "tablist" }, APP.LEVELS.map((L) =>
      h("button", { role: "tab", type: "button", "aria-selected": L === lv, onclick: () => APP.go("course", L) }, L, h("small", {}, APP.pct(APP.levelProgress(L))))));
    const desc = {
      A1: "Survive day one: greetings, numbers, family, food, directions, the present and future.",
      A2: "Everyday life: the past tense, negation, shopping, health, work, phone calls, travel.",
      B1: "Tell stories, give opinions, use conditions, relative clauses, participles, the passive and social formulas.",
      B2: "Hypotheticals, reported speech, aspect, discourse markers, idioms, formal and professional Egyptian.",
      C1: "Register shifting, proverbs, humour, the root system, rhetoric and the dialects of Egypt.",
      C2: "Colloquial poetry, social ritual, nuance, fast speech, public speaking and a mastery capstone.",
    };
    const S = APP.state();
    const list = h("div", { class: "units" }, APP.unitsOf(lv).map((u, k) => {
      const p = APP.unitProgress(u.id), st = S.units[u.id] || {};
      return h("button", { class: "unit-card" + (st.done ? " done" : ""), type: "button", onclick: () => APP.go("unit", u.id) },
        h("div", { class: "uc-top" }, h("span", { class: "uc-n" }, u.level + "." + (k + 1)), st.done ? h("span", { class: "pill k" }, "Passed") : p > 0 ? h("span", { class: "pill l" }, "In progress") : null),
        h("b", { class: "uc-t" }, u.title), ar(u.ar, "uc-ar"), h("small", { class: "uc-g" }, u.goals.slice(0, 2).join(" · ")), meter(p));
    }));
    m.append(h("div", { class: "page-head" }, h("h1", {}, "Course"), h("p", { class: "lead" }, "Work through the units in order. Pass each unit test (80%) to complete it; everything stays open so you can jump around."),
        h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn small", type: "button", onclick: () => APP.go("script") }, "Alphabet course (8 lessons)"), h("button", { class: "btn small ghost", type: "button", onclick: () => APP.go("placement") }, "Placement test"))),
      tabs, h("p", { class: "lvdesc" }, h("b", {}, lv + " · " + APP.LEVEL_NAMES[lv] + ". "), desc[lv]), list);
  };

  // ---------- unit ----------
  VIEWS.unit = function (m) {
    const u = APP.UNIT[param];
    if (!u) return VIEWS.course(m);
    const st = APP.unitState(u.id);
    const tabsDef = [["lesson", "Lesson"], ["dialogue", "Dialogue"], ["words", "Words"], u.reading ? ["reading", "Reading"] : null, ["practice", "Practice"], ["test", "Unit test"], ["tutor", "Tutor"]].filter(Boolean);
    const cur = tabsDef.some((t) => t[0] === sub) ? sub : "lesson";
    if (!st.opened) { st.opened = 1; APP.addCards(APP.unitCardIds(u)); APP.save(); }
    const idx = APP.UNITS.indexOf(u);
    const head = h("div", { class: "unit-head" },
      back("Course · " + u.level, () => APP.go("course", u.level)),
      h("div", { class: "label" }, `${u.level} · Unit ${APP.unitsOf(u.level).indexOf(u) + 1} of ${APP.unitsOf(u.level).length}`),
      h("h1", {}, u.title, " ", ar(u.ar, "h-ar")),
      h("ul", { class: "goals" }, u.goals.map((g) => h("li", {}, g))),
      h("div", { class: "unit-prog" }, meter(APP.unitProgress(u.id)), h("span", { class: "label" }, APP.pct(APP.unitProgress(u.id)))));
    const tabs = h("div", { class: "utabs", role: "tablist" }, tabsDef.map(([k, lab]) =>
      h("button", { role: "tab", type: "button", "aria-selected": k === cur, onclick: () => APP.go("unit", u.id, k) }, lab, stepMark(st, k))));
    const body = h("div", { class: "unit-body" });
    m.append(head, tabs, body);
    UNIT_TABS[cur](body, u, st);
    const nav = h("div", { class: "unit-nav" },
      idx > 0 ? h("button", { class: "btn ghost", type: "button", onclick: () => APP.go("unit", APP.UNITS[idx - 1].id) }, "‹ " + APP.UNITS[idx - 1].title) : h("span"),
      idx < APP.UNITS.length - 1 ? h("button", { class: "btn ghost", type: "button", onclick: () => APP.go("unit", APP.UNITS[idx + 1].id) }, APP.UNITS[idx + 1].title + " ›") : h("span"));
    m.append(nav);
  };
  function stepMark(st, k) {
    const done = { lesson: st.lesson, dialogue: st.dialogue, words: st.words, reading: st.reading, practice: (st.practice || 0) >= 70, test: st.done }[k];
    return done ? h("span", { class: "tick", "aria-label": "done" }, "✓") : null;
  }
  function nextStep(u, k) {
    const order = ["lesson", "dialogue", "words", u.reading ? "reading" : null, "practice", "test"].filter(Boolean);
    const i = order.indexOf(k);
    return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  }
  const stepLabel = { dialogue: "Dialogue", words: "Words", reading: "Reading", practice: "Practice", test: "Unit test" };
  function doneBtn(u, st, k) {
    const nx = nextStep(u, k);
    return h("div", { class: "step-done" }, h("button", { class: "btn primary", type: "button", onclick: () => { st[k] = 1; APP.addXP(3); APP.save(); nx ? APP.go("unit", u.id, nx) : APP.go("unit", u.id, k); } }, nx ? "Done · next: " + stepLabel[nx] : "Mark as done"));
  }

  const UNIT_TABS = {};
  UNIT_TABS.lesson = function (el, u, st) {
    u.lesson.forEach((sec) => {
      const s = h("section", { class: "lsec" }, h("h2", {}, sec.h), h("p", { html: sec.p }));
      if (sec.ex) s.append(h("div", { class: "examples" }, sec.ex.map(([a, t, e]) => h("div", { class: "ex" }, h("div", { class: "row" }, ar(a, "ex-ar"), speakBtn(a)), tr(t), h("span", { class: "en" }, e)))));
      if (sec.table) s.append(h("div", { class: "tbl" }, h("table", {}, h("thead", {}, h("tr", {}, sec.table.head.map((c) => h("th", {}, c)))),
        h("tbody", {}, sec.table.rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, cellContent(c)))))))));
      el.append(s);
    });
    el.append(h("section", { class: "lsec culture" }, h("h2", {}, "Culture"), h("div", { html: u.culture })));
    if (u.verbs && u.verbs.length) el.append(h("section", { class: "lsec" }, h("h2", {}, "Verbs in this unit"),
      h("div", { class: "chips" }, u.verbs.map((id) => h("button", { class: "chipbtn", type: "button", onclick: () => { APP._verb = id; APP.go("verbs"); } }, E.VERB[id].en, " · ", tr(E.VERB[id].p3 ? E.VERB[id].p3.tr : "")))),
      h("p", { class: "note" }, "Open a verb to see every tense in the conjugation trainer.")));
    el.append(doneBtn(u, st, "lesson"));
  };
  function cellContent(c) {
    // "franco arabic" pairs in tables: render Arabic part in Arabic font
    const m = String(c).match(/^(.*?)([؀-ۿ][؀-ۿ\s؟]*)$/);
    if (m && m[1].trim()) return [h("span", { class: "tr-cell" }, m[1].trim()), " ", ar(m[2].trim())];
    return E.hasArabic(c) ? ar(c) : c;
  }
  UNIT_TABS.dialogue = function (el, u, st) {
    const d = u.dialogue;
    const showEn = h("input", { type: "checkbox", id: "dlg-en", checked: true });
    const showTr = h("input", { type: "checkbox", id: "dlg-tr", checked: APP.state().settings.franco === "show" });
    const lines = h("div", { class: "dlg" }, d.lines.map((l, k) => h("div", { class: "dline " + (k % 2 ? "b" : "a"), "data-k": k },
      h("div", { class: "who" }, l[0]),
      h("div", { class: "row" }, ar(l[1], "d-ar"), speakBtn(l[1])), h("div", { class: "tr d-tr" }, l[2]), h("div", { class: "en d-en" }, l[3]))));
    const sync = () => { lines.querySelectorAll(".d-en").forEach((x) => (x.hidden = !showEn.checked)); lines.querySelectorAll(".d-tr").forEach((x) => (x.hidden = !showTr.checked)); };
    showEn.onchange = sync; showTr.onchange = sync;
    let playing = false;
    const playAll = h("button", { class: "btn", type: "button", onclick: () => {
      if (playing) { playing = false; APP.stopSpeech(); playAll.textContent = "▶ Play the whole dialogue"; return; }
      playing = true; playAll.textContent = "■ Stop";
      let k = 0;
      const step = () => {
        lines.querySelectorAll(".dline").forEach((x) => x.classList.remove("on"));
        if (!playing || k >= d.lines.length) { playing = false; playAll.textContent = "▶ Play the whole dialogue"; return; }
        const row = lines.children[k]; row.classList.add("on"); row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        APP.speak(d.lines[k][1], () => { k++; setTimeout(step, 350); });
      };
      step();
    } }, "▶ Play the whole dialogue");
    el.append(h("h2", {}, d.title), h("div", { class: "bar" }, playAll, h("label", { class: "check" }, showTr, " Franco"), h("label", { class: "check" }, showEn, " English")), lines);
    sync();
    if (APP.aiState === "ready") el.append(h("p", {}, h("button", { class: "btn ghost", type: "button", onclick: () => APP.go("unit", u.id, "tutor") }, "Act out this scene with the AI tutor")));
    if (!APP.tts) el.append(h("p", { class: "note" }, "Audio needs a browser with speech synthesis and an Arabic voice installed."));
    el.append(doneBtn(u, st, "dialogue"));
  };
  UNIT_TABS.words = function (el, u, st) {
    const ids = APP.unitCardIds(u);
    const q = h("input", { type: "search", id: "w-search", placeholder: "Filter these words…", "aria-label": "Filter words" });
    const list = h("div", { class: "wordlist" });
    const draw = () => {
      const f = E.normTr(q.value) , fa = E.normAr(q.value);
      list.replaceChildren(...ids.map(APP.card).filter((c) => !q.value || E.normTr(c.tr + c.en).includes(f) || (fa && E.normAr(c.ar).includes(fa))).map((c) =>
        h("div", { class: "witem" }, ar(c.ar, "w-ar"), speakBtn(c.ar), tr(c.tr), h("span", { class: "w-en" }, c.en), statusPill(c.id), c.note ? h("small", { class: "note w-note" }, c.note) : null)));
    };
    q.oninput = draw; draw();
    el.append(h("div", { class: "bar" }, q, h("span", { class: "label" }, ids.length + " words · added to your review deck")),
      list, h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: () => APP.go("review") }, "Review these now"),
        h("button", { class: "btn ghost", type: "button", onclick: () => { const box = h("div", { class: "qz panel" }); el.append(box); box.scrollIntoView({ behavior: "smooth" }); APP.runQuiz(box, shuffle(ids.map(APP.card)).slice(0, 12).map((c) => Q.vocabQ(c, ids.map(APP.card))), { title: "Word quiz" }); } }, "Quick word quiz")),
      doneBtn(u, st, "words"));
  };
  function statusPill(id) { const s = APP.cardStatus(id); return h("span", { class: "pill " + ({ known: "k", learning: "l" }[s] || "") }, s === "unseen" ? "new" : s); }
  UNIT_TABS.reading = function (el, u, st) {
    const r = u.reading;
    const showEn = h("input", { type: "checkbox", id: "rd-en" });
    const body = h("div", { class: "reading-text" }, r.text.map(([a, t, e]) => h("div", { class: "rline" }, h("div", { class: "row" }, ar(a, "r-ar"), speakBtn(a)), tr(t), h("div", { class: "en r-en", hidden: true }, e))));
    showEn.onchange = () => body.querySelectorAll(".r-en").forEach((x) => (x.hidden = !showEn.checked));
    const quiz = h("div", { class: "qz" });
    el.append(h("h2", {}, r.title), h("p", { class: "note" }, "Read it first without English. Tap the speaker to hear each line."), h("label", { class: "check" }, showEn, " Show English"), body,
      h("h3", {}, "Questions"), h("button", { class: "btn primary", type: "button", onclick: () => APP.runQuiz(quiz, r.questions.map((x) => Q.mc("Reading", { text: x.q }, x.opts.map((t) => ({ text: t })), x.a)), {
        title: "Reading", onDone: (pct, s, miss, foot) => { if (pct >= 60) { st.reading = 1; APP.save(); } foot.append(h("button", { class: "btn primary", type: "button", onclick: () => APP.go("unit", u.id, "practice") }, "Next: Practice")); } }) }, "Answer the questions"), quiz);
  };
  UNIT_TABS.practice = function (el, u, st) {
    const box = h("div", { class: "qz panel" });
    const start = () => APP.runQuiz(box, Q.unitPractice(u), { title: "Practice", onDone: (pct, s, miss, foot) => {
      st.practice = Math.max(st.practice || 0, pct); APP.save();
      foot.append(h("button", { class: "btn", type: "button", onclick: start }, "Practise again"), h("button", { class: "btn primary", type: "button", onclick: () => APP.go("unit", u.id, "test") }, "Take the unit test"));
    } });
    el.append(h("p", { class: "note" }, "A fresh mix every time: the unit's exercises, its words, verbs and the dialogue. Best score: " + (st.practice || 0) + "%. Aim for 70% before the test."), box);
    start();
  };
  UNIT_TABS.test = function (el, u, st) {
    const box = h("div", { class: "qz panel" });
    const intro = h("div", { class: "panel" }, h("h2", {}, "Unit test"),
      h("p", {}, "Up to 16 questions covering everything in the unit. Score 80% or more to complete it. ", st.test ? "Best so far: " + st.test + "%." : ""),
      h("button", { class: "btn primary", type: "button", onclick: () => { intro.remove(); run(); } }, st.done ? "Retake the test" : "Start the test"));
    const run = () => APP.runQuiz(box, Q.unitTest(u), { title: "Unit test", pass: 80, onDone: (pct, s, miss, foot) => {
      st.test = Math.max(st.test || 0, pct);
      if (pct >= 80 && !st.done) { st.done = 1; APP.addXP(30); APP.toast("Unit complete! Mabruuk!"); }
      APP.save();
      const idx = APP.UNITS.indexOf(u), nx = APP.UNITS[idx + 1];
      foot.append(h("button", { class: "btn", type: "button", onclick: () => { box.replaceChildren(); run(); } }, "Retake"),
        pct >= 80 && nx ? h("button", { class: "btn primary", type: "button", onclick: () => APP.go("unit", nx.id) }, "Next unit: " + nx.title) : h("button", { class: "btn primary", type: "button", onclick: () => APP.go("unit", u.id, "practice") }, "Practise more"));
    } });
    el.append(intro, box);
  };
  UNIT_TABS.tutor = function (el, u) {
    if (APP.aiState !== "ready") { el.append(T.unavailable()); return; }
    const box = h("div", { class: "panel tutor-box" });
    const scene = `Act out a scene like this unit's dialogue "${u.dialogue.title}" (topic: ${u.title}; goals: ${u.goals.join("; ")}). Play the other character. Here is the original dialogue for reference: ${u.dialogue.lines.map((l) => l[0] + ": " + l[2]).join(" / ")}.`;
    const tasks = [{ title: "Act out the dialogue", prompt: scene }, { title: "Quiz me on this unit", prompt: `Ask me questions that make me use this unit's language (${u.title}: ${u.goals.join("; ")}), one at a time, and correct my answers. Key words: ${u.vocab.slice(0, 20).map((v) => v[1]).join(", ")}.` }, ...(u.tutor || [])];
    el.append(h("p", { class: "note" }, "Practise this unit with your AI partner. It replies in Egyptian Arabic, corrects you, and explains."),
      h("div", { class: "chips" }, tasks.map((t) => h("button", { class: "chipbtn", type: "button", onclick: () => { box.hidden = false; T.task(box, t, u.level); } }, t.title))), box);
    box.hidden = true;
  };

  // ---------- script course ----------
  VIEWS.script = function (m) {
    const S = APP.state();
    if (param) {
      const L = window.SCRIPT.find((x) => x.id === param);
      if (L) return scriptLesson(m, L);
    }
    m.append(h("div", { class: "page-head" }, h("h1", {}, "The Arabic alphabet"), h("p", { class: "lead" }, "Eight short lessons take you from zero to reading every word in the course. You can use the course in Franco (Latin letters) meanwhile, but reading Arabic script makes everything easier.")),
      h("div", { class: "units" }, window.SCRIPT.map((L, k) => {
        const st = S.script[L.id] || {};
        return h("button", { class: "unit-card" + (st.done ? " done" : ""), type: "button", onclick: () => APP.go("script", L.id) },
          h("div", { class: "uc-top" }, h("span", { class: "uc-n" }, "Lesson " + (k + 1)), st.done ? h("span", { class: "pill k" }, "Passed") : null),
          h("b", { class: "uc-t" }, L.title), ar(L.sub, "uc-ar"), meter(st.done ? 1 : st.best ? st.best / 100 : 0));
      })));
  };
  function scriptLesson(m, L) {
    const S = APP.state();
    const st = (S.script[L.id] = S.script[L.id] || {});
    const G = Q.letterForms;
    const tbl = h("div", { class: "tbl" }, h("table", { class: "letters" },
      h("thead", {}, h("tr", {}, ["Letter", "Name", "Sound", "Alone", "Start", "Middle", "End", "How to say it", ""].map((c) => h("th", {}, c)))),
      h("tbody", {}, L.letters.map((l) => { const f = G(l); return h("tr", {}, h("td", {}, ar(l[0], "big-l")), h("td", {}, l[1]), h("td", {}, h("b", {}, l[2])),
        [0, 1, 2, 3].map((k) => h("td", {}, f[k] ? ar(f[k], "form") : "—")), h("td", { class: "small" }, l[3]), h("td", {}, speakBtn(l[0]))); }))));
    const marks = L.marks ? h("div", { class: "tbl" }, h("table", {}, h("thead", {}, h("tr", {}, ["Mark", "Name", "Sound", ""].map((c) => h("th", {}, c)))),
      h("tbody", {}, L.marks.map((x) => h("tr", {}, h("td", {}, ar(x[0], "big-l")), h("td", {}, x[1]), h("td", {}, x[2]), h("td", { class: "small" }, x[3])))))) : null;
    const words = h("div", { class: "wordlist" }, L.words.map(([a, t, e]) => h("div", { class: "witem" }, ar(a, "w-ar"), speakBtn(a), tr(t), h("span", { class: "w-en" }, e))));
    const nums = L.numerals ? h("div", { class: "numerals" }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => h("div", {}, h("b", { class: "ar" }, E.eastern(d)), h("span", {}, d), tr(E.number(d).tr)))) : null;
    const box = h("div", { class: "qz panel" });
    const idx = window.SCRIPT.indexOf(L), nx = window.SCRIPT[idx + 1];
    m.append(back("Alphabet", () => APP.go("script")), h("div", { class: "label" }, "Alphabet · lesson " + (idx + 1)), h("h1", {}, L.title),
      h("div", { class: "lsec", html: L.intro }), h("h2", {}, "Letters"), tbl, marks, h("h2", {}, "Read these words"), words, nums,
      h("h2", {}, "Check yourself"), h("button", { class: "btn primary", type: "button", onclick: () => APP.runQuiz(box, Q.scriptQuiz(L), { title: "Alphabet", pass: 80, onDone: (pct, s, miss, foot) => {
        st.best = Math.max(st.best || 0, pct); if (pct >= 80) st.done = 1; APP.save();
        if (nx) foot.append(h("button", { class: "btn primary", type: "button", onclick: () => APP.go("script", nx.id) }, "Next lesson: " + nx.title));
        else foot.append(h("button", { class: "btn primary", type: "button", onclick: () => APP.go("course", "A1") }, "Start the course"));
      } }) }, "Start the quiz"), box);
  }

  // ---------- review (SRS) ----------
  VIEWS.review = function (m) {
    const S = APP.state();
    const due = APP.dueCards();
    const fresh = APP.newCards().slice(0, S.settings.newPerDay);
    let queue = [...due, ...fresh];
    let cur = null, revealed = false, dir = "ar", done = 0;
    const card = h("div", { class: "card" });
    const acts = h("div", { class: "actions" });
    const info = h("div", { class: "label" });
    const dirSeg = h("div", { class: "seg", role: "group", "aria-label": "Card direction" },
      h("button", { type: "button", "aria-pressed": "true", onclick: (e) => setDir("ar", e) }, "Arabic → English"),
      h("button", { type: "button", "aria-pressed": "false", onclick: (e) => setDir("en", e) }, "English → Arabic"));
    function setDir(d, e) { dir = d; [...dirSeg.children].forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget)); revealed = false; draw(); }
    m.append(h("div", { class: "page-head" }, h("h1", {}, "Review"), h("p", { class: "lead" }, "Spaced repetition: each word comes back just before you'd forget it. Words from every unit you open are added automatically.")),
      h("div", { class: "bar" }, dirSeg, info, h("span", { class: "grow" }), h("button", { class: "btn ghost small", type: "button", onclick: () => APP.go("bank") }, "Word bank"), h("button", { class: "btn ghost small", type: "button", onclick: () => APP.go("words") }, "All my words")), card, acts,
      h("p", { class: "hint" }, "Keys: Space shows the answer, 1–4 rate it, S plays the audio."));
    function nextCard() { cur = queue.shift() || null; revealed = false; draw(); }
    function draw() {
      card.replaceChildren(); acts.replaceChildren();
      info.textContent = `${queue.length + (cur ? 1 : 0)} left · ${done} done`;
      if (!cur) {
        const soon = Object.values(S.srs).filter((s) => !s[2]).map((s) => s[1]).sort((a, b) => a - b)[0];
        card.append(h("div", { class: "done" }, ar("خلاص!", "kufi"), h("b", {}, done ? "All done for now." : "Nothing to review right now."),
          h("p", { class: "note" }, soon ? "Next review in " + APP.fmtDays(Math.max(0, (soon - Date.now()) / 864e5)) + "." : "Open a unit to add its words.")));
        acts.className = "actions one";
        const ids = Object.keys(S.srs).filter((id) => APP.card(id));
        if (ids.length >= 4) acts.append(h("button", { class: "btn", type: "button", onclick: () => { const box = h("div", { class: "qz panel" }); m.append(box); APP.runQuiz(box, Q.reviewQuiz(ids, 12), { title: "Mixed word quiz" }); box.scrollIntoView({ behavior: "smooth" }); } }, "Practise a mixed quiz anyway"));
        return;
      }
      const c = APP.card(cur);
      const s = S.srs[cur];
      card.append(h("div", { class: "card-meta" }, h("span", { class: "chip" }, c.src), h("span", { class: "label" }, s[2] ? "new" : "level " + s[0])));
      const face = h("div", { class: "face" });
      if (dir === "ar") { face.append(h("div", { class: "row center" }, ar(c.ar, "big-ar"), speakBtn(c.ar))); if (APP.state().settings.franco === "show") face.append(tr(c.tr, "sub")); }
      else face.append(h("div", { class: "big-en" }, c.en));
      card.append(face);
      if (revealed) {
        const ans = h("div", { class: "answer" });
        if (dir === "ar") ans.append(h("div", { class: "en-ans" }, c.en), APP.state().settings.franco !== "show" ? tr(c.tr) : null);
        else ans.append(h("div", { class: "row center" }, ar(c.ar, "ar-ans"), speakBtn(c.ar)), tr(c.tr));
        if (c.note) ans.append(h("p", { class: "note" }, c.note));
        card.append(ans);
        acts.className = "actions";
        [["Again", "again"], ["Hard", "hard"], ["Good", "good"], ["Easy", "easy"]].forEach(([lab, cls], g) =>
          acts.append(h("button", { class: "rate " + cls, type: "button", onclick: () => rate(g) }, lab, h("small", {}, APP.fmtDays(APP.srsNext(cur, g).days)), h("kbd", {}, g + 1))));
      } else {
        acts.className = "actions one";
        acts.append(h("button", { class: "btn primary", type: "button", onclick: reveal }, "Show answer"));
      }
    }
    function reveal() { if (!cur || revealed) return; revealed = true; draw(); if (dir === "en") APP.speak(APP.card(cur).ar); }
    function rate(g) {
      if (!cur || !revealed) return;
      APP.srsRate(cur, g);
      if (g === 0) queue.splice(Math.min(queue.length, 3), 0, cur);
      done++; S.stats.reviews++; APP.addXP(1); APP.save(); renderHeaderStats(); nextCard();
    }
    const keys = (e) => {
      if (route !== "review") { document.removeEventListener("keydown", keys); return; }
      if (e.target.matches("input,textarea,select") || e.metaKey || e.ctrlKey) return;
      if (e.key === " " && cur && !revealed) { e.preventDefault(); reveal(); }
      else if (/^[1-4]$/.test(e.key) && revealed) rate(+e.key - 1);
      else if ((e.key === "s" || e.key === "S") && cur) APP.speak(APP.card(cur).ar);
    };
    document.addEventListener("keydown", keys);
    nextCard();
  };

  VIEWS.words = function (m) {
    const S = APP.state();
    const ids = Object.keys(S.srs).filter((id) => APP.card(id));
    const q = h("input", { type: "search", id: "all-search", placeholder: "Search your words (Arabic, Franco or English)…", "aria-label": "Search words" });
    const filt = h("select", { id: "all-filter", "aria-label": "Filter" }, [["all", "All"], ["new", "New"], ["learning", "Learning"], ["known", "Known"]].map(([v, l]) => h("option", { value: v }, l)));
    const list = h("div", { class: "wordlist" }), count = h("span", { class: "label" });
    const draw = () => {
      const f = E.normTr(q.value), fa = E.normAr(q.value);
      const rows = ids.map(APP.card).filter((c) => (filt.value === "all" || APP.cardStatus(c.id) === filt.value) && (!q.value || E.normTr(c.tr + c.en).includes(f) || (fa && E.normAr(c.ar).includes(fa))));
      count.textContent = rows.length + " words";
      list.replaceChildren(...rows.slice(0, 400).map((c) => h("div", { class: "witem" }, ar(c.ar, "w-ar"), speakBtn(c.ar), tr(c.tr), h("span", { class: "w-en" }, c.en), statusPill(c.id), h("small", { class: "note w-note" }, c.src))));
    };
    q.oninput = draw; filt.onchange = draw; draw();
    m.append(back("Review", () => APP.go("review")), h("h1", {}, "My words"), h("div", { class: "bar" }, q, filt, count), list);
  };

  VIEWS.bank = function (m) {
    const S = APP.state();
    const decks = window.WORDBANK || [];
    const total = decks.reduce((a, d) => a + d.words.length, 0);
    const box = h("div", { class: "qz panel" }); box.hidden = true;
    m.append(back("Review", () => APP.go("review")), h("h1", {}, "Word bank"),
      h("p", { class: "lead" }, `${total} extra high-frequency words in ${decks.length} themed decks, beyond the ${APP.UNITS.reduce((a, u) => a + u.vocab.length, 0)} words in the units. Add a deck and its words join your daily review.`),
      h("div", { class: "units" }, decks.map((d) => {
        const ids = APP.bankIds(d), added = ids.filter((id) => S.srs[id]).length;
        const list = h("div", { class: "wordlist", hidden: true }, d.words.map((_, k) => { const c = APP.card(ids[k]); return h("div", { class: "witem" }, ar(c.ar, "w-ar"), speakBtn(c.ar), tr(c.tr), h("span", { class: "w-en" }, c.en), statusPill(c.id)); }));
        const addBtn = h("button", { class: "btn small" + (added < ids.length ? " primary" : ""), type: "button", disabled: added === ids.length, onclick: () => { const n = APP.addCards(ids); APP.save(); APP.toast(n + " words added to review."); addBtn.disabled = true; addBtn.textContent = "In your deck"; addBtn.classList.remove("primary"); } }, added === ids.length ? "In your deck" : added ? `Add the other ${ids.length - added}` : "Add to review");
        return h("div", { class: "unit-card bank-card" },
          h("div", { class: "uc-top" }, h("span", { class: "uc-n" }, d.level), h("span", { class: "label" }, d.words.length + " words")),
          h("b", { class: "uc-t" }, d.title),
          h("div", { class: "row" }, addBtn,
            h("button", { class: "btn small ghost", type: "button", onclick: () => { box.hidden = false; const pool = ids.map(APP.card); APP.runQuiz(box, shuffle(pool).slice(0, 12).map((c) => Q.vocabQ(c, pool)), { title: d.title }); box.scrollIntoView({ behavior: "smooth" }); } }, "Quiz"),
            h("button", { class: "btn small ghost", type: "button", onclick: (e) => { list.hidden = !list.hidden; e.currentTarget.textContent = list.hidden ? "Show words" : "Hide words"; } }, "Show words")),
          list);
      })), box);
  };

  // ---------- practice hub + trainers ----------
  VIEWS.practice = function (m) {
    const lv = APP.currentLevel();
    const box = h("div", { class: "qz panel" }); box.hidden = true;
    const typed = h("input", { type: "checkbox", id: "p-typed" });
    const go = (qs, title) => { box.hidden = false; APP.runQuiz(box, qs, { title, onDone: (p, s, mm, foot) => foot.append(h("button", { class: "btn", type: "button", onclick: () => box.scrollIntoView() }, "Again from the menu above")) }); box.scrollIntoView({ behavior: "smooth" }); };
    const n = (f, k) => Array.from({ length: k || 10 }, f);
    const lvIdx = APP.LEVELS.indexOf(lv);
    const tiles = [
      ["Verb conjugation", "All tenses, every person, for the verbs up to your level", () => APP.go("verbs")],
      ["Quick verb drill", "10 random verbs and tenses", () => go(Q.verbSet(E.verbsUpTo(lv === "A1" ? "A2" : lv).map((v) => v.id), lv, 10, typed.checked), "Verbs")],
      ["Numbers 0–100", "Read, hear and say numbers", () => go(n(() => Q.numberQ(100)), "Numbers")],
      ["Big numbers", "Prices, years and thousands", () => go(n(() => Q.numberQ(pick([1000, 5000, 20000, 250000]))), "Big numbers")],
      ["Telling the time", "Quarter past, twenty to, half past", () => go(n(() => Q.timeQ()), "Time")],
      ["Possessive endings", "my, your, his, her… on 18 nouns", () => go(n(() => Q.possQ(typed.checked)), "Possessives")],
      ["Counting things", "1 book, 2 books, 3 books, 11 books", () => go(n(() => Q.countQ()), "Counting")],
      ["Word bank", "1,000+ extra words in themed decks", () => APP.go("bank")],
      ["Listening", "Hear words from your deck and pick the meaning", () => { const ids = Object.keys(APP.state().srs).filter((id) => APP.card(id)); if (ids.length < 4) { APP.toast("Open a unit first to add words."); return; } const pool = ids.map(APP.card); go(shuffle(pool).slice(0, 10).map((c) => Q.vocabQ(c, pool, "listen")), "Listening"); }],
      ["Mixed level review", "Exercises from every unit you've opened", () => {
        const S = APP.state(); const us = APP.UNITS.filter((u) => (S.units[u.id] || {}).opened);
        if (!us.length) { APP.toast("Open a unit first."); return; }
        go(shuffle(us.flatMap((u) => u.drills.map((d) => Q.fromDrill(d, u)))).slice(0, 15), "Mixed review");
      }],
    ];
    m.append(h("div", { class: "page-head" }, h("h1", {}, "Practice"), h("p", { class: "lead" }, "Trainers that generate new questions every time, so you can drill as long as you like.")),
      h("label", { class: "check" }, typed, " Type my answers (harder) where possible"),
      h("div", { class: "tiles-grid" }, tiles.map(([t, d, f]) => h("button", { class: "tool", type: "button", onclick: f }, h("b", {}, t), h("small", {}, d)))), box);
  };

  VIEWS.verbs = function (m) {
    const lv = APP.currentLevel();
    const verbs = E.VERBS.filter((v) => v.id !== "want");
    const sel = h("select", { id: "vb-verb", "aria-label": "Verb" }, APP.LEVELS.slice(0, 4).map((L) => h("optgroup", { label: L }, verbs.filter((v) => v.level === L).map((v) => h("option", { value: v.id }, v.en + (v.p3 ? " · " + v.p3.tr : ""))))));
    sel.value = APP._verb && E.VERB[APP._verb] ? APP._verb : "write";
    const tsel = h("select", { id: "vb-tense", "aria-label": "Tense" }, E.TENSES.map((t) => h("option", { value: t.k }, t.en)));
    const table = h("div", { class: "tbl" });
    const note = h("p", { class: "note" });
    const draw = () => {
      APP._verb = sel.value;
      const forms = E.conjugate(sel.value, tsel.value);
      const T0 = E.TENSES.find((t) => t.k === tsel.value);
      note.textContent = T0.note;
      if (!forms) { table.replaceChildren(h("p", { class: "note" }, "Not used in this tense.")); return; }
      const persons = forms.length === 3 ? E.IMP_PERSONS : E.PERSONS;
      table.replaceChildren(h("table", { class: "conj" }, h("thead", {}, h("tr", {}, h("th", {}, "Person"), h("th", {}, "Arabic"), h("th", {}, "Franco"), h("th", {}, ""))),
        h("tbody", {}, forms.map((f, k) => h("tr", {}, h("td", {}, persons[k].en, " ", ar(persons[k].ar, "small-ar")), h("td", {}, ar(f.ar, "conj-ar")), h("td", {}, tr(f.tr)), h("td", {}, speakBtn(f.ar)))))));
    };
    sel.onchange = draw; tsel.onchange = draw; draw();
    const box = h("div", { class: "qz panel" }); box.hidden = true;
    const typed = h("input", { type: "checkbox", id: "vb-typed" });
    const drill = (ids) => { box.hidden = false; APP.runQuiz(box, Q.verbSet(ids, APP.LEVELS.indexOf(lv) < 2 ? "A2" : "B1", 10, typed.checked), { title: "Verb drill" }); box.scrollIntoView({ behavior: "smooth" }); };
    m.append(back("Practice", () => APP.go("practice")), h("h1", {}, "Verb conjugation"),
      h("p", { class: "lead" }, `${verbs.length} verbs, generated in every tense. Egyptian verbs are regular once you know their type: sound, hollow, weak-final or doubled.`),
      h("div", { class: "bar" }, sel, tsel), note, table,
      h("div", { class: "row" }, h("label", { class: "check" }, typed, " Type answers"), h("button", { class: "btn", type: "button", onclick: () => drill([sel.value]) }, "Drill this verb"),
        h("button", { class: "btn primary", type: "button", onclick: () => drill(E.verbsUpTo(lv === "A1" ? "A2" : lv).map((v) => v.id)) }, "Drill all verbs up to " + (lv === "A1" ? "A2" : lv))), box);
  };

  // ---------- tutor ----------
  VIEWS.tutor = function (m) {
    m.append(h("div", { class: "page-head" }, h("h1", {}, "AI tutor"), h("p", { class: "lead" }, "Conversation, writing and reading practice that adapts to your level. This is how you get past B1: real, open-ended use of the language.")));
    if (APP.aiState === "checking") { m.append(h("p", { class: "note" }, "Connecting to Claude…")); return; }
    if (APP.aiState !== "ready") { m.append(T.unavailable()); return; }
    const modes = [["talk", "Conversation"], ["write", "Writing coach"], ["read", "Reading room"], ["ask", "Ask anything"]];
    const cur = modes.some((x) => x[0] === param) ? param : "talk";
    const tabs = h("div", { class: "utabs", role: "tablist" }, modes.map(([k, l]) => h("button", { role: "tab", type: "button", "aria-selected": k === cur, onclick: () => APP.go("tutor", k) }, l)));
    const box = h("div", { class: "panel tutor-box" });
    m.append(tabs);
    if (cur === "talk") {
      const lv = APP.currentLevel();
      const sc = T.SCENARIOS;
      const pickBox = h("div", { class: "scenarios" }, APP.LEVELS.map((L) => {
        const items = sc.filter((s) => s.lv === L);
        return h("div", { class: "sc-group" + (L === lv ? " current" : "") }, h("div", { class: "label" }, L + (L === lv ? " · your level" : "")),
          items.map((s) => h("button", { class: "chipbtn", type: "button", onclick: () => { box.hidden = false; T.conversation(box, { level: L, role: s.role, title: s.title }); box.scrollIntoView({ behavior: "smooth" }); } }, s.title)));
      }));
      const free = h("input", { type: "text", id: "free-role", placeholder: "Or describe your own scene (e.g. arguing with a microbus driver)", "aria-label": "Your own scene" });
      m.append(h("h2", {}, "Pick a scene"), pickBox,
        h("div", { class: "bar" }, free, h("button", { class: "btn", type: "button", onclick: () => { if (!free.value.trim()) return; box.hidden = false; T.conversation(box, { level: lv, role: "the other person in this scene: " + free.value.trim(), title: free.value.trim() }); } }, "Start")), box);
      box.hidden = true;
    } else {
      m.append(box);
      ({ write: T.writing, read: T.reading, ask: T.ask })[cur](box);
    }
  };

  // ---------- placement test ----------
  VIEWS.placement = function (m) {
    const box = h("div", { class: "qz panel" });
    let li = 0;
    m.append(back("Home", () => APP.go("home")), h("h1", {}, "Placement test"),
      h("p", { class: "lead" }, "Six questions per level, starting at A1. The test stops at the first level where you score under 70%, and your course starts there. It takes 5–15 minutes."), box);
    const runLevel = () => {
      const L = APP.LEVELS[li];
      APP.runQuiz(box, Q.placementSet(L, 6), { title: "Placement · " + L, onDone: (pct, s, miss, foot) => {
        if (pct >= 70 && li < APP.LEVELS.length - 1) {
          foot.append(h("p", { class: "note" }, `${L}: ${pct}%. Moving on to ${APP.LEVELS[li + 1]}.`), h("button", { class: "btn primary", type: "button", onclick: () => { li++; runLevel(); } }, "Continue to " + APP.LEVELS[li + 1]));
        } else {
          const place = pct >= 70 ? "C2" : L;
          const S = APP.state(); S.placement = place; APP.save();
          foot.append(h("p", {}, h("b", {}, `Your starting level: ${place} (${APP.LEVEL_NAMES[place]}).`), " Earlier levels stay open for review."),
            h("button", { class: "btn primary", type: "button", onclick: () => APP.go("course", place) }, "Go to " + place));
        }
      } });
    };
    runLevel();
  };

  // ---------- settings ----------
  VIEWS.settings = function (m) {
    const S = APP.state();
    const franco = h("select", { id: "set-franco" }, [["show", "Always show Franco under Arabic"], ["after", "Show Franco only after I answer"]].map(([v, l]) => h("option", { value: v, selected: S.settings.franco === v }, l)));
    franco.onchange = () => { S.settings.franco = franco.value; APP.save(); APP.toast("Saved."); };
    const rate = h("input", { type: "range", id: "set-rate", min: "0.5", max: "1.2", step: "0.05", value: S.settings.rate });
    const rateV = h("span", { class: "label" }, S.settings.rate + "×");
    rate.oninput = () => { S.settings.rate = +rate.value; rateV.textContent = rate.value + "×"; };
    rate.onchange = () => { APP.save(); APP.speak("أهلاً، إزيك؟"); };
    const npd = h("input", { type: "number", id: "set-new", min: "5", max: "60", value: S.settings.newPerDay });
    npd.onchange = () => { S.settings.newPerDay = Math.max(5, Math.min(60, +npd.value || 15)); APP.save(); };
    const voiceNote = h("p", { class: "note" }, !APP.tts ? "This browser has no speech synthesis, so audio is off." : APP.voice ? `Voice: ${APP.voice.name} (${APP.voice.lang}). ${/EG/i.test(APP.voice.lang) ? "Egyptian voice found." : "Not an Egyptian voice: it may say ج as “j” and ق as “q”. Trust the Franco."}` : "No Arabic voice found on this device. Install one in your system's speech settings to hear audio.");
    const file = h("input", { type: "file", id: "set-import", accept: "application/json,.json", hidden: true });
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return;
      try { const d = JSON.parse(await f.text()); if (!d || d.v !== 2) throw 0; APP.replaceState(d); APP.save(); APP.toast("Progress imported."); APP.go("home"); }
      catch (e) { APP.toast("That file isn't a Yalla Masri progress file."); }
    };
    const confirmBox = h("span", { hidden: true }, " Erase everything? ", h("button", { class: "btn small danger", type: "button", onclick: () => { APP.reset(); APP.toast("Progress erased."); APP.go("home"); } }, "Erase"), " ", h("button", { class: "btn small ghost", type: "button", onclick: () => (confirmBox.hidden = true) }, "Keep"));
    m.append(h("h1", {}, "Settings"),
      h("section", { class: "panel set" },
        h("label", { for: "set-franco" }, "Franco-Arabic"), franco,
        h("label", { for: "set-rate" }, "Speech speed"), h("div", { class: "row" }, rate, rateV), voiceNote,
        h("label", { for: "set-new" }, "New words per day"), npd),
      h("section", { class: "panel set" }, h("h2", {}, "Your progress"),
        h("p", { class: "note" }, APP.sync.status === "synced" ? "Your progress is saved to your Claude account and follows you across devices." : "Your progress is saved in this browser. Open the page on claude.ai while signed in to sync it to your account."),
        h("div", { class: "row" },
          h("button", { class: "btn", type: "button", onclick: exportProgress }, "Export progress"),
          h("button", { class: "btn", type: "button", onclick: () => file.click() }, "Import progress"), file,
          h("button", { class: "btn ghost", type: "button", onclick: () => APP.go("placement") }, "Retake placement test"),
          h("button", { class: "btn ghost danger-t", type: "button", onclick: () => (confirmBox.hidden = false) }, "Reset progress"), confirmBox)),
      h("section", { class: "panel set" }, h("h2", {}, "How Franco-Arabic works"),
        h("div", { class: "franco" }, [["2", "ء ق", "glottal stop"], ["3", "ع", "throat squeeze"], ["7", "ح", "breathy h"], ["kh", "خ", "as in “loch”"], ["gh", "غ", "gargled r"], ["sh", "ش", "sh"], ["aa ii uu", "ا ي و", "long vowels"], ["g", "ج", "hard g in Cairo"]].map(([a, b, c]) => h("div", {}, h("b", {}, a), ar(b), h("small", {}, c)))),
        h("p", { class: "note" }, "Answers are checked leniently: e/i and o/u are treated alike, doubled letters are optional, and you can always type Arabic script instead.")));
  }
  async function exportProgress() {
    const data = JSON.stringify(APP.state(), null, 1);
    try {
      const dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
      if (dl) { await dl.save({ filename: "yalla-masri-progress.json", data }); return; }
    } catch (e) { if (e && e.code && e.code !== "cancelled") APP.toast("The download was blocked."); return; }
    try { await navigator.clipboard.writeText(data); APP.toast("Progress copied to the clipboard. Paste it into a file to keep it."); }
    catch (e) { APP.toast("Export isn't available in this view."); }
  }

  // ---------- boot ----------
  APP.boot = function () {
    document.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => APP.go(b.dataset.nav)));
    let t = (location.hash || "").slice(1);
    if (!t) { try { t = localStorage.getItem("yalla-route") || ""; } catch (e) {} }
    const [r, p, s] = parseToken(t);
    route = r; param = p || null; sub = s || null;
    render();
    APP.initCaps();
  };
})();
