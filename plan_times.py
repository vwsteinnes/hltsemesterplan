"""The school's clock-time model, shared by every semester plan.

Decoded from screenshots of the published H26 schedule; verify_block_model()
asserts it against those observations and is called by each builder. The spring
plan uses the same lesson length and block structure.
"""


# ---------------------------------------------------------------------------
# Clock times.
#
# The numbers in the sheet are 45-minute lessons ("undervisningstimer"), not
# clock hours, and teaching runs in two fixed blocks per day. Decoded from
# screenshots of the published schedule; see verify_block_model() below, which
# checks this against every observation.
#
#   lesson 45 min, 15 min break between consecutive lessons in a block
#   -> a block of N lessons lasts N*45 + (N-1)*15 minutes
#   morning block starts 09:00 (Mondays 10:00)
#   afternoon block always starts 12:30; lunch is whatever gap is left
# ---------------------------------------------------------------------------
LESSON_MINUTES = 45
BREAK_MINUTES = 15
AFTERNOON_START = 12 * 60 + 30


def morning_start(weekday_iso):
    return 10 * 60 if weekday_iso == 1 else 9 * 60


def block_minutes(lessons):
    return lessons * LESSON_MINUTES + (lessons - 1) * BREAK_MINUTES


def fmt_time(mins):
    mins = int(round(mins))
    return f"{mins // 60:02d}:{mins % 60:02d}"


def morning_capacity(weekday_iso):
    """Most lessons that still finish before the afternoon block begins.

    Three from 09:00, but only two from a 10:00 Monday start.
    """
    start = morning_start(weekday_iso)
    n = 0
    while block_minutes(n + 1) <= AFTERNOON_START - start:
        n += 1
    return n


# A course-day of this many lessons cannot fit in one block, so it always takes
# both and therefore cannot share its day with another course of the same group.
def needs_both_blocks(lessons, weekday_iso):
    return lessons > morning_capacity(weekday_iso)


def split_lessons(lessons, weekday_iso):
    """How a course-day divides between the morning and afternoon blocks.

    Fridays fill the morning as far as it goes, which is what makes a 4-lesson
    Friday end at 13:15. Other days divide evenly, giving the 14:15 finish seen
    on Tuesday and Wednesday. Both readings agree on the 5- and 6-lesson
    Fridays that the screenshots actually show.
    """
    cap = morning_capacity(weekday_iso)
    if lessons <= cap:
        return lessons, 0
    wanted = lessons - 1 if weekday_iso == 5 else (lessons + 1) // 2
    am = min(cap, wanted)
    return am, lessons - am


def blocks_for(lessons, weekday_iso, prefer_afternoon=False):
    """Clock spans for one course-day, as (start, end, lessons) tuples."""
    am_start = morning_start(weekday_iso)
    if not needs_both_blocks(lessons, weekday_iso):
        # Fits in a single block; another course may already hold the morning.
        start = AFTERNOON_START if prefer_afternoon else am_start
        return [(fmt_time(start), fmt_time(start + block_minutes(lessons)), lessons, "pm" if prefer_afternoon else "am")]
    am, pm = split_lessons(lessons, weekday_iso)
    out = []
    if am:
        out.append((fmt_time(am_start), fmt_time(am_start + block_minutes(am)), am, "am"))
    if pm:
        out.append((fmt_time(AFTERNOON_START), fmt_time(AFTERNOON_START + block_minutes(pm)), pm, "pm"))
    return out


def verify_block_model():
    """Check the model against the published schedule screenshots.

    Each entry is (weekday, lessons, holds_afternoon, expected spans).
    """
    cases = [
        (1, 2, True, ["12:30-14:15"]),                  # Mon 10 Aug  KRI1111
        (2, 4, False, ["09:00-10:45", "12:30-14:15"]),  # Tue 11 Aug  KRI1111
        (3, 4, False, ["09:00-10:45", "12:30-14:15"]),  # Wed 12 Aug  KRI1112
        (4, 2, False, ["09:00-10:45"]),                 # Thu 13 Aug  KRI1112
        (4, 3, True, ["12:30-15:15"]),                  # Thu 13 Aug  RLE1030
        (5, 5, False, ["09:00-11:45", "12:30-14:15"]),  # Fri 14 Aug  RLE1030
        (5, 6, False, ["09:00-11:45", "12:30-15:15"]),  # Fri 21 Aug  PRA1010
    ]
    failures = []
    for weekday, lessons, pm, expected in cases:
        got = [f"{a}-{b}" for a, b, _, _ in blocks_for(lessons, weekday, pm)]
        if got != expected:
            failures.append(f"weekday {weekday}, {lessons} lessons: got {got}, expected {expected}")
    if failures:
        raise SystemExit("Block model no longer matches the real schedule:\n  " + "\n  ".join(failures))
    return len(cases)


def lesson_spans(start_text, lessons):
    """The individual 45-minute lessons inside a block, and the gaps between."""
    h, m = start_text.split(":")
    cursor = int(h) * 60 + int(m)
    out = []
    for i in range(lessons):
        out.append({"start": fmt_time(cursor), "end": fmt_time(cursor + LESSON_MINUTES)})
        cursor += LESSON_MINUTES
        if i < lessons - 1:
            cursor += BREAK_MINUTES
    return out
