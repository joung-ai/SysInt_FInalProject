// Minimal RFC 4180 CSV reader/writer: quoted fields, escaped quotes ("") and CRLF or LF line endings.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text).replace(/^﻿/, '');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
}

// Quotes every cell and neutralises spreadsheet formula prefixes (CSV injection). Plain signed
// numbers such as "+639171110001" cannot run as formulas, so they are left intact.
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const toCsv = rows => `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;

module.exports = { parseCsv, csvCell, toCsv };
