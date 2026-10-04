(function () {
  "use strict";
  const DATA = window.HLT_DATA;
  const SECTIONS = DATA.sections;
  const COURSES = DATA.courses;
  const STAFF = DATA.staff_legend;
  const WEEK_NOTES = DATA.week_notes;
  const DAY_NOTES = DATA.day_notes;

  // Exams come from the exam-date PDF, not the semester spreadsheet, so they
  // load from their own file and are absent if that file is not deployed.
  const EXAM_DATA = window.HLT_EXAMS || { exams: [], source: null, note: null };
  const EXAMS = EXAM_DATA.exams || [];
  const COURSE_BY_KEY = new Map();

  const NOW = new Date();
  const TODAY_ISO = NOW.toISOString().slice(0, 10);

  const MONTH_NAMES = ["", "Januar", "Februar", "Mars", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Desember"];
  const DOW_SHORT = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];
  const DOW_FULL = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"];

  // ---------------------------------------------------------------- helpers
  function parseISO(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function toISO(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function isoWeekday(d) {
    const wd = d.getDay();
    return wd === 0 ? 7 : wd;
  }
  function getISOWeek(d) {
    const date = new Date(d.getTime());
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 4 - isoWeekday(date));
    const yearStart = new Date(date.getFullYear(), 0, 1);
    return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  }
  function isoWeekToMonday(year, week) {
    const simple = new Date(year, 0, 4 + (week - 1) * 7);
    const dow = simple.getDay() || 7;
    simple.setDate(simple.getDate() - dow + 1);
    return simple;
  }
  function fmtDayMonth(d) {
    return d.getDate() + ". " + MONTH_NAMES[d.getMonth() + 1].slice(0, 3).toLowerCase();
  }
  function fmtHours(h) {
    return (Math.round(h * 10) / 10).toString().replace(".", ",");
  }
  function legendName(code) {
    return STAFF[code] ? code + " – " + STAFF[code] : code;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const ALL_COURSE_IDS = COURSES.map((c) => c.id);

  function courseLabel(c) {
    return c.code || c.title;
  }

  // Number of --cN colour triples defined in style.css. Keep in sync.
  const PALETTE_SIZE = 11;

  function sectionColorVar(section) {
    const idx = SECTIONS.indexOf(section);
    const n = idx >= 0 ? idx % PALETTE_SIZE : PALETTE_SIZE - 1;
    return { fg: `var(--c${n}-fg)`, bg: `var(--c${n}-bg)`, solid: `var(--c${n})` };
  }

  // ------------------------------------------------------------------ state
  const state = {
    search: "",
    // Courses are filtered by id, since codes such as VEL1220 and PAL1212
    // appear in more than one category.
    courseIds: new Set(ALL_COURSE_IDS),
    // Show only the dates a reduced-teaching student must attend.
    reducedOnly: false,
    // Exams are shown alongside teaching; they can be hidden on their own.
    showExams: true,
    view: "month",
    monthCursor: { year: 2026, month: 8 },
    // Monday of the displayed week, as an ISO date. Stored as a date rather
    // than a week number because exams run past new year into 2027.
    weekStart: null,
  };

  // ------------------------------------------------------- saved preferences
  // Selections are stored per browser under stable course keys, so they survive
  // a reload and a re-uploaded plan that shifts row numbers around.
  const STORAGE_KEY = "hlt-semesterplan-valg-v1";

  function savePrefs() {
    try {
      const all = COURSES.length && COURSES.every((c) => state.courseIds.has(c.id));
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          all,
          courses: all ? [] : COURSES.filter((c) => state.courseIds.has(c.id)).map((c) => c.key),
          reduced: state.reducedOnly,
          exams: state.showExams,
        })
      );
    } catch (e) {
      /* private mode or storage full — the app still works, just without memory */
    }
  }

  function loadPrefs() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (e) {
      saved = null;
    }
    if (!saved) return;
    state.reducedOnly = !!saved.reduced;
    if (typeof saved.exams === "boolean") state.showExams = saved.exams;
    if (saved.all || !Array.isArray(saved.courses)) return;
    const wanted = new Set(saved.courses);
    const matched = COURSES.filter((c) => wanted.has(c.key));
    // A plan can be re-uploaded with courses added or dropped; keep whatever
    // still exists, and ignore the memory entirely if none of it matches.
    if (matched.length) state.courseIds = new Set(matched.map((c) => c.id));
  }

  loadPrefs();

  // ------------------------------------------------------------------- exams
  COURSES.forEach((c) => COURSE_BY_KEY.set(c.key, c));

  const EXAM_KIND_LABEL = { skoleeksamen: "Skoleeksamen", muntlig: "Muntlig eksamen", innlevering: "Innlevering" };

  function examName(exam) {
    return exam.code + (exam.variant ? " " + exam.variant : "");
  }

  // One calendar entry per sitting or deadline. A submission has no start
  // time — only the deadline — so `deadline` marks which kind of block to draw.
  const EXAM_EVENTS = (() => {
    const out = [];
    EXAMS.forEach((exam) => {
      const course = exam.course_key ? COURSE_BY_KEY.get(exam.course_key) || null : null;
      exam.occurrences.forEach((occ, i) => {
        out.push({
          isExam: true,
          exam,
          course,
          date: occ.date,
          start: occ.start,
          end: occ.end,
          room: occ.room,
          until: occ.until,
          deadline: !occ.start,
          seq: i + 1,
          total: exam.occurrences.length,
        });
      });
    });
    out.sort((a, b) => (a.date + (a.start || a.end || "")).localeCompare(b.date + (b.start || b.end || "")));
    return out;
  })();

  // Exams follow the course picker. One that has no course in the plan (the
  // Norwegian VEL5040) would otherwise be unreachable, so it always shows.
  function visibleExamEvents() {
    if (!state.showExams) return [];
    const needle = state.search.trim().toLowerCase();
    return EXAM_EVENTS.filter((e) => {
      if (e.course && !state.courseIds.has(e.course.id)) return false;
      if (needle) {
        const hay = [examName(e.exam), e.exam.title, e.exam.form, e.room, (e.exam.teachers || []).join(" ")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }

  function examsForCourse(course) {
    return EXAMS.filter((x) => x.course_key === course.key);
  }

  // ------------------------------------------------------------ week cursor
  // Every Monday that has teaching or an exam, so the week picker reaches into
  // the exam period after the teaching plan ends.
  const WEEK_STARTS = (() => {
    const set = new Set();
    const add = (iso) => {
      const d = parseISO(iso);
      d.setDate(d.getDate() - (isoWeekday(d) - 1));
      set.add(toISO(d));
    };
    COURSES.forEach((c) => c.sessions.forEach((s) => add(s.date)));
    EXAM_EVENTS.forEach((e) => add(e.date));
    return Array.from(set).sort();
  })();

  (function initWeekCursor() {
    state.weekStart = WEEK_STARTS[0] || toISO(NOW);
    // Land on the current week if the term is under way.
    const monday = new Date(NOW.getTime());
    monday.setDate(monday.getDate() - (isoWeekday(monday) - 1));
    const thisWeek = toISO(monday);
    if (WEEK_STARTS.includes(thisWeek)) state.weekStart = thisWeek;
    const first = WEEK_STARTS[0];
    const last = WEEK_STARTS[WEEK_STARTS.length - 1];
    if (first && TODAY_ISO >= first && TODAY_ISO <= last) {
      state.monthCursor = { year: NOW.getFullYear(), month: NOW.getMonth() + 1 };
    }
  })();

  // --------------------------------------------------------------- filtering
  function courseHaystack(c) {
    return [c.code, c.title, c.raw_name, c.section, c.subcategory, ...c.lecturers.map((l) => l + " " + (STAFF[l] || ""))]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function courseMatches(c) {
    if (!state.courseIds.has(c.id)) return false;
    if (state.search.trim()) {
      const needle = state.search.trim().toLowerCase();
      if (!courseHaystack(c).includes(needle)) return false;
    }
    return true;
  }

  function filteredCourses() {
    return COURSES.filter(courseMatches);
  }

  function anyFilterActive() {
    if (state.search.trim()) return true;
    return COURSES.some((c) => !state.courseIds.has(c.id));
  }

  // With reduced teaching on, courses offering it drop to their mandatory
  // dates. Courses without the option are unaffected — every date still counts.
  function visibleSessions(course) {
    if (!state.reducedOnly || !course.reduced_available) return course.sessions;
    return course.sessions.filter((s) => s.reduced);
  }

  function flatSessions(courses) {
    const out = [];
    courses.forEach((c) => {
      visibleSessions(c).forEach((s) => {
        out.push({ ...s, course: c });
      });
    });
    out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    return out;
  }

  function eventsByDate(sessions) {
    const map = new Map();
    sessions.forEach((s) => {
      if (!map.has(s.date)) map.set(s.date, []);
      map.get(s.date).push(s);
    });
    return map;
  }

  // ------------------------------------------------------------------ modal
  function closeModal() {
    const el = document.getElementById("modal-root");
    el.innerHTML = "";
  }

  function sessionCardHtml(s) {
    const col = sectionColorVar(s.course.section);
    const split = s.blocks_today > 1;
    return `<div class="modal-session" style="border-left:3px solid ${col.solid}">
      <div class="m-code">${escapeHtml(s.course.code || s.course.title)}${
      split ? `<span class="m-half">${s.half === "am" ? "formiddag" : "ettermiddag"}</span>` : ""
    }</div>
      ${s.course.code ? `<div class="m-title">${escapeHtml(s.course.title)}</div>` : ""}
      <div class="m-meta">${s.start}–${s.end} · ${fmtHours(s.hours)} ${
      s.hours === 1 ? "time" : "timer"
    } á 45 min · ${escapeHtml(s.course.section)}${
      s.course.lecturers.length ? " · " + s.course.lecturers.map(legendName).join(", ") : ""
    }</div>
      ${
        split
          ? `<div class="m-chain">Emnet har ${fmtHours(s.day_lessons)} timer denne dagen, delt i to økter med lunsj imellom</div>`
          : ""
      }
    </div>`;
  }

  function showDayModal(iso) {
    const d = parseISO(iso);
    const sessions = flatSessions(filteredCourses()).filter((s) => s.date === iso);
    const week = getISOWeek(d);
    const weekNote = WEEK_NOTES[String(week)];
    const dayNote = DAY_NOTES[iso];
    let body = "";
    if (weekNote) body += `<p class="modal-sub" style="color:var(--accent)">Uke ${week}: ${escapeHtml(weekNote)}</p>`;
    if (dayNote && dayNote.event) body += `<p class="modal-sub">📌 ${escapeHtml(dayNote.event)}</p>`;
    const dayExams = visibleExamEvents().filter((e) => e.date === iso);
    if (dayExams.length) body += dayExams.map(examCardHtml).join("");
    if (!sessions.length && !dayExams.length) {
      body += `<p class="empty-state">Ingen undervisning registrert${anyFilterActive() ? " for valgte filtre" : ""} denne dagen.</p>`;
    } else {
      body += sessions.map(sessionCardHtml).join("");
    }
    renderModal(`${DOW_FULL[isoWeekday(d) - 1]} ${fmtDayMonth(d)} ${d.getFullYear()}`, `Uke ${week}`, body);
  }

  function showCourseModal(courseId) {
    const c = COURSES.find((x) => x.id === courseId);
    if (!c) return;
    const sessions = visibleSessions(c).slice().sort((a, b) => a.date.localeCompare(b.date));
    let body = `<p class="modal-sub">${escapeHtml(c.section)}${c.subcategory ? " · " + escapeHtml(c.subcategory) : ""}</p>`;
    body += `<p class="modal-sub">Foreleser(e): ${c.lecturers.length ? c.lecturers.map(legendName).join(", ") : "–"} · Totalt ${c.total_hours ?? "?"} timer</p>`;
    if (c.notes && c.notes.length) {
      body += c.notes.map((n) => `<p class="modal-sub" style="font-style:italic">${n.date ? fmtDayMonth(parseISO(n.date)) + ": " : ""}${escapeHtml(n.text)}</p>`).join("");
    }
    const courseExams = examsForCourse(c);
    if (courseExams.length) {
      body += `<h4 class="modal-h">Eksamen</h4>`;
      body += courseExams.map((x) => examSummaryHtml(x)).join("");
    }
    if (!sessions.length) {
      body += `<p class="empty-state">Ingen undervisningsdatoer registrert i planen ennå.</p>`;
    } else {
      body += `<h4 class="modal-h">Undervisning</h4>`;
      body += sessions
        .map((s) => {
          const d = parseISO(s.date);
          return `<div class="modal-session">
          <div class="m-code">${DOW_SHORT[isoWeekday(d) - 1]} ${fmtDayMonth(d)}</div>
          <div class="m-meta">${s.start}–${s.end} · ${fmtHours(s.hours)} t · uke ${s.week}</div>
        </div>`;
        })
        .join("");
    }
    renderModal(c.code || c.title, c.title !== (c.code || "") ? c.title : "", body);
  }

  function examDateText(occ) {
    const d = parseISO(occ.date);
    let text = DOW_SHORT[isoWeekday(d) - 1] + " " + fmtDayMonth(d) + " " + d.getFullYear();
    if (occ.until) {
      const u = parseISO(occ.until);
      text += " – " + fmtDayMonth(u) + " " + u.getFullYear();
    }
    return text;
  }

  function examTimeText(occ) {
    if (occ.start) return occ.start + (occ.end ? "–" + occ.end : "");
    return "frist kl. " + (occ.end || "12:00");
  }

  // One dated sitting or deadline, as shown in the day modal.
  function examCardHtml(e) {
    return `<div class="modal-session modal-exam" data-act="exam" data-id="${e.exam.id}" style="cursor:pointer">
      <div class="m-code">${escapeHtml(examName(e.exam))}<span class="m-exam-tag">${escapeHtml(
      EXAM_KIND_LABEL[e.exam.kind] || "Eksamen"
    )}</span></div>
      <div class="m-title">${escapeHtml(e.exam.title)}</div>
      <div class="m-meta">${escapeHtml(examTimeText(e))}${e.room ? " · " + escapeHtml(e.room) : ""}${
      e.total > 1 ? ` · dag ${e.seq} av ${e.total}` : ""
    }${e.exam.form ? " · " + escapeHtml(e.exam.form) : ""}</div>
    </div>`;
  }

  // The whole exam, as shown inside a course.
  function examSummaryHtml(exam) {
    const when = exam.occurrences.length
      ? exam.occurrences.map((o) => escapeHtml(examDateText(o) + " · " + examTimeText(o) + (o.room ? " · " + o.room : ""))).join("<br>")
      : `<em>${escapeHtml(exam.tbd || "Dato ikke fastsatt")}</em>`;
    return `<div class="modal-session modal-exam" data-act="exam" data-id="${exam.id}" style="cursor:pointer">
      <div class="m-code">${escapeHtml(examName(exam))}<span class="m-exam-tag">${escapeHtml(
      EXAM_KIND_LABEL[exam.kind] || "Eksamen"
    )}</span></div>
      ${exam.form ? `<div class="m-title">${escapeHtml(exam.form)}</div>` : ""}
      <div class="m-meta">${when}</div>
    </div>`;
  }

  function showExamModal(examId) {
    const exam = EXAMS.find((x) => x.id === examId);
    if (!exam) return;
    let body = `<p class="modal-sub">${escapeHtml(EXAM_KIND_LABEL[exam.kind] || "Eksamen")}${
      exam.master ? " · master" : ""
    }${exam.form ? " · " + escapeHtml(exam.form) : ""}</p>`;

    const rows = [];
    if (exam.anonymous !== null && exam.anonymous !== undefined) {
      rows.push(["Anonymitet", exam.anonymous ? "Anonym" : "Ikke anonym"]);
    }
    if (exam.teachers && exam.teachers.length) rows.push(["Faglærer", exam.teachers.map(legendName).join(", ")]);
    if (exam.grading) rows.push(["Sensurfrist", examDateText({ date: exam.grading })]);
    const course = exam.course_key ? COURSE_BY_KEY.get(exam.course_key) : null;
    if (course) rows.push(["Emne i planen", course.section]);
    if (rows.length) {
      body += `<table class="info-table">${rows
        .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
        .join("")}</table>`;
    }

    if (exam.occurrences.length) {
      body += exam.occurrences
        .map(
          (o) => `<div class="modal-session">
        <div class="m-code">${escapeHtml(examDateText(o))}</div>
        <div class="m-meta">${escapeHtml(examTimeText(o))}${o.room ? " · " + escapeHtml(o.room) : ""}${
            o.until ? " · 72 timer" : ""
          }</div>
      </div>`
        )
        .join("");
    } else {
      body += `<p class="empty-state">${escapeHtml(exam.tbd || "Dato ikke fastsatt")}</p>`;
    }

    if (exam.note) body += `<p class="modal-sub" style="font-style:italic">${escapeHtml(exam.note)}</p>`;
    if (!course) {
      body += `<p class="admin-note">Dette emnet står ikke i semesterplanen, så eksamenen vises uavhengig av emnevalget.</p>`;
    }
    body += `<p class="admin-note">${escapeHtml(EXAM_DATA.note || "")}${
      EXAM_DATA.source ? " Kilde: " + escapeHtml(EXAM_DATA.source) : ""
    }</p>`;
    renderModal(examName(exam), exam.title, body);
  }

  function showInfoModal() {
    const staffRows = Object.entries(STAFF)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([code, name]) => `<div>${escapeHtml(code)} — ${escapeHtml(name)}</div>`)
      .join("");
    const body = `
      <p class="modal-sub">${escapeHtml(DATA.generated_note)}</p>
      <h3 style="margin-top:14px">Beregning av start- og sluttider</h3>
      <p class="modal-sub">Semesterplanen viser antall undervisningstimer per dag — ingen klokkeslett. Én time er en <strong>undervisningstime på 45 minutter</strong>, med 15 minutters pause mellom timene. En økt med N timer varer derfor N×45 + (N−1)×15 minutter: 1 time = 45 min, 2 timer = 1 t 45 min, 3 timer = 2 t 45 min, 4 timer = 3 t 45 min.</p>
      <p class="modal-sub">Undervisningen går i to faste økter: formiddagsøkten starter <strong>09:00</strong> (mandager <strong>10:00</strong>), og ettermiddagsøkten starter alltid <strong>12:30</strong>. Lunsjen er tiden som blir igjen mellom øktene. Det gir disse sluttidene:</p>
      <table class="info-table">
        <thead><tr><th>Timer i økten</th><th>Fra 09:00</th><th>Fra 12:30</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>09:45</td><td>13:15</td></tr>
          <tr><td>2</td><td>10:45</td><td>14:15</td></tr>
          <tr><td>3</td><td>11:45</td><td>15:15</td></tr>
          <tr><td>4</td><td>12:45</td><td>16:15</td></tr>
        </tbody>
      </table>
      <p class="modal-sub">Har et emne flere timer enn det er plass til før 12:30, deles dagen i to økter med lunsj imellom. Har samme studentgruppe to korte emner samme dag, tar det første formiddagen og det andre ettermiddagen.</p>
      <p class="modal-sub">Modellen er utledet fra skjermbilder av den publiserte timeplanen og stemmer med alle sju kontrollerte øktene. To ting er ikke bekreftet: fredager med 4 timer (her lagt som 3 + 1, altså slutt 13:15) og mandager med 3 timer (lagt som 2 + 1).</p>
      <h3 style="margin-top:14px">Redusert undervisning</h3>
      <p class="modal-sub">Emner merket <strong>R</strong> i emnevelgeren tilbyr redusert undervisning. Slår du på «Redusert undervisning» der, vises bare datoene som er obligatoriske for disse emnene. Hvilke datoer det gjelder er hentet fra fargemerkingen i regnearket, slik forklaringen i planen beskriver.</p>
      <p class="modal-sub">${escapeHtml(DATA.reduced_teaching_note || "")}</p>
      <h3 style="margin-top:14px">Eksamen</h3>
      <p class="modal-sub">Eksamensdatoer og innleveringsfrister kommer fra ${escapeHtml(
        EXAM_DATA.source || "eksamensoversikten"
      )} og vises sammen med undervisningen. Fylt merke er en eksamen du møter opp til; åpent merke er en innleveringsfrist (kl. 12:00). Eksamener følger emnevalget, og kan skjules med «Vis eksamener» i emnevelgeren. ${escapeHtml(
        EXAM_DATA.note || ""
      )}</p>
      <p class="modal-sub">Sensurfrist står i detaljene for hver eksamen. Noen emner mangler dato fordi oversikten venter på emneansvarlig; de er merket i emnevisningen.</p>
      <h3 style="margin-top:14px">Lagring</h3>
      <p class="modal-sub">Emnevalget og innstillingen for redusert undervisning lagres i denne nettleseren, så de er der neste gang du åpner siden. «Nullstill» tømmer dem.</p>
      <h3 style="margin-top:14px">Fagpersoner</h3>
      <div class="legend-grid">${staffRows}</div>
    `;
    renderModal("Om planen", "", body);
  }

  function renderModal(title, sub, bodyHtml) {
    const el = document.getElementById("modal-root");
    el.innerHTML = `<div class="modal-backdrop" data-close="1">
      <div class="modal" data-stop="1">
        <button class="modal-close" data-close="1">&times;</button>
        <h3>${escapeHtml(title)}</h3>
        ${sub ? `<div class="modal-sub">${escapeHtml(sub)}</div>` : ""}
        ${bodyHtml}
      </div>
    </div>`;
    el.querySelectorAll("[data-close]").forEach((n) =>
      n.addEventListener("click", (e) => {
        if (e.target.dataset.close) closeModal();
      })
    );
    el.querySelector(".modal").addEventListener("click", (e) => e.stopPropagation());
    bindExamClicks(el);
  }

  // Below this width month cells show colour dots instead of course codes.
  const COMPACT_BREAKPOINT = 560;
  function isCompact() {
    return window.innerWidth <= COMPACT_BREAKPOINT;
  }

  // The side-by-side timeline needs ~260px for names plus ~8px per week to be
  // legible. Below that the name column starves the track, so stack instead.
  const TIMELINE_STACK_BREAKPOINT = 760;
  function isTimelineStacked() {
    return window.innerWidth <= TIMELINE_STACK_BREAKPOINT;
  }

  // Must match the max-width of the full-width popover rule in style.css,
  // below which the panels span the toolbar and need no flipping.
  const POPOVER_STACK_BREAKPOINT = 700;

  // A panel anchored under its own button can run off the right edge when the
  // button sits far right — flip it to right-aligned instead of overflowing.
  function positionPopover(details) {
    const panel = details.querySelector(".popover-panel");
    if (!panel) return;
    panel.style.left = "";
    panel.style.right = "";
    if (window.innerWidth <= POPOVER_STACK_BREAKPOINT) return; // CSS handles it
    if (!details.open) return;
    const rect = panel.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      panel.style.left = "auto";
      panel.style.right = "0";
    }
  }

  function positionAllPopovers() {
    document.querySelectorAll("details.filter-popover").forEach(positionPopover);
  }

  // -------------------------------------------------------------- month view
  function renderMonth(root) {
    const { year, month } = state.monthCursor;
    const sessions = flatSessions(filteredCourses());
    const byDate = eventsByDate(sessions);
    const examsByDate = eventsByDate(visibleExamEvents());

    const first = new Date(year, month - 1, 1);
    const startOffset = isoWeekday(first) - 1;
    const gridStart = new Date(year, month - 1, 1 - startOffset);

    let html = `<div class="view-nav">
      <div class="nav-btns">
        <button class="btn" data-act="month-prev">‹</button>
        <h2>${MONTH_NAMES[month]} ${year}</h2>
        <button class="btn" data-act="month-next">›</button>
      </div>
      <div class="nav-btns">
        <select data-act="month-select">${monthOptions(year, month)}</select>
        <button class="btn" data-act="month-today">I dag</button>
      </div>
    </div>`;

    html += `<div class="month-grid">`;
    DOW_SHORT.concat(["Lør", "Søn"]).slice(0, 0); // no-op guard
    ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"].forEach((d) => (html += `<div class="dow">${d}</div>`));

    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getTime());
      d.setDate(gridStart.getDate() + i);
      const iso = toISO(d);
      const outside = d.getMonth() + 1 !== month;
      const wk = getISOWeek(d);
      const weekNote = WEEK_NOTES[String(wk)];
      const dayNote = DAY_NOTES[iso];
      // One chip per course: a course split across the morning and afternoon
      // blocks is still one subject on this date.
      const seenCourse = new Set();
      const evs = (byDate.get(iso) || [])
        .slice()
        .sort((a, b) => a.start.localeCompare(b.start))
        .filter((s) => !seenCourse.has(s.course.id) && seenCourse.add(s.course.id));
      const isToday = iso === TODAY_ISO;

      html += `<div class="day-cell${outside ? " outside" : ""}${isToday ? " today" : ""}" data-act="day" data-date="${iso}">`;
      html += `<div class="date-num">${d.getDate()}${d.getDate() === 1 || i === 0 ? " " + MONTH_NAMES[d.getMonth() + 1].slice(0, 3) : ""}</div>`;
      if (weekNote && isoWeekday(d) === 1) html += `<div class="week-flag">${escapeHtml(weekNote)}</div>`;
      if (dayNote && dayNote.event) html += `<div class="event-note" title="${escapeHtml(dayNote.event)}">${escapeHtml(dayNote.event)}</div>`;
      html += `<div class="chips-wrap">`;
      // Exams first: they are the fixed points a student plans around.
      (examsByDate.get(iso) || []).forEach((e) => {
        html += `<div class="session-chip exam-chip${e.deadline ? " exam-chip-deadline" : ""}" title="${escapeHtml(
          examChipTitle(e)
        )}">${escapeHtml(examName(e.exam))}</div>`;
      });
      const shown = evs.slice(0, isCompact() ? 10 : 3);
      shown.forEach((s) => {
        const col = sectionColorVar(s.course.section);
        html += `<div class="session-chip" style="background:${col.bg};color:${col.fg};--chip-solid:${col.solid}" title="${escapeHtml(
          (s.course.code ? s.course.code + " – " : "") + s.course.title
        )}">${escapeHtml(s.course.code || s.course.title.slice(0, 10))}</div>`;
      });
      if (evs.length > shown.length) html += `<div class="more-chip">+${evs.length - shown.length} til</div>`;
      html += `</div></div>`;
    }
    html += `</div>`;
    root.innerHTML = html;

    root.querySelector('[data-act="month-prev"]').onclick = () => {
      let m = month - 1, y = year;
      if (m < 1) { m = 12; y--; }
      state.monthCursor = { year: y, month: m };
      renderView();
    };
    root.querySelector('[data-act="month-next"]').onclick = () => {
      let m = month + 1, y = year;
      if (m > 12) { m = 1; y++; }
      state.monthCursor = { year: y, month: m };
      renderView();
    };
    root.querySelector('[data-act="month-today"]').onclick = () => {
      state.monthCursor = { year: 2026, month: 8 };
      if (TODAY_ISO >= DATA.date_range.start && TODAY_ISO <= DATA.date_range.end) {
        state.monthCursor = { year: NOW.getFullYear(), month: NOW.getMonth() + 1 };
      }
      renderView();
    };
    root.querySelector('[data-act="month-select"]').onchange = (e) => {
      const [y, m] = e.target.value.split("-").map(Number);
      state.monthCursor = { year: y, month: m };
      renderView();
    };
    root.querySelectorAll('[data-act="day"]').forEach((n) => (n.onclick = () => showDayModal(n.dataset.date)));
  }

  // Every month holding teaching or an exam, so the picker reaches the exam
  // period that runs past the end of the teaching plan.
  const CONTENT_MONTHS = (() => {
    const set = new Set();
    COURSES.forEach((c) => c.sessions.forEach((s) => set.add(s.date.slice(0, 7))));
    EXAM_EVENTS.forEach((e) => set.add(e.date.slice(0, 7)));
    return Array.from(set).sort();
  })();

  function monthOptions(curYear, curMonth) {
    const cur = curYear + "-" + String(curMonth).padStart(2, "0");
    return CONTENT_MONTHS.map((ym) => {
      const [y, m] = ym.split("-").map(Number);
      const sel = ym === cur ? "selected" : "";
      return `<option value="${y}-${m}" ${sel}>${MONTH_NAMES[m]} ${y}</option>`;
    }).join("");
  }

  function examChipTitle(e) {
    const bits = [examName(e.exam) + " – " + e.exam.title, EXAM_KIND_LABEL[e.exam.kind] || "Eksamen"];
    if (e.deadline) bits.push("Frist kl. " + (e.end || "12:00"));
    else if (e.start) bits.push(e.start + (e.end ? "–" + e.end : ""));
    if (e.room) bits.push(e.room);
    if (e.total > 1) bits.push(`dag ${e.seq} av ${e.total}`);
    return bits.join(" · ");
  }

  // --------------------------------------------------------------- week view
  function weekOptions(cur) {
    return WEEK_STARTS.map((iso) => {
      const mon = parseISO(iso);
      const sat = new Date(mon.getTime());
      sat.setDate(mon.getDate() + 5);
      const label = `Uke ${getISOWeek(mon)} (${fmtDayMonth(mon)}–${fmtDayMonth(sat)}${
        mon.getFullYear() !== 2026 ? " " + mon.getFullYear() : ""
      })`;
      return `<option value="${iso}" ${iso === cur ? "selected" : ""}>${label}</option>`;
    }).join("");
  }

  function toMinutes(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }

  // Greedy interval packing: assign each session the first lane whose last
  // session has already ended, so parallel classes never cover each other.
  function packLanes(sessions) {
    const laneEnds = [];
    const of = sessions.map((s) => {
      const start = toMinutes(s.start), end = toMinutes(s.end);
      let lane = laneEnds.findIndex((e) => e <= start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(end);
      } else {
        laneEnds[lane] = end;
      }
      return lane;
    });
    return { of, count: laneEnds.length };
  }

  function renderWeek(root) {
    const monday = parseISO(state.weekStart);
    const wk = getISOWeek(monday);
    const days = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(monday.getTime());
      d.setDate(monday.getDate() + i);
      days.push(d);
    }
    const from = toISO(days[0]);
    const to = toISO(days[days.length - 1]);
    const inWeek = (iso) => iso >= from && iso <= to;

    const sessions = flatSessions(filteredCourses()).filter((s) => inWeek(s.date));
    // Exams share the day rows with teaching, so they go through the same
    // date index and lane packing.
    const exams = visibleExamEvents().filter((e) => inWeek(e.date));
    const byDate = eventsByDate(sessions.concat(exams.map(examAsBlock)));

    let minH = 8, maxH = 17;
    byDate.forEach((list) =>
      list.forEach((s) => {
        minH = Math.min(minH, parseInt(s.start.split(":")[0]));
        maxH = Math.max(maxH, parseInt(s.end.split(":")[0]) + (s.end.endsWith(":00") ? 0 : 1));
      })
    );
    const hourSpan = maxH - minH;

    const weekNote = WEEK_NOTES[String(wk)];

    let html = `<div class="view-nav">
      <div class="nav-btns">
        <button class="btn" data-act="week-prev">‹</button>
        <h2>Uke ${wk}${monday.getFullYear() !== 2026 ? " · " + monday.getFullYear() : ""}${weekNote ? " · " + escapeHtml(weekNote) : ""}</h2>
        <button class="btn" data-act="week-next">›</button>
      </div>
      <div class="nav-btns"><select data-act="week-select">${weekOptions(state.weekStart)}</select></div>
    </div>`;

    const pct = (mins) => ((mins - minH * 60) / (hourSpan * 60)) * 100;
    const LANE_H = 26;

    html += `<div class="wk-wrap"><div class="wk-grid">`;
    html += `<div class="wk-row wk-headrow"><div class="wk-gutter"></div><div class="wk-track">`;
    for (let h = minH; h <= maxH; h++) {
      html += `<div class="wk-hourline" style="left:${pct(h * 60)}%"></div>`;
      if (h < maxH) html += `<div class="wk-hourlabel" style="left:${pct(h * 60)}%">${h}:00</div>`;
    }
    html += `</div></div>`;

    days.forEach((d) => {
      const iso = toISO(d);
      const note = DAY_NOTES[iso];
      const evs = (byDate.get(iso) || []).slice().sort((a, b) => a.start.localeCompare(b.start) || b.hours - a.hours);
      const lanes = packLanes(evs);
      const rowH = Math.max(LANE_H + 6, lanes.count * LANE_H + 6);
      const isToday = iso === TODAY_ISO;

      html += `<div class="wk-row${isToday ? " today" : ""}">`;
      html += `<div class="wk-gutter"><strong>${DOW_SHORT[isoWeekday(d) - 1]}</strong> ${fmtDayMonth(d)}${
        note && note.event ? `<span class="wk-daynote">${escapeHtml(note.event)}</span>` : ""
      }</div>`;
      html += `<div class="wk-track" style="height:${rowH}px">`;
      for (let h = minH; h <= maxH; h++) html += `<div class="wk-hourline" style="left:${pct(h * 60)}%"></div>`;
      evs.forEach((s, idx) => {
        const startMin = toMinutes(s.start), endMin = toMinutes(s.end);
        if (s.isExam) {
          const e = s.event;
          html += `<div class="wk-block wk-exam${e.deadline ? " wk-exam-deadline" : ""}" data-act="exam" data-id="${e.exam.id}"
            title="${escapeHtml(examChipTitle(e))}"
            style="left:${pct(startMin)}%;width:${pct(endMin) - pct(startMin)}%;top:${lanes.of[idx] * LANE_H + 3}px">
            <span class="wk-b-code">${escapeHtml(examName(e.exam))}</span>
            <span class="wk-b-meta">${e.deadline ? "frist " + (e.end || "12:00") : e.start + (e.end ? "–" + e.end : "")}${
            e.room ? " · " + escapeHtml(e.room) : ""
          }</span>
          </div>`;
          return;
        }
        const col = sectionColorVar(s.course.section);
        // The 15-minute breaks between lessons are cut out of the block, so a
        // long session reads as the separate lessons it actually is.
        const gaps = (s.lessons || [])
          .slice(0, -1)
          .map((lesson, i) => {
            const from = toMinutes(lesson.end);
            const to = toMinutes(s.lessons[i + 1].start);
            const within = (m) => ((m - startMin) / (endMin - startMin)) * 100;
            return `<span class="wk-gap" style="left:${within(from)}%;width:${within(to) - within(from)}%" title="Pause ${lesson.end}–${s.lessons[i + 1].start}"></span>`;
          })
          .join("");
        html += `<div class="wk-block" data-act="course" data-id="${s.course.id}"
          title="${escapeHtml((s.course.code ? s.course.code + " – " : "") + s.course.title)} · ${s.start}–${s.end} · ${fmtHours(s.hours)} t${
          s.lessons && s.lessons.length > 1 ? ` (${s.lessons.length} timer med 15 min pause)` : ""
        }"
          style="left:${pct(startMin)}%;width:${pct(endMin) - pct(startMin)}%;top:${lanes.of[idx] * LANE_H + 3}px;background:${col.bg};color:${col.fg};box-shadow:inset 3px 0 0 0 ${col.solid}">
          ${gaps}
          <span class="wk-b-code">${escapeHtml(s.course.code || s.course.title.slice(0, 18))}</span>
          <span class="wk-b-meta">${s.start}–${s.end}${s.course.lecturers.length ? " · " + escapeHtml(s.course.lecturers.join("/")) : ""}</span>
        </div>`;
      });
      html += `</div></div>`;
    });
    html += `</div></div>`;

    if (!sessions.length && !exams.length)
      html += `<p class="empty-state">Ingen undervisning eller eksamen denne uken for valgte filtre.</p>`;

    root.innerHTML = html;
    const stepWeek = (delta) => {
      const i = WEEK_STARTS.indexOf(state.weekStart);
      const next = WEEK_STARTS[Math.min(WEEK_STARTS.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))];
      if (next) state.weekStart = next;
      renderView();
    };
    root.querySelector('[data-act="week-prev"]').onclick = () => stepWeek(-1);
    root.querySelector('[data-act="week-next"]').onclick = () => stepWeek(1);
    root.querySelector('[data-act="week-select"]').onchange = (e) => {
      state.weekStart = e.target.value;
      renderView();
    };
    root.querySelectorAll('[data-act="course"]').forEach((n) => (n.onclick = () => showCourseModal(n.dataset.id)));
    bindExamClicks(root);
  }

  // An exam needs start and end clock times to occupy space in the week grid.
  // A submission deadline has only its 12:00 cut-off, so it is drawn as a short
  // fixed-width marker ending at that time.
  function examAsBlock(e) {
    const endText = e.end || (e.start ? e.start : "12:00");
    let start = e.start;
    if (!start) {
      const [h, m] = endText.split(":").map(Number);
      const from = Math.max(0, h * 60 + m - 45);
      start = String(Math.floor(from / 60)).padStart(2, "0") + ":" + String(from % 60).padStart(2, "0");
    }
    return {
      isExam: true,
      event: e,
      date: e.date,
      start,
      end: endText,
      hours: 0,
      course: e.course,
    };
  }

  function bindExamClicks(root) {
    root.querySelectorAll('[data-act="exam"]').forEach((n) => (n.onclick = (ev) => {
      ev.stopPropagation();
      showExamModal(n.dataset.id);
    }));
  }

  // ------------------------------------------------------------- agenda view
  function renderAgenda(root) {
    const sessions = flatSessions(filteredCourses());
    const exams = visibleExamEvents();
    if (!sessions.length && !exams.length) {
      root.innerHTML = `<p class="empty-state">Ingen treff for valgte filtre/søk.</p>`;
      return;
    }
    const byDate = eventsByDate(sessions.concat(exams.map(examAsBlock)));
    const dates = Array.from(byDate.keys()).sort();
    let html = "";
    let curMonth = "";
    dates.forEach((iso) => {
      const d = parseISO(iso);
      const monthLabel = MONTH_NAMES[d.getMonth() + 1] + " " + d.getFullYear();
      if (monthLabel !== curMonth) {
        html += `<h2 style="font-size:13px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px">${monthLabel}</h2>`;
        curMonth = monthLabel;
      }
      const wk = getISOWeek(d);
      const weekNote = WEEK_NOTES[String(wk)];
      const dayNote = DAY_NOTES[iso];
      html += `<div class="agenda-day">`;
      html += `<div class="agenda-day-header">${DOW_FULL[isoWeekday(d) - 1]} ${fmtDayMonth(d)} <span class="wk">uke ${wk}${weekNote ? " · " + escapeHtml(weekNote) : ""}${dayNote && dayNote.event ? " · " + escapeHtml(dayNote.event) : ""}</span></div>`;
      const evs = byDate.get(iso).slice().sort((a, b) => a.start.localeCompare(b.start));
      evs.forEach((s) => {
        if (s.isExam) {
          const e = s.event;
          html += `<div class="agenda-row agenda-exam" data-act="exam" data-id="${e.exam.id}" style="cursor:pointer">
            <div class="time">${e.deadline ? "frist " + (e.end || "12:00") : e.start + (e.end ? "–" + e.end : "")}</div>
            <div class="tag exam-tag">${escapeHtml(examName(e.exam))}</div>
            <div class="title">${escapeHtml(e.exam.title)} <span class="exam-kind">${escapeHtml(
            EXAM_KIND_LABEL[e.exam.kind] || "Eksamen"
          )}${e.total > 1 ? ` · dag ${e.seq} av ${e.total}` : ""}</span></div>
            <div class="lect">${escapeHtml(e.room || "")}</div>
          </div>`;
          return;
        }
        const col = sectionColorVar(s.course.section);
        html += `<div class="agenda-row" data-act="course" data-id="${s.course.id}" style="cursor:pointer">
          <div class="time">${s.start}–${s.end}</div>
          <div class="tag" style="background:${col.bg};color:${col.fg}">${escapeHtml(s.course.code || "—")}</div>
          <div class="title">${escapeHtml(s.course.title)} <span style="color:var(--text-faint)">(${fmtHours(s.hours)} t)</span></div>
          <div class="lect">${s.course.lecturers.join("/")}</div>
        </div>`;
      });
      html += `</div>`;
    });
    root.innerHTML = html;
    root.querySelectorAll('[data-act="course"]').forEach((n) => (n.onclick = () => showCourseModal(n.dataset.id)));
    bindExamClicks(root);
  }

  // ----------------------------------------------------------- timeline view
  // Span the weeks that carry something: teaching, or a marked week such as the
  // exam period. The sheet's grid also reaches back into July, which never has
  // a class and only wasted width on a misleading "Jul" label. Derived from
  // every course, not the filtered set, so the axis holds still while filtering.
  const TIMELINE_WEEKS = (() => {
    const weeks = COURSES.flatMap((c) => c.sessions.map((s) => s.week)).filter((w) => typeof w === "number");
    Object.keys(WEEK_NOTES).forEach((w) => weeks.push(Number(w)));
    const out = [];
    if (!weeks.length) return out;
    for (let i = Math.min(...weeks); i <= Math.max(...weeks); i++) out.push(i);
    return out;
  })();

  // Weeks flagged in the sheet (exams, research week) — shown on the axis so a
  // stretch with no teaching still explains itself.
  function timelineNoteBandsHtml() {
    return TIMELINE_WEEKS.map((w, idx) => {
      const note = WEEK_NOTES[String(w)];
      if (!note) return "";
      return `<div class="tl-note-band" style="left:${(idx / TIMELINE_WEEKS.length) * 100}%;width:${(
        1 / TIMELINE_WEEKS.length
      ) * 100}%" title="Uke ${w}: ${escapeHtml(note)}"></div>`;
    }).join("");
  }

  // Week index at which each month starts, for axis labels and gridlines.
  function timelineMonthStarts() {
    const out = [];
    let last = null;
    TIMELINE_WEEKS.forEach((w, idx) => {
      const m = isoWeekToMonday(2026, w).getMonth() + 1;
      if (m !== last) {
        out.push({ idx, month: m, label: MONTH_NAMES[m].slice(0, 3) });
        last = m;
      }
    });
    return out;
  }

  function weekHoursFor(course) {
    const byWeek = {};
    visibleSessions(course).forEach((s) => (byWeek[s.week] = (byWeek[s.week] || 0) + s.hours));
    return byWeek;
  }

  // Marks for one course, positioned across the shared week grid.
  function timelineMarksHtml(course, solid) {
    const byWeek = weekHoursFor(course);
    let html = "";
    TIMELINE_WEEKS.forEach((w, idx) => {
      const hrs = byWeek[w];
      if (!hrs) return;
      const left = (idx / TIMELINE_WEEKS.length) * 100;
      const width = (1 / TIMELINE_WEEKS.length) * 100;
      const opacity = Math.min(1, 0.45 + hrs / 12);
      html += `<div class="timeline-mark" style="left:${left}%;width:${width}%;background:${solid};opacity:${opacity}" title="Uke ${w}: ${fmtHours(
        hrs
      )} t"></div>`;
    });
    return html;
  }

  function timelineGridlinesHtml() {
    return timelineMonthStarts()
      .filter((m) => m.idx > 0)
      .map((m) => `<div class="tl-gridline" style="left:${(m.idx / TIMELINE_WEEKS.length) * 100}%"></div>`)
      .join("");
  }

  // A course-day can now hold two blocks, so anything counting "days" has to
  // count distinct dates rather than session entries.
  function courseDays(course) {
    return new Set(visibleSessions(course).map((s) => s.date)).size;
  }

  function courseDayCount(courses) {
    return courses.reduce((a, c) => a + courseDays(c), 0);
  }

  function courseSpanLabel(course) {
    const list = visibleSessions(course);
    if (!list.length) return "";
    const first = parseISO(list[0].date);
    const last = parseISO(list[list.length - 1].date);
    const a = fmtDayMonth(first);
    return courseDays(course) === 1 ? a : `${a} – ${fmtDayMonth(last)}`;
  }

  function renderTimeline(root) {
    if (isTimelineStacked()) return renderTimelineStacked(root);
    return renderTimelineTable(root);
  }

  // Narrow screens: each course becomes a card with its name above a
  // full-width track, and a single sticky month axis serves the whole list.
  function renderTimelineStacked(root) {
    const courses = filteredCourses();
    const months = timelineMonthStarts();

    let html = `<div class="view-nav"><h2>Emner over semesteret</h2></div>`;

    if (!courses.length) {
      root.innerHTML = html + `<p class="empty-state">Ingen emner matcher valgte filtre.</p>`;
      return;
    }

    html += `<div class="tl-axis"><div class="tl-axis-inner">${timelineNoteBandsHtml()}${timelineGridlinesHtml()}${months
      .map(
        (m) =>
          `<span class="tl-axis-label" style="left:${(m.idx / TIMELINE_WEEKS.length) * 100}%">${escapeHtml(
            m.label
          )}</span>`
      )
      .join("")}</div></div>`;

    html += `<div class="tl-list">`;
    let curSection = null;
    courses.forEach((c) => {
      const col = sectionColorVar(c.section);
      if (c.section !== curSection) {
        curSection = c.section;
        html += `<div class="tl-cat" style="--group-bg:${col.bg};--group-fg:${col.fg};--group-solid:${col.solid}">${escapeHtml(
          curSection
        )}</div>`;
      }
      const shown = visibleSessions(c);
      const hours = shown.reduce((a, s) => a + s.hours, 0);
      // Four courses in the sheet carry no dates at all; "0 t · 0 dager" reads
      // like a data error, so say what is actually the case.
      const days = courseDays(c);
      const meta = shown.length
        ? [`${fmtHours(hours)} t`, `${days} ${days === 1 ? "dag" : "dager"}`, courseSpanLabel(c)]
            .filter(Boolean)
            .join(" · ")
        : (c.total_hours ? `${fmtHours(c.total_hours)} t planlagt · ` : "") + "ingen datoer i planen";
      html += `<div class="tl-card${shown.length ? "" : " tl-card-empty"}" data-act="course" data-id="${
        c.id
      }" role="button" tabindex="0" style="--card-solid:${col.solid}">
        <div class="tl-card-name">${
          c.code ? `<span class="tl-code">${escapeHtml(c.code)}</span> ${escapeHtml(c.title)}` : escapeHtml(c.title)
        }</div>
        <div class="tl-card-meta">${escapeHtml(meta)}</div>
        ${
          shown.length
            ? `<div class="timeline-track">${timelineGridlinesHtml()}${timelineMarksHtml(c, col.solid)}</div>`
            : ""
        }
      </div>`;
    });
    html += `</div>`;

    root.innerHTML = html;
    bindTimelineCourseClicks(root);
  }

  function bindTimelineCourseClicks(root) {
    root.querySelectorAll('[data-act="course"]').forEach((n) => {
      n.onclick = () => showCourseModal(n.dataset.id);
      n.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          showCourseModal(n.dataset.id);
        }
      };
    });
  }

  function renderTimelineTable(root) {
    const WEEKS = TIMELINE_WEEKS;
    const courses = filteredCourses();

    let html = `<div class="view-nav"><h2>Emner over semesteret</h2></div>`;
    html += `<div class="timeline-months" style="grid-template-columns:260px repeat(${WEEKS.length},1fr)"><div></div>`;
    let lastMonth = "";
    WEEKS.forEach((w) => {
      const mon = isoWeekToMonday(2026, w);
      const mLabel = MONTH_NAMES[mon.getMonth() + 1].slice(0, 3);
      html += `<div>${mLabel !== lastMonth ? mLabel : ""}</div>`;
      lastMonth = mLabel;
    });
    html += `</div>`;

    html += `<table class="timeline-table"><colgroup><col style="width:260px">${WEEKS.map(() => "<col>").join("")}</colgroup><tbody>`;
    let curSection = null;
    courses.forEach((c) => {
      if (c.section !== curSection) {
        curSection = c.section;
        html += `<tr class="timeline-section-head"><td colspan="${WEEKS.length + 1}">${escapeHtml(curSection)}</td></tr>`;
      }
      const col = sectionColorVar(c.section);
      html += `<tr data-act="course" data-id="${c.id}" style="cursor:pointer">`;
      // Let CSS ellipsise these; slicing cut mid-word with no "…" to show it had.
      html += `<td class="timeline-row-name" title="${escapeHtml(c.raw_name)}"><span class="code">${escapeHtml(
        c.code || c.title
      )}</span>${c.code ? `<span class="sub">${escapeHtml(c.title)}</span>` : ""}</td>`;
      html += `<td colspan="${WEEKS.length}" class="timeline-track-cell"><div class="timeline-track">${timelineGridlinesHtml()}${timelineMarksHtml(
        c,
        col.solid
      )}</div></td></tr>`;
    });
    html += `</tbody></table>`;
    if (!courses.length) html += `<p class="empty-state">Ingen emner matcher valgte filtre.</p>`;
    root.innerHTML = html;
    bindTimelineCourseClicks(root);
  }

  // --------------------------------------------------------------- stats view
  function renderStats(root) {
    const courses = filteredCourses();
    const sessions = flatSessions(courses);
    const totalHours = sessions.reduce((a, s) => a + s.hours, 0);
    const lecturers = new Set(courses.flatMap((c) => c.lecturers));

    const bySection = {};
    sessions.forEach((s) => (bySection[s.course.section] = (bySection[s.course.section] || 0) + s.hours));
    const byLecturer = {};
    sessions.forEach((s) => s.course.lecturers.forEach((l) => (byLecturer[l] = (byLecturer[l] || 0) + s.hours / s.course.lecturers.length)));
    const byWeek = {};
    sessions.forEach((s) => (byWeek[s.week] = (byWeek[s.week] || 0) + s.hours));

    const maxSection = Math.max(1, ...Object.values(bySection));
    const maxLecturer = Math.max(1, ...Object.values(byLecturer));
    const maxWeek = Math.max(1, ...Object.values(byWeek));

    let html = `<div class="view-nav"><h2>Statistikk</h2></div>`;
    html += `<div class="stats-grid">`;

    html += `<div class="card" style="grid-column:1/-1"><div class="stat-kpis">
      <div class="kpi"><div class="n">${courses.length}</div><div class="l">emner</div></div>
      <div class="kpi"><div class="n">${courseDayCount(courses)}</div><div class="l">undervisningsdager</div></div>
      <div class="kpi"><div class="n">${sessions.length}</div><div class="l">økter</div></div>
      <div class="kpi"><div class="n">${fmtHours(totalHours)}</div><div class="l">timer totalt</div></div>
      <div class="kpi"><div class="n">${lecturers.size}</div><div class="l">fagpersoner</div></div>
    </div></div>`;

    html += `<div class="card"><h3>Timer per programkategori</h3>`;
    SECTIONS.filter((s) => bySection[s]).sort((a, b) => bySection[b] - bySection[a]).forEach((s) => {
      const col = sectionColorVar(s);
      html += barRow(s, bySection[s], maxSection, col.solid);
    });
    html += `</div>`;

    html += `<div class="card"><h3>Timer per fagperson</h3>`;
    Object.entries(byLecturer)
      .sort((a, b) => b[1] - a[1])
      .forEach(([l, h]) => html += barRow(legendName(l), h, maxLecturer, "var(--accent)"));
    html += `</div>`;

    html += `<div class="card" style="grid-column:1/-1"><h3>Timer per uke</h3>`;
    html += `<div class="weekbars-wrap"><div class="weekbars">`;
    for (let w = 31; w <= 51; w++) {
      const h = byWeek[w] || 0;
      html += `<div class="wb" style="height:${Math.max(2, (h / maxWeek) * 90)}px" title="Uke ${w}: ${fmtHours(h)} t"></div>`;
    }
    html += `</div><div class="weekbars-labels">`;
    for (let w = 31; w <= 51; w++) html += `<span>${w}</span>`;
    html += `</div></div></div>`;

    html += `</div>`;
    root.innerHTML = html;
  }

  function barRow(label, val, max, color) {
    const pct = Math.max(2, (val / max) * 100);
    return `<div class="bar-row">
      <div class="label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
      <div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="val">${fmtHours(val)}</div>
    </div>`;
  }

  // -------------------------------------------------------------- top-level
  function renderView() {
    const root = document.getElementById("view-root");
    if (state.view === "month") renderMonth(root);
    else if (state.view === "week") renderWeek(root);
    else if (state.view === "agenda") renderAgenda(root);
    else if (state.view === "timeline") renderTimeline(root);
    else if (state.view === "stats") renderStats(root);
    renderActiveChips();
  }

  function renderActiveChips() {
    const wrap = document.getElementById("active-filters");
    const chips = [];
    if (state.search.trim()) {
      chips.push({ label: `Søk: “${state.search.trim()}”`, clear: () => { state.search = ""; document.getElementById("search-input").value = ""; } });
    }
    if (EXAMS.length && !state.showExams) {
      chips.push({
        label: "Eksamener skjult",
        clear: () => {
          state.showExams = true;
          savePrefs();
        },
      });
    }
    if (state.reducedOnly) {
      chips.push({
        label: "Redusert undervisning",
        clear: () => {
          state.reducedOnly = false;
          savePrefs();
        },
      });
    }
    const picked = COURSES.filter((c) => state.courseIds.has(c.id));
    if (picked.length < COURSES.length) {
      // Naming the categories is more use than a bare count when the selection
      // happens to be exactly one or two of them.
      const sects = Array.from(new Set(picked.map((c) => c.section)));
      const wholeSections = sects.filter((s) => {
        const inSection = COURSES.filter((c) => c.section === s);
        return inSection.every((c) => state.courseIds.has(c.id));
      });
      const label =
        picked.length && wholeSections.length === sects.length && sects.length <= 2
          ? sects.join(" + ")
          : `${picked.length} av ${COURSES.length} emner`;
      chips.push({ label, clear: () => resetCourses() });
    }
    if (!chips.length) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = chips.map((c, i) => `<span class="chip">${escapeHtml(c.label)}<button data-i="${i}">&times;</button></span>`).join("");
    wrap.querySelectorAll("button").forEach((b, i) => (b.onclick = () => { chips[i].clear(); syncFilterUI(); renderView(); }));
  }

  function resetCourses() {
    state.courseIds = new Set(ALL_COURSE_IDS);
  }
  function syncFilterUI() {
    buildCoursePanel();
    updateFilterSummaries();
  }
  function updateFilterSummaries() {
    const picked = COURSES.filter((c) => state.courseIds.has(c.id)).length;
    document.getElementById("course-count").textContent = picked === COURSES.length ? "Alle" : picked;
  }

  // -------------------------------------------------------------- ics export
  function icsEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  }
  function icsStamp(iso, hhmm) {
    return iso.replace(/-/g, "") + "T" + hhmm.replace(":", "") + "00";
  }
  function foldLine(line) {
    // RFC 5545 caps lines at 75 octets; continuations start with a space.
    const chunks = [];
    let rest = line;
    while (rest.length > 73) {
      chunks.push(rest.slice(0, 73));
      rest = rest.slice(73);
    }
    chunks.push(rest);
    return chunks.join("\r\n ");
  }

  function exportIcs() {
    const sessions = flatSessions(filteredCourses());
    const exams = visibleExamEvents();
    if (!sessions.length && !exams.length) {
      alert("Ingen undervisning eller eksamen å eksportere med gjeldende filtre.");
      return;
    }
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//HLT//Semesterplan H26//NO",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:HLT " + DATA.term,
    ];
    sessions.forEach((s, i) => {
      const summary = (s.course.code ? s.course.code + " " : "") + s.course.title;
      const descParts = [s.course.section];
      if (s.course.lecturers.length) descParts.push("Foreleser: " + s.course.lecturers.map(legendName).join(", "));
      descParts.push(fmtHours(s.hours) + (s.hours === 1 ? " undervisningstime" : " undervisningstimer") + " á 45 min");
      if (s.blocks_today > 1) {
        descParts.push(`Økt ${s.half === "am" ? "1 av 2 (formiddag)" : "2 av 2 (ettermiddag)"} — ${fmtHours(s.day_lessons)} timer denne dagen`);
      }
      descParts.push("Klokkeslett er beregnet fra timetallet i semesterplanen.");
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:hlt-h26-${s.course.id}-${s.date.replace(/-/g, "")}-${i}@hlt.local`);
      lines.push("DTSTAMP:20260804T000000Z");
      lines.push("DTSTART:" + icsStamp(s.date, s.start));
      lines.push("DTEND:" + icsStamp(s.date, s.end));
      lines.push(foldLine("SUMMARY:" + icsEscape(summary)));
      lines.push(foldLine("DESCRIPTION:" + icsEscape(descParts.join("\n"))));
      lines.push("END:VEVENT");
    });

    // Exams: a sitting keeps its clock times; a submission has only a deadline,
    // so it is written as a 30-minute reminder ending at the cut-off.
    exams.forEach((e, i) => {
      const summary = "Eksamen: " + examName(e.exam) + " " + e.exam.title;
      const descParts = [EXAM_KIND_LABEL[e.exam.kind] || "Eksamen"];
      if (e.exam.form) descParts.push(e.exam.form);
      if (e.exam.anonymous === true) descParts.push("Anonym");
      if (e.exam.anonymous === false) descParts.push("Ikke anonym");
      if (e.room) descParts.push("Sted: " + e.room);
      if (e.total > 1) descParts.push(`Dag ${e.seq} av ${e.total}`);
      if (e.until) descParts.push("72-timers hjemmeeksamen fra " + e.date);
      if (e.exam.teachers.length) descParts.push("Faglærer: " + e.exam.teachers.map(legendName).join(", "));
      if (e.exam.grading) descParts.push("Sensurfrist: " + e.exam.grading);
      if (e.exam.note) descParts.push(e.exam.note);
      if (EXAM_DATA.note) descParts.push(EXAM_DATA.note);

      const endTime = e.end || e.start || "12:00";
      let startTime = e.start;
      if (!startTime) {
        const [h, m] = endTime.split(":").map(Number);
        const from = Math.max(0, h * 60 + m - 30);
        startTime = String(Math.floor(from / 60)).padStart(2, "0") + ":" + String(from % 60).padStart(2, "0");
      }
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:hlt-exam-${e.exam.id}-${e.date.replace(/-/g, "")}-${i}@hlt.local`);
      lines.push("DTSTAMP:20260907T000000Z");
      lines.push("DTSTART:" + icsStamp(e.date, startTime));
      lines.push("DTEND:" + icsStamp(e.date, endTime));
      lines.push(foldLine("SUMMARY:" + icsEscape(summary)));
      if (e.room) lines.push(foldLine("LOCATION:" + icsEscape(e.room)));
      lines.push(foldLine("DESCRIPTION:" + icsEscape(descParts.join("\n"))));
      lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");

    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hlt-semesterplan-h26.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // The one filter in the toolbar: every course, grouped under the category
  // heading it has in the spreadsheet. The heading's own checkbox toggles the
  // whole category, and "kun disse" narrows to just that category.
  function buildCoursePanel() {
    const panel = document.getElementById("course-panel");

    const reducedCourses = COURSES.filter((c) => c.reduced_available);
    let html = "";
    if (EXAMS.length) {
      html += `<label class="popover-mode" title="Eksamensdatoer og innleveringsfrister vises sammen med undervisningen">
        <input type="checkbox" data-act="exams"${state.showExams ? " checked" : ""}>
        <span class="popover-mode-text"><strong>Vis eksamener</strong>
          <span>${EXAMS.length} eksamener og innleveringsfrister fra eksamensoversikten. Følger emnevalget under.</span>
        </span>
      </label>`;
    }
    html += `<label class="popover-mode" title="Emner som tilbyr redusert undervisning vises da bare på de datoene som er obligatoriske">
      <input type="checkbox" data-act="reduced"${state.reducedOnly ? " checked" : ""}>
      <span class="popover-mode-text"><strong>Redusert undervisning</strong>
        <span>Viser bare obligatoriske datoer for de ${reducedCourses.length} emnene som tilbyr det. Øvrige emner vises som vanlig.</span>
      </span>
    </label>`;

    SECTIONS.forEach((section) => {
      const inSection = COURSES.filter((c) => c.section === section);
      if (!inSection.length) return;
      const chosen = inSection.filter((c) => state.courseIds.has(c.id)).length;
      const col = sectionColorVar(section);
      // The category's own colour tints the whole heading, so the group a course
      // belongs to is readable at a glance without a separate marker.
      html += `<div class="popover-group">
        <div class="popover-group-head" style="--group-bg:${col.bg};--group-fg:${col.fg};--group-solid:${col.solid}">
          <label class="popover-group-label" title="Slå hele kategorien av eller på">
            <input type="checkbox" data-group="${escapeHtml(section)}"${chosen === inSection.length ? " checked" : ""}>
            <span>${escapeHtml(section)}</span>
          </label>
          <button class="popover-group-only" data-only="${escapeHtml(section)}" title="Vis bare emnene i denne kategorien">kun disse</button>
        </div>`;
      inSection.forEach((c) => {
        // With no code the whole title sits in the bold slot, which then has to
        // be allowed to shrink and ellipsise rather than overflow the panel.
        const reducedMark = c.reduced_available
          ? `<span class="course-reduced" title="Tilbyr redusert undervisning">R</span>`
          : "";
        html += `<label title="${escapeHtml(c.raw_name)}"><input type="checkbox" data-course="${c.id}"${
          state.courseIds.has(c.id) ? " checked" : ""
        }><span class="course-code${c.code ? "" : " solo"}">${escapeHtml(courseLabel(c))}</span>${
          c.code ? `<span class="course-name">${escapeHtml(c.title)}</span>` : ""
        }${reducedMark}</label>`;
      });
      html += `</div>`;
    });
    html += `<div class="popover-actions"><button data-act="all">Velg alle</button><button data-act="none">Fjern alle</button></div>`;
    panel.innerHTML = html;

    // A part-selected category reads as neither on nor off.
    SECTIONS.forEach((section) => {
      const box = panel.querySelector(`input[data-group="${cssEscape(section)}"]`);
      if (!box) return;
      const inSection = COURSES.filter((c) => c.section === section);
      const chosen = inSection.filter((c) => state.courseIds.has(c.id)).length;
      box.indeterminate = chosen > 0 && chosen < inSection.length;
    });

    // Re-check the edge fit: the panel is rebuilt on every toggle, and it may
    // be open at the time.
    const details = panel.closest("details.filter-popover");
    if (details && details.open) positionPopover(details);

    const apply = (rebuild) => {
      savePrefs();
      if (rebuild) buildCoursePanel();
      updateFilterSummaries();
      renderView();
    };

    panel.querySelector('[data-act="reduced"]').addEventListener("change", (e) => {
      state.reducedOnly = e.target.checked;
      apply(true);
    });
    const examToggle = panel.querySelector('[data-act="exams"]');
    if (examToggle) {
      examToggle.addEventListener("change", (e) => {
        state.showExams = e.target.checked;
        apply(true);
      });
    }

    panel.querySelectorAll("input[data-course]").forEach((cb) =>
      cb.addEventListener("change", () => {
        if (cb.checked) state.courseIds.add(cb.dataset.course);
        else state.courseIds.delete(cb.dataset.course);
        apply(true); // group checkbox above it may need to change state
      })
    );
    panel.querySelectorAll("input[data-group]").forEach((cb) =>
      cb.addEventListener("change", () => {
        COURSES.filter((c) => c.section === cb.dataset.group).forEach((c) => {
          if (cb.checked) state.courseIds.add(c.id);
          else state.courseIds.delete(c.id);
        });
        apply(true);
      })
    );
    panel.querySelectorAll("[data-only]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.courseIds = new Set(COURSES.filter((c) => c.section === btn.dataset.only).map((c) => c.id));
        apply(true);
      })
    );
    panel.querySelector('[data-act="all"]').onclick = () => {
      resetCourses();
      apply(true);
    };
    panel.querySelector('[data-act="none"]').onclick = () => {
      state.courseIds = new Set();
      apply(true);
    };
  }

  // Section names contain spaces, slashes and dots, so they need escaping
  // before going into a querySelector attribute value.
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  // ------------------------------------------------------------------- init
  function buildToolbar() {
    document.getElementById("search-input").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderView();
    });

    buildCoursePanel();

    document.getElementById("reset-filters").onclick = () => {
      state.search = "";
      document.getElementById("search-input").value = "";
      resetCourses();
      state.reducedOnly = false;
      state.showExams = true;
      savePrefs();
      syncFilterUI();
      renderView();
    };

    document.getElementById("info-btn").onclick = showInfoModal;
    document.getElementById("export-ics").onclick = exportIcs;

    document.querySelectorAll("details.filter-popover").forEach((d) =>
      d.addEventListener("toggle", () => positionPopover(d))
    );

    updateFilterSummaries();
  }

  function buildTabs() {
    document.querySelectorAll(".tabs button").forEach((btn) => {
      btn.onclick = () => {
        state.view = btn.dataset.view;
        document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
        renderView();
      };
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("term-label").textContent = DATA.term;
    buildToolbar();
    buildTabs();
    renderView();

    // Each layout breakpoint changes what gets rendered, not just its styling,
    // so crossing either one needs a re-render.
    let wasCompact = isCompact();
    let wasStacked = isTimelineStacked();
    window.addEventListener("resize", () => {
      if (isCompact() !== wasCompact || isTimelineStacked() !== wasStacked) {
        wasCompact = isCompact();
        wasStacked = isTimelineStacked();
        renderView();
      }
      positionAllPopovers();
    });
  });
})();
