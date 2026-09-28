// Yalla Masri — language engine: verb conjugation, possessives, numbers,
// clock times and answer normalisation. Everything here is generative, so
// the trainers never run out of fresh items.
(function () {
  const E = (window.ENGINE = {});

  // ---------- persons ----------
  E.PERSONS = [
    { k: "ana", en: "I", ar: "أنا" },
    { k: "enta", en: "you (m)", ar: "إنت" },
    { k: "enti", en: "you (f)", ar: "إنتي" },
    { k: "howwa", en: "he", ar: "هو" },
    { k: "heyya", en: "she", ar: "هي" },
    { k: "e7na", en: "we", ar: "إحنا" },
    { k: "entu", en: "you (pl)", ar: "إنتو" },
    { k: "homma", en: "they", ar: "هم" },
  ];

  // ---------- helpers ----------
  const V = "aeiou";
  const isV = (c) => V.includes(c);
  const split = (s) => { const [tr, ar] = s.split("|"); return { tr, ar }; };
  // Does a Franco stem start with two consonants (sh/kh/gh count as one)?
  function startsCC(tr) {
    let i = 0;
    if (/^(sh|kh|gh)/.test(tr)) i = 2; else i = 1;
    return tr.length > i && !isV(tr[0]) && !isV(tr[i]);
  }
  // Does a Franco word end in two consonants (sh/kh/gh count as one)?
  function endsCC(tr) {
    let s = tr;
    let last = 1;
    if (/(sh|kh|gh)$/.test(s)) last = 2;
    const before = s[s.length - last - 1];
    return before !== undefined && !isV(before) && !isV(s[s.length - 1]);
  }

  // ---------- verbs ----------
  // Verb row: [id, english, class, level, ...stems]  stems are "franco|arabic"
  //   s  sound:     perfect, imperfect            (katab|كتب, ktib|كتب)
  //   h  hollow:    perfect 3rd, perfect 1st/2nd, imperfect
  //   d  defective: perfect 3rd, perfect 1st/2nd, perfect before vowel, imperfect
  //   g  geminate:  perfect 3rd, perfect 1st/2nd, imperfect
  //   x  irregular: full tables in IRREGULAR
  // Options object (optional last element): {pv:"u"} prefix vowel, {v:1} vowel-initial
  // imperfect (aakul), {imp:"kul|كل"} imperative override.
  const VERBS_RAW = [
    // --- A1 ---
    ["write", "to write", "s", "A1", "katab|كتب", "ktib|كتب"],
    ["drink", "to drink", "s", "A1", "shirib|شرب", "shrab|شرب"],
    ["eat", "to eat", "s", "A1", "akal|أكل", "aakul|اكل", { v: 1, imp: "kul|كل" }],
    ["go", "to go", "h", "A1", "raa7|راح", "ru7|رح", "ruu7|روح"],
    ["see", "to see", "h", "A1", "shaaf|شاف", "shuf|شف", "shuuf|شوف"],
    ["say", "to say", "h", "A1", "2aal|قال", "2ul|قل", "2uul|قول"],
    ["sleep", "to sleep", "h", "A1", "naam|نام", "nim|نم", "naam|نام"],
    ["love", "to love, like", "g", "A1", "7abb|حب", "7abbee|حبي", "7ebb|حب"],
    ["speak", "to speak", "s", "A1", "itkallim|اتكلم", "tkallim|تكلم"],
    ["learn", "to learn", "s", "A1", "it3allim|اتعلم", "t3allim|تعلم"],
    ["understand", "to understand", "s", "A1", "fihim|فهم", "fham|فهم"],
    ["know", "to know", "s", "A1", "3irif|عرف", "3raf|عرف"],
    ["work", "to work", "s", "A1", "ishtaghal|اشتغل", "shtaghal|شتغل"],
    ["live", "to live (reside)", "s", "A1", "sikin|سكن", "skun|سكن", { pv: "u" }],
    ["do", "to do, make", "s", "A1", "3amal|عمل", "3mil|عمل"],
    ["come", "to come", "x", "A1"],
    ["want", "to want (verb form)", "x", "A1"],
    ["read", "to read", "d", "A1", "2ara|قرا", "2aree|قري", "2ar|قر", "2ra|قرا"],
    ["buy", "to buy", "d", "A1", "ishtara|اشترى", "ishtaree|اشتري", "ishtar|اشتر", "shtiri|شتري"],
    ["wakeup", "to wake up", "s", "A1", "si7i|صحي", "s7a|صحى", { d: 1 }],
    // --- A2 ---
    ["take", "to take", "s", "A2", "khad|خد", "aakhud|اخد", { v: 1, imp: "khud|خد" }],
    ["give", "to give", "d", "A2", "idda|ادى", "iddee|ادي", "idd|اد", "ddi|دي"],
    ["walk", "to walk", "d", "A2", "mishi|مشي", "mishii|مشي", "mishy|مشي", "mshi|مشي"],
    ["forget", "to forget", "d", "A2", "nisi|نسي", "nisii|نسي", "nisy|نسي", "nsa|نسى"],
    ["be", "to be (was)", "h", "A2", "kaan|كان", "kun|كن", "kuun|كون"],
    ["open", "to open", "s", "A2", "fata7|فتح", "fta7|فتح"],
    ["close", "to close", "s", "A2", "2afal|قفل", "2fil|قفل"],
    ["hear", "to hear", "s", "A2", "simi3|سمع", "sma3|سمع"],
    ["play", "to play", "s", "A2", "li3ib|لعب", "l3ab|لعب"],
    ["godown", "to go down, get off", "s", "A2", "nizil|نزل", "nzil|نزل"],
    ["ride", "to ride, get on", "s", "A2", "rikib|ركب", "rkab|ركب"],
    ["wear", "to wear", "s", "A2", "libis|لبس", "lbis|لبس"],
    ["return", "to come back", "s", "A2", "rigi3|رجع", "rga3|رجع"],
    ["finish", "to finish, be over", "s", "A2", "khilis|خلص", "khlas|خلص"],
    ["send", "to send", "s", "A2", "ba3at|بعت", "b3at|بعت"],
    ["pay", "to pay", "s", "A2", "dafa3|دفع", "dfa3|دفع"],
    ["enter", "to enter", "s", "A2", "dakhal|دخل", "dkhul|دخل", { pv: "u" }],
    ["goout", "to go out", "s", "A2", "kharag|خرج", "khrug|خرج", { pv: "u" }],
    ["sit", "to sit, stay", "s", "A2", "2a3ad|قعد", "23ud|قعد", { pv: "u" }],
    ["order", "to order, ask for", "s", "A2", "talab|طلب", "tlub|طلب", { pv: "u" }],
    ["ask", "to ask", "s", "A2", "sa2al|سأل", "s2al|سأل"],
    ["wash", "to wash", "s", "A2", "ghasal|غسل", "ghsil|غسل"],
    ["cook", "to cook", "s", "A2", "tabakh|طبخ", "tbukh|طبخ", { pv: "u" }],
    ["arrive", "to arrive", "s", "A2", "wisil|وصل", "wsal|وصل"],
    ["bring", "to bring", "h", "A2", "gaab|جاب", "gib|جب", "giib|جيب"],
    ["sell", "to sell", "h", "A2", "baa3|باع", "bi3|بع", "bii3|بيع"],
    ["visit", "to visit", "h", "A2", "zaar|زار", "zur|زر", "zuur|زور"],
    ["getup", "to get up", "h", "A2", "2aam|قام", "2um|قم", "2uum|قوم"],
    ["put", "to put", "g", "A2", "7att|حط", "7attee|حطي", "7utt|حط", { pv: "u" }],
    ["answer", "to answer, reply", "g", "A2", "radd|رد", "raddee|ردي", "rudd|رد", { pv: "u" }],
    ["teach", "to teach", "s", "A2", "3allim|علم", "3allim|علم"],
    ["think", "to think", "s", "A2", "fakkar|فكر", "fakkar|فكر"],
    ["call", "to call, talk to", "s", "A2", "kallim|كلم", "kallim|كلم"],
    ["help", "to help", "s", "A2", "saa3id|ساعد", "saa3id|ساعد"],
    ["try", "to try", "s", "A2", "7aawil|حاول", "7aawil|حاول"],
    ["lookfor", "to look for", "s", "A2", "dawwar|دور", "dawwar|دور"],
    ["clean", "to clean", "s", "A2", "naddaf|نضف", "naddaf|نضف"],
    ["lunch", "to have lunch", "d", "A2", "itghadda|اتغدى", "itghaddee|اتغدي", "itghadd|اتغد", "tghadda|تغدى"],
    ["dinner", "to have dinner", "d", "A2", "it3asha|اتعشى", "it3ashee|اتعشي", "it3ash|اتعش", "t3asha|تعشى"],
    ["watch", "to watch (for fun)", "s", "A2", "itfarrag|اتفرج", "tfarrag|تفرج"],
    ["wait", "to wait", "d", "A2", "istanna|استنى", "istannee|استني", "istann|استن", "stanna|ستنى"],
    ["find", "to find", "d", "A2", "la2a|لقى", "la2ee|لقي", "la2|لق", "l2a|لقى"],
    ["become", "to become, remain", "d", "A2", "bi2i|بقى", "bi2ii|بقي", "bi2y|بقي", "b2a|بقى"],
    ["drive", "to drive", "h", "A2", "saa2|ساق", "su2|سق", "suu2|سوق"],
    ["carry", "to carry, lift", "h", "A2", "shaal|شال", "shil|شل", "shiil|شيل"],
    ["fear", "to be afraid", "h", "A2", "khaaf|خاف", "khuf|خف", "khaaf|خاف"],
    // --- B1 ---
    ["hit", "to hit", "s", "B1", "darab|ضرب", "drab|ضرب"],
    ["break", "to break", "s", "B1", "kasar|كسر", "ksar|كسر"],
    ["hold", "to hold, catch", "s", "B1", "misik|مسك", "msik|مسك"],
    ["stop", "to stand, stop", "s", "B1", "wi2if|وقف", "2af|قف", { pv: "u" }],
    ["memorize", "to memorize", "s", "B1", "7afaz|حفظ", "7faz|حفظ"],
    ["happen", "to happen", "s", "B1", "7asal|حصل", "7sal|حصل"],
    ["succeed", "to succeed, pass", "s", "B1", "nigi7|نجح", "ngaa7|نجح"],
    ["change", "to change", "s", "B1", "ghayyar|غير", "ghayyar|غير"],
    ["arrange", "to arrange, tidy", "s", "B1", "rattib|رتب", "rattib|رتب"],
    ["prepare", "to prepare, get ready", "s", "B1", "gahhiz|جهز", "gahhiz|جهز"],
    ["believe", "to believe", "s", "B1", "sadda2|صدق", "sadda2|صدق"],
    ["explain", "to explain", "s", "B1", "fahhim|فهم", "fahhim|فهم"],
    ["cry", "to cry", "s", "B1", "3ayyat|عيط", "3ayyat|عيط"],
    ["fix", "to fix, repair", "s", "B1", "salla7|صلح", "salla7|صلح"],
    ["meet", "to meet", "s", "B1", "2aabil|قابل", "2aabil|قابل"],
    ["discuss", "to discuss", "s", "B1", "naa2ish|ناقش", "naa2ish|ناقش"],
    ["marry", "to get married", "s", "B1", "itgawwiz|اتجوز", "tgawwiz|تجوز"],
    ["belate", "to be late", "s", "B1", "it2akhkhar|اتأخر", "t2akhkhar|تأخر"],
    ["graduate", "to graduate", "s", "B1", "itkharrag|اتخرج", "tkharrag|تخرج"],
    ["enjoy", "to enjoy oneself", "s", "B1", "inbasat|انبسط", "nbisit|نبسط"],
    ["need", "to need", "h", "B1", "i7taag|احتاج", "i7tag|احتج", "7taag|حتاج"],
    ["choose", "to choose", "h", "B1", "ikhtaar|اختار", "ikhtar|اختر", "khtaar|ختار"],
    ["rest", "to rest", "h", "B1", "irtaa7|ارتاح", "irta7|ارتح", "rtaa7|رتاح"],
    ["use", "to use", "s", "B1", "ista3mil|استعمل", "sta3mil|ستعمل"],
    ["sing", "to sing", "d", "B1", "ghanna|غنى", "ghannee|غني", "ghann|غن", "ghanni|غني"],
    ["let", "to let, leave", "d", "B1", "khalla|خلى", "khallee|خلي", "khall|خل", "khalli|خلي"],
    ["show", "to show", "d", "B1", "warra|ورى", "warree|وري", "warr|ور", "warri|وري"],
    ["throw", "to throw", "d", "B1", "rama|رمى", "ramee|رمي", "ram|رم", "rmi|رمي"],
    ["feel", "to feel", "g", "B1", "7ass|حس", "7assee|حسي", "7iss|حس"],
    ["solve", "to solve", "g", "B1", "7all|حل", "7allee|حلي", "7ill|حل"],
    ["count", "to count", "g", "B1", "3add|عد", "3addee|عدي", "3idd|عد"],
    ["pass", "to pass by", "h", "B1", "faat|فات", "fut|فت", "fuut|فوت"],
    ["livelife", "to live (be alive)", "h", "B1", "3aash|عاش", "3ish|عش", "3iish|عيش"],
    ["fly", "to fly", "h", "B1", "taar|طار", "tir|طر", "tiir|طير"],
    // --- B2+ ---
    ["translate", "to translate", "s", "B2", "targim|ترجم", "targim|ترجم"],
    ["quarrel", "to quarrel", "s", "B2", "itkhaani2|اتخانق", "tkhaani2|تخانق"],
    ["agree", "to come to an agreement", "s", "B2", "ittafa2|اتفق", "ttifi2|تفق"],
    ["besurprised", "to find strange", "s", "B2", "istaghrab|استغرب", "staghrab|ستغرب"],
    ["wish", "to wish", "d", "B2", "itmanna|اتمنى", "itmannee|اتمني", "itmann|اتمن", "tmanna|تمنى"],
    ["deserve", "to deserve", "s", "B2", "ista7a22|استحق", "sta7a22|ستحق"],
    ["imagine", "to imagine", "s", "B2", "itkhayyil|اتخيل", "tkhayyil|تخيل"],
    ["complain", "to complain", "d", "B2", "ishtaka|اشتكى", "ishtakee|اشتكي", "ishtak|اشتك", "shtiki|شتكي"],
    ["expect", "to expect", "s", "B2", "itwa22a3|اتوقع", "twa22a3|توقع"],
  ];

  // Irregular verbs: full tables, 8 persons each.
  const IRREGULAR = {
    come: {
      past: ["geet|جيت", "geet|جيت", "geeti|جيتي", "geh|جه", "gat|جت", "geena|جينا", "geetu|جيتوا", "gum|جم"],
      sub: ["aagi|آجي", "tiigi|تيجي", "tiigi|تيجي", "yiigi|ييجي", "tiigi|تيجي", "niigi|نيجي", "tiigu|تيجوا", "yiigu|ييجوا"],
      pres: ["baagi|باجي", "bitiigi|بتيجي", "bitiigi|بتيجي", "biyiigi|بييجي", "bitiigi|بتيجي", "biniigi|بنيجي", "bitiigu|بتيجوا", "biyiigu|بييجوا"],
      fut: ["haagi|هاجي", "hatiigi|هتيجي", "hatiigi|هتيجي", "hayiigi|هييجي", "hatiigi|هتيجي", "haniigi|هنيجي", "hatiigu|هتيجوا", "hayiigu|هييجوا"],
      imp: ["ta3aala|تعالى", "ta3aali|تعالي", "ta3aalu|تعالوا"],
      negpast: ["mageetsh|ماجيتش", "mageetsh|ماجيتش", "mageetiish|ماجيتيش", "magaash|ماجاش", "magatsh|ماجتش", "mageenaash|ماجيناش", "mageetuush|ماجيتوش", "maguush|ماجوش"],
    },
    want: {
      // Egyptian "want" is the participle 3aayiz, which agrees in gender/number.
      pres: ["3aayiz / 3ayza|عايز / عايزة", "3aayiz|عايز", "3ayza|عايزة", "3aayiz|عايز", "3ayza|عايزة", "3ayziin|عايزين", "3ayziin|عايزين", "3ayziin|عايزين"],
    },
  };

  function parseVerb(row) {
    const [id, en, cls, level, ...rest] = row;
    const opt = rest.length && typeof rest[rest.length - 1] === "object" ? rest.pop() : {};
    const v = { id, en, cls, level, opt };
    if (cls === "x") { v.irr = IRREGULAR[id]; return v; }
    if (cls === "s" && opt.d) {
      // defective written in sound shorthand (si7i/yis7a)
      const p = split(rest[0]), i = split(rest[1]);
      v.cls = "d";
      v.p3 = p; v.p1 = { tr: p.tr + "i", ar: p.ar }; v.pV = { tr: p.tr.slice(0, -1) + "y", ar: p.ar }; v.i = i;
      return v;
    }
    if (cls === "s") {
      const p = split(rest[0]);
      v.p3 = p; v.p1 = p;
      const m = p.tr.match(/^([^aeiou]+)i([^aeiou]+)i([^aeiou]+)$/);
      v.pV = m ? { tr: m[1] + "i" + m[2] + m[3], ar: p.ar } : p;
      v.i = split(rest[1]);
    } else if (cls === "h" || cls === "g") {
      v.p3 = split(rest[0]); v.p1 = split(rest[1]); v.pV = v.p3; v.i = split(rest[2]);
    } else if (cls === "d") {
      v.p3 = split(rest[0]); v.p1 = split(rest[1]); v.pV = split(rest[2]); v.i = split(rest[3]);
    }
    return v;
  }
  E.VERBS = VERBS_RAW.map(parseVerb);
  E.VERB = Object.fromEntries(E.VERBS.map((v) => [v.id, v]));

  E.TENSES = [
    { k: "past", en: "Past", note: "katabt = I wrote" },
    { k: "pres", en: "Present (b-)", note: "baktib = I write / am writing" },
    { k: "fut", en: "Future (ha-)", note: "haktib = I will write" },
    { k: "sub", en: "Bare imperfect", note: "used after 3aayiz, laazim, mumkin: 3aayiz aktib" },
    { k: "imp", en: "Imperative", note: "iktib = write!" },
    { k: "negpast", en: "Negative past", note: "makatabtish = I didn't write" },
    { k: "negpres", en: "Negative present", note: "mabaktibsh = I don't write" },
    { k: "negfut", en: "Negative future", note: "mish haktib = I won't write" },
    { k: "negimp", en: "Negative imperative", note: "matiktibsh = don't write!" },
  ];

  // Imperfect stems for 2fs (-i) and plural (-u)
  function impStems(v) {
    const i = v.i;
    if (v.cls === "d") {
      const base = i.tr.replace(/[aeiou]$/, ""), abase = i.ar.replace(/[يىا]$/, "");
      return { I: { tr: base + "i", ar: abase + "ي" }, U: { tr: base + "u", ar: abase + "و" } };
    }
    return { I: { tr: i.tr + "i", ar: i.ar + "ي" }, U: { tr: i.tr + "u", ar: i.ar + "و" } };
  }
  const withAlef = (ar) => (ar.endsWith("و") ? ar + "ا" : ar);

  // bare imperfect forms (8 persons), returned as {tr, ar} with alef-less plurals for negation
  function subForms(v) {
    const { I, U } = impStems(v), i = v.i;
    const pv = v.opt.pv || "i";
    if (v.opt.v) {
      // vowel-initial imperfect (aakul): prefixes are bare consonants
      const arStem = i.ar; // "اكل"
      const mk = (c, arc, st) => ({ tr: c + st.tr, ar: arc + st.ar });
      return [
        { tr: i.tr, ar: "آ" + arStem.slice(1) },
        mk("t", "ت", i), mk("t", "ت", I), mk("y", "ي", i), mk("t", "ت", i), mk("n", "ن", i), mk("t", "ت", U), mk("y", "ي", U),
      ];
    }
    const mk = (c, arc, st) => ({ tr: c + pv + st.tr, ar: arc + st.ar });
    return [
      { tr: "a" + i.tr, ar: "أ" + i.ar },
      mk("t", "ت", i), mk("t", "ت", I), mk("y", "ي", i), mk("t", "ت", i), mk("n", "ن", i), mk("t", "ت", U), mk("y", "ي", U),
    ];
  }
  function pastForms(v) {
    const { p1, p3, pV } = v;
    return [
      { tr: p1.tr + "t", ar: p1.ar + "ت" },
      { tr: p1.tr + "t", ar: p1.ar + "ت" },
      { tr: p1.tr + "ti", ar: p1.ar + "تي" },
      { tr: p3.tr, ar: p3.ar },
      { tr: pV.tr + "it", ar: pV.ar + "ت" },
      { tr: p1.tr + "na", ar: p1.ar + "نا" },
      { tr: p1.tr + "tu", ar: p1.ar + "تو" },
      { tr: pV.tr + "u", ar: pV.ar + "و" },
    ];
  }
  // With b-/ha- (and ma-t- commands) a stem starting consonant+vowel loses
  // the prefix vowel: yiruu7 → biyruu7, hatruu7; yiktib → biyiktib keeps it.
  const tight = (v, f) => (!v.opt.v && !startsCC(v.i.tr) ? { tr: f.tr[0] + f.tr.slice(2), ar: f.ar } : f);
  function prefixed(v, sub, pre) {
    // pre: "b" or "h"
    sub = sub.map((f, n) => (n ? tight(v, f) : f));
    return sub.map((f, n) => {
      if (n === 0) {
        if (v.opt.v) return { tr: pre + f.tr, ar: (pre === "b" ? "ب" : "ه") + v.i.ar };
        return { tr: pre + "a" + v.i.tr, ar: (pre === "b" ? "ب" : "ه") + v.i.ar };
      }
      return { tr: pre + (pre === "b" ? "i" : "a") + f.tr, ar: (pre === "b" ? "ب" : "ه") + f.ar };
    });
  }
  function impForms(v) {
    if (v.opt.imp) {
      const b = split(v.opt.imp);
      return [b, { tr: b.tr + "i", ar: b.ar + "ي" }, { tr: b.tr + "u", ar: b.ar + "و" }];
    }
    const { I, U } = impStems(v), i = v.i;
    const pre = startsCC(i.tr) ? (v.opt.pv === "u" ? "u" : "i") : "";
    const apre = pre ? "ا" : "";
    return [
      { tr: pre + i.tr, ar: apre + i.ar },
      { tr: pre + I.tr, ar: apre + I.ar },
      { tr: pre + U.tr, ar: apre + U.ar },
    ];
  }
  function neg(f) {
    let tr = f.tr;
    const last = tr[tr.length - 1];
    if (isV(last)) tr = tr + last + "sh";
    else if (endsCC(tr)) tr = tr + "ish";
    else tr = tr + "sh";
    // a long vowel shortens in the new closed syllable: mashaafsh → mashafsh
    tr = tr.replace(/(aa|ii|uu|ee|oo)([^aeiou])sh$/, (m, vv, c) => vv[0] + c + "sh");
    // ma- swallows a word-initial vowel: akalt → makaltish, itkallim → matkallimsh
    if (isV(tr[0])) tr = tr.slice(1);
    let ar = f.ar;
    if (ar.endsWith("وا")) ar = ar.slice(0, -1);
    if (ar.endsWith("ى")) ar = ar.slice(0, -1) + "ا";
    if (/^[اأ]/.test(ar)) ar = ar.slice(1);
    return { tr: "ma" + tr, ar: "ما" + ar + "ش" };
  }

  // Returns array of {tr, ar}: 8 persons, or 3 (m, f, pl) for imperatives.
  E.conjugate = function (id, tense) {
    const v = E.VERB[id];
    if (!v) return null;
    if (v.irr) {
      const t = v.irr;
      const get = (k) => t[k] && t[k].map(split);
      if (t[tense]) return get(tense);
      if (id === "want") return null;
      const base = { past: get("past"), pres: get("pres"), fut: get("fut"), sub: get("sub"), imp: get("imp") };
      if (tense === "negpast") return base.past.map(neg);
      if (tense === "negpres") return base.pres.map(neg);
      if (tense === "negfut") return base.fut.map((f) => ({ tr: "mish " + f.tr, ar: "مش " + f.ar }));
      if (tense === "negimp") return [1, 2, 6].map((n) => neg(base.sub[n]));
      return null;
    }
    const sub = subForms(v);
    const fin = (arr) => arr.map((f) => ({ tr: f.tr, ar: withAlef(f.ar) }));
    switch (tense) {
      case "past": return fin(pastForms(v));
      case "sub": return fin(sub);
      case "pres": return fin(prefixed(v, sub, "b"));
      case "fut": return fin(prefixed(v, sub, "h"));
      case "imp": return fin(impForms(v));
      case "negpast": return pastForms(v).map(neg);
      case "negpres": return prefixed(v, sub, "b").map(neg);
      case "negfut": return fin(prefixed(v, sub, "h")).map((f) => ({ tr: "mish " + f.tr, ar: "مش " + f.ar }));
      case "negimp": return [1, 2, 6].map((n) => neg(tight(v, sub[n])));
    }
    return null;
  };
  E.IMP_PERSONS = [
    { k: "enta", en: "to a man", ar: "إنت" },
    { k: "enti", en: "to a woman", ar: "إنتي" },
    { k: "entu", en: "to a group", ar: "إنتو" },
  ];
  E.verbsUpTo = function (level) {
    const order = ["A1", "A2", "B1", "B2", "C1", "C2"];
    const n = order.indexOf(level);
    return E.VERBS.filter((v) => order.indexOf(v.level) <= n && (v.id !== "want"));
  };

  // ---------- possessive suffixes ----------
  // [english, franco base, arabic base, type]
  // type: "c" consonant-final (kitaab), "cc" ends in two consonants (ism),
  //       "t" feminine -a (3arabeyya → 3arabeyyit-)
  E.NOUNS = [
    ["book", "kitaab", "كتاب", "c"], ["house", "beet", "بيت", "c"], ["name", "ism", "اسم", "cc"],
    ["car", "3arabeyya", "عربية", "t"], ["bag", "shanta", "شنطة", "t"], ["teacher", "ustaaz", "أستاذ", "c"],
    ["phone", "tilifoon", "تليفون", "c"], ["work", "shughl", "شغل", "cc"], ["door", "baab", "باب", "c"],
    ["key", "muftaa7", "مفتاح", "c"], ["apartment", "sha22a", "شقة", "t"], ["room", "ooda", "أوضة", "t"],
    ["money", "filuus", "فلوس", "c"], ["family", "3eela", "عيلة", "t"], ["daughter", "bint", "بنت", "cc"],
    ["bed", "sereer", "سرير", "c"], ["idea", "fikra", "فكرة", "t"], ["dog", "kalb", "كلب", "cc"],
  ];
  E.POSS = [
    { k: "ana", en: "my", s: "i", ar: "ي" },
    { k: "enta", en: "your (m)", s: "ak", ar: "ك" },
    { k: "enti", en: "your (f)", s: "ik", ar: "ك" },
    { k: "howwa", en: "his", s: "u", ar: "ه" },
    { k: "heyya", en: "her", s: "ha", ar: "ها" },
    { k: "e7na", en: "our", s: "na", ar: "نا" },
    { k: "entu", en: "your (pl)", s: "ku", ar: "كو" },
    { k: "homma", en: "their", s: "hum", ar: "هم" },
  ];
  const shorten = (tr) => tr.replace(/(aa|ii|uu|ee|oo)(?=[^aeiou]+$)/, (m) => m[0]);
  E.possess = function (noun, pn) {
    const [, tr, ar, type] = noun;
    const P = E.POSS[pn];
    const consSuffix = /^[^aeiou]/.test(P.s);
    let t, a;
    if (type === "t") {
      let stem = tr.slice(0, -1) + "it";
      if (tr === "ooda") stem = consSuffix ? "oodit" : "oodt";
      t = (consSuffix ? shorten(stem.replace(/it$/, "")) + "it" : stem) + P.s;
      a = ar.slice(0, -1) + "ت" + P.ar;
    } else if (type === "cc") {
      const link = { ha: "aha", na: "ina", ku: "uku", hum: "uhum" };
      t = tr + (consSuffix ? link[P.s] : P.s);
      a = ar + P.ar;
    } else {
      t = (consSuffix ? shorten(tr) : tr) + P.s;
      a = ar + P.ar;
    }
    return { tr: t, ar: a, en: P.en + " " + noun[0] };
  };

  // ---------- numbers ----------
  const ONES = [
    ["sifr", "صفر"], ["waa7id", "واحد"], ["itneen", "اتنين"], ["talaata", "تلاتة"], ["arba3a", "أربعة"],
    ["khamsa", "خمسة"], ["sitta", "ستة"], ["sab3a", "سبعة"], ["tamanya", "تمانية"], ["tis3a", "تسعة"],
    ["3ashara", "عشرة"], ["7idaashar", "حداشر"], ["itnaashar", "اتناشر"], ["talattaashar", "تلتاشر"],
    ["arba3taashar", "أربعتاشر"], ["khamastaashar", "خمستاشر"], ["sittaashar", "ستاشر"],
    ["saba3taashar", "سبعتاشر"], ["tamantaashar", "تمنتاشر"], ["tisa3taashar", "تسعتاشر"],
  ];
  const TENS = [null, null, ["3ishriin", "عشرين"], ["talatiin", "تلاتين"], ["arbi3iin", "أربعين"], ["khamsiin", "خمسين"],
    ["sittiin", "ستين"], ["sab3iin", "سبعين"], ["tamaniin", "تمانين"], ["tis3iin", "تسعين"]];
  const HUNDREDS = [null, ["miyya", "مية"], ["miteen", "ميتين"], ["tultumiyya", "تلتمية"], ["rub3umiyya", "ربعمية"],
    ["khumsumiyya", "خمسمية"], ["suttumiyya", "ستمية"], ["sub3umiyya", "سبعمية"], ["tumnumiyya", "تمنمية"], ["tus3umiyya", "تسعمية"]];
  const THOUSANDS = [null, ["alf", "ألف"], ["alfeen", "ألفين"], ["talat-talaaf", "تلات تلاف"], ["arba3t-alaaf", "أربع تلاف"],
    ["khamast-alaaf", "خمس تلاف"], ["sitt-alaaf", "ست تلاف"], ["saba3t-alaaf", "سبع تلاف"], ["tamant-alaaf", "تمن تلاف"],
    ["tisa3t-alaaf", "تسع تلاف"], ["3ashart-alaaf", "عشر تلاف"]];
  function under100(n) {
    if (n < 20) return ONES[n];
    const t = Math.floor(n / 10), o = n % 10;
    if (!o) return TENS[t];
    return [ONES[o][0] + " w " + TENS[t][0], ONES[o][1] + " و" + TENS[t][1]];
  }
  function under1000(n) {
    const parts = [];
    const h = Math.floor(n / 100), r = n % 100;
    if (h) parts.push(HUNDREDS[h]);
    if (r) parts.push(under100(r));
    return parts;
  }
  E.number = function (n) {
    if (n === 0) return { tr: ONES[0][0], ar: ONES[0][1] };
    const parts = [];
    const th = Math.floor(n / 1000), r = n % 1000;
    if (th) {
      if (th <= 10) parts.push(THOUSANDS[th]);
      else {
        const p = under1000(th);
        parts.push([p.map((x) => x[0]).join(" w ") + " alf", p.map((x) => x[1]).join(" و") + " ألف"]);
      }
    }
    parts.push(...under1000(r));
    return { tr: parts.map((p) => p[0]).join(" w "), ar: parts.map((p) => p[1]).join(" و") };
  };
  E.eastern = (n) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);

  // Counting nouns: [english sg, english pl, sg, dual, plural] (franco|arabic)
  E.COUNT_NOUNS = [
    ["book", "books", "kitaab|كتاب", "kitabeen|كتابين", "kutub|كتب"],
    ["pound", "pounds", "gineeh|جنيه", "gineeheen|جنيهين", "gineeh|جنيه"],
    ["hour", "hours", "saa3a|ساعة", "sa3teen|ساعتين", "saa3aat|ساعات"],
    ["day", "days", "yoom|يوم", "yomeen|يومين", "ayyaam|أيام"],
    ["child", "children", "3ayyil|عيل", "3ayyileen|عيلين", "3iyaal|عيال"],
    ["year", "years", "sana|سنة", "sanateen|سنتين", "siniin|سنين"],
    ["week", "weeks", "usbuu3|أسبوع", "usbu3een|أسبوعين", "asabii3|أسابيع"],
  ];
  const SHORT = [null, null, null, ["talat", "تلات"], ["arba3", "أربع"], ["khamas", "خمس"], ["sitt", "ست"], ["saba3", "سبع"], ["taman", "تمن"], ["tisa3", "تسع"], ["3ashar", "عشر"]];
  E.count = function (n, noun) {
    const [ensg, enpl, sg, du, pl] = noun, S = split(sg), D = split(du), P = split(pl);
    const en = n + " " + (n === 1 ? ensg : enpl);
    if (n === 1) return { tr: S.tr + " waa7id", ar: S.ar + " واحد", en };
    if (n === 2) return { tr: D.tr, ar: D.ar, en };
    if (n <= 10) return { tr: SHORT[n][0] + " " + P.tr, ar: SHORT[n][1] + " " + P.ar, en };
    const num = E.number(n);
    return { tr: num.tr + " " + S.tr, ar: num.ar + " " + S.ar, en };
  };

  // ---------- time ----------
  const HOURS = [null, ["waa7da", "واحدة"], ["itneen", "اتنين"], ["talaata", "تلاتة"], ["arba3a", "أربعة"], ["khamsa", "خمسة"],
    ["sitta", "ستة"], ["sab3a", "سبعة"], ["tamanya", "تمانية"], ["tis3a", "تسعة"], ["3ashara", "عشرة"], ["7idaashar", "حداشر"], ["itnaashar", "اتناشر"]];
  const MINS = {
    0: ["bizzabt", "بالظبط"], 5: ["w khamsa", "وخمسة"], 10: ["w 3ashara", "وعشرة"], 15: ["w rub3", "وربع"], 20: ["w tilt", "وتلت"],
    25: ["w nuss illa khamsa", "ونص إلا خمسة"], 30: ["w nuss", "ونص"], 35: ["w nuss w khamsa", "ونص وخمسة"],
    40: ["illa tilt", "إلا تلت"], 45: ["illa rub3", "إلا ربع"], 50: ["illa 3ashara", "إلا عشرة"], 55: ["illa khamsa", "إلا خمسة"],
  };
  E.time = function (h, m) {
    let hh = m >= 40 ? (h % 12) + 1 : h;
    const H = HOURS[hh], M = MINS[m];
    return { tr: "is-saa3a " + H[0] + " " + M[0], ar: "الساعة " + H[1] + " " + M[1] };
  };

  // ---------- answer checking ----------
  const TASHKEEL = /[ً-ٰٟـ]/g;
  E.hasArabic = (s) => /[؀-ۿ]/.test(s);
  E.normAr = (s) => s.replace(TASHKEEL, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/[^ء-ي]/g, "");
  E.normTr = (s) => s.toLowerCase().replace(/5/g, "kh").replace(/8/g, "gh").replace(/[’'`]/g, "2")
    .replace(/[^a-z0-9]/g, "").replace(/e/g, "i").replace(/o/g, "u").replace(/(.)\1+/g, "$1");
  // expected: {tr, ar} — tr may hold variants separated by " / "
  E.check = function (input, expected) {
    const s = (input || "").trim();
    if (!s) return false;
    if (E.hasArabic(s)) {
      const got = E.normAr(s);
      return String(expected.ar || "").split("/").some((a) => E.normAr(a) === got && got.length > 0);
    }
    const got = E.normTr(s);
    return String(expected.tr || "").split("/").some((t) => E.normTr(t.replace(/\(.*?\)/g, "")) === got && got.length > 0);
  };
})();
