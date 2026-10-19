// Minimal CSV reading for admin/vendor uploads — no dependency needed.
// Handles "quoted, cells", "" escapes, and comma/tab/semicolon separators
// (spreadsheets exported in some locales use semicolons).

// Splits one CSV line, honouring quotes
const splitCsvLine = (line, sep) => {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) cells.push(cur.trim()), (cur = "");
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
};

const detectSeparator = (line) => [",", "\t", ";"].find((s) => line.includes(s)) || ",";

/**
 * Parses CSV text whose first non-empty line is a header row.
 * Header names are lower-cased and trimmed.
 * @returns {{ headers: string[], rows: Array<{ line: number, values: object }> }}
 */
const parseCsvWithHeader = (text) => {
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim());
  if (start < 0) return { headers: [], rows: [] };
  const sep = detectSeparator(lines[start]);
  const headers = splitCsvLine(lines[start], sep).map((h) => h.toLowerCase());
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i], sep);
    const values = {};
    headers.forEach((h, j) => {
      if (h) values[h] = cells[j] ?? "";
    });
    rows.push({ line: i + 1, values });
  }
  return { headers, rows };
};

// "a|b|c" or "a; b" inside one cell → ["a","b","c"]
const splitList = (cell) =>
  String(cell || "")
    .split(/[|;]/)
    .map((s) => s.trim())
    .filter(Boolean);

const parseBool = (cell) => {
  const v = String(cell ?? "").trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["no", "n", "false", "0"].includes(v)) return false;
  return undefined;
};

module.exports = { splitCsvLine, detectSeparator, parseCsvWithHeader, splitList, parseBool };
