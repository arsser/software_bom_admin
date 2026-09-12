/**
 * 将 kit/files 上传到 IT Artifactory，并写出带真实下载 URL 的 BOM tsv。
 *
 * 环境变量（不要把 Key 写入仓库）：
 *   IT_ARTIFACTORY_BASE_URL  例 https://host/artifactory 或含仓库的 base
 *   IT_ARTIFACTORY_API_KEY
 *   IT_ARTIFACTORY_REPO      源仓库 key（BOM 下载 URL 用）
 *   IT_DL_BASE               可选；默认 {origin}/artifactory/{repo}/startship-collision-kit
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const filesDir = path.join(here, 'files');
const expected = JSON.parse(fs.readFileSync(path.join(here, 'expected.json'), 'utf8'));

const baseRaw = String(process.env.IT_ARTIFACTORY_BASE_URL ?? '').trim().replace(/\/+$/, '');
const apiKey = String(process.env.IT_ARTIFACTORY_API_KEY ?? '').trim();
const repo = String(process.env.IT_ARTIFACTORY_REPO ?? '').trim();
if (!baseRaw || !apiKey || !repo) {
  console.error('need IT_ARTIFACTORY_BASE_URL, IT_ARTIFACTORY_API_KEY, IT_ARTIFACTORY_REPO');
  process.exit(1);
}

function artifactoryOrigin(base) {
  try {
    const u = new URL(base.includes('://') ? base : `https://${base}`);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

const origin = artifactoryOrigin(baseRaw);
const kitPrefix = expected.kitPrefix;
const dlBase =
  String(process.env.IT_DL_BASE ?? '').trim().replace(/\/+$/, '') ||
  `${origin}/artifactory/${repo}/${kitPrefix}`;
const putRoot = `${origin}/artifactory/${repo}/${kitPrefix}`;

const header = { 'X-JFrog-Art-Api': apiKey, 'Content-Type': 'application/octet-stream' };

const rels = Object.keys(expected.files);
for (const rel of rels) {
  const abs = path.join(filesDir, rel);
  const buf = fs.readFileSync(abs);
  const url = `${putRoot}/${rel.replace(/^\/+/, '')}`;
  const res = await fetch(url, { method: 'PUT', headers: header, body: buf });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`PUT ${rel} HTTP ${res.status} ${t.slice(0, 300)}`);
  }
  console.log('uploaded', rel);
}

function rewriteTsv(name) {
  const src = fs.readFileSync(path.join(here, name), 'utf8');
  const out = src.replaceAll('__IT_DL_BASE__', dlBase);
  const dest = path.join(here, name.replace('.tsv', '.uploaded.tsv'));
  fs.writeFileSync(dest, out);
  console.log('wrote', dest);
}

rewriteTsv('bom-v1.0.tsv');
rewriteTsv('bom-v2.0.tsv');
fs.writeFileSync(
  path.join(here, 'upload-meta.json'),
  `${JSON.stringify({ repo, kitPrefix, dlBase, putRoot, origin }, null, 2)}\n`,
);
console.log('dlBase', dlBase);
