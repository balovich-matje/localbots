// Minimal CSV parser for wago.tools DB2 exports (handles quoted fields).
// `columns` limits which fields are kept — ItemSparse is 49MB, we only need a few.

export function parseCsv(text, columns = null) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift();
  const keep = columns
    ? header.map((h, i) => (columns.includes(h) ? i : -1)).filter((i) => i >= 0)
    : header.map((_, i) => i);
  const names = keep.map((i) => header[i]);
  const out = [];
  for (const r of rows) {
    if (r.length < 2) continue;
    const obj = {};
    for (let k = 0; k < keep.length; k++) obj[names[k]] = r[keep[k]];
    out.push(obj);
  }
  return out;
}
