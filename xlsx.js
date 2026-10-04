/* Minimal XLSX reader.
 *
 * An .xlsx file is a ZIP of XML parts. Browsers can already inflate raw deflate
 * streams (DecompressionStream) and parse XML (DOMParser), so no third-party
 * library is needed — this reads the ZIP central directory, inflates the parts
 * it needs, and exposes cell values, merges and fill colours.
 */
window.HLTXlsx = (function () {
  "use strict";

  const td = new TextDecoder();

  function readU16(v, o) {
    return v.getUint16(o, true);
  }
  function readU32(v, o) {
    return v.getUint32(o, true);
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Locate the end-of-central-directory record, which sits at the tail of the
  // file after an optional comment of up to 64 KB.
  function findEocd(view, len) {
    const start = Math.max(0, len - 66_000);
    for (let i = len - 22; i >= start; i--) {
      if (readU32(view, i) === 0x06054b50) return i;
    }
    return -1;
  }

  async function readZip(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const len = bytes.length;

    const eocd = findEocd(view, len);
    if (eocd < 0) throw new Error("Ikke en gyldig .xlsx-fil (fant ikke ZIP-katalogen).");

    let count = readU16(view, eocd + 10);
    let dirOffset = readU32(view, eocd + 16);

    // ZIP64: the 32-bit fields saturate on large archives.
    if (dirOffset === 0xffffffff || count === 0xffff) {
      for (let i = eocd - 20; i >= 0; i--) {
        if (readU32(view, i) === 0x07064b50) {
          const zip64Eocd = Number(view.getBigUint64(i + 8, true));
          count = Number(view.getBigUint64(zip64Eocd + 32, true));
          dirOffset = Number(view.getBigUint64(zip64Eocd + 48, true));
          break;
        }
      }
    }

    const entries = [];
    let p = dirOffset;
    for (let i = 0; i < count && p + 46 <= len; i++) {
      if (readU32(view, p) !== 0x02014b50) break;
      const method = readU16(view, p + 10);
      const compSize = readU32(view, p + 20);
      const nameLen = readU16(view, p + 28);
      const extraLen = readU16(view, p + 30);
      const commentLen = readU16(view, p + 32);
      const localOffset = readU32(view, p + 42);
      const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.push({ name, method, compSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    const files = new Map();
    for (const entry of entries) {
      const lo = entry.localOffset;
      if (readU32(view, lo) !== 0x04034b50) continue;
      const nameLen = readU16(view, lo + 26);
      const extraLen = readU16(view, lo + 28);
      const dataStart = lo + 30 + nameLen + extraLen;
      const raw = bytes.subarray(dataStart, dataStart + entry.compSize);
      files.set(entry.name, { method: entry.method, raw });
    }

    return {
      names: () => Array.from(files.keys()),
      async text(name) {
        const f = files.get(name);
        if (!f) return null;
        if (f.method === 0) return td.decode(f.raw);
        if (f.method === 8) return td.decode(await inflateRaw(f.raw));
        throw new Error("Ustøttet komprimering i .xlsx (metode " + f.method + ").");
      },
    };
  }

  const parser = new DOMParser();
  function parseXml(text) {
    const doc = parser.parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Kunne ikke lese XML i .xlsx-filen.");
    return doc;
  }

  function colToNumber(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const ch = ref.charCodeAt(i);
      if (ch < 65 || ch > 90) break;
      n = n * 26 + (ch - 64);
    }
    return n;
  }

  function splitRef(ref) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) return null;
    return { col: colToNumber(m[1]), row: parseInt(m[2], 10) };
  }

  // Shared strings hold the text of every string cell, by index.
  function readSharedStrings(doc) {
    if (!doc) return [];
    return Array.from(doc.getElementsByTagName("si")).map((si) => {
      // Rich text splits a value across several <t> runs.
      const ts = si.getElementsByTagName("t");
      let out = "";
      for (let i = 0; i < ts.length; i++) {
        // Skip phonetic guides, which are not part of the value.
        if (ts[i].parentNode.nodeName === "rPh") continue;
        out += ts[i].textContent;
      }
      return out;
    });
  }

  // styles.xml maps a cell's style index to its fill, which is what marks the
  // dates a reduced-teaching student must attend.
  function readFills(doc) {
    if (!doc) return { cellFills: [], describe: () => null };

    function describeColor(node) {
      if (!node) return null;
      if (node.hasAttribute("rgb")) {
        const v = node.getAttribute("rgb");
        return v === "00000000" || v === "FFFFFFFF" ? null : "rgb:" + v;
      }
      if (node.hasAttribute("theme")) {
        const theme = parseInt(node.getAttribute("theme"), 10);
        const tint = Math.round(parseFloat(node.getAttribute("tint") || "0") * 10000) / 10000;
        if (theme === 0 && Math.abs(tint) < 1e-9) return null; // white
        return "theme:" + theme + "/" + tint;
      }
      if (node.hasAttribute("indexed")) return "idx:" + node.getAttribute("indexed");
      return "other";
    }

    const fillsEl = doc.getElementsByTagName("fills")[0];
    const fills = fillsEl
      ? Array.from(fillsEl.getElementsByTagName("fill")).map((fill) => {
          const pf = fill.getElementsByTagName("patternFill")[0];
          if (!pf) return null;
          const type = pf.getAttribute("patternType");
          if (!type || type === "none") return null;
          return describeColor(pf.getElementsByTagName("fgColor")[0]);
        })
      : [];

    const xfsEl = doc.getElementsByTagName("cellXfs")[0];
    const cellFills = xfsEl
      ? Array.from(xfsEl.getElementsByTagName("xf")).map((xf) => {
          const fillId = parseInt(xf.getAttribute("fillId") || "0", 10);
          return fills[fillId] || null;
        })
      : [];

    return { cellFills };
  }

  async function load(arrayBuffer) {
    const zip = await readZip(arrayBuffer);

    const wbText = await zip.text("xl/workbook.xml");
    if (!wbText) throw new Error("Fant ikke arbeidsboken i .xlsx-filen.");
    const wb = parseXml(wbText);

    const relsText = await zip.text("xl/_rels/workbook.xml.rels");
    const relMap = new Map();
    if (relsText) {
      Array.from(parseXml(relsText).getElementsByTagName("Relationship")).forEach((rel) => {
        relMap.set(rel.getAttribute("Id"), rel.getAttribute("Target"));
      });
    }

    const sheets = Array.from(wb.getElementsByTagName("sheet")).map((sheet) => ({
      name: sheet.getAttribute("name"),
      rid: sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"),
    }));

    const sharedText = await zip.text("xl/sharedStrings.xml");
    const shared = readSharedStrings(sharedText ? parseXml(sharedText) : null);

    const stylesText = await zip.text("xl/styles.xml");
    const styles = readFills(stylesText ? parseXml(stylesText) : null);

    async function sheetByName(name) {
      const entry = sheets.find((s) => s.name === name);
      if (!entry) return null;
      let target = relMap.get(entry.rid) || "worksheets/sheet1.xml";
      if (target.startsWith("/")) target = target.slice(1);
      else target = "xl/" + target.replace(/^\.\//, "");
      const text = await zip.text(target);
      if (!text) return null;
      const doc = parseXml(text);

      const cells = new Map(); // "row,col" -> {v, fill}
      let maxRow = 0;
      let maxCol = 0;
      Array.from(doc.getElementsByTagName("c")).forEach((c) => {
        const ref = splitRef(c.getAttribute("r") || "");
        if (!ref) return;
        const type = c.getAttribute("t");
        const styleIdx = parseInt(c.getAttribute("s") || "0", 10);
        let value = null;

        if (type === "inlineStr") {
          const is = c.getElementsByTagName("is")[0];
          value = is ? is.textContent : null;
        } else {
          const vEl = c.getElementsByTagName("v")[0];
          const raw = vEl ? vEl.textContent : null;
          if (raw !== null) {
            if (type === "s") value = shared[parseInt(raw, 10)] ?? null;
            else if (type === "str" || type === "e") value = raw;
            else if (type === "b") value = raw === "1";
            else {
              const num = parseFloat(raw);
              value = Number.isNaN(num) ? raw : num;
            }
          }
        }
        if (value === null || value === "") {
          // Still record the fill: an empty highlighted cell carries no lesson,
          // but keeping the shape uniform avoids special cases upstream.
          if (!styles.cellFills[styleIdx]) return;
        }
        cells.set(ref.row + "," + ref.col, { v: value, fill: styles.cellFills[styleIdx] || null });
        if (ref.row > maxRow) maxRow = ref.row;
        if (ref.col > maxCol) maxCol = ref.col;
      });

      const merges = Array.from(doc.getElementsByTagName("mergeCell"))
        .map((m) => {
          const parts = (m.getAttribute("ref") || "").split(":");
          if (parts.length !== 2) return null;
          const a = splitRef(parts[0]);
          const b = splitRef(parts[1]);
          if (!a || !b) return null;
          return { minRow: a.row, minCol: a.col, maxRow: b.row, maxCol: b.col };
        })
        .filter(Boolean);

      return {
        maxRow,
        maxCol,
        merges,
        cell(row, col) {
          return cells.get(row + "," + col) || { v: null, fill: null };
        },
        value(row, col) {
          return (cells.get(row + "," + col) || {}).v ?? null;
        },
      };
    }

    return { sheetNames: sheets.map((s) => s.name), sheetByName };
  }

  return { load };
})();
