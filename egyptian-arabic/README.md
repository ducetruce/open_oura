# Yalla Masri — Egyptian Arabic, A1 to C2

A self-contained web app for learning Egyptian (Cairene) Arabic. It is unrelated
to the Oura clients in this repo and has no build step: open `index.html` through
any static file server (for example `python3 -m http.server` in this folder).

## What's inside

| Part | Where | Size |
| --- | --- | --- |
| Alphabet course (letters, joined forms, vowel marks, numerals) | `data/script.js` | 8 lessons |
| CEFR course: lesson, dialogue, words, drills, culture, reading (B1+), unit test | `data/a1.js` … `data/c2.js` | 50 units, ~1,460 words, ~460 hand-written drills |
| Word bank: themed high-frequency decks | `data/wordbank.js` | 23 decks, ~950 words |
| Generative engine: verb conjugation (9 tenses, 108 verbs), possessive endings, numbers to 999,999, clock times, counting, lenient answer checking | `js/engine.js` | — |
| Question generators, spaced-repetition review, quiz runner, Arabic keyboard | `js/questions.js`, `js/core.js` | — |
| AI tutor: role-play with corrections, writing coach, level-graded reading generator, Q&A, "why was I wrong?" | `js/tutor.js` | — |
| Views and router | `js/views.js` | — |

## Runtime notes

* The AI tutor uses the claude.ai artifact `sample` capability, so it only works
  when the page is opened on claude.ai; everything else works anywhere.
* Progress is stored in `localStorage` and, on claude.ai, synced to the viewer's
  private `data/users/<id>/progress` document (`db` + `user` capabilities).
* Audio uses the browser's speech synthesis with an Arabic (ideally ar-EG) voice.

## Accuracy

Content was written for this app and has not yet been reviewed by a native
speaker. Franco transliteration follows one consistent convention
(2 3 7 kh gh sh, doubled long vowels); real-world spelling varies.
