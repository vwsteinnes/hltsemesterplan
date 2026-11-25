"""Build site/data-v27.js from Semesterplan-V27.pdf.

The spring plan arrives as a one-page landscape PDF rather than a spreadsheet,
so the grid is read positionally: the DAG row of weekday letters gives the
column spine, and every other value is matched to a column by its x position.

The document checks itself — each course prints "Sum timer", "Planlagt
timetall" and "Avvik" — so the build asserts the hours it reads against the
sum the plan states, and fails rather than shipping a silent mismatch.

Usage: python3 build_v27.py
"""
import datetime
import json
import os
import re
import sys

import pdfplumber

from plan_times import blocks_for, lesson_spans, needs_both_blocks, verify_block_model

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "Semesterplan-V27.pdf")
OUT = os.path.join(HERE, "data-v27.js")

PLAN_ID = "v27"
TERM = "Vår 2027"
YEAR = 2027

# Letters that appear in a grid cell instead of an hour count.
CELL_MARKERS = {"P": "Praksis", "T": "Tur", "F": "Fri", "X": "Merket"}

WEEKDAY_LETTERS = "MTOFL"
NOR_WEEKDAY = {1: "M", 2: "T", 3: "O", 4: "T", 5: "F", 6: "L", 7: "S"}


def mid(obj):
    return (obj["x0"] + obj["x1"]) / 2


def group_adjacent(chars, gap=1.2):
    """Join characters that sit side by side into one token."""
    out = []
    for c in sorted(chars, key=lambda c: c["x0"]):
        if out and c["x0"] - out[-1][-1]["x1"] < gap:
            out[-1].append(c)
        else:
            out.append([c])
    return [("".join(x["text"] for x in g), (g[0]["x0"] + g[-1]["x1"]) / 2) for g in out]


def unrotate(words):
    """Rotated labels read bottom-to-top with each word's characters reversed."""
    by_x = {}
    for w in words:
        by_x.setdefault(round(mid(w) / 4) * 4, []).append(w)
    out = []
    for x, group in by_x.items():
        group.sort(key=lambda w: -w["top"])
        text = " ".join(w["text"][::-1] for w in group).strip()
        if text:
            out.append((text, sum(mid(w) for w in group) / len(group)))
    return out


def main():
    if not os.path.exists(SRC):
        sys.exit("Missing " + SRC)
    page = pdfplumber.open(SRC).pages[0]
    chars = [c for c in page.chars if c.get("upright", True)]
    words = page.extract_words(extra_attrs=["upright"])
    upright = [w for w in words if w.get("upright", True)]
    rotated = [w for w in words if not w.get("upright", True)]

    # ---- column spine: one weekday letter per teaching day --------------
    dag = sorted(
        [c for c in chars if 163 <= c["top"] <= 169 and c["text"] in WEEKDAY_LETTERS],
        key=lambda c: c["x0"],
    )
    if not dag:
        sys.exit("Could not find the DAG row — has the plan's layout changed?")
    cols = [mid(c) for c in dag]
    letters = [c["text"] for c in dag]
    col_pitch = (cols[-1] - cols[0]) / (len(cols) - 1)

    def column_for(x, tol=None):
        """Nearest column, or None when the token sits between columns."""
        tol = tol if tol is not None else col_pitch * 0.45
        i = min(range(len(cols)), key=lambda j: abs(cols[j] - x))
        return i if abs(cols[i] - x) <= tol else None

    # ---- dates ----------------------------------------------------------
    day_tokens = group_adjacent([c for c in chars if 155 <= c["top"] <= 163 and c["text"].isdigit()])
    day_of_month = {}
    for text, x in day_tokens:
        i = column_for(x)
        if i is not None:
            day_of_month[i] = int(text)
    if len(day_of_month) != len(cols):
        sys.exit(f"Read {len(day_of_month)} dates for {len(cols)} columns — layout changed?")

    # The plan prints only day numbers; the month advances whenever the day
    # number drops.
    dates = []
    month = 1
    previous = 0
    for i in range(len(cols)):
        dom = day_of_month[i]
        if dom < previous:
            month += 1
        previous = dom
        try:
            d = datetime.date(YEAR, month, dom)
        except ValueError:
            sys.exit(f"Column {i}: {YEAR}-{month}-{dom} is not a real date")
        dates.append(d)

    # Cross-check every date against the weekday letter the plan prints.
    wrong = [
        (dates[i].isoformat(), letters[i], NOR_WEEKDAY[dates[i].isoweekday()])
        for i in range(len(cols))
        if NOR_WEEKDAY[dates[i].isoweekday()] != letters[i]
    ]
    if wrong:
        sys.exit("Dates disagree with the printed weekday letters: " + str(wrong[:5]))

    # ...and the ISO week against the printed UKE row.
    uke = {}
    for w in upright:
        if 134 <= w["top"] <= 140 and w["text"].isdigit():
            i = column_for(mid(w), tol=col_pitch * 2.6)
            if i is not None:
                uke[int(w["text"])] = i
    bad_weeks = [
        (wk, dates[i].isoformat(), dates[i].isocalendar()[1])
        for wk, i in uke.items()
        if dates[i].isocalendar()[1] != wk
    ]
    if bad_weeks:
        sys.exit("ISO weeks disagree with the printed UKE row: " + str(bad_weeks[:5]))

    col_info = [
        {"date": d.isoformat(), "week": d.isocalendar()[1], "weekday": d.isoweekday()} for d in dates
    ]
    grid_left, grid_right = cols[0] - col_pitch, cols[-1] + col_pitch

    # ---- week notes and day events --------------------------------------
    # The week markings are letter-spaced across each week's cell and wrap onto
    # a second line, so they have to be rebuilt from characters in reading
    # order rather than collected word by word.
    def read_line(band_lo, band_hi, x_lo, x_hi):
        sel = sorted(
            [c for c in chars if band_lo <= c["top"] <= band_hi and x_lo <= mid(c) <= x_hi],
            key=lambda c: c["x0"],
        )
        if not sel:
            return ""
        text = ""
        for k, c in enumerate(sel):
            if k and c["x0"] - sel[k - 1]["x1"] > 1.1:
                text += " "
            text += c["text"]
        return " ".join(text.split())

    week_span = {}
    for i, info in enumerate(col_info):
        lo, hi = week_span.get(info["week"], (float("inf"), float("-inf")))
        week_span[info["week"]] = (min(lo, cols[i] - col_pitch / 2), max(hi, cols[i] + col_pitch / 2))

    week_notes = {}
    for wk, (x_lo, x_hi) in week_span.items():
        parts = [read_line(143, 148.5, x_lo, x_hi), read_line(148.6, 153, x_lo, x_hi)]
        text = " ".join(p for p in parts if p)
        if text:
            week_notes[str(wk)] = text

    day_notes = {}
    # Every rotated label in the header is a day event; the week markings above
    # them are horizontal. A tall label starts well above the day row, so it
    # must not be filtered by height.
    for text, x in unrotate(rotated):
        i = column_for(x, tol=col_pitch * 0.9)
        if i is not None:
            iso = col_info[i]["date"]
            entry = day_notes.setdefault(iso, {"staff": None, "event": None})
            entry["event"] = (entry["event"] + " / " + text) if entry["event"] else text
    for text, x in group_adjacent([c for c in chars if 170 <= c["top"] <= 180 and grid_left <= c["x0"] <= grid_right]):
        i = column_for(x, tol=col_pitch * 0.9)
        if i is not None:
            iso = col_info[i]["date"]
            entry = day_notes.setdefault(iso, {"staff": None, "event": None})
            entry["staff"] = text

    # ---- rows -------------------------------------------------------------
    by_top = {}
    for w in upright:
        if w["top"] >= 214:
            by_top.setdefault(round(w["top"]), []).append(w)

    SUMMARY_X = 1090
    # Column geometry: headings and course names start at the left edge, the
    # teacher column begins at x=156, and the grid starts after that.
    NAME_X_MAX = 150
    TEACHER_X_MAX = 200

    def is_section(text):
        letters_only = [ch for ch in text if ch.isalpha()]
        if not letters_only:
            return False
        upper = sum(1 for ch in letters_only if ch.isupper())
        return upper / len(letters_only) > 0.6

    COURSE_CODE_RE = re.compile(r"^[A-ZÅÆØ0-9/]{4,}")

    courses = []
    section = None
    subcategory = None
    problems = []
    row_tops = sorted(by_top)

    for idx, top in enumerate(row_tops):
        row = sorted(by_top[top], key=lambda w: w["x0"])
        summary = [w["text"] for w in row if w["x0"] >= SUMMARY_X]
        left_text = " ".join(w["text"] for w in row if w["x1"] < SUMMARY_X).strip()
        if not left_text:
            continue
        if left_text.startswith(("Antall fysiske", "Romkapasitet", "Versjon")):
            continue

        stated = None
        for token in summary:
            if token.isdigit():
                stated = int(token)
                break

        if stated is None:
            # No total, so this is either a heading or the teacher line that
            # continues the course above. Only a heading starts at the left
            # edge; the teacher column begins further in.
            if row[0]["x0"] >= NAME_X_MAX:
                continue
            # A heading can be split across two baselines a point apart
            # ("Samlinger" + "Kristiansand"); pull the far fragment back in.
            text = left_text
            for other in (top - 1, top + 1, top - 2, top + 2):
                for w in sorted(by_top.get(other, []), key=lambda w: w["x0"]):
                    if w["x0"] >= TEACHER_X_MAX and w["x0"] < SUMMARY_X:
                        text += " " + w["text"]
            if is_section(text):
                section = text
                subcategory = None
            else:
                subcategory = text
            continue

        # Course name is the left column, the teacher column sits at x=156 on a
        # baseline 0.4pt below the name's. Splitting them by x alone breaks when
        # a long title overflows past x=150: pdfplumber then interleaves the two
        # runs into one word ("...Old and New TestameTnDt/JDA/KIT/TL"). Read the
        # two baselines from the characters instead, so each stays whole.
        name_tops = [w["top"] for w in row if w["x0"] < NAME_X_MAX]
        base = min(name_tops) if name_tops else top
        name = "".join(
            c["text"]
            for c in sorted(
                (
                    c
                    for c in chars
                    if abs(c["top"] - base) < 0.05 and c["x0"] < TEACHER_X_MAX
                ),
                key=lambda c: c["x0"],
            )
        ).strip()
        teacher = "".join(
            c["text"]
            for c in sorted(
                (
                    c
                    for c in chars
                    if base + 0.05 < c["top"] < base + 1.0
                    and NAME_X_MAX <= c["x0"] < TEACHER_X_MAX
                ),
                key=lambda c: c["x0"],
            )
        ).strip()

        m = COURSE_CODE_RE.match(name)
        code = m.group(0) if m and any(ch.isdigit() for ch in m.group(0)) else None
        title = name[len(code):].strip() if code else name

        # Grid cells on the course's own row.
        cells = group_adjacent(
            [c for c in chars if top - 3 <= c["top"] <= top + 4 and grid_left <= c["x0"] <= grid_right]
        )
        sessions = []
        markers = []
        for text, x in cells:
            i = column_for(x)
            if i is None:
                continue
            if text.isdigit() and len(text) <= 2:
                sessions.append({"date": col_info[i]["date"], "week": col_info[i]["week"], "hours": int(text)})
            elif text in CELL_MARKERS:
                markers.append({"date": col_info[i]["date"], "code": text, "label": CELL_MARKERS[text]})

        got = sum(s["hours"] for s in sessions)
        if got != stated:
            problems.append(f"{code or title[:28]}: read {got} hours, plan states {stated}")

        courses.append({
            "key": f"{section}::{code or title}",
            "id": f"v{len(courses) + 1}",
            "row": len(courses) + 1,
            "code": code,
            "title": title,
            "raw_name": name,
            "section": section,
            "subcategory": subcategory,
            "cohort": subcategory or section,
            "lecturers": [p.strip() for p in re.split(r"[/,]", teacher) if p.strip()],
            "lecturer_raw": teacher or None,
            "total_hours": stated,
            "reduced_available": False,
            "markers": markers,
            "sessions": sessions,
            "notes": [],
        })

    if problems:
        sys.exit("Hours read from the grid disagree with the plan's own totals:\n  " + "\n  ".join(problems))

    # ---- clock times ------------------------------------------------------
    verified = verify_block_model()
    weekday_of = {c["date"]: c["weekday"] for c in col_info}
    by_cohort_day = {}
    for course in courses:
        for s in course["sessions"]:
            by_cohort_day.setdefault((course["cohort"], s["date"]), []).append((course, s))

    for (_cohort, date), entries in by_cohort_day.items():
        wd = weekday_of[date]
        single = sorted((e for e in entries if not needs_both_blocks(e[1]["hours"], wd)), key=lambda e: e[0]["row"])
        both = [e for e in entries if needs_both_blocks(e[1]["hours"], wd)]
        for _c, s in both:
            s["blocks"] = blocks_for(s["hours"], wd)
        for i, (_c, s) in enumerate(single):
            s["blocks"] = blocks_for(s["hours"], wd, prefer_afternoon=(i % 2 == 1))

    for course in courses:
        expanded = []
        for s in course["sessions"]:
            blocks = s.pop("blocks", [])
            for start, end, lessons, half in blocks:
                expanded.append({
                    "date": s["date"], "week": s["week"], "hours": lessons,
                    "start": start, "end": end, "half": half,
                    "reduced": True,
                    "lessons": lesson_spans(start, lessons),
                    "day_lessons": s["hours"], "blocks_today": len(blocks),
                })
        course["sessions"] = sorted(expanded, key=lambda s: (s["date"], s["start"]))

    sections = []
    for c in courses:
        if c["section"] not in sections:
            sections.append(c["section"])

    data = {
        "plan_id": PLAN_ID,
        "term": TERM,
        "source": os.path.basename(SRC),
        "generated_note": next(
            (" ".join(w["text"] for w in sorted(by_top[t], key=lambda w: w["x0"]))
             for t in row_tops
             if " ".join(w["text"] for w in by_top[t]).startswith("Versjon")),
            "",
        ),
        "date_range": {"start": col_info[0]["date"], "end": col_info[-1]["date"]},
        "sections": sections,
        "courses": courses,
        "week_notes": week_notes,
        "day_notes": day_notes,
        "staff_legend": {},
        "exam_code_legend": {},
        "reduced_teaching_note": "",
    }

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(f'window.HLT_PLANS = window.HLT_PLANS || {{}};\nwindow.HLT_PLANS["{PLAN_ID}"] = '
                + json.dumps(data, ensure_ascii=False) + ";")

    blocks_total = sum(len(c["sessions"]) for c in courses)
    course_days = sum(len({s["date"] for s in c["sessions"]}) for c in courses)
    marker_total = sum(len(c["markers"]) for c in courses)
    print("Source:", os.path.basename(SRC))
    print("Wrote:", OUT)
    print(f"Columns: {len(cols)} teaching days, {col_info[0]['date']} to {col_info[-1]['date']}")
    print(f"Dates checked against the printed weekday and UKE rows: all {len(cols)} agree")
    print(f"Courses: {len(courses)} in {len(sections)} categories")
    print(f"Hours match the plan's own totals for all {len(courses)} courses")
    print(f"Course-days: {course_days} | Teaching blocks: {blocks_total} | Cell markers: {marker_total}")
    print(f"Block model verified against {verified}/{verified} real schedule observations")
    print("Categories:")
    for s in sections:
        n = sum(1 for c in courses if c["section"] == s)
        print(f"  {n:>2}  {s[:64]}")


if __name__ == "__main__":
    main()
