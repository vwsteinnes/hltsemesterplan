/* Turns an uploaded semester-plan workbook into the same data shape that
 * build_data.py produces. Keep the two in step — parse-plan.test compares this
 * against the committed data.js.
 */
window.HLTParsePlan = (function () {
  "use strict";

  const MAX_COL = 115; // column DK, the last date column
  const MONTHS = { AUGUST: 8, SEPTEMBER: 9, OKTOBER: 10, NOVEMBER: 11, DESEMBER: 12 };

  const SECTION_HEADER_ROWS = [
    [9, "GRUNNSTUDIUM"],
    [17, "EMNEGRUPPER"],
    [26, "PRAKSIS / FORDYPNING / TEOLOGI"],
    [32, "BALA/LEA - ØKONOMI OG ADMINISTRASJON"],
    [37, "HLT STAVANGER"],
    [39, "HLT KOMPETANSE"],
    [42, "ÅRSSTUDIUM I TEOLOGI OG MENIGHETSLEDELSE (DIGITALT)"],
    [45, "MASTER I TEOLOGI OG VERDIBEVISST LEDELSE"],
    [56, "ENGLISH BACHELOR PROGRAMS 1st/3rd yr & Theology/Leadership 2nd yr"],
  ];

  const LESSON_MINUTES = 45;
  const BREAK_MINUTES = 15;
  const AFTERNOON_START = 12 * 60 + 30;

  const morningStart = (wd) => (wd === 1 ? 10 * 60 : 9 * 60);
  const blockMinutes = (n) => n * LESSON_MINUTES + (n - 1) * BREAK_MINUTES;
  const fmtTime = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

  function morningCapacity(wd) {
    const start = morningStart(wd);
    let n = 0;
    while (blockMinutes(n + 1) <= AFTERNOON_START - start) n++;
    return n;
  }

  const needsBothBlocks = (lessons, wd) => lessons > morningCapacity(wd);

  function splitLessons(lessons, wd) {
    const cap = morningCapacity(wd);
    if (lessons <= cap) return [lessons, 0];
    const wanted = wd === 5 ? lessons - 1 : Math.ceil(lessons / 2);
    const am = Math.min(cap, wanted);
    return [am, lessons - am];
  }

  function blocksFor(lessons, wd, preferAfternoon) {
    const amStart = morningStart(wd);
    if (!needsBothBlocks(lessons, wd)) {
      const start = preferAfternoon ? AFTERNOON_START : amStart;
      return [[fmtTime(start), fmtTime(start + blockMinutes(lessons)), lessons, preferAfternoon ? "pm" : "am"]];
    }
    const [am, pm] = splitLessons(lessons, wd);
    const out = [];
    if (am) out.push([fmtTime(amStart), fmtTime(amStart + blockMinutes(am)), am, "am"]);
    if (pm) out.push([fmtTime(AFTERNOON_START), fmtTime(AFTERNOON_START + blockMinutes(pm)), pm, "pm"]);
    return out;
  }

  function lessonSpans(startText, lessons) {
    const [h, m] = startText.split(":").map(Number);
    let cursor = h * 60 + m;
    const out = [];
    for (let i = 0; i < lessons; i++) {
      out.push({ start: fmtTime(cursor), end: fmtTime(cursor + LESSON_MINUTES) });
      cursor += LESSON_MINUTES;
      if (i < lessons - 1) cursor += BREAK_MINUTES;
    }
    return out;
  }

  // Same seven observations the Python builder asserts against.
  function verifyBlockModel() {
    const cases = [
      [1, 2, true, ["12:30-14:15"]],
      [2, 4, false, ["09:00-10:45", "12:30-14:15"]],
      [3, 4, false, ["09:00-10:45", "12:30-14:15"]],
      [4, 2, false, ["09:00-10:45"]],
      [4, 3, true, ["12:30-15:15"]],
      [5, 5, false, ["09:00-11:45", "12:30-14:15"]],
      [5, 6, false, ["09:00-11:45", "12:30-15:15"]],
    ];
    cases.forEach(([wd, lessons, pm, expected]) => {
      const got = blocksFor(lessons, wd, pm).map((b) => b[0] + "-" + b[1]);
      if (got.join("|") !== expected.join("|")) {
        throw new Error(`Tidsmodellen stemmer ikke (${wd}/${lessons}): ${got.join(" + ")}`);
      }
    });
    return cases.length;
  }

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isText = (v) => typeof v === "string" && v.trim() !== "";

  const COURSE_CODE_RE = /^[A-ZÅÆØ0-9/]{4,}/;

  function splitCourseName(raw) {
    const clean = raw.replace(/\n/g, " ").trim().replace(/\s+/g, " ");
    const m = COURSE_CODE_RE.exec(clean);
    if (m && /\d/.test(m[0])) return [m[0], clean.slice(m[0].length).trim()];
    return [null, clean];
  }

  function isoDate(y, m, d) {
    return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  function isoWeekday(y, m, d) {
    const wd = new Date(y, m - 1, d).getDay();
    return wd === 0 ? 7 : wd;
  }

  async function parse(arrayBuffer, opts) {
    const options = opts || {};
    const year = options.year || 2026;
    const book = await window.HLTXlsx.load(arrayBuffer);

    const sheetName = book.sheetNames.find((n) => /høst|hoest|vår|vaar|semester/i.test(n)) || book.sheetNames[0];
    const ws = await book.sheetByName(sheetName);
    if (!ws) throw new Error("Fant ingen brukbar arkfane i filen.");

    const mergeAt = (row, col) =>
      ws.merges.find((m) => m.minRow <= row && row <= m.maxRow && m.minCol <= col && col <= m.maxCol) || null;

    function topLeftValue(row, col) {
      const m = mergeAt(row, col);
      return m ? ws.value(m.minRow, m.minCol) : ws.value(row, col);
    }

    // --- month + week per column -------------------------------------------
    const monthCols = [];
    for (let c = 1; c <= MAX_COL; c++) {
      const v = ws.value(6, c);
      if (isText(v) && MONTHS[v.trim().toUpperCase()]) monthCols.push([c, MONTHS[v.trim().toUpperCase()]]);
    }
    monthCols.sort((a, b) => a[0] - b[0]);
    const monthForCol = (c) => {
      let cur = 7;
      for (const [col, m] of monthCols) {
        if (c >= col) cur = m;
        else break;
      }
      return cur;
    };
    const weekForCol = (c) => {
      const v = topLeftValue(2, c);
      return isNum(v) ? v : null;
    };

    const colInfo = new Map();
    for (let c = 5; c <= MAX_COL; c++) {
      const dom = ws.value(4, c);
      if (!isNum(dom)) continue;
      const month = monthForCol(c);
      const day = Math.round(dom);
      const probe = new Date(year, month - 1, day);
      if (probe.getMonth() + 1 !== month || probe.getDate() !== day) continue;
      colInfo.set(c, { date: isoDate(year, month, day), week: weekForCol(c), weekday: isoWeekday(year, month, day) });
    }
    if (!colInfo.size) throw new Error("Fant ingen datokolonner — er dette riktig semesterplan?");

    // --- notes --------------------------------------------------------------
    const weekNotes = {};
    for (let c = 5; c <= MAX_COL; c++) {
      const v = ws.value(3, c);
      if (isText(v)) {
        const wk = weekForCol(c);
        if (wk !== null) weekNotes[String(wk)] = v.trim();
      }
    }
    const dayNotes = {};
    for (let c = 5; c <= MAX_COL; c++) {
      const staff = ws.value(7, c);
      const event = ws.value(8, c);
      const info = colInfo.get(c);
      if (info && (isText(staff) || isText(event))) {
        dayNotes[info.date] = {
          staff: isText(staff) ? staff.trim() : null,
          event: isText(event) ? event.trim() : null,
        };
      }
    }

    // --- legends ------------------------------------------------------------
    const colIndex = (letters) => {
      let n = 0;
      for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
      return n;
    };
    const staffLegend = {};
    ["BD", "BP", "CB", "CN", "CX"].forEach((letters) => {
      const col = colIndex(letters);
      for (let r = 68; r <= 72; r++) {
        const v = ws.value(r, col);
        if (isText(v) && v.includes(" - ")) {
          const i = v.indexOf(" - ");
          staffLegend[v.slice(0, i).trim()] = v.slice(i + 3).trim();
        }
      }
    });
    const examLegend = {};
    ["E", "N", "W", "AH", "AQ"].forEach((letters) => {
      const col = colIndex(letters);
      for (let r = 68; r <= 71; r++) {
        const v = ws.value(r, col);
        if (isText(v) && v.includes(" - ")) {
          const i = v.indexOf(" - ");
          examLegend[v.slice(0, i).trim()] = v.slice(i + 3).trim();
        }
      }
    });

    // --- courses ------------------------------------------------------------
    const headerRows = new Map(SECTION_HEADER_ROWS);
    const currentSection = (row) => {
      let cur = null;
      for (const [r, name] of SECTION_HEADER_ROWS) {
        if (row >= r) cur = name;
        else break;
      }
      return cur;
    };

    const courses = [];
    for (let row = 9; row <= 64; row++) {
      if (headerRows.has(row)) continue;
      const nameCell = ws.value(row, 2);
      if (!isText(nameCell)) continue;

      const totalHours = ws.value(row, 1);
      const subcatRaw = topLeftValue(row, 3);
      const lecturerRaw = ws.value(row, 4);
      const section = currentSection(row);
      const [code, title] = splitCourseName(nameCell);

      const sessions = [];
      const notes = [];
      let c = 5;
      while (c <= MAX_COL) {
        const m = mergeAt(row, c);
        if (m && m.maxCol > m.minCol) {
          if (m.minRow === row) {
            const cell = ws.cell(m.minRow, m.minCol);
            const ncols = m.maxCol - m.minCol + 1;
            if (isNum(cell.v) && cell.v) {
              let perDay = cell.v / ncols;
              if (Number.isInteger(perDay)) perDay = Math.round(perDay);
              for (let cc = m.minCol; cc <= m.maxCol; cc++) {
                const info = colInfo.get(cc);
                if (info) sessions.push({ date: info.date, week: info.week, hours: perDay, fill: cell.fill });
              }
            }
          }
          c = m.maxCol + 1;
          continue;
        }
        const cell = ws.cell(row, c);
        const info = colInfo.get(c);
        if (isNum(cell.v) && cell.v && info) {
          sessions.push({ date: info.date, week: info.week, hours: cell.v, fill: cell.fill });
        } else if (isText(cell.v)) {
          notes.push({ date: c !== 5 && info ? info.date : null, text: cell.v.trim() });
        }
        c++;
      }

      const lecturers = isText(lecturerRaw)
        ? lecturerRaw
            .split(/[/,]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      const subcategory = isText(subcatRaw) ? subcatRaw.trim() : null;
      const highlights = sessions.filter((s) => s.fill).map((s) => s.fill);
      const plain = sessions.filter((s) => !s.fill);
      const reducedAvailable = highlights.length > 0 && plain.length > 0 && new Set(highlights).size === 1;
      sessions.forEach((s) => {
        s.reduced = reducedAvailable ? !!s.fill : true;
        delete s.fill;
      });

      courses.push({
        key: section + "::" + (code || title),
        id: "c" + row,
        row,
        code,
        title,
        raw_name: nameCell.replace(/\n/g, " ").trim(),
        section,
        subcategory,
        cohort: subcategory || section,
        lecturers,
        lecturer_raw: isText(lecturerRaw) ? lecturerRaw : lecturerRaw ?? null,
        total_hours: isNum(totalHours) ? totalHours : null,
        reduced_available: reducedAvailable,
        sessions: sessions.sort((a, b) => a.date.localeCompare(b.date)),
        notes,
      });
    }

    // --- block assignment ---------------------------------------------------
    const verified = verifyBlockModel();
    const byCohortDay = new Map();
    courses.forEach((course) => {
      course.sessions.forEach((s) => {
        const k = course.cohort + " " + s.date;
        if (!byCohortDay.has(k)) byCohortDay.set(k, []);
        byCohortDay.get(k).push([course, s]);
      });
    });

    const weekdayOf = new Map();
    colInfo.forEach((info) => weekdayOf.set(info.date, info.weekday));

    byCohortDay.forEach((entries) => {
      const wd = weekdayOf.get(entries[0][1].date);
      const single = entries.filter(([, s]) => !needsBothBlocks(s.hours, wd)).sort((a, b) => a[0].row - b[0].row);
      const both = entries.filter(([, s]) => needsBothBlocks(s.hours, wd));
      both.forEach(([, s]) => (s.blocks = blocksFor(s.hours, wd, false)));
      single.forEach(([, s], i) => (s.blocks = blocksFor(s.hours, wd, i % 2 === 1)));
    });

    courses.forEach((course) => {
      const expanded = [];
      course.sessions.forEach((session) => {
        const dayLessons = session.hours;
        const blocks = session.blocks || [];
        delete session.blocks;
        blocks.forEach(([start, end, lessons, half]) => {
          expanded.push({
            date: session.date,
            week: session.week,
            hours: lessons,
            start,
            end,
            half,
            reduced: session.reduced,
            lessons: lessonSpans(start, lessons),
            day_lessons: dayLessons,
            blocks_today: blocks.length,
          });
        });
      });
      expanded.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
      course.sessions = expanded;
    });

    const sections = [];
    SECTION_HEADER_ROWS.forEach(([, name]) => {
      if (!sections.includes(name)) sections.push(name);
    });
    const orphans = Array.from(new Set(courses.map((c) => c.section))).filter((s) => !sections.includes(s));
    if (orphans.length) throw new Error("Emner i ukjent kategori: " + orphans.join(", "));

    const allDates = Array.from(colInfo.values())
      .map((i) => i.date)
      .sort();

    const termLabel = isText(ws.value(1, 1)) ? ws.value(1, 1).trim() : "";
    const versionNote = (() => {
      for (let r = 60; r <= 70; r++) {
        const v = ws.value(r, 2);
        if (isText(v) && /versjon/i.test(v)) return v.trim();
      }
      return "";
    })();

    return {
      term: options.term || (/vår|vaar/i.test(sheetName) ? "Vår " + year : "Høst " + year),
      source_sheet: sheetName,
      generated_note: versionNote || termLabel,
      date_range: { start: allDates[0], end: allDates[allDates.length - 1] },
      sections,
      courses,
      week_notes: weekNotes,
      day_notes: dayNotes,
      staff_legend: staffLegend,
      exam_code_legend: examLegend,
      reduced_teaching_note: isText(ws.value(65, 5)) ? ws.value(65, 5).trim() : "",
      _stats: {
        verified,
        courseDays: courses.reduce((a, c) => a + new Set(c.sessions.map((s) => s.date)).size, 0),
        blocks: courses.reduce((a, c) => a + c.sessions.length, 0),
        lessons: courses.reduce((a, c) => a + c.sessions.reduce((b, s) => b + s.hours, 0), 0),
      },
    };
  }

  return { parse, verifyBlockModel };
})();
