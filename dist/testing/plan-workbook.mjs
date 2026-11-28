const encoder = new TextEncoder();
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRelations = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelations = 'http://schemas.openxmlformats.org/package/2006/relationships';
const typesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function xmlText(text) {
  return text.toWellFormed()
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[&<>"\r]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': '&#13;' })[character])
    // SpreadsheetML treats this pattern as an encoded character, even in text cells.
    .replace(/_x[0-9a-f]{4}_/gi, value => `_x005F_${value.slice(1)}`);
}

function worksheet(rows) {
  const merged = [];
  const data = rows.map(({ values, heading, span }, index) => {
    const number = index + 1;
    if (heading || span) merged.push(`<mergeCell ref="A${number}:B${number}"/>`);
    const lines = Math.max(1, ...values.map((value, column) => value.split(/\r?\n/).reduce((total, line) => {
      const width = heading || span ? 52 : column ? 40 : 10;
      return total + Math.max(1, Math.ceil(Array.from(line).length / width));
    }, 0)));
    const cells = values.map((value, column) => `<c r="${column ? 'B' : 'A'}${number}" s="${heading ? 2 : 1}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`).join('');
    return `<row r="${number}" ht="${Math.min(408, 6 + 16 * lines)}" customHeight="1">${cells}</row>`;
  });
  return `<worksheet xmlns="${spreadsheet}"><cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="88" customWidth="1"/></cols><sheetData>${data.join('')}</sheetData><mergeCells count="${merged.length}">${merged.join('')}</mergeCells></worksheet>`;
}

// These are the workbook, worksheet and styles parts of a single-sheet XLSX.
const styles = `<styleSheet xmlns="${spreadsheet}">
  <fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><name val="Yu Gothic"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function relationships(entries) {
  return `<Relationships xmlns="${packageRelations}">${entries.map(([type, target], index) =>
    `<Relationship Id="rId${index + 1}" Type="${officeRelations}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

export function createWorkbook(rows) {
  const parts = {
    '[Content_Types].xml': `<Types xmlns="${typesNamespace}">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
    </Types>`,
    '_rels/.rels': relationships([['officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<workbook xmlns="${spreadsheet}" xmlns:r="${officeRelations}"><sheets><sheet name="テスト計画" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships([['worksheet', 'worksheets/sheet1.xml'], ['styles', 'styles.xml']]),
    'xl/worksheets/sheet1.xml': worksheet(rows),
    'xl/styles.xml': styles,
  };
  return storeZip(parts);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// XLSX uses ZIP. All part names are ASCII and entries are stored without compression.
function storeZip(parts) {
  const local = [], directory = [];
  let fileOffset = 0, directorySize = 0;
  for (const [path, xml] of Object.entries(parts)) {
    const name = encoder.encode(path), data = encoder.encode(xmlHeader + xml);
    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(12, 33, true); // DOS date: 1980-01-01.
    localHeader.setUint32(14, crc32(data), true);
    localHeader.setUint32(18, data.length, true);
    localHeader.setUint32(22, data.length, true);
    localHeader.setUint16(26, name.length, true);
    local.push(localHeader.buffer, name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    new Uint8Array(entry.buffer, 6, 26).set(new Uint8Array(localHeader.buffer, 4, 26));
    entry.setUint32(42, fileOffset, true);
    directory.push(entry.buffer, name);
    fileOffset += localHeader.byteLength + name.length + data.length;
    directorySize += entry.byteLength + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, directory.length / 2, true);
  end.setUint16(10, directory.length / 2, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, fileOffset, true);
  return [...local, ...directory, end.buffer];
}
