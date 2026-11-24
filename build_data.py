"""Regenerate site/data.js from the semester plan spreadsheet.

Usage: python3 build_data.py [path/to/Semesterplan.xlsx]
"""
import glob, json, datetime, os, re, sys
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1:
    SRC = sys.argv[1]
else:
    matches = sorted(glob.glob(os.path.join(HERE, "Semesterplan*.xlsx")))
    if not matches:
        sys.exit("No Semesterplan*.xlsx found in " + HERE)
    SRC = matches[-1]
OUT = os.path.join(HERE, "data.js")

wb = openpyxl.load_workbook(SRC, data_only=True)
ws = wb["Høst 26"]

MAX_COL = 115  # column DK
YEAR = 2026
MONTH_MAP = {"AUGUST": 8, "SEPTEMBER": 9, "OKTOBER": 10, "NOVEMBER": 11, "DESEMBER": 12}

merges = list(ws.merged_cells.ranges)

def merge_for(row, col):
    for m in merges:
        if m.min_row <= row <= m.max_row and m.min_col <= col <= m.max_col:
            return m
    return None

def top_left_value(row, col):
    m = merge_for(row, col)
    if m:
        return ws.cell(row=m.min_row, column=m.min_col).value
    return ws.cell(row=row, column=col).value

# ---------------------------------------------------------------------------
# Column -> date/week/day metadata
# ---------------------------------------------------------------------------
month_labels = []
for c in range(1, MAX_COL + 1):
    v = ws.cell(row=6, column=c).value
    if isinstance(v, str) and v.strip().upper() in MONTH_MAP:
        month_labels.append((c, MONTH_MAP[v.strip().upper()]))
month_labels.sort()

def month_for_col(c):
    cur = 7
    for col, m in month_labels:
        if c >= col:
            cur = m
        else:
            break
    return cur

def week_for_col(c):
    v = top_left_value(2, c)
    return v if isinstance(v, int) else None

col_info = {}
for c in range(5, MAX_COL + 1):
    dom = ws.cell(row=4, column=c).value
    if not isinstance(dom, int):
        continue
    month = month_for_col(c)
    try:
        d = datetime.date(YEAR, month, dom)
    except ValueError:
        continue
    col_info[c] = {
        "date": d.isoformat(),
        "week": week_for_col(c),
        "weekday_iso": d.isoweekday(),
    }

WEEKDAY_NAMES = {1: "Mandag", 2: "Tirsdag", 3: "Onsdag", 4: "Torsdag", 5: "Fredag", 6: "Lørdag", 7: "Søndag"}
WEEKDAY_SHORT = {1: "Man", 2: "Tir", 3: "Ons", 4: "Tor", 5: "Fre", 6: "Lør", 7: "Søn"}

# week-level notes (exam periods etc.) from row 3
week_notes = {}
for c in range(5, MAX_COL + 1):
    v = ws.cell(row=3, column=c).value
    if isinstance(v, str) and v.strip():
        wk = week_for_col(c)
        if wk is not None:
            week_notes[wk] = v.strip()

# single-day notes: row7 staff duty code, row8 event label
day_notes = {}
for c in range(5, MAX_COL + 1):
    staff = ws.cell(row=7, column=c).value
    event = ws.cell(row=8, column=c).value
    if (staff or event) and c in col_info:
        day_notes[col_info[c]["date"]] = {
            "staff": staff.strip() if isinstance(staff, str) else None,
            "event": event.strip() if isinstance(event, str) else None,
        }

# ---------------------------------------------------------------------------
# Staff legend (rows 67-72)
# ---------------------------------------------------------------------------
staff_legend = {}
exam_code_legend = {}
legend_cols_staff = ["BD", "BP", "CB", "CN", "CX"]
legend_cols_exam = ["E", "N", "W", "AH", "AQ"]

from openpyxl.utils import column_index_from_string

for col_letter in legend_cols_staff:
    col = column_index_from_string(col_letter)
    for r in range(68, 73):
        v = ws.cell(row=r, column=col).value
        if isinstance(v, str) and " - " in v:
            code, name = v.split(" - ", 1)
            staff_legend[code.strip()] = name.strip()

for col_letter in legend_cols_exam:
    col = column_index_from_string(col_letter)
    for r in range(68, 72):
        v = ws.cell(row=r, column=col).value
        if isinstance(v, str) and " - " in v:
            code, name = v.split(" - ", 1)
            exam_code_legend[code.strip()] = name.strip()

# ---------------------------------------------------------------------------
# Sections + courses + sessions
# ---------------------------------------------------------------------------
SECTION_HEADER_ROWS = {
    9: "GRUNNSTUDIUM",
    17: "EMNEGRUPPER",
    26: "PRAKSIS / FORDYPNING / TEOLOGI",
    32: "BALA/LEA - ØKONOMI OG ADMINISTRASJON",
    37: "HLT STAVANGER",
    39: "HLT KOMPETANSE",
    42: "ÅRSSTUDIUM I TEOLOGI OG MENIGHETSLEDELSE (DIGITALT)",
    45: "MASTER I TEOLOGI OG VERDIBEVISST LEDELSE",
    56: "ENGLISH BACHELOR PROGRAMS 1st/3rd yr & Theology/Leadership 2nd yr",
}

ORDERED_SECTION_ROWS = sorted(SECTION_HEADER_ROWS.items())


def current_section(row):
    """The spreadsheet's own category heading for a course row."""
    cur = None
    for r, name in ORDERED_SECTION_ROWS:
        if row >= r:
            cur = name
        else:
            break
    return cur

COURSE_CODE_RE = re.compile(r"^[A-ZÅÆØ0-9/]{4,}")

def split_course_name(raw):
    raw = raw.replace("\n", " ").strip()
    raw = re.sub(r"\s+", " ", raw)
    m = COURSE_CODE_RE.match(raw)
    if m and any(ch.isdigit() for ch in m.group(0)):
        code = m.group(0)
        rest = raw[len(code):].strip()
        return code, rest
    return None, raw

from plan_times import (
    LESSON_MINUTES,
    BREAK_MINUTES,
    AFTERNOON_START,
    morning_start,
    block_minutes,
    fmt_time,
    morning_capacity,
    needs_both_blocks,
    split_lessons,
    blocks_for,
    verify_block_model,
    lesson_spans,
)

# ---------------------------------------------------------------------------
# Reduced teaching.
#
# Row 9 of the sheet: "TALL MED FARGE VISER ANTALL OBLIGATORISKE
# UNDERVISNINGSTIMER FOR STUDENTER MED REDUSERT UNDERVISNING PA ANGITT DATO".
# A course offers the reduced option when its dates split into filled and
# unfilled cells sharing one highlight colour; the filled ones are the dates
# such a student must still attend. A course coloured uniformly is merely
# colour-coded, and one using two highlight colours is marking something else.
# Cross-checked against the sheet's own list of courses without the option.
# ---------------------------------------------------------------------------
def fill_key(cell):
    fill = cell.fill
    if not fill.patternType:
        return None
    colour = fill.fgColor
    kind = getattr(colour, "type", None)
    if kind == "rgb":
        value = str(colour.rgb)
        return None if value in ("00000000", "FFFFFFFF") else "rgb:" + value
    if kind == "theme":
        if colour.theme == 0 and abs(colour.tint) < 1e-9:
            return None  # white is the sheet's "no highlight"
        return f"theme:{colour.theme}/{round(colour.tint, 4)}"
    return "other"


courses = []

for row in range(9, 65):
    if row in SECTION_HEADER_ROWS:
        continue
    name_cell = ws.cell(row=row, column=2).value
    if not isinstance(name_cell, str) or not name_cell.strip():
        continue
    total_hours = ws.cell(row=row, column=1).value
    # Column C is merged down each block, so only the anchor row holds the text.
    # It is the finer cohort marker: it splits the English bachelor rows into
    # "Year 1" and "Year 2 & 3 combined", which are separate student groups.
    subcat = top_left_value(row, 3)
    lecturer_raw = ws.cell(row=row, column=4).value
    section = current_section(row)
    code, title = split_course_name(name_cell)

    sessions = []
    notes = []
    c = 5
    while c <= MAX_COL:
        m = merge_for(row, c)
        if m and m.max_col > m.min_col:
            # multi-column merge (may also span extra rows, e.g. a stray
            # formatting artifact): only the anchor row actually holds data,
            # and its hour value is split evenly across the merged columns.
            if m.min_row == row:
                val = ws.cell(row=m.min_row, column=m.min_col).value
                ncols = m.max_col - m.min_col + 1
                if isinstance(val, (int, float)) and val:
                    # A merge spanning several dates holds the whole run's
                    # lesson count, shared evenly across those dates.
                    per_day = val / ncols
                    if float(per_day).is_integer():
                        per_day = int(per_day)
                    highlight = fill_key(ws.cell(row=m.min_row, column=m.min_col))
                    for cc in range(m.min_col, m.max_col + 1):
                        if cc in col_info:
                            info = col_info[cc]
                            sessions.append({
                                "date": info["date"], "week": info["week"],
                                "hours": per_day, "fill": highlight,
                            })
            c = m.max_col + 1
            continue
        cell = ws.cell(row=row, column=c)
        val = cell.value
        if isinstance(val, (int, float)) and val and c in col_info:
            info = col_info[c]
            sessions.append({
                "date": info["date"], "week": info["week"],
                "hours": val, "fill": fill_key(cell),
            })
        elif isinstance(val, str) and val.strip():
            note_date = col_info.get(c, {}).get("date") if c != 5 else None
            notes.append({"date": note_date, "text": val.strip()})
        c += 1

    lecturers = []
    if isinstance(lecturer_raw, str):
        for part in re.split(r"[/,]", lecturer_raw):
            p = part.strip()
            if p:
                lecturers.append(p)

    subcategory = subcat.strip() if isinstance(subcat, str) else None
    # Cohort = finest grouping available. Column C is finer than the category
    # heading where present (it splits the English bachelor rows into "Year 1"
    # and "Year 2 & 3 combined", which are separate student groups).
    cohort = subcategory or section

    highlights = [s["fill"] for s in sessions if s["fill"]]
    plain = [s for s in sessions if not s["fill"]]
    reduced_available = bool(highlights) and bool(plain) and len(set(highlights)) == 1
    for s in sessions:
        # Without the option every date is required, so the flag is only
        # meaningful where the course actually offers reduced teaching.
        s["reduced"] = bool(s["fill"]) if reduced_available else True
        del s["fill"]

    courses.append({
        # Row numbers shift when the sheet is edited, so selections are stored
        # against this instead of the id.
        "key": f"{section}::{code or title}",
        "id": f"c{row}",
        "row": row,
        "code": code,
        "title": title,
        "raw_name": name_cell.replace("\n", " ").strip(),
        "section": section,
        "subcategory": subcategory,
        "cohort": cohort,
        "lecturers": lecturers,
        "lecturer_raw": lecturer_raw,
        "total_hours": total_hours if isinstance(total_hours, (int, float)) else None,
        "reduced_available": reduced_available,
        "sessions": sorted(sessions, key=lambda s: s["date"]),
        "notes": notes,
    })

# ---------------------------------------------------------------------------
# Turn each course-day into its teaching blocks.
#
# A course needing only one block can share the day with another course of the
# same student group: the first by sheet order takes the morning, the next the
# afternoon. A course needing both blocks fills the day by itself, so anything
# else on that date is a parallel group (MA4010 and MA4010E, for instance, are
# the same course taught in Norwegian and in English).
# ---------------------------------------------------------------------------
verified_cases = verify_block_model()

by_cohort_day = {}
for course in courses:
    for session in course["sessions"]:
        by_cohort_day.setdefault((course["cohort"], session["date"]), []).append((course, session))

weekday_of = {info["date"]: info["weekday_iso"] for info in col_info.values()}
shared_days = []

for (cohort, date), entries in sorted(by_cohort_day.items(), key=lambda kv: (kv[0][1], kv[0][0])):
    weekday = weekday_of[date]
    single = sorted(
        (e for e in entries if not needs_both_blocks(e[1]["hours"], weekday)), key=lambda e: e[0]["row"]
    )
    both = [e for e in entries if needs_both_blocks(e[1]["hours"], weekday)]

    for course, session in both:
        session["blocks"] = blocks_for(session["hours"], weekday)

    # Alternate morning/afternoon down the sheet order. With two courses that
    # reproduces the observed pairing; beyond two, the extra courses are
    # parallel groups and simply reuse a block.
    for i, (course, session) in enumerate(single):
        session["blocks"] = blocks_for(session["hours"], weekday, prefer_afternoon=(i % 2 == 1))

    if len(single) > 1:
        shared_days.append(
            (date, cohort, [(c["code"] or c["title"][:14], s["hours"], s["blocks"][0][3]) for c, s in single])
        )

# Expand every course-day into one entry per block, which is what the calendar,
# week and list views each draw.
for course in courses:
    expanded = []
    for session in course["sessions"]:
        day_lessons = session["hours"]
        blocks = session.pop("blocks")
        for start, end, lessons, half in blocks:
            expanded.append(
                {
                    "date": session["date"],
                    "week": session["week"],
                    "hours": lessons,
                    "start": start,
                    "end": end,
                    "half": half,
                    "reduced": session["reduced"],
                    "lessons": lesson_spans(start, lessons),
                    "day_lessons": day_lessons,
                    "blocks_today": len(blocks),
                }
            )
    course["sessions"] = sorted(expanded, key=lambda s: (s["date"], s["start"]))

sections = []
seen = set()
for r, name in ORDERED_SECTION_ROWS:
    if name not in seen:
        sections.append(name)
        seen.add(name)

# Every course must land in a listed section, or it silently vanishes from the
# category filter.
orphans = sorted({c["section"] for c in courses} - set(sections))
if orphans:
    raise SystemExit("Courses in unlisted sections: " + ", ".join(orphans))

all_dates = sorted(set(info["date"] for info in col_info.values()))

data = {
    "plan_id": "h26",
    "term": "Høst 2026",
    "generated_note": "Versjon 04.08.2026 med forbehold om endringer",
    "date_range": {"start": all_dates[0], "end": all_dates[-1]},
    "sections": sections,
    "courses": courses,
    "week_notes": week_notes,
    "day_notes": day_notes,
    "staff_legend": staff_legend,
    "exam_code_legend": exam_code_legend,
    "reduced_teaching_note": ws.cell(row=65, column=5).value,
}

with open(OUT, "w", encoding="utf-8") as f:
    f.write(
        "window.HLT_PLANS = window.HLT_PLANS || {};\n"
        + 'window.HLT_PLANS["h26"] = '
        + json.dumps(data, ensure_ascii=False)
        + ";"
    )

blocks_total = sum(len(c["sessions"]) for c in courses)
course_days = sum(len({s["date"] for s in c["sessions"]}) for c in courses)

print("Source:", SRC)
print("Wrote:", OUT)
print(f"Courses: {len(courses)} | Course-days: {course_days} | Teaching blocks: {blocks_total}")
print(f"Block model verified against {verified_cases}/{verified_cases} real schedule observations")
print(f"Days where two courses of one group split the blocks: {len(shared_days)}")
for date, cohort, items in shared_days:
    detail = " + ".join(f"{code} {n}L {half}" for code, n, half in items)
    print(f"  {date} {cohort[:32]:<33} {detail}")
for c in courses:
    got = sum(s["hours"] for s in c["sessions"])
    if c["total_hours"] and abs(got - c["total_hours"]) > 0.01:
        print(f"  note: {c['code'] or c['title'][:30]} planned {c['total_hours']} lessons, dates sum to {got}")
