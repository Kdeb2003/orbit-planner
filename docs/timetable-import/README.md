# Timetable import (Phase 4A.1 extraction, Phase 4A.2 checkpoint 1 preview UI)

| Document | Content |
|---|---|
| [pdf-structure-analysis.md](pdf-structure-analysis.md) | How the UTN semester timetable PDF is built, and what is wrong or ambiguous in it |
| [extraction-design.md](extraction-design.md) | Deterministic extraction method, intermediate data model, mapping onto calendar events, identity/re-import, selection rules, tooling, privacy |
| [baseline.md](baseline.md) | Frozen counts, source revision (SHA-256) and the independent verification record |
| [import-review-ui.md](import-review-ui.md) | The *Import timetable* page (preview only): browser PDF parsing and worker, errors, course/group selection, review and corrections, clashes, anomalies, tests, limits |
| [phase-4a2-plan.md](phase-4a2-plan.md) | Handoff plan for the user-facing import, schema limitations, open questions |

Scope: Phase 4A.1 parses and validates (`src/timetable/utn/`). Phase 4A.2 checkpoint 1 adds a **preview-only** upload-and-review page (`src/pages/ImportTimetablePage.tsx`). Nothing is uploaded, no calendar data is created or changed, and nothing is persisted. Saving to the calendar is the next checkpoint.
