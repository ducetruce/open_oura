// Yalla Masri — question generators for units, trainers, the script course
// and the placement test. All output is in the quiz-runner format (core.js).
(function () {
  const APP = window.APP, E = window.ENGINE;
  const { shuffle, pick } = APP;
  const G = (APP.Q = {});

  // shuffle options, keeping track of the answer
  function mc(label, prompt, options, answer, extra) {
    const idx = shuffle(options.map((_, k) => k));
    return Object.assign({ kind: "mc", label, prompt, options: idx.map((k) => options[k]), answer: idx.indexOf(answer) }, extra || {});
  }
  G.mc = mc;
  const wordOpt = (w, side) => (side === "en" ? { text: w.en } : { ar: w.ar, tr: w.tr });
  const cleanEn = (s) => s.replace(/\s*\((m|f|m \/ f|m \/ f \/ pl)\)\s*$/i, "");

  // ---------- from a unit's hand-written drills ----------
  G.fromDrill = function (d, u) {
    const why = d.why || "";
    if (d.t === "mc") {
      const options = d.opts.map((o) => (E.hasArabic(o) ? { ar: o } : { text: o }));
      return mc("Choose the answer", { text: d.q }, options, d.a, { explain: why });
    }
    if (d.t === "fill") {
      const options = d.opts.map(([ar, tr]) => ({ ar, tr }));
      return mc("Fill the gap", { ar: d.s.replace("___", "…"), tr: d.tr.replace("___", "…"), en: d.en, speak: false }, options, d.a, { explain: why });
    }
    if (d.t === "tr") return { kind: "type", label: "Say it in Egyptian", prompt: { text: d.en }, expect: { ar: d.a[0], tr: d.a[1] }, explain: why };
    if (d.t === "order") return { kind: "order", label: "Build the sentence", ar: d.ar, tr: d.tr, en: d.en };
    return null;
  };

  // ---------- vocabulary questions ----------
  G.vocabQ = function (card, pool, mode) {
    const others = shuffle(pool.filter((w) => w.id !== card.id && cleanEn(w.en) !== cleanEn(card.en) && w.ar !== card.ar)).slice(0, 3);
    if (others.length < 3) mode = "type";
    mode = mode || pick(["ar-en", "en-ar", "listen", "type"]);
    if (!APP.tts && mode === "listen") mode = "ar-en";
    const opts = [card, ...others];
    if (mode === "ar-en") return mc("What does it mean?", { ar: card.ar, tr: card.tr }, opts.map((w) => ({ text: w.en })), 0, { card: card.id, explain: card.note });
    if (mode === "en-ar") return mc("How do you say it?", { text: card.en }, opts.map((w) => ({ ar: w.ar, tr: w.tr })), 0, { card: card.id, explain: card.note });
    if (mode === "listen") return mc("Listen. What does it mean?", { listen: card.ar }, opts.map((w) => ({ text: w.en })), 0, { card: card.id, explain: card.note });
    return { kind: "type", label: "Type it in Egyptian", prompt: { text: card.en }, expect: { ar: card.ar, tr: card.tr }, card: card.id, explain: card.note };
  };
  const unitCards = (u) => APP.unitCardIds(u).map(APP.card);

  // ---------- verbs ----------
  const TENSES_BY_LEVEL = {
    A1: ["pres", "fut", "sub", "imp"], A2: ["past", "pres", "fut", "negpast", "negpres", "imp"],
    B1: ["past", "pres", "fut", "sub", "imp", "negpast", "negpres", "negfut", "negimp"],
  };
  G.tensesFor = (lv) => TENSES_BY_LEVEL[lv] || TENSES_BY_LEVEL.B1;
  G.conjQ = function (verbId, tense, typed) {
    const v = E.VERB[verbId];
    const forms = E.conjugate(verbId, tense);
    if (!forms) return null;
    const T = E.TENSES.find((t) => t.k === tense);
    const imp = tense === "imp" || tense === "negimp";
    const persons = imp ? E.IMP_PERSONS : E.PERSONS;
    const n = Math.floor(Math.random() * forms.length);
    const P = persons[n];
    const right = forms[n];
    const label = `${v.en} · ${T.en}`;
    const prompt = { text: imp ? `${T.en} ${P.en}` : `${P.en} (${P.k}) — ${T.en.toLowerCase()}`, en: `Verb: ${v.en} (${v.p3 ? v.p3.tr : ""})` };
    if (typed) return { kind: "type", label, prompt, expect: right, explain: T.note };
    const seen = new Set([right.tr]);
    const wrong = [];
    for (const f of shuffle(forms)) if (!seen.has(f.tr)) { seen.add(f.tr); wrong.push(f); }
    const otherT = shuffle(G.tensesFor("B1").filter((t) => t !== tense));
    for (const t of otherT) {
      if (wrong.length >= 3) break;
      const fs = E.conjugate(verbId, t); if (!fs || fs.length !== forms.length) continue;
      const f = fs[n]; if (!seen.has(f.tr)) { seen.add(f.tr); wrong.push(f); }
    }
    const options = [right, ...wrong.slice(0, 3)].map((f) => ({ ar: f.ar, tr: f.tr }));
    return mc(label, prompt, options, 0, { explain: T.note });
  };
  G.verbSet = function (ids, level, n, typed) {
    const out = [];
    const tenses = G.tensesFor(level);
    for (let k = 0; k < n * 3 && out.length < n; k++) {
      const q = G.conjQ(pick(ids), pick(tenses), typed);
      if (q) out.push(q);
    }
    return out;
  };

  // ---------- numbers, time, possessives, counting ----------
  G.numberQ = function (max, mode) {
    const n = Math.floor(Math.random() * max) + (max > 20 ? 1 : 0);
    const w = E.number(n);
    mode = mode || pick(["read", "listen", "say"]);
    if (!APP.tts && mode === "listen") mode = "read";
    if (mode === "listen") return { kind: "type", digits: true, label: "Listen and type the number", prompt: { listen: w.ar }, expect: { num: n, ar: w.ar, tr: w.tr } };
    if (mode === "say") return { kind: "type", label: "Say this number in Egyptian", prompt: { text: String(n) + "  ·  " + E.eastern(n) }, expect: w };
    const others = new Set([n]);
    while (others.size < 4) { const d = Math.max(0, n + Math.floor((Math.random() - 0.5) * Math.max(10, n * 0.4))); others.add(d); }
    const opts = [...others].map((x) => ({ ar: E.number(x).ar, tr: E.number(x).tr }));
    return mc("Which is this number?", { text: String(n) + "  ·  " + E.eastern(n) }, opts, 0);
  };
  G.timeQ = function (mode) {
    const h = 1 + Math.floor(Math.random() * 12), m = 5 * Math.floor(Math.random() * 12);
    const t = E.time(h, m), label = `${h}:${String(m).padStart(2, "0")}`;
    mode = mode || pick(["read", "hear", "say"]);
    if (!APP.tts && mode === "hear") mode = "read";
    const seen = new Set([label]); const opts = [{ t, label }];
    while (opts.length < 4) {
      const hh = 1 + Math.floor(Math.random() * 12), mm = 5 * Math.floor(Math.random() * 12), l = `${hh}:${String(mm).padStart(2, "0")}`;
      if (!seen.has(l)) { seen.add(l); opts.push({ t: E.time(hh, mm), label: l }); }
    }
    if (mode === "say") return { kind: "type", label: "Say the time in Egyptian", prompt: { text: label }, expect: t };
    if (mode === "hear") return mc("Listen. What time is it?", { listen: t.ar }, opts.map((o) => ({ text: o.label })), 0);
    return mc("What time is it?", { text: label }, opts.map((o) => ({ ar: o.t.ar, tr: o.t.tr })), 0);
  };
  G.possQ = function (typed) {
    const noun = pick(E.NOUNS), p = Math.floor(Math.random() * 8), r = E.possess(noun, p);
    if (typed) return { kind: "type", label: "Possessive endings", prompt: { text: r.en }, expect: r };
    const seen = new Set([r.tr]), opts = [r];
    for (const k of shuffle([0, 1, 2, 3, 4, 5, 6, 7])) { const x = E.possess(noun, k); if (!seen.has(x.tr)) { seen.add(x.tr); opts.push(x); } if (opts.length === 4) break; }
    return mc("Possessive endings", { text: r.en }, opts.map((o) => ({ ar: o.ar, tr: o.tr })), 0, { explain: "Endings: -i my, -ak/-ik your, -u his, -ha her, -na our, -ku your (pl), -hum their." });
  };
  G.countQ = function () {
    const noun = pick(E.COUNT_NOUNS), n = pick([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20]), r = E.count(n, noun);
    const seen = new Set([r.tr]), opts = [r];
    for (const k of shuffle([1, 2, 3, 5, 8, 10, 11, 13, 20])) { const x = E.count(k, noun); if (!seen.has(x.tr)) { seen.add(x.tr); opts.push(x); } if (opts.length === 4) break; }
    return mc("Counting things", { text: r.en }, opts.map((o) => ({ ar: o.ar, tr: o.tr })), 0, { explain: "1: noun + waa7id · 2: dual (-een) · 3–10: short number + plural · 11+: number + singular." });
  };

  // ---------- dialogue ordering ----------
  G.dialogueQ = function (u) {
    const lines = u.dialogue.lines.filter((l) => l[1].split(" ").length >= 3 && l[1].split(" ").length <= 8);
    if (!lines.length) return null;
    const l = pick(lines);
    return { kind: "order", label: "Rebuild the line from the dialogue", ar: l[1].replace(/[.،؟!?,]/g, "").trim(), tr: l[2].replace(/[.,?!]/g, ""), en: l[3] };
  };

  // ---------- unit sessions ----------
  G.unitPractice = function (u, n) {
    n = n || 12;
    const cards = unitCards(u);
    const qs = [];
    shuffle(u.drills).slice(0, 5).forEach((d) => { const q = G.fromDrill(d, u); if (q) qs.push(q); });
    shuffle(cards).slice(0, 5).forEach((c) => qs.push(G.vocabQ(c, cards)));
    if (u.verbs && u.verbs.length) qs.push(...G.verbSet(u.verbs, u.level, 2));
    (u.gen || []).forEach((g) => { const q = genQ(g); if (q) qs.push(q); });
    const dq = G.dialogueQ(u); if (dq) qs.push(dq);
    return shuffle(qs).slice(0, n);
  };
  G.unitTest = function (u) {
    const cards = unitCards(u);
    const qs = u.drills.map((d) => G.fromDrill(d, u)).filter(Boolean);
    shuffle(cards).slice(0, 4).forEach((c) => qs.push(G.vocabQ(c, cards, pick(["en-ar", "type", "ar-en"]))));
    if (u.verbs && u.verbs.length) qs.push(...G.verbSet(u.verbs, u.level, 2));
    if (u.reading) u.reading.questions.slice(0, 2).forEach((r) => qs.push(mc("Reading: " + u.reading.title, { text: r.q }, r.opts.map((t) => ({ text: t })), r.a)));
    return shuffle(qs).slice(0, 16);
  };
  function genQ(g) {
    if (g === "num") return G.numberQ(100);
    if (g === "time") return G.timeQ();
    if (g === "poss") return G.possQ();
    if (g === "count") return G.countQ();
    return null;
  }

  // ---------- review quiz from SRS cards ----------
  G.reviewQuiz = function (ids, n) {
    const cards = ids.map(APP.card).filter(Boolean);
    const pool = Object.keys(APP.state().srs).map(APP.card).filter(Boolean);
    return shuffle(cards).slice(0, n || 12).map((c) => G.vocabQ(c, pool.length >= 4 ? pool : cards));
  };

  // ---------- script course ----------
  G.letterForms = function (L) {
    const [l, name, , , joins] = L;
    if (l === "ء" || l === "ـّ") return [l];
    if (l === "ة" || l === "ى") return [l, null, null, "ـ" + l];
    if (!joins) return [l, l, "ـ" + l, "ـ" + l];
    return [l, l + "ـ", "ـ" + l + "ـ", "ـ" + l];
  };
  G.scriptQuiz = function (lesson) {
    const upto = window.SCRIPT.slice(0, window.SCRIPT.indexOf(lesson) + 1);
    const allLetters = upto.flatMap((s) => s.letters).filter((L) => L[0] !== "ـّ");
    const letters = lesson.letters.filter((L) => L[0] !== "ـّ");
    const words = upto.flatMap((s) => s.words);
    const qs = [];
    letters.forEach((L) => {
      const others = shuffle(allLetters.filter((x) => x[2] !== L[2])).slice(0, 3);
      qs.push(mc("Which sound does this letter make?", { ar: L[0], speak: false }, [L, ...others].map((x) => ({ text: x[2] + " (" + x[1] + ")" })), 0, { explain: L[3] }));
      const forms = G.letterForms(L).filter(Boolean);
      if (forms.length > 1) {
        const f = pick(forms.slice(1));
        const otherL = shuffle(allLetters.filter((x) => x[0] !== L[0])).slice(0, 3);
        qs.push(mc("This is a joined form. Which letter is it?", { ar: f, speak: false }, [L, ...otherL].map((x) => ({ ar: x[0], tr: x[1] })), 0));
      }
    });
    lesson.words.forEach((w) => {
      const others = shuffle(words.filter((x) => x[0] !== w[0])).slice(0, 3);
      if (others.length === 3) qs.push(mc("How do you read this word?", { ar: w[0], speak: true }, [w, ...others].map((x) => ({ text: x[1] + " — " + x[2] })), 0));
    });
    if (lesson.marks) lesson.marks.forEach((m) => qs.push(mc("What does this mark add?", { ar: m[0], speak: false }, [m, ...lesson.marks.filter((x) => x !== m)].map((x) => ({ text: x[2] + " (" + x[1] + ")" })), 0)));
    if (lesson.numerals) for (let k = 0; k < 3; k++) { const n = Math.floor(Math.random() * 90) + 10; qs.push(mc("Read the Eastern Arabic number", { text: E.eastern(n) }, shuffle([n, n + 1, n + 10, Number(String(n).split("").reverse().join(""))].filter((x, i, a) => a.indexOf(x) === i)).slice(0, 4).sort((a, b) => (a === n ? -1 : b === n ? 1 : 0)).map((x) => ({ text: String(x) })), 0)); }
    return shuffle(qs).slice(0, 14);
  };

  // ---------- placement ----------
  G.placementSet = function (level, n) {
    const us = APP.unitsOf(level);
    const qs = [];
    const drills = shuffle(us.flatMap((u) => u.drills.filter((d) => d.t === "mc" || d.t === "fill").map((d) => [d, u])));
    drills.slice(0, n || 6).forEach(([d, u]) => qs.push(G.fromDrill(d, u)));
    return qs.map((q) => Object.assign(q, { label: "Placement · " + level }));
  };
})();
