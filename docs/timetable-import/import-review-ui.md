# Import timetable: upload and review UI (Phase 4A.2, checkpoint 1)

Status: **preview only.** The page reads a UTN timetable PDF in the browser and lets the user review it. **Nothing is written** to Supabase, the calendar, localStorage, sessionStorage or IndexedDB, and there is no "import" button. The next checkpoint (confirmed import to the cloud calendar) is not started. A durable provenance/import migration has **not** been implemented and no migration was added.

## Where it is

| Item | Location |
|---|---|
| Route | `#/import-timetable`, lazy-loaded, behind `RequireAuth` when Supabase is configured |
| Entry points | Calendar page ("Import timetable"), Today quick action ("Import timetable (preview)"); Settings' "Import events saved in this browser" is untouched |
| Page and components | `src/pages/ImportTimetablePage.tsx`, `src/components/timetable/` |
| Loader (PDF.js, limits, errors) | `src/timetable/import/loadTimetable.ts` |
| Review model (pure) | `src/timetable/utn/review.ts` |
| Parser (unchanged engine) | `src/timetable/utn/` (only addition: `NO_DATE_REASON` constant in `selection.ts`) |

## Browser parsing and the worker

1. The user picks (or drops) a file. `checkBytes` rejects empty files, files above **25 MB** and content without a `%PDF-` header before any parsing.
2. PDF.js (`pdfjs-dist/legacy/build/pdf.mjs`, the legacy build for older phones) is loaded with a dynamic `import()`, together with `pdf.worker.min.mjs?url`. Vite emits the worker as a hashed asset and the URL carries the production base, so it resolves under `/orbit-planner/assets/` on GitHub Pages and from the dev server locally. The calendar's main bundle only grew by ~0.35 kB (the route and link); the page chunk (~67 kB) and PDF.js (~488 kB) are separate chunks fetched when the import page / a file is used.
3. `extractFromPdf` (Phase 4A.1) runs on the parsed document; progress is reported per page by wrapping `getPage`. The task is destroyed afterwards (`task.destroy()`), the bytes are not kept.
4. PDF.js is opened with `enableXfa: false`, `disableFontFace: true`, `useSystemFonts: false`, `verbosity: 0`, no font/cmap URLs, so it fetches nothing and logs nothing. Output is identical with and without font data (verified in 4A.1).

No request carries the PDF: the Playwright tests record every request during a full preview and assert same-origin GET only, no post data, no `/rest/v1` write, no storage change.

## Errors (nothing is shown as import-ready)

| Case | Result |
|---|---|
| Empty file / not a PDF / > 25 MB | clear message (with the limit) before parsing |
| Encrypted (password) PDF | "password-protected" (PDF.js `PasswordException`) |
| Damaged PDF | "could not be read" |
| Scanned/image-only, other layout, no weeks (`supported: false`) | "not a supported UTN timetable" with the extractor's reason; **no sessions** |
| Anything else | generic "could not be processed"; no file content in the message |

## Course and group selection

The eight defaults come from `SELECTED_COURSES`; every other course code in the PDF is listed as well, unticked, with its legend title (or code). A group picker appears for courses that print two or more groups; **AI Basic defaults to Group B**. "Not decided" keeps all groups and marks them *needs review* (attendance is never assumed). Sessions of another group are counted as "other group (not attended)" and are kept in the extraction, not deleted. Selections are React state only and are **not** synchronised across devices; durable account preferences will be designed separately.

## Review and corrections

Per session: date and weekday, Berlin start/end, title (course name, "— Tutorial"), course code, type, group, room/online, semester week, PDF page(s), slots merged, confidence and warnings, review state (*no issues / needs review / invalid / excluded*), clash badge. Filters: course, week, date, status (needs review, invalid, no issues, edited, clashing, excluded) with empty states.

Corrections (title, date, start, end, room) go through a dialog with validation (real calendar date, 24-hour times, end after start, title 1-120, room ≤ 120, no duplicate of another included session). The extracted values are shown beside each field, changed fields are listed on the row, "Restore extracted values" removes the correction. `ReviewState.edits` stores only differing fields and the parser output is never mutated (unit-tested). A correction that is valid resolves "no usable date"; an undated or invalid-date session is `invalid` and can never be "ready".

Identical consecutive slots stay merged (the 4A.1 default) and the per-slot source cards remain available as provenance (`session.source`, pages shown on the row). A one-event-per-slot option is **deferred**: it would require splitting `TimetableSession` back into its slot cards (data already present in `source`), re-deriving identity per slot and a second clash/summary basis; it is a presentation/mapping change for the import checkpoint, not for the extraction.

## Clashes

Computed from the *current* effective values of included, valid sessions (strict overlap, touching ends do not clash). Shown side by side (stacked on phones) with Edit/Exclude on each half and per course-pair counts. Excluding, correcting or deselecting recalculates them. Clashes never remove a session. The frozen baseline (real PDF): 29 clashes = AI tutorial B × NLU 14, Informatics & Society × Multimodal 9, NLG × Advanced Robotics tutorial 6; there is no LLM × Robotics clash on 20 Oct.

## Source anomalies

Always displayed (grouped by kind with weeks): week 1 undated, week 23 Saturday date header invalid (withheld, not repaired), duplicate date, week gaps; the PDF's own "preliminary" notice is quoted. Each anomaly says whether any selected session is affected.

## Summary step

Sessions selected, excluded by you, other group, needing attention, manual corrections, remaining clashes, per-course counts, date range, anomalies, and the fixed text *"Preview complete. Saving these sessions to your calendar will be available after cloud import verification."* The only actions are navigation (back to sessions, back to calendar, jump to filtered lists).

## Tests

| Suite | What it proves |
|---|---|
| `src/timetable/utn/review.test.ts` | defaults, Group A/B, deselection, clash recalculation, edit/reset, validation, duplicates, undated/malformed dates, filters, source facts, no mutation |
| `tests/utn/generated-pdf.test.ts` | the fixture rendered as a real PDF parses through PDF.js to the same sessions; text-only and image-only PDFs are unsupported |
| `tests/utn/loadTimetable.test.ts` | size/empty/not-PDF checks, error classification, a real encrypted PDF |
| `tests/utn/preview-isolation.test.ts` | the preview code has no storage, network, Supabase/cloud/calendar or logging code |
| `e2e/import-timetable.e2e.ts` | upload in a browser, worker/asset loading, defaults, groups, filters, clashes, corrections, summary, privacy, errors |
| `e2e/import-timetable-responsive.e2e.ts` | 1440/768/390/320 px: no horizontal scroll, dialog fits, clash comparison layout |
| `e2e/import-timetable-auth.e2e.ts` | route protection, no cloud writes, existing cloud calendar still saves |
| `e2e/import-timetable-pages.e2e.ts` | production build under `/orbit-planner/`: lazy chunk + worker are real JS under the base path, hard refresh, no PDF upload |
| optional real-PDF cases | 168 sessions / 29 clashes / per-course counts in the browser; skipped without the private PDF (`UTN_TIMETABLE_PDF` or `../orbit-import-inputs/`) |

## Known limitations

* Preview only; closing or leaving the page discards all choices. No import, no diff against an earlier import, no durable provenance (needs a decision on the optional `event_imports` migration, see [phase-4a2-plan.md](phase-4a2-plan.md)).
* Course choices are not persisted or synchronised.
* The parser supports the UTN drawing conventions only; other layouts and scans fail by design (no OCR).
* The "Edited / extracted" comparison is per session, not per slot.
* Verified locally and on a local production build; **not** verified on the deployed GitHub Pages site.
