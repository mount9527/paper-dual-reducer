// 发布前合规自查：只检查 package.json 的 files 白名单。
// 用法：node tools/privacy-check.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const files = [];
for (const pattern of pkg.files ?? []) {
  if (pattern.includes('*')) {
    const dir = join(root, dirname(pattern));
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) files.push(join(dir, name));
    }
  } else {
    files.push(join(root, pattern));
  }
}
const sampleTxt = new Set([
  join(root, 'aigc', 'samples', 'ai_sample.txt'),
  join(root, 'aigc', 'samples', 'human_sample.txt'),
  join(root, 'aigc', 'samples', 'colloquial_bad.txt'),
]);
const allowedTxt = new Set([...sampleTxt, join(root, 'aigc', 'requirements.txt')]);
const textExt = new Set(['.js', '.mjs', '.py', '.md', '.json', '.txt']);
const forbiddenDomain = /(?:openalex|hanspub|paper\.edu\.cn)/i;
const secretPattern = /(?:sk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]\s*['"][^'"]{8,}|authorization\s*[:=]\s*['"]bearer\s+[^'"]+)/i;
const problems = [];
for (const file of files) {
  if (!existsSync(file)) { problems.push('missing package file: ' + file); continue; }
  if (!statSync(file).isFile()) continue;
  const rel = file.slice(root.length + 1);
  const ext = extname(file).toLowerCase();
  if (['.pdf', '.jsonl', '.csv', '.xls', '.xlsx'].includes(ext)) {
    problems.push('forbidden package extension: ' + rel);
  }
  if (ext === '.txt' && !allowedTxt.has(file)) {
    problems.push('unregistered txt in package: ' + rel);
  }
  if (sampleTxt.has(file)) {
    const header = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0];
    if (!header.startsWith('说明：') || !header.includes('自撰')) {
      problems.push('sample txt lacks self-authored header: ' + rel);
    }
  }
  if (textExt.has(ext)) {
    const text = readFileSync(file, 'utf8');
    if (forbiddenDomain.test(text)) problems.push('crawler/domain residue: ' + rel);
    if (secretPattern.test(text)) problems.push('possible credential in: ' + rel);
  }
}
if (problems.length) {
  console.error('发布合规检查失败：');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('发布合规检查通过：无第三方语料文件、无爬虫域名、无凭据模式。');
