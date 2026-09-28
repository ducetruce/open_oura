// Yalla Masri — AI tutor (runs on the viewer's Claude via the `sample`
// capability): conversation role-play with corrections, writing coach,
// level-graded reading generator, and free questions.
(function () {
  const APP = window.APP;
  const { h } = APP;
  const T = (APP.T = {});

  const FRANCO = "Franco-Arabic (Arabizi) transliteration conventions: 2 = hamza and Cairene qaf, 3 = ein, 7 = Haa, kh, gh, sh; long vowels doubled (aa, ii, uu, ee, oo).";
  const LEVEL_STYLE = {
    A1: "very short, simple sentences with the most common words; speak slowly and clearly; one idea per reply",
    A2: "short everyday sentences, common words, simple past and future",
    B1: "natural everyday Egyptian at a moderate pace, some idioms explained by context",
    B2: "natural Egyptian with idioms, discourse markers (ba2a, ya3ni, aslan) and varied tenses",
    C1: "fully natural educated Cairene, idioms, proverbs, humour, and register shifts",
    C2: "completely native Cairene at full richness: idioms, proverbs, wit, cultural references",
  };

  T.SCENARIOS = [
    { lv: "A1", title: "Order at a café", role: "a friendly waiter at a traditional Cairo ahwa taking the learner's order" },
    { lv: "A1", title: "Meet a new neighbour", role: "a new neighbour in the learner's building who wants to get to know them" },
    { lv: "A1", title: "Take a taxi", role: "a chatty Cairo taxi driver; the learner must say where they're going and agree a price" },
    { lv: "A2", title: "Buy clothes", role: "a shop assistant in a Downtown Cairo clothes shop; bargain a little" },
    { lv: "A2", title: "At the pharmacy", role: "a pharmacist; the learner describes symptoms" },
    { lv: "A2", title: "Hotel problem", role: "a hotel receptionist; the learner's air conditioning is broken" },
    { lv: "A2", title: "Make weekend plans", role: "a friend on the phone making plans for the weekend" },
    { lv: "B1", title: "Tell me about your weekend", role: "a curious colleague who asks lots of follow-up questions about the learner's weekend" },
    { lv: "B1", title: "Complain to the landlord", role: "a stubborn landlord; the learner complains about a leak and wants it fixed" },
    { lv: "B1", title: "Discuss a film", role: "a friend who just watched a popular Egyptian film and wants the learner's opinion" },
    { lv: "B2", title: "Informal job interview", role: "a manager at a Cairo start-up interviewing the learner informally" },
    { lv: "B2", title: "Debate: Cairo or the coast?", role: "a friend who argues that living in Cairo is better than moving to the coast; push back" },
    { lv: "B2", title: "Rent a flat", role: "an estate agent (simsaar) showing a flat and negotiating rent" },
    { lv: "C1", title: "Talk-show guest", role: "a talk-show host interviewing the learner about a social issue of their choice, in educated Egyptian" },
    { lv: "C1", title: "Explain a proverb", role: "an Egyptian grandmother who uses proverbs and asks the learner to explain them" },
    { lv: "C2", title: "Condolence visit", role: "a family member receiving condolences; the learner must use the right formulas and tone" },
    { lv: "C2", title: "Witty banter", role: "a quick-witted Egyptian friend teasing the learner; expect and reward 2afshat (comebacks)" },
    { lv: "C2", title: "Formal speech Q&A", role: "an audience member asking sharp questions after the learner's talk" },
  ];

  const convoRules = (lv, role) => `You are playing a role in a conversation with a learner of Egyptian (Cairene) Arabic at CEFR level ${lv}.
Your role: ${role}.
Rules:
- Speak ONLY natural Cairene Egyptian Arabic, never Modern Standard Arabic unless the role needs it. Style: ${LEVEL_STYLE[lv]}.
- Stay in character. Keep each reply to 1-3 sentences and end with something that invites the learner to answer.
- The learner may write in Arabic script, Franco-Arabic or English. If they use English, respond in role anyway and show in the feedback how to say it in Egyptian.
- Reply with ONLY a JSON object: {"reply_ar": "<your reply in Arabic script>", "reply_tr": "<the same reply in ${FRANCO}>", "reply_en": "<English translation>", "feedback": {"ok": <true if the learner's last message was natural and correct>, "corrected_ar": "<a corrected, natural version of the learner's last message in Arabic script, or empty>", "corrected_tr": "<the same in Franco, or empty>", "note": "<one short English tip about the most important error, or a useful alternative phrase if it was fine>"}}.
- For the very first turn (when the learner says START), open the scene yourself and set "feedback" to {"ok": true, "corrected_ar": "", "corrected_tr": "", "note": ""}.`;

  function aiUnavailable() {
    return h("div", { class: "panel ai-off" },
      h("h2", {}, "The AI tutor isn't available here"),
      h("p", {}, "The tutor runs on your own Claude account and only works when this page is opened on claude.ai. It also needs you to allow the page to use Claude when it asks. Everything else in Yalla Masri works without it."));
  }
  T.unavailable = aiUnavailable;

  // ---------- conversation ----------
  T.conversation = function (root, opt) {
    opt = opt || {};
    const lv = opt.level || APP.currentLevel();
    const role = opt.role || T.SCENARIOS[0].role;
    const title = opt.title || "Conversation";
    const turns = [];
    let ctl = null, busy = false;
    const log = h("div", { class: "chat", "aria-live": "polite" });
    const inp = h("textarea", { class: "chat-in", id: "chat-input", rows: 2, dir: "auto", placeholder: "Reply in Arabic, Franco or English…", "aria-label": "Your message" });
    const send = h("button", { class: "btn primary", type: "button", onclick: () => go() }, "Send");
    const stop = h("button", { class: "btn ghost", type: "button", hidden: true, onclick: () => ctl && ctl.abort() }, "Stop");
    const kbBtn = h("button", { class: "btn ghost small", type: "button", onclick: () => { kb.hidden = !kb.hidden; } }, "Arabic keyboard");
    const kb = APP.keyboard(inp); kb.hidden = true;
    const hint = h("button", { class: "btn ghost small", type: "button", onclick: suggest }, "Help me answer");
    root.replaceChildren(
      h("div", { class: "chat-head" }, h("div", {}, h("div", { class: "label" }, "Role-play · " + lv), h("h2", {}, title)),
        h("button", { class: "btn ghost small", type: "button", onclick: () => T.conversation(root, opt) }, "Restart")),
      log, h("div", { class: "chat-bar" }, inp, h("div", { class: "row" }, kbBtn, hint, h("span", { class: "grow" }), stop, send)), kb);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });

    function bubble(who, parts) { const b = h("div", { class: "bubble " + who }, parts); log.append(b); b.scrollIntoView({ block: "end", behavior: "smooth" }); return b; }
    function tutorBubble(d) {
      const tr = h("div", { class: "tr" }, d.reply_tr || "");
      const en = h("div", { class: "en", hidden: true }, d.reply_en || "");
      return [h("div", { class: "row" }, APP.ar(d.reply_ar || "", "chat-ar"), APP.speakBtn(d.reply_ar || "")), tr, en,
        h("button", { class: "linkish", type: "button", onclick: (e) => { en.hidden = !en.hidden; e.currentTarget.textContent = en.hidden ? "Show English" : "Hide English"; } }, "Show English")];
    }
    function feedbackBox(f) {
      if (!f || (f.ok && !f.note)) return null;
      return h("div", { class: "chat-fb " + (f.ok ? "good" : "bad") },
        h("b", {}, f.ok ? "Nice. Tip:" : "Correction:"),
        f.corrected_ar ? h("div", { class: "row" }, APP.ar(f.corrected_ar), APP.speakBtn(f.corrected_ar)) : null,
        f.corrected_tr ? APP.tr(f.corrected_tr) : null,
        f.note ? h("p", { class: "note" }, f.note) : null);
    }
    async function go(isStart) {
      if (busy) return;
      const text = isStart ? "START" : inp.value.trim();
      if (!text) return;
      if (!isStart) { bubble("me", h("div", {}, APP.auto(text))); inp.value = ""; }
      turns.push({ role: "user", content: text });
      const wait = bubble("them pending", h("div", { class: "typing" }, "Thinking…"));
      busy = true; send.disabled = true; stop.hidden = false;
      ctl = new AbortController();
      try {
        const input = [{ role: "user", content: convoRules(lv, role) }, ...turns.slice(-24)];
        const d = await APP.ai.json(input, { signal: ctl.signal, cache: false });
        wait.remove();
        if (!isStart) { const fb = feedbackBox(d.feedback); if (fb) log.lastChild.append(fb); }
        bubble("them", tutorBubble(d));
        APP.speak(d.reply_ar);
        turns.push({ role: "assistant", content: (d.reply_ar || "") + "\n" + (d.reply_tr || "") });
        APP.addXP(3); APP.save();
      } catch (e) {
        wait.remove(); turns.pop();
        const msg = APP.aiError(e);
        if (msg) bubble("sys", msg);
        if (APP.aiState === "off") root.replaceChildren(aiUnavailable());
      } finally { busy = false; send.disabled = false; stop.hidden = true; inp.focus(); }
    }
    async function suggest() {
      if (busy || !turns.length) return;
      hint.disabled = true;
      const last = turns.filter((t) => t.role === "assistant").slice(-1)[0];
      const box = bubble("sys", "Thinking of ideas…");
      try {
        const prompt = `A learner of Egyptian Arabic (level ${lv}) must reply to this line in a role-play: "${last ? last.content : ""}". Give 3 short possible replies suitable for their level, each as Arabic script, then ${FRANCO.split(":")[0]} Franco in parentheses, then English. Plain text, one per line, no preamble.`;
        await APP.ai(prompt, { modelTier: "quick", cache: false, onText: ({ text }) => { box.textContent = text; } });
      } catch (e) { box.textContent = APP.aiError(e); }
      hint.disabled = false;
    }
    go(true);
  };

  // ---------- writing coach ----------
  T.writing = function (root) {
    const lv = APP.currentLevel();
    const topics = {
      A1: ["Introduce yourself and your family", "Describe your flat", "Your daily routine"],
      A2: ["What you did last weekend", "Your last holiday", "Your favourite food and how to make it"],
      B1: ["A funny thing that happened to you", "Your opinion on living in a big city", "A person who influenced you"],
      B2: ["If you could change one thing about your country", "Pros and cons of social media", "A film you'd recommend and why"],
      C1: ["Explain an Egyptian proverb with a story", "A formal email complaining about a service", "Tradition vs modern life in Egypt"],
      C2: ["A short colloquial poem or monologue", "A speech for a friend's wedding", "An op-ed in educated Egyptian"],
    };
    const topicSel = h("select", { id: "w-topic", "aria-label": "Topic" }, ["(my own topic)", ...(topics[lv] || [])].map((t) => h("option", {}, t)));
    const ta = h("textarea", { id: "w-text", class: "w-in", rows: 8, dir: "auto", placeholder: "Write in Egyptian Arabic (Arabic script or Franco)…", "aria-label": "Your text" });
    const kb = APP.keyboard(ta); kb.hidden = true;
    const out = h("div", { class: "ai-text", "aria-live": "polite" });
    let ctl = null;
    const btn = h("button", { class: "btn primary", type: "button", onclick: run }, "Correct my writing");
    const stop = h("button", { class: "btn ghost", type: "button", hidden: true, onclick: () => ctl && ctl.abort() }, "Stop");
    root.replaceChildren(h("h2", {}, "Writing coach"),
      h("p", { class: "note" }, `Write a few sentences at your level (${lv}). You'll get a corrected version, the reason for each change, a more native way to say it, and a score.`),
      h("div", { class: "bar" }, h("label", { class: "label", for: "w-topic" }, "Topic"), topicSel),
      ta, h("div", { class: "row" }, h("button", { class: "btn ghost small", type: "button", onclick: () => { kb.hidden = !kb.hidden; } }, "Arabic keyboard"), h("span", { class: "grow" }), stop, btn), kb, out);
    async function run() {
      const text = ta.value.trim();
      if (!text) { APP.toast("Write something first."); return; }
      btn.disabled = true; stop.hidden = false; out.textContent = "Thinking…";
      ctl = new AbortController();
      const topic = topicSel.value.startsWith("(") ? "free topic" : topicSel.value;
      const prompt = `You are an expert teacher of Egyptian (Cairene) Arabic. A CEFR ${lv} learner wrote this text on the topic "${topic}":\n\n${text}\n\nRespond in English with these sections, using plain text with short headings in capitals:\nCORRECTED: the full corrected text in natural Egyptian Arabic, in Arabic script, then again in ${FRANCO}\nCHANGES: a numbered list of each correction with a one-line reason (grammar, vocabulary, register, MSA vs Egyptian)\nMORE NATIVE: how an educated Cairene would say it, in Arabic script and Franco\nSCORE: accuracy, range, and naturalness out of 10 each, and one thing to practise next.`;
      try {
        await APP.ai(prompt, { signal: ctl.signal, cache: false, onText: ({ text }) => { out.textContent = text; } });
        APP.addXP(10); APP.save();
      } catch (e) { const m = APP.aiError(e); if (m) out.textContent = (e.text ? e.text + "\n\n" : "") + m; }
      btn.disabled = false; stop.hidden = true;
    }
  };

  // ---------- reading generator ----------
  T.reading = function (root) {
    const lvSel = h("select", { id: "r-level", "aria-label": "Level" }, APP.LEVELS.map((l) => h("option", { selected: l === APP.currentLevel() }, l)));
    const topic = h("input", { id: "r-topic", type: "text", placeholder: "Topic (e.g. football, a wedding, the metro, a folk tale)", "aria-label": "Topic" });
    const btn = h("button", { class: "btn primary", type: "button", onclick: run }, "Write me a text");
    const out = h("div", { class: "gen-read" });
    root.replaceChildren(h("h2", {}, "Reading room"),
      h("p", { class: "note" }, "Get a new Egyptian Arabic text written for your level, with Franco, translation, key words and questions. Save the new words to your review deck."),
      h("div", { class: "bar" }, h("label", { class: "label", for: "r-level" }, "Level"), lvSel, topic, btn), out);
    async function run() {
      const lv = lvSel.value, tp = topic.value.trim() || "daily life in Cairo";
      btn.disabled = true; out.replaceChildren(h("p", { class: "note" }, "Writing your text… this can take up to a minute."));
      const len = { A1: "60-80", A2: "90-120", B1: "140-180", B2: "180-230", C1: "230-280", C2: "280-350" }[lv];
      const prompt = `Write an original text in natural Egyptian (Cairene) Arabic, NOT Modern Standard Arabic, for a CEFR ${lv} learner, about: ${tp}. Length ${len} words, split into 4-7 short paragraphs or sentence groups. Language style: ${LEVEL_STYLE[lv]}.
Reply with ONLY JSON: {"title": "<English title>", "paragraphs": [{"ar": "<Arabic script>", "tr": "<${FRANCO}>", "en": "<English translation>"}], "vocab": [{"ar": "...", "tr": "...", "en": "..."}], "questions": [{"q": "<comprehension question in English>", "options": ["<correct answer>", "<wrong>", "<wrong>", "<wrong>"], "answer": 0}]}
Give 8-12 useful vocab items from the text and 4 questions. In each question put the correct option at the index given by "answer".`;
      try {
        const d = await APP.ai.json(prompt, { cache: false });
        renderReading(d, lv);
        APP.addXP(5); APP.save();
      } catch (e) { out.replaceChildren(h("p", { class: "bad-t" }, APP.aiError(e) || "Stopped.")); }
      btn.disabled = false;
    }
    function renderReading(d, lv) {
      const paras = Array.isArray(d.paragraphs) ? d.paragraphs : [];
      const vocab = Array.isArray(d.vocab) ? d.vocab.filter((v) => v && v.ar && v.en) : [];
      const qs = Array.isArray(d.questions) ? d.questions : [];
      const showEn = h("input", { type: "checkbox", id: "r-en" });
      const body = h("div", { class: "reading-text" }, paras.map((p) => h("div", { class: "rline" },
        h("div", { class: "row" }, APP.ar(p.ar || "", "r-ar"), APP.speakBtn(p.ar || "")), APP.tr(p.tr || ""), h("div", { class: "en r-en", hidden: true }, p.en || ""))));
      showEn.onchange = () => body.querySelectorAll(".r-en").forEach((x) => (x.hidden = !showEn.checked));
      const save = h("button", { class: "btn", type: "button", onclick: () => {
        const S = APP.state();
        const ids = vocab.map((v) => { S.custom.push({ ar: v.ar, tr: v.tr || "", en: v.en }); return "c:" + (S.custom.length - 1); });
        const n = APP.addCards(ids); APP.save(); save.disabled = true; APP.toast(n + " words added to your review deck.");
      } }, "Add words to review");
      const quiz = h("div", {});
      const valid = qs.filter((q) => q && q.q && Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer < q.options.length);
      out.replaceChildren(h("h3", {}, d.title || "Your text", " ", h("span", { class: "chip" }, lv)),
        h("label", { class: "check" }, showEn, " Show English"), body,
        vocab.length ? h("div", {}, h("h3", {}, "Key words"), h("div", { class: "wordlist" }, vocab.map((v) => h("div", { class: "witem" }, APP.ar(v.ar), APP.speakBtn(v.ar), APP.tr(v.tr || ""), h("span", {}, v.en)))), save) : null,
        valid.length ? h("div", {}, h("h3", {}, "Check your understanding"), h("button", { class: "btn primary", type: "button", onclick: () => APP.runQuiz(quiz, valid.map((q) => APP.Q.mc("Reading", { text: q.q }, q.options.map((t) => ({ text: String(t) })), q.answer)), { title: "Reading" }) }, "Start questions"), quiz) : null);
    }
  };

  // ---------- ask anything ----------
  T.ask = function (root) {
    const ta = h("textarea", { id: "ask-text", rows: 3, dir: "auto", placeholder: "e.g. What's the difference between lissa and ba2a? How do I say “I'm running late”?", "aria-label": "Your question" });
    const out = h("div", { class: "ai-text", "aria-live": "polite" });
    let ctl = null;
    const btn = h("button", { class: "btn primary", type: "button", onclick: run }, "Ask");
    const stop = h("button", { class: "btn ghost", type: "button", hidden: true, onclick: () => ctl && ctl.abort() }, "Stop");
    root.replaceChildren(h("h2", {}, "Ask the tutor"),
      h("p", { class: "note" }, "Grammar, vocabulary, culture, slang, a sentence you heard, a song lyric: ask anything about Egyptian Arabic."),
      ta, h("div", { class: "row" }, h("span", { class: "grow" }), stop, btn), out);
    async function run() {
      const q = ta.value.trim(); if (!q) return;
      btn.disabled = true; stop.hidden = false; out.textContent = "Thinking…";
      ctl = new AbortController();
      const prompt = `You are a warm, precise teacher of Egyptian (Cairene) Arabic for a CEFR ${APP.currentLevel()} learner. Answer the question below in English, in plain text (no markdown tables). Every Arabic example must be in Egyptian Arabic (not MSA unless asked), written in Arabic script followed by ${FRANCO.split(":")[0]} in parentheses and an English gloss. Be concise but complete.\n\nQuestion: ${q}`;
      try { await APP.ai(prompt, { signal: ctl.signal, cache: false, onText: ({ text }) => { out.textContent = text; } }); }
      catch (e) { const m = APP.aiError(e); if (m) out.textContent = (e.text ? e.text + "\n\n" : "") + m; }
      btn.disabled = false; stop.hidden = true;
    }
  };

  // ---------- a unit-specific task (free-form, streamed) ----------
  T.task = function (root, task, level) {
    T.conversation(root, { level, title: task.title, role: `a tutor running this exercise with the learner: ${task.prompt} Keep the JSON reply format: put your turn in reply_ar/reply_tr/reply_en (you may use English in reply_en for instructions), and your corrections in feedback.` });
  };
})();
