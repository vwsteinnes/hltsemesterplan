/* Admin panel: replace the published plan by uploading a new workbook.
 *
 * Opened with #admin in the URL, or Shift+A three times. The PIN only keeps the
 * panel out of the way of ordinary visitors — everything here runs in the
 * browser, so the code and the PIN are readable by anyone who looks. Treat it
 * as a lock on a cupboard, not on a safe.
 */
(function () {
  "use strict";

  const PIN = "0175";
  const DATA_KEY = "hlt-semesterplan-data-v1";

  // Applied before app.js reads window.HLT_DATA, so an uploaded plan wins over
  // the bundled data.js for this browser.
  (function applyStoredPlan() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw);
      if (stored && stored.data && Array.isArray(stored.data.courses) && stored.data.courses.length) {
        window.HLT_DATA = stored.data;
        window.HLT_DATA_SOURCE = { local: true, uploaded: stored.uploaded, filename: stored.filename };
      }
    } catch (e) {
      /* corrupt entry — fall back to the bundled plan */
    }
  })();

  // The standalone build inlines every script, so there is no data.js on the
  // server to replace. In that case the page rewrites a copy of itself instead.
  const SINGLE_FILE = !document.querySelector("script[src]");

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => node.appendChild(c));
    return node;
  }

  function close() {
    const root = document.getElementById("admin-root");
    if (root) root.innerHTML = "";
    if (location.hash === "#admin") history.replaceState(null, "", location.pathname + location.search);
  }

  function shell(title, bodyNodes) {
    const root = document.getElementById("admin-root");
    root.innerHTML = "";
    const closeBtn = el("button", { class: "modal-close", "aria-label": "Lukk" });
    closeBtn.innerHTML = "&times;";
    closeBtn.onclick = close;
    const panel = el("div", { class: "modal admin-modal" }, [closeBtn, el("h3", { text: title })].concat(bodyNodes));
    const backdrop = el("div", { class: "modal-backdrop" }, [panel]);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    root.appendChild(backdrop);
    return panel;
  }

  function askPin() {
    const input = el("input", { class: "search-input", type: "password", inputmode: "numeric", placeholder: "PIN", maxlength: "8" });
    const error = el("p", { class: "admin-error" });
    const submit = el("button", { class: "btn admin-primary", text: "Lås opp" });
    const tryPin = () => {
      if (input.value === PIN) showPanel();
      else {
        error.textContent = "Feil PIN.";
        input.value = "";
        input.focus();
      }
    };
    submit.onclick = tryPin;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") tryPin();
    });
    shell("Administrasjon", [
      el("p", { class: "modal-sub", text: "Skriv inn PIN for å oppdatere semesterplanen." }),
      input,
      error,
      el("div", { class: "admin-actions" }, [submit]),
    ]);
    input.focus();
  }

  function fmtWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString("no-NO", { dateStyle: "short", timeStyle: "short" });
  }

  function showPanel() {
    const source = window.HLT_DATA_SOURCE;
    const current = window.HLT_DATA;

    const status = el("p", { class: "modal-sub" });
    status.textContent = source && source.local
      ? `Viser opplastet plan: ${source.filename || "ukjent fil"} (${fmtWhen(source.uploaded)}).`
      : "Viser planen som ligger i data.js på serveren.";

    const summary = el("div", { class: "admin-summary" });
    summary.innerHTML =
      `<div><strong>${current.courses.length}</strong> emner</div>` +
      `<div><strong>${current.courses.reduce((a, c) => a + new Set(c.sessions.map((s) => s.date)).size, 0)}</strong> undervisningsdager</div>` +
      `<div><strong>${current.date_range.start} – ${current.date_range.end}</strong></div>`;

    const file = el("input", { type: "file", accept: ".xlsx", class: "admin-file" });
    const result = el("div", { class: "admin-result" });
    const applyBtn = el("button", { class: "btn admin-primary", text: "Ta i bruk her", disabled: "disabled" });
    const downloadBtn = el("button", {
      class: "btn",
      text: SINGLE_FILE ? "Last ned oppdatert index.html" : "Last ned data.js",
      disabled: "disabled",
    });
    const clearBtn = el("button", { class: "btn", text: "Tilbakestill til serverversjon" });

    let parsed = null;

    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      parsed = null;
      applyBtn.disabled = true;
      downloadBtn.disabled = true;
      if (!f) return;
      result.className = "admin-result";
      result.textContent = "Leser " + f.name + " …";
      try {
        const buf = await f.arrayBuffer();
        const data = await window.HLTParsePlan.parse(buf);
        parsed = { data, filename: f.name };
        const s = data._stats;
        delete data._stats;
        result.className = "admin-result ok";
        result.innerHTML =
          `<strong>${f.name} lest.</strong><br>` +
          `${data.courses.length} emner · ${s.courseDays} undervisningsdager · ${s.blocks} økter · ${s.lessons} timer<br>` +
          `Periode ${data.date_range.start} – ${data.date_range.end} · arkfane «${data.source_sheet}»<br>` +
          `Tidsmodellen bekreftet mot ${s.verified} kontrollpunkter.`;
        applyBtn.disabled = false;
        downloadBtn.disabled = false;
      } catch (err) {
        result.className = "admin-result err";
        result.textContent = "Kunne ikke lese filen: " + (err && err.message ? err.message : err);
      }
    });

    applyBtn.onclick = () => {
      if (!parsed) return;
      try {
        localStorage.setItem(
          DATA_KEY,
          JSON.stringify({ data: parsed.data, filename: parsed.filename, uploaded: new Date().toISOString() })
        );
      } catch (e) {
        result.className = "admin-result err";
        result.textContent = "Klarte ikke lagre lokalt (for stor fil eller privat nettleservindu).";
        return;
      }
      location.reload();
    };

    function saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    // A literal </script> inside the embedded JSON would close the tag early.
    function guardScript(text) {
      return text.replace(/<\/script/gi, "<\\/script");
    }

    downloadBtn.onclick = async () => {
      if (!parsed) return;
      const payload = "window.HLT_DATA = " + JSON.stringify(parsed.data) + ";";

      if (!SINGLE_FILE) {
        saveBlob(new Blob([payload], { type: "application/javascript" }), "data.js");
        return;
      }

      // Rebuild this page with the new plan swapped in, so the result is still
      // one file that can be committed straight back to the host.
      try {
        const html = await (await fetch(window.location.href, { cache: "reload" })).text();
        const lines = html.split("\n");
        const i = lines.findIndex((line) => line.startsWith("window.HLT_DATA = "));
        if (i === -1) throw new Error("fant ikke plandataene i filen");
        lines[i] = guardScript(payload);
        saveBlob(new Blob([lines.join("\n")], { type: "text/html;charset=utf-8" }), "index.html");
      } catch (err) {
        result.className = "admin-result err";
        result.textContent =
          "Klarte ikke lage oppdatert index.html: " + (err && err.message ? err.message : err) +
          ". «Ta i bruk her» virker fortsatt.";
      }
    };

    clearBtn.onclick = () => {
      localStorage.removeItem(DATA_KEY);
      location.reload();
    };

    shell("Administrasjon", [
      status,
      summary,
      el("h4", { class: "admin-h", text: "Last opp ny semesterplan" }),
      el("p", { class: "modal-sub", text: "Velg en .xlsx-fil med samme oppsett som Semesterplan-H26. Filen leses i nettleseren; ingenting sendes noe sted." }),
      file,
      result,
      el("div", { class: "admin-actions" }, [applyBtn, downloadBtn]),
      el("p", {
        class: "admin-note",
        text: SINGLE_FILE
          ? "«Ta i bruk her» lagrer planen i denne nettleseren — andre besøkende ser den ikke. For å publisere for alle: last ned oppdatert index.html og erstatt filen på nettstedet (f.eks. commit til GitHub Pages-repoet)."
          : "«Ta i bruk her» lagrer planen i denne nettleseren — andre besøkende ser den ikke. For å publisere for alle: last ned data.js og legg den i site-mappen på webhotellet.",
      }),
      el("div", { class: "admin-actions" }, [clearBtn]),
      el("p", { class: "admin-note", text: "PIN-koden ligger i JavaScript-filen og kan leses av den som vil. Den holder panelet unna vanlige besøkende, men er ikke reell sikkerhet." }),
    ]);
  }

  function open() {
    askPin();
  }

  // Hash entry, plus a keyboard escape hatch for phones without an address bar.
  function wire() {
    if (location.hash === "#admin") open();
    window.addEventListener("hashchange", () => {
      if (location.hash === "#admin") open();
    });
    let taps = 0;
    let timer = null;
    document.addEventListener("keydown", (e) => {
      if (e.shiftKey && (e.key === "A" || e.key === "a")) {
        taps++;
        clearTimeout(timer);
        timer = setTimeout(() => (taps = 0), 1200);
        if (taps >= 3) {
          taps = 0;
          open();
        }
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
