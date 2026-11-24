# HLT Semesterplan

Interactive view of HLT's semester plans: calendar, weekly timetable, list,
subject overview and statistics, with a course filter and calendar export.

The repository root is the website: GitHub Pages serves it from `main` at `/`.
A single-file build of the same site is also written to `docs/index.html`.

## Semesters

| Plan | Source | Built by |
|---|---|---|
| Høst 2026 | `Semesterplan-H26 8.xlsx` | `build_data.py` |
| Vår 2027 | `Semesterplan-V27.pdf` | `build_v27.py` |
| H26 exams | `Oversikt over eksamensdatoer_Canvas_H26.pdf` | `build_exams.py` |

Each semester registers itself into `window.HLT_PLANS`, so adding a term means
shipping one more data file.

## Rebuilding

```bash
python3 build_data.py        # autumn plan  -> data.js
python3 build_exams.py       # autumn exams -> exams.js
python3 build_v27.py         # spring plan  -> data-v27.js
python3 stamp_assets.py      # cache-busting hashes in index.html
python3 build_standalone.py  # single-file build -> docs/index.html
```

Run `stamp_assets.py` before deploying: without it a returning visitor keeps a
cached `data.js` and sees a stale plan.

Requires `openpyxl`, `pdfplumber` and `pypdf`.

## How times are worked out

The plans record teaching hours per day, never clock times. One hour is a
45-minute lesson with a 15-minute break between lessons, and teaching runs in
two fixed blocks: mornings from 09:00 (Mondays 10:00) and afternoons always
from 12:30. `plan_times.py` holds that model and asserts it against seven
sittings taken from the published schedule; the builders fail rather than emit
times that no longer match.

## Admin

`#admin` on the site (PIN in `admin.js`) accepts an updated autumn spreadsheet,
parses it in the browser and can download a replacement data file. The PIN only
hides the panel from casual visitors — it is readable in the source and is not
security. The spring plan comes from a PDF and is built by script only.
