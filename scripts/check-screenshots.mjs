import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// docs/screens/<Issue番号>/ の画像が、docs/screenshots.md の規則に合っているかを検査する。
export const LIMITS = Object.freeze({ fileBytes: 150 * 1024, width: 800, folderBytes: 1024 * 1024, totalBytes: 30 * 1024 * 1024 });
const folderPattern = /^[1-9][0-9]*$/;
const filePattern = /^(before|after)-[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.jpg$/;

// JPEGのSOFマーカーから幅を読む。JPEGでなければnull。
export function jpegWidth(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) return bytes.readUInt16BE(offset + 7);
    offset += 2 + length;
  }
  return null;
}

const kib = bytes => `${Math.ceil(bytes / 1024)}KiB`;

export async function checkScreenshots(root) {
  const problems = [];
  let folders;
  try { folders = await readdir(root, { withFileTypes: true }); } catch { return problems; }
  let total = 0;
  for (const folder of folders) {
    const where = `docs/screens/${folder.name}`;
    if (!folder.isDirectory()) { if (folder.name !== 'README.md') problems.push(`${where}: 作業ごとのフォルダー以外は置けない`); continue; }
    if (!folderPattern.test(folder.name)) { problems.push(`${where}: フォルダー名はIssue番号（半角数字）にする`); continue; }
    let sum = 0;
    for (const file of await readdir(path.join(root, folder.name), { withFileTypes: true })) {
      const label = `${where}/${file.name}`;
      if (!file.isFile()) { problems.push(`${label}: ファイル以外は置けない`); continue; }
      if (!filePattern.test(file.name)) { problems.push(`${label}: 名前は before-01-name.jpg または after-01-name.jpg の形（半角英小文字・数字・ハイフン）にする`); continue; }
      const bytes = await readFile(path.join(root, folder.name, file.name));
      sum += bytes.length;
      if (bytes.length > LIMITS.fileBytes) problems.push(`${label}: ${kib(bytes.length)}で、1枚${kib(LIMITS.fileBytes)}を超えている`);
      const width = jpegWidth(bytes);
      if (width === null) problems.push(`${label}: JPEGとして読めない`);
      else if (width > LIMITS.width) problems.push(`${label}: 幅${width}pxで、${LIMITS.width}pxを超えている`);
    }
    total += sum;
    if (sum > LIMITS.folderBytes) problems.push(`${where}: 合計${kib(sum)}で、1作業${kib(LIMITS.folderBytes)}を超えている`);
  }
  if (total > LIMITS.totalBytes) problems.push(`docs/screens: 全体で${kib(total)}あり、${kib(LIMITS.totalBytes)}を超えている。古い画像を整理する`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(fileURLToPath(new URL('../docs/screens/', import.meta.url)));
  const problems = await checkScreenshots(root);
  if (problems.length) { process.stderr.write(problems.join('\n') + '\n'); process.exitCode = 1; }
  else process.stdout.write('docs/screens: 規則に合っている\n');
}
