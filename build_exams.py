"""Build site/exams.js from the exam-date PDF.

The PDF's table layout does not survive text extraction cleanly (grouped rows,
multi-date cells, "waiting for the course leader" placeholders), so the exam
list below is transcribed by hand from
"Oversikt over eksamensdatoer_Canvas_H26_07.09.2026-1.pdf" rather than scraped.

What is automated is the checking: every exam is matched against a real course
in data.js, every date is parsed, and anything that cannot be resolved fails the
build instead of shipping silently.

Usage: python3 build_exams.py
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_JS = os.path.join(HERE, "data.js")
OUT = os.path.join(HERE, "exams.js")

SOURCE_DOC = "Oversikt over eksamensdatoer_Canvas_H26_07.09.2026-1.pdf"
SOURCE_NOTE = "Med forbehold om endringer / Exam dates are subject to change"

# Exam kinds, in the order the PDF groups them.
SCHOOL = "skoleeksamen"
ORAL = "muntlig"
SUBMISSION = "innlevering"

# Each entry: code, section hint (only where the code is ambiguous), variant,
# title, kind, form, anonymity, occurrences, teachers, grading date, notes.
#
# An occurrence is (date, start, end, room). start=None marks a deadline rather
# than a sitting; the time then lives in `end`.
EXAMS = [
    # ---------------- SKOLEEKSAMENER ----------------
    dict(code="VEL1220", section="EMNEGRUPPER", title="Verdibevisst ledelse", kind=SCHOOL,
         form="5 timer skoleeksamen, 100 %", anonymous=True,
         occurrences=[("2026-10-16", "09:00", "14:00", "Lillesalen 1 og 2")],
         teachers=["SE", "KIT"], grading="2026-11-06"),
    dict(code="INF1020", title="Examen fakultatum", kind=SCHOOL,
         form="4 timer skoleeksamen, 100 %", anonymous=True,
         occurrences=[("2026-11-10", "09:00", "13:00", "Grünerløkka")],
         teachers=["JDA", "BW"], grading="2026-12-01"),
    dict(code="KRI1112", title="Innføring i NT", kind=SCHOOL,
         form="4 timer skoleeksamen, 50 %", anonymous=True,
         occurrences=[("2026-11-13", "09:00", "13:00", "Usalen")],
         teachers=["DAE", "LTJ"], grading="2026-12-04"),
    dict(code="KRI1031", title="Allmenn kirkehistorie", kind=SCHOOL,
         form="3 timer skoleeksamen, 50 %", anonymous=True,
         occurrences=[("2026-12-02", "09:00", "12:00", "Lillesalen 1 og 2 og Usalen")],
         teachers=["DAE"], grading="2026-12-23"),
    dict(code="PAL1140E", title="Mission Church and Society", kind=SCHOOL,
         form="4-hour school exam, 50 %", anonymous=True,
         occurrences=[("2026-12-04", "09:00", "13:00", "Lillesalen 1 og 2 og Usalen")],
         teachers=["GS", "TK"], grading="2026-12-29"),
    # The Norwegian VEL5040 has no row in the teaching plan; only VEL5040E does.
    dict(code="VEL5040", section=None, unlinked=True,
         title="Ledelse, bærekraft og samfunnsansvar", kind=SCHOOL,
         form="6 timer skoleeksamen, 100 %", anonymous=True,
         occurrences=[("2026-12-08", "09:00", "15:00", "Usalen")],
         teachers=["CD", "GS"], grading="2027-01-05", master=True),
    dict(code="VEL5040E", title="Leadership, Sustainability, and Social Responsibility", kind=SCHOOL,
         form="6-hour school exam, 100 %", anonymous=True,
         occurrences=[("2026-12-08", "09:00", "15:00", "Usalen")],
         teachers=["CD", "GS"], grading="2027-01-05", master=True),
    # KRI1032, KRI1033 and KRI1034 share one 09:00-12:00 slot in the PDF.
    dict(code="KRI1032", title="Norsk kirkehistorie", kind=SCHOOL,
         form="1,5 timer skoleeksamen, 25 %", anonymous=True,
         occurrences=[("2026-12-10", "09:00", "12:00", "Usalen og Tusenfryd (ekstra rom)")],
         teachers=["DAA"], grading="2027-01-08"),
    dict(code="KRI1033", match_code="KRI1033/4",
         title="Pinsebevegelsen og den karismatiske bevegelsen", kind=SCHOOL,
         form="1,5 timer skoleeksamen, 25 %", anonymous=True,
         occurrences=[("2026-12-10", "09:00", "12:00", "Usalen og Tusenfryd (ekstra rom)")],
         teachers=["ØGA"], grading="2027-01-08"),
    dict(code="KRI1034", match_code="KRI1033/4", title="Baptismens historie", kind=SCHOOL,
         form="1,5 timer skoleeksamen, 25 %", anonymous=True,
         occurrences=[("2026-12-10", "09:00", "12:00", "Usalen og Tusenfryd (ekstra rom)")],
         teachers=["LAA"], grading="2027-01-08"),
    dict(code="LEA1010", title="Bedriftsøkonomi", kind=SCHOOL,
         form="4 timer skoleeksamen, 100 %", anonymous=True,
         occurrences=[("2026-12-15", "09:00", "13:00", "Lillesalen 1 og 2")],
         teachers=["MS", "KLC"], grading="2027-01-12"),
    dict(code="TEO4010", title="Kristen tro i kontekst", kind=SCHOOL,
         form="4 timer skoleeksamen, 60 %", anonymous=True,
         occurrences=[("2026-12-17", "09:00", "13:00", "Usalen")],
         teachers=["JDA", "GS", "TD", "KIT"], grading="2027-01-14", master=True),
    dict(code="TEO4010E", title="Christian Faith in Context", kind=SCHOOL,
         form="4-hour school exam, 60 %", anonymous=True,
         occurrences=[("2026-12-17", "09:00", "13:00", "Usalen")],
         teachers=["GS", "JDA", "TD", "KIT"], grading="2027-01-14", master=True),

    # ---------------- MUNTLIGE EKSAMENER ----------------
    dict(code="LEA1020", title="Markedsføring og kommunikasjon", kind=ORAL,
         form="Muntlig gruppeeksamen, 40 %", anonymous=False,
         occurrences=[("2026-10-02", "09:00", None, "Lillesalen 1 og 2")],
         teachers=["MS", "TL"], grading="2026-10-23"),
    dict(code="MA4010", title="Hermeneutikk og dømmekraft", kind=ORAL,
         form="Muntlig gruppeeksamen, 50 %", anonymous=False,
         occurrences=[("2026-11-19", None, None, "Hovedøya og Tusenfryd"),
                      ("2026-11-20", None, None, "Speilsalen og Tusenfryd")],
         teachers=["GWH", "KIT", "RZ"], grading="2026-12-11", master=True),
    dict(code="MA4010E", title="Hermeneutics and Discernment", kind=ORAL,
         form="Oral presentation of the written assignment in a seminar, 50 %", anonymous=False,
         occurrences=[("2026-11-19", None, None, "Hovedøya og Tusenfryd"),
                      ("2026-11-20", None, None, "Speilsalen og Tusenfryd")],
         teachers=["GWH", "KIT", "RZ"], grading="2026-12-11", master=True),
    dict(code="VEL1250", title="Coaching, veiledning og ledelse", kind=ORAL,
         form="Muntlig eksamen, 100 %", anonymous=False,
         occurrences=[("2026-11-25", None, None, "Lillesalen 1 og 2"),
                      ("2026-11-26", None, None, "Grünerløkka"),
                      ("2026-11-27", None, None, "Grünerløkka")],
         teachers=["TØ", "HFB"], grading="2026-12-17"),
    dict(code="LEA1030", title="Innovasjon og entreprenørskap", kind=ORAL,
         form="Muntlig forsvar, 40 %", anonymous=False,
         occurrences=[("2026-12-01", None, None, "Lillesalen 1"),
                      ("2026-12-02", None, None, "Hovedøya")],
         teachers=["TL", "AU"], grading="2026-12-23"),
    dict(code="TEO2020", title="Ny testamentlig teologi", kind=ORAL,
         form="Muntlig eksamen, 50 %", anonymous=False,
         occurrences=[("2026-12-01", None, None, "Tusenfryd"),
                      ("2026-12-02", None, None, "Tusenfryd")],
         teachers=["LAA", "JDA"], grading="2026-12-23"),
    dict(code="PAL1211", title="Sjelesorg", kind=ORAL,
         form="Muntlig eksamen, 100 %", anonymous=False,
         occurrences=[("2026-12-09", None, None, "Hovedøya"),
                      ("2026-12-10", None, None, "Hovedøya"),
                      ("2026-12-11", None, None, "Bønnehuset")],
         teachers=["ÅMS", "AS"], grading="2027-01-08"),

    # ---------------- OPPGAVEINNLEVERINGER ----------------
    dict(code="INF1241", variant="Stavanger", title="Teologi for livet", kind=SUBMISSION,
         form="Oppgave 2000 ord, 100 %", anonymous=True, occurrences=[],
         teachers=["LTJ"], grading=None, room="Canvas",
         tbd="Venter på forslag fra emneansvarlig"),
    dict(code="INF1241", variant="Oslo", title="Teologi for livet", kind=SUBMISSION,
         form="Oppgave 2000 ord, 100 %", anonymous=True, occurrences=[],
         teachers=["LTJ"], grading=None, room="Canvas",
         tbd="Venter på forslag fra emneansvarlig"),
    dict(code="INF1241", variant="Bergen", title="Teologi for livet", kind=SUBMISSION,
         form="Oppgave 2000 ord, 100 %", anonymous=True, occurrences=[],
         teachers=["LTJ"], grading=None, room="Canvas",
         tbd="Venter på forslag fra emneansvarlig"),
    dict(code="INF1241", variant="Kristiansand", title="Teologi for livet", kind=SUBMISSION,
         form="Oppgave 2000 ord, 100 %", anonymous=True, occurrences=[],
         teachers=["LTJ"], grading=None, room="Canvas",
         tbd="Venter på forslag fra emneansvarlig"),
    dict(code="KRI1111", title="Innføring i Det gamle testamentet", kind=SUBMISSION,
         form="Oppgave 2000 ord, 50 %", anonymous=True,
         occurrences=[("2026-10-16", None, "12:00", "Canvas")],
         teachers=["TD"], grading="2026-11-06"),
    dict(code="KRI1140", variant="Stavanger", title="Troslære og spiritualitet", kind=SUBMISSION,
         form=None, anonymous=None, occurrences=[],
         teachers=["KIT", "BW"], grading=None,
         tbd="Venter på informasjon fra emneansvarlig"),
    dict(code="KRI2110/SAM2110", title="Forskning, metode og design", kind=SUBMISSION,
         form="72 timers hjemmeeksamen 2000 ord, 60 %", anonymous=True,
         occurrences=[("2026-11-10", None, "12:00", "Canvas", "2026-11-13")],
         teachers=["CD", "GH", "TD"], grading="2026-12-04"),
    dict(code="KRI2110/SAM2110", variant="prosjektbeskrivelse",
         title="Forskning, metode og design", kind=SUBMISSION,
         form="Prosjektbeskrivelse 1000 ord, 40 %", anonymous=False,
         occurrences=[("2026-11-06", None, "12:00", "Canvas")],
         teachers=["CD", "GH", "TD"], grading="2026-11-27"),
    dict(code="KRI2110E/SAM2110E", match_code="SAM/KRI2110E", title="Research method", kind=SUBMISSION,
         form="72-hour take-home exam of 2000 words, 60 %", anonymous=True,
         occurrences=[("2026-11-03", None, "12:00", "Canvas", "2026-11-06")],
         teachers=["CD", "GH", "TD"], grading="2026-11-27"),
    dict(code="KRI2110E/SAM2110E", match_code="SAM/KRI2110E", variant="proposal",
         title="Research method", kind=SUBMISSION,
         form="1000-word proposal for a research project, 40 %", anonymous=False,
         occurrences=[("2026-11-27", None, "12:00", "Canvas")],
         teachers=["CD", "GH", "TD"], grading="2026-12-18"),
    dict(code="KTR1010", title="Konflikttransformasjon", kind=SUBMISSION,
         form="Oppgave 3000 ord, 100 %", anonymous=True,
         occurrences=[("2026-10-23", None, "12:00", "Canvas")],
         teachers=["TK"], grading="2026-11-13"),
    dict(code="KTR1010E", title="Conflict Transformation", kind=SUBMISSION,
         form="3000-word assignment, 100 %", anonymous=True,
         occurrences=[("2026-10-23", None, "12:00", "Canvas")],
         teachers=["TK"], grading="2026-11-13"),
    dict(code="LEA1020", title="Markedsføring og kommunikasjon", kind=SUBMISSION,
         form="Oppgave 2500 ord, 60 %", anonymous=True,
         occurrences=[("2026-10-16", None, "12:00", "Canvas")],
         teachers=["MS"], grading="2026-11-06"),
    dict(code="LEA1030", title="Innovasjon og entreprenørskap", kind=SUBMISSION,
         form="Oppgave 2500 ord, 60 %", anonymous=True,
         occurrences=[("2026-12-10", None, "12:00", "Canvas")],
         teachers=["TL", "AU"], grading="2027-01-08"),
    dict(code="MA4010", title="Hermeneutikk og dømmekraft", kind=SUBMISSION,
         form="Oppgave 4000 ord, 50 %", anonymous=True,
         occurrences=[("2026-11-06", None, "12:00", "Canvas")],
         teachers=["GWH", "KIT", "RZ"], grading="2026-11-27", master=True),
    dict(code="MA4010E", title="Hermeneutics and Discernment", kind=SUBMISSION,
         form="Written presentation 4000 words, 50 %", anonymous=True,
         occurrences=[("2026-11-06", None, "12:00", "Canvas")],
         teachers=["GWH", "KIT", "RZ"], grading="2026-11-27", master=True),
    dict(code="PAL1140E", title="Mission Church and Society", kind=SUBMISSION,
         form="Case study 1500 words, 50 %", anonymous=False,
         occurrences=[("2026-12-17", None, "12:00", "Canvas")],
         teachers=["GS", "TK"], grading="2027-01-14"),
    dict(code="PAL1212", section="EMNEGRUPPER", title="Pastoral teologi", kind=SUBMISSION,
         form="Oppgave 1500 ord, 50 %", anonymous=True,
         occurrences=[("2026-12-03", None, "12:00", "Canvas")],
         teachers=["LTJ"], grading="2026-12-23"),
    dict(code="PAL1212", section="ÅRSSTUDIUM I TEOLOGI OG MENIGHETSLEDELSE (DIGITALT)",
         variant="TML", title="Pastoral teologi", kind=SUBMISSION,
         form="Oppgave 1500 ord, 50 %", anonymous=True,
         occurrences=[("2026-12-03", None, "12:00", "Canvas")],
         teachers=["LTJ"], grading="2026-12-23"),
    dict(code="RLE1030", title="Religions- og livssynskunnskap", kind=SUBMISSION,
         form="Oppgave 2500 ord, 100 %", anonymous=True,
         occurrences=[("2026-12-18", None, "12:00", "Canvas")],
         teachers=["AM", "LAA"], grading="2027-01-15"),
    dict(code="TEO2020", title="Ny testamentlig teologi", kind=SUBMISSION,
         form="Oppgave 3000 ord, 50 %", anonymous=True,
         occurrences=[("2026-12-17", None, "12:00", "Canvas")],
         teachers=["LAA", "JDA"], grading="2027-01-14"),
    dict(code="TEO4010", title="Kristen tro i kontekst", kind=SUBMISSION,
         form="Oppgave 2000 ord inkl. muntlig presentasjon i undervisning, 40 %", anonymous=False,
         occurrences=[("2026-11-02", None, "12:00", "Canvas")],
         teachers=["JDA", "GS", "TD", "KIT"], grading="2026-11-23", master=True),
    dict(code="TEO4010E", title="Christian Faith in Context", kind=SUBMISSION,
         form="Instructor-assigned paper of 2000 words incl. oral presentation, 40 %", anonymous=False,
         occurrences=[("2026-11-02", None, "12:00", "Canvas")],
         teachers=["GS", "JDA", "TD", "KIT"], grading="2026-11-23", master=True),
    dict(code="TEO5040", title="Spiritualitet og menighetsutvikling", kind=SUBMISSION,
         form="Oppgave 4500 ord, 100 %", anonymous=True,
         occurrences=[("2027-02-12", None, "12:00", "Canvas")],
         teachers=["BW", "AS"], grading="2027-03-05", master=True),
    dict(code="TEO5060E", match_code="TEO5060", title="Pauline Theology", kind=SUBMISSION,
         form="Project paper of 5000 words", anonymous=True,
         occurrences=[("2026-12-10", None, "12:00", "Canvas"),
                      ("2026-12-17", None, None, "Zoom")],
         teachers=["EP", "GWH"], grading="2027-01-08", master=True,
         note="Presentasjon og muntlig forsvar 17.12.2026 via Zoom. Nærmere informasjon kommer fra faglærerne."),
    dict(code="TEO5080", title="Lukas og Acta", kind=SUBMISSION,
         form="Prosjektoppgave 5000 ord, 100 %", anonymous=False,
         occurrences=[("2026-11-20", None, "12:00", "Canvas")],
         teachers=["JDA", "ØGA", "KIT"], grading="2026-12-11", master=True),
    dict(code="UNG1210", variant="Oslo",
         title="Barne- og ungdomsarbeidets teologiske fundament", kind=SUBMISSION,
         form="Oppgave 2000 ord, 100 %", anonymous=True,
         occurrences=[("2026-12-03", None, "12:00", "Canvas")],
         teachers=["LTJ", "RZ"], grading="2026-12-23"),
    dict(code="VEL1210", title="Den verdibevisste organisasjonen", kind=SUBMISSION,
         form="Oppgave 3000 ord, 100 %", anonymous=True,
         occurrences=[("2026-12-16", None, "12:00", "Canvas")],
         teachers=["MS", "JIJ"], grading="2027-01-12"),
    dict(code="VEL1220", section="ÅRSSTUDIUM I TEOLOGI OG MENIGHETSLEDELSE (DIGITALT)",
         variant="TML", title="Verdibevisst ledelse", kind=SUBMISSION,
         form="Oppgave 3000 ord, 100 %", anonymous=True,
         occurrences=[("2026-12-18", None, "12:00", "Canvas")],
         teachers=["GH"], grading="2027-01-15"),
    dict(code="VEL1220", section="HLT KOMPETANSE", variant="Hedmarktoppen",
         title="Verdibevisst ledelse", kind=SUBMISSION,
         form="Oppgave 3000 ord, 100 %", anonymous=True, occurrences=[],
         teachers=[], grading=None, room="Canvas", tbd="Vår 2027"),
    dict(code="VEL4010", title="Verdibasert ledelse og dømmekraft", kind=SUBMISSION,
         form="Oppgave 4500 ord, 100 %", anonymous=True,
         occurrences=[("2026-12-17", None, "12:00", "Canvas")],
         teachers=["RZ", "GH", "KIT", "JIJ"], grading="2027-01-14", master=True),
    dict(code="VEL4010E", title="Values-Based Leadership and Discernment", kind=SUBMISSION,
         form="Take-home examination of 4500 words, 100 %", anonymous=True,
         occurrences=[("2026-12-17", None, "12:00", "Canvas")],
         teachers=["GH", "RZ", "KIT", "JIJ"], grading="2027-01-14", master=True),

    # ---------------- PRAKSIS ----------------
    dict(code="PRA1010", variant="Oslo", title="Praksis I", kind=SUBMISSION,
         form="Emnerefleksjon og logg", anonymous=False, occurrences=[],
         teachers=["ALV", "CHNK", "CD"], grading=None, room="Canvas",
         tbd="Vår 2027 — ytterligere informasjon kommer neste semester"),
    dict(code="PRA1020", variant="Oslo", title="Praksis II", kind=SUBMISSION,
         form="Emnerefleksjon og logg", anonymous=False,
         occurrences=[("2026-12-15", None, "12:00", "Canvas")],
         teachers=["CHNK", "ÅMS"], grading="2027-01-12"),
]


def load_courses():
    raw = open(DATA_JS, encoding="utf-8").read()
    marker = 'window.HLT_PLANS["h26"] = '
    if marker not in raw:
        sys.exit("site/data.js has an unexpected shape — run build_data.py first.")
    body = raw[raw.index(marker) + len(marker):].rstrip().rstrip(";")
    return json.loads(body)["courses"]


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def main():
    courses = load_courses()
    by_code = {}
    for c in courses:
        by_code.setdefault(c["code"], []).append(c)

    out = []
    problems = []
    linked_keys = set()

    for i, ex in enumerate(EXAMS, start=1):
        code = ex["code"]
        match_code = ex.get("match_code", code)
        course_key = None

        if not ex.get("unlinked"):
            candidates = by_code.get(match_code, [])
            if ex.get("section"):
                candidates = [c for c in candidates if c["section"] == ex["section"]]
            if not candidates:
                problems.append(f"{code}: no course matches {match_code!r}"
                                + (f" in section {ex['section']!r}" if ex.get("section") else ""))
            elif len(candidates) > 1:
                problems.append(f"{code}: {match_code!r} is ambiguous across "
                                + ", ".join(c["section"] for c in candidates)
                                + " — add a section hint")
            else:
                course_key = candidates[0]["key"]
                linked_keys.add(course_key)

        occurrences = []
        for occ in ex["occurrences"]:
            date, start, end, room = occ[0], occ[1], occ[2], occ[3]
            until = occ[4] if len(occ) > 4 else None
            for value, label in ((date, "date"), (until, "until")):
                if value and not DATE_RE.match(value):
                    problems.append(f"{code}: bad {label} {value!r}")
            for value, label in ((start, "start"), (end, "end")):
                if value and not TIME_RE.match(value):
                    problems.append(f"{code}: bad {label} {value!r}")
            if until and until < date:
                problems.append(f"{code}: window ends {until} before it starts {date}")
            occurrences.append({
                "date": date, "start": start, "end": end, "room": room, "until": until,
            })

        if not occurrences and not ex.get("tbd"):
            problems.append(f"{code}: no dates and no 'tbd' note")

        out.append({
            "id": f"x{i}",
            "code": code,
            "variant": ex.get("variant"),
            "title": ex["title"],
            "kind": ex["kind"],
            "form": ex.get("form"),
            "anonymous": ex.get("anonymous"),
            "master": bool(ex.get("master")),
            "teachers": ex.get("teachers") or [],
            "grading": ex.get("grading"),
            "room": ex.get("room"),
            "note": ex.get("note"),
            "tbd": ex.get("tbd"),
            "course_key": course_key,
            "occurrences": occurrences,
        })

    if problems:
        sys.exit("Exam list does not line up with the teaching plan:\n  " + "\n  ".join(problems))

    data = {
        "source": SOURCE_DOC,
        "note": SOURCE_NOTE,
        "exams": out,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(
            "window.HLT_EXAMS_BY_PLAN = window.HLT_EXAMS_BY_PLAN || {};\n"
            + 'window.HLT_EXAMS_BY_PLAN["h26"] = '
            + json.dumps(data, ensure_ascii=False)
            + ";"
        )

    dated = [e for e in out if e["occurrences"]]
    all_dates = sorted({o["date"] for e in out for o in e["occurrences"]})
    print("Source:", SOURCE_DOC)
    print("Wrote:", OUT)
    print(f"Exams: {len(out)} ({len(dated)} dated, {len(out) - len(dated)} awaiting a date)")
    print(f"Exam dates span {all_dates[0]} to {all_dates[-1]}")
    by_kind = {}
    for e in out:
        by_kind[e["kind"]] = by_kind.get(e["kind"], 0) + 1
    print("By kind:", ", ".join(f"{k}: {v}" for k, v in sorted(by_kind.items())))

    unlinked = [e["code"] for e in out if not e["course_key"]]
    if unlinked:
        print("Not linked to a course in the plan:", ", ".join(sorted(set(unlinked))))
    no_exam = [c for c in courses if c["code"] and c["key"] not in linked_keys]
    if no_exam:
        print("Courses with no exam in the PDF:")
        for c in no_exam:
            print(f"  {c['code']:<18} {c['section'][:40]}")


if __name__ == "__main__":
    main()
