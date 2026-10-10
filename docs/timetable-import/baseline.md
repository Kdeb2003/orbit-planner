# Frozen extraction baseline and verification record (Phase 4A.1)

Recorded after the pre-merge audit. If a recomputation differs, investigate (new PDF revision? parser regression?) instead of editing the numbers. The checks are in `tests/utn/real-pdf.test.ts`; the full list of dates is deliberately **not** published (it is the user's schedule); it is pinned by content hashes.

## Source revision

| | |
|---|---|
| Timetable file | `timetable UTN WiSe26-27_AIR all courses(3).pdf`, 9 pages, created 2026-09-29 11:11 (Adobe Acrobat 26.2), "preliminary as of 28 September 2026 and subject to change" |
| SHA-256 | `e614706789dbbe9bcd35e5c5ea6f14081ba31b6f996575cc2cdf2a867d684df3` |
| Course List file | `Course List winter semester 2027_AIR & HAI_updated(2).pdf`, 4 pages (images only), created 2026-09-29 08:46 (Word), SHA-256 `d7630e997dde76b20c37faf28c35e125e729459279d95af3eb2795a13eccb868` |
| Note | A differently named copy of the timetable existed in Downloads without the `(3)`; it was not used. Always compare the SHA-256 of a new file with the one above. |

## Counts (recomputed from the real PDF)

* 25 week tables, 684 grid cells, 567 sessions in total; **168 selected sessions** on **80 distinct dates**, 2026-10-12 to 2027-03-19; 28 AI Group A sessions excluded.
* Active semester weeks (with at least one selected session): 3-13, 15-20, 23-25. No selected session in weeks 1, 2, 14, 21, 22 and none on Saturdays.
* Per course: AI Basic Group B 28 (14 main + 14 tutorial), Advanced Robotics 31 (15 + 16), NLG 6, NLU 30 (15 + 15), Multimodal 15, LLM 15, Informatics & Society 11, German A2 32. German A2 March blocks: 9 online sessions 13:15-18:15 (weeks 23, 24, 25: Mon, Tue, Fri).
* **29 clashes, all preserved**: AI tutorial B x NLU tutorial 14, Informatics & Society x Multimodal 9, NLG x Robotics tutorial 6. There is no LLM x Robotics clash on 20 Oct (LLM is Tue 10:45, Robotics main is Wed 21 Oct 10:45).
* Source anomalies, kept unresolved: week 1 prints no dates; week 23 Saturday prints 05.03.2027 (a duplicate of Friday), date withheld.
* Pinned by hash: selected-session keys `7fbb7d55...49a`, clash list `d8a25443...bf9`.

## Independent verification

1. **Cross-engine** (`scripts/utn-crosscheck.py`): MuPDF finds the same 684 grid cells and identical text in all of them (0 differences). Weakness: both engines read the same text layer.
2. **Visual** (`scripts/utn-verify-sheets.py`): 43 selected sessions, chosen to cover all 20 active weeks, all 8 courses, group B main and tutorial, every room (ALC1, ALC2, S31, S32, PC-Pool, online), narrow / medium / wide layouts, tables that break across pages (weeks 4, 8, 25), a header separated from its rows (week 8), multi-slot blocks (German 15:00-18:15 and 13:15-18:15, Multimodal block day) and the known clashes, were each compared with a crop of the rendered page: weekday and date header, slot label (time) and the card text. **43 of 43 match; 0 discrepancies.** The earlier 17-session check is included in this number.
3. Honest limit: the visual comparison was done by eye on crops, not by an automatic image-to-text procedure; 168 sessions were not each individually viewed (the other 125 are covered by the cross-engine comparison and the structural checks).
