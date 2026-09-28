// Yalla Masri — the Arabic script course (8 lessons).
// Letter: [glyph, name, franco sound, how to say it, joins-left?]
window.SCRIPT = [
  {
    id: "s1", title: "How Arabic writing works", sub: "ا ب ت ث and short vowels",
    intro: `<p>Arabic is written <b>right to left</b>, in cursive: most letters join the next letter, so each letter has up to four shapes (alone, start, middle, end). The shapes differ only by small connecting strokes, and the dots are what tell many letters apart.</p>
      <p>Only long vowels are written as letters. Short vowels are small marks above or below, and everyday writing leaves them out. You will learn to read words from their consonants and your knowledge of the language, the same way Egyptians do.</p>`,
    letters: [
      ["ا", "alif", "a / aa", "a long “aa”, or a seat for a vowel at the start of a word", false],
      ["ب", "baa", "b", "b as in “bed”, one dot below", true],
      ["ت", "taa", "t", "t as in “tea”, two dots above", true],
      ["ث", "thaa", "t / s", "“th” in standard Arabic; Cairo says t or s", true],
    ],
    marks: [
      ["بَ", "fat7a", "a", "a short line above: ba"],
      ["بِ", "kasra", "i / e", "a short line below: bi"],
      ["بُ", "damma", "u / o", "a small و above: bu"],
      ["بْ", "sukuun", "no vowel", "a small circle: the consonant stops"],
    ],
    words: [["باب", "baab", "door"], ["بابا", "baaba", "dad"], ["تاب", "taab", "he repented"], ["بات", "baat", "he stayed the night"], ["تابت", "taabit", "she repented"]],
  },
  {
    id: "s2", title: "Long vowels and the throat", sub: "ج ح خ و ي",
    intro: `<p>The letters <span class="ar">ا و ي</span> do double duty. As vowels they write the long sounds <i>aa</i>, <i>uu/oo</i> and <i>ii/ee</i>. At the start of a syllable <span class="ar">و</span> is <i>w</i> and <span class="ar">ي</span> is <i>y</i>.</p>
      <p><span class="ar">ح</span> is one of the two sounds English lacks: a breathy h from deep in the throat, like fogging a mirror while squeezing. Franco writes it as <b>7</b>, because the digit looks like the letter.</p>`,
    letters: [
      ["ج", "giim", "g", "Cairo says a hard g (“gamal”); most other Arabs say j", true],
      ["ح", "7aa", "7", "a strong breathy h from the throat", true],
      ["خ", "khaa", "kh", "like Scottish “loch” or German “Bach”", true],
      ["و", "waaw", "w / uu / oo", "w, or the long vowels uu and oo", false],
      ["ي", "yaa", "y / ii / ee", "y, or the long vowels ii and ee", true],
    ],
    words: [["حب", "7ubb", "love"], ["خوخ", "khookh", "peaches"], ["جوز", "gooz", "husband; walnuts"], ["بيت", "beet", "house"], ["حوت", "7uut", "whale"], ["تاج", "taag", "crown"]],
  },
  {
    id: "s3", title: "Letters that never join forward", sub: "د ذ ر ز",
    intro: `<p>Six letters never connect to the letter after them: <span class="ar">ا د ذ ر ز و</span>. After one of them, the next letter starts fresh, which leaves little gaps inside words. This is normal and helps you spot word shapes.</p>`,
    letters: [
      ["د", "daal", "d", "d as in “door”", false],
      ["ذ", "zaal", "d / z", "“th” as in “this” in standard Arabic; Cairo says d or z", false],
      ["ر", "raa", "r", "a flapped r, like Spanish “pero”", false],
      ["ز", "zeen", "z", "z as in “zoo”", false],
    ],
    words: [["ورد", "ward", "roses"], ["رز", "rozz", "rice"], ["دار", "daar", "home, house"], ["باز", "baaz", "falcon"], ["درج", "durg", "drawer"], ["جديد", "gidiid", "new"]],
  },
  {
    id: "s4", title: "S sounds, plain and heavy", sub: "س ش ص ض",
    intro: `<p>Arabic has “heavy” (emphatic) versions of s, d, t and z. Say them with the back of the tongue raised and the lips slightly rounded; they darken the vowels around them. Franco writes them with the same letters as the plain ones, so learn each word's spelling in Arabic.</p>`,
    letters: [
      ["س", "siin", "s", "s as in “see”", true],
      ["ش", "shiin", "sh", "sh as in “shoe”", true],
      ["ص", "saad", "s (heavy)", "a heavy, dark s", true],
      ["ض", "daad", "d (heavy)", "a heavy, dark d", true],
    ],
    words: [["شاي", "shaay", "tea"], ["شمس", "shams", "sun"], ["صورة", "suura", "picture"], ["ضهر", "dahr", "back; noon"], ["سوس", "suus", "licorice drink"], ["صباح", "sabaa7", "morning"]],
  },
  {
    id: "s5", title: "Heavy t, heavy z, and the famous 3", sub: "ط ظ ع غ",
    intro: `<p><span class="ar">ع</span> is the sound learners fear most: squeeze the muscles of your throat as if about to gag, and voice through it. Franco writes it <b>3</b>, a mirror image of the letter. <span class="ar">غ</span> is a gargled r, like French “Paris”, written <b>gh</b>.</p>`,
    letters: [
      ["ط", "taa (heavy)", "t (heavy)", "a heavy, dark t", true],
      ["ظ", "zaa (heavy)", "z (heavy)", "a heavy z (standard Arabic says a heavy “th”)", true],
      ["ع", "3een", "3", "a voiced squeeze deep in the throat", true],
      ["غ", "gheen", "gh", "a gargled r, as in French “Paris”", true],
    ],
    words: [["عيش", "3eesh", "bread"], ["طبق", "taba2", "plate"], ["غالي", "ghaali", "expensive"], ["ظرف", "zarf", "envelope"], ["عربي", "3arabi", "Arabic"], ["شغل", "shughl", "work"]],
  },
  {
    id: "s6", title: "The Cairo glottal stop", sub: "ف ق ك ل",
    intro: `<p><span class="ar">ق</span> is the letter that marks an Egyptian accent. Standard Arabic says a deep q; Cairo drops it to a glottal stop, the catch in “uh-oh”, written <b>2</b>. So <span class="ar">قهوة</span> is <i>2ahwa</i>, coffee. A few learned words keep the q, such as <span class="ar">القرآن</span> (<i>el-qur2aan</i>).</p>
      <p><span class="ar">ل</span> followed by <span class="ar">ا</span> makes the special joined shape <span class="ar">لا</span>, which is also the word “no” in standard Arabic.</p>`,
    letters: [
      ["ف", "faa", "f", "f as in “far”, one dot above", true],
      ["ق", "2aaf", "2", "a glottal stop in Cairo (q in standard Arabic)", true],
      ["ك", "kaaf", "k", "k as in “kite”", true],
      ["ل", "laam", "l", "l as in “lemon”", true],
    ],
    words: [["قلب", "2alb", "heart"], ["فول", "fuul", "fava beans"], ["كلب", "kalb", "dog"], ["فلوس", "filuus", "money"], ["قلم", "2alam", "pen"], ["لا", "la", "no (standard Arabic)"]],
  },
  {
    id: "s7", title: "The last core letters", sub: "م ن ه",
    intro: `<p>With these three you know every letter of the alphabet. <span class="ar">ه</span> changes shape the most, so spend a moment on its four forms. At the end of a word after a consonant it is often silent in Egyptian pronunciation of pronoun endings: <span class="ar">كتابه</span> is <i>kitaabu</i>, his book.</p>`,
    letters: [
      ["م", "miim", "m", "m as in “moon”", true],
      ["ن", "nuun", "n", "n as in “noon”", true],
      ["ه", "haa", "h", "a light h as in “hat”", true],
    ],
    words: [["مية", "mayya", "water"], ["نوم", "noom", "sleep"], ["هنا", "hina", "here"], ["مين", "miin", "who"], ["نهار", "nahaar", "daytime"], ["منه", "minnu", "from him"]],
  },
  {
    id: "s8", title: "Extra marks and the article", sub: "ة ء ى ـّ ال and numerals",
    intro: `<p><b>Taa marbuuta</b> <span class="ar">ة</span> ends most feminine words and sounds like <i>a</i>; before an ending it turns into <i>t</i>: <span class="ar">عربية</span> <i>3arabeyya</i> → <span class="ar">عربيتي</span> <i>3arabeyyiti</i>, my car.</p>
      <p><b>Hamza</b> <span class="ar">ء</span> is the glottal stop in standard spelling. It sits alone or on a seat: <span class="ar">أ إ ؤ ئ</span>. <b>Alif maqsuura</b> <span class="ar">ى</span> is a word-final <i>a</i> without dots.</p>
      <p><b>Shadda</b> <span class="ar">ـّ</span> doubles a consonant: <span class="ar">حمّام</span> <i>7ammaam</i>. The article <span class="ar">ال</span> means “the”. Before “sun letters” (t, d, r, z, s, sh, n and others made with the tongue tip) its l blends into the next sound: <span class="ar">الشمس</span> is <i>ish-shams</i>, not <i>il-shams</i>.</p>
      <p>Egypt writes digits in the Eastern Arabic style, left to right: <span class="ar">٠ ١ ٢ ٣ ٤ ٥ ٦ ٧ ٨ ٩</span>. Prices, phone numbers and bus numbers all use them.</p>`,
    letters: [
      ["ة", "taa marbuuta", "a / it", "feminine ending, said a; becomes t before an ending", false],
      ["ء", "hamza", "2", "a glottal stop (standard spelling)", false],
      ["ى", "alif maqsuura", "a", "a word-final a written like ي without dots", false],
      ["ـّ", "shadda", "double", "doubles the consonant it sits on", false],
    ],
    words: [["عربية", "3arabeyya", "car"], ["الشمس", "ish-shams", "the sun"], ["القمر", "il-2amar", "the moon"], ["سماء", "samaa2", "sky (formal)"], ["مستشفى", "mustashfa", "hospital"], ["حمّام", "7ammaam", "bathroom"]],
    numerals: true,
  },
];
