/**
 * 生成 startship 碰撞测试源文件、MD5、BOM 表与 expected.json。
 * 下载 URL 里的 __IT_DL_BASE__ 在上传到 Artifactory 后替换为真实前缀
 * （形如 https://host/artifactory/<itRepo>/startship-collision-kit ）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const filesDir = path.join(here, 'files');

/** @type {{ rel: string, body: string, label: string }[]} */
const FILES = [
  { rel: 'kit/a/same.sh', body: 'startship-payload-alpha\n', label: 'alpha' },
  { rel: 'kit/a/alpha-old.sh', body: 'startship-payload-alpha\n', label: 'alpha' },
  { rel: 'kit/collide/b/collide.sh', body: 'startship-payload-beta\n', label: 'beta' },
  { rel: 'kit/collide/c/collide.sh', body: 'startship-payload-gamma\n', label: 'gamma' },
  { rel: 'kit/collide/z/collide.sh', body: 'startship-payload-zeta\n', label: 'zeta' },
  { rel: 'kit/a4/one.bin', body: 'startship-payload-delta\n', label: 'delta' },
  { rel: 'kit/a4/two.tar.gz', body: 'startship-payload-epsilon-targz\n', label: 'epsilon' },
  { rel: 'kit/b2/collide.sh', body: 'startship-payload-theta\n', label: 'theta' },
  { rel: 'kit/b2v2/collide.sh', body: 'startship-payload-mu\n', label: 'mu' },
  { rel: 'kit/b3/fins-alias.sh', body: 'startship-payload-alpha\n', label: 'alpha' },
  { rel: 'kit/b3v2/v2-alias.sh', body: 'startship-payload-alpha\n', label: 'alpha' },
  { rel: 'kit/b4/unique-gf.dat', body: 'startship-payload-iota\n', label: 'iota' },
  { rel: 'kit/b4v2/unique-v2.dat', body: 'startship-payload-kappa\n', label: 'kappa' },
];

function md5Of(s) {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

function urlFor(rel) {
  return `__IT_DL_BASE__/${rel.replace(/^\/+/, '')}`;
}

fs.rmSync(filesDir, { recursive: true, force: true });

/** @type {Record<string, { rel: string, md5: string, bytes: number, label: string }>} */
const byRel = {};
for (const f of FILES) {
  const abs = path.join(filesDir, f.rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, f.body, 'utf8');
  const md5 = md5Of(f.body);
  byRel[f.rel] = { rel: f.rel, md5, bytes: Buffer.byteLength(f.body), label: f.label };
}

const alpha = byRel['kit/a/same.sh'].md5;
if (byRel['kit/a/alpha-old.sh'].md5 !== alpha) throw new Error('alpha-old must match same.sh');
if (byRel['kit/b3/fins-alias.sh'].md5 !== alpha) throw new Error('fins-alias must match alpha');
if (byRel['kit/b3v2/v2-alias.sh'].md5 !== alpha) throw new Error('v2-alias must match alpha');

function row(p) {
  return {
    模块: p.module,
    组件名: p.component,
    组件ID: p.componentId,
    下载路径: urlFor(p.rel),
    MD5: byRel[p.rel].md5,
    文件大小: String(byRel[p.rel].bytes),
    备注: p.note,
  };
}

const v1Rows = [
  row({ module: 'Raptor', component: 'same', componentId: 'ss-a1-1', rel: 'kit/a/same.sh', note: 'A1#1 同目录同名同MD5' }),
  row({ module: 'Raptor', component: 'same', componentId: 'ss-a1-2', rel: 'kit/a/same.sh', note: 'A1#2 同目录同名同MD5' }),
  row({ module: 'Raptor', component: 'collide', componentId: 'ss-a2-b', rel: 'kit/collide/b/collide.sh', note: 'A2#1 collide.sh 原名' }),
  row({ module: 'Raptor', component: 'collide', componentId: 'ss-a2-c', rel: 'kit/collide/c/collide.sh', note: 'A2#2 【自动重命名1】collide.sh' }),
  row({ module: 'Raptor', component: 'collide', componentId: 'ss-a2-z', rel: 'kit/collide/z/collide.sh', note: 'A2#3 【自动重命名2】collide.sh' }),
  row({ module: 'Raptor', component: 'alpha-old', componentId: 'ss-a3', rel: 'kit/a/alpha-old.sh', note: 'A3 不同名同MD5' }),
  row({ module: 'Raptor', component: 'one', componentId: 'ss-a4-1', rel: 'kit/a4/one.bin', note: 'A4 one.bin' }),
  row({ module: 'Raptor', component: 'two', componentId: 'ss-a4-2', rel: 'kit/a4/two.tar.gz', note: 'A4 two.tar.gz' }),
  row({ module: 'GridFins', component: 'same', componentId: 'ss-b1-v1', rel: 'kit/a/same.sh', note: 'B1 跨模块同名同MD5' }),
  row({ module: 'GridFins', component: 'collide', componentId: 'ss-b2-v1', rel: 'kit/b2/collide.sh', note: 'B2 跨模块同名不同MD5' }),
  row({ module: 'GridFins', component: 'fins-alias', componentId: 'ss-b3-v1', rel: 'kit/b3/fins-alias.sh', note: 'B3 跨模块不同名同MD5' }),
  row({ module: 'GridFins', component: 'unique-gf', componentId: 'ss-b4-v1', rel: 'kit/b4/unique-gf.dat', note: 'B4 跨模块不同名不同MD5' }),
];

const v2Rows = [
  row({ module: 'Raptor', component: 'same', componentId: 'ss-b1-v2', rel: 'kit/a/same.sh', note: 'B1 跨版本同名同MD5' }),
  row({ module: 'Raptor', component: 'collide', componentId: 'ss-b2-v2', rel: 'kit/b2v2/collide.sh', note: 'B2 跨版本同名不同MD5' }),
  row({ module: 'Raptor', component: 'v2-alias', componentId: 'ss-b3-v2', rel: 'kit/b3v2/v2-alias.sh', note: 'B3 跨版本不同名同MD5' }),
  row({ module: 'Raptor', component: 'unique-v2', componentId: 'ss-b4-v2', rel: 'kit/b4v2/unique-v2.dat', note: 'B4 跨版本不同名不同MD5' }),
  row({ module: 'GridFins', component: 'unique-gf', componentId: 'ss-gf-v2', rel: 'kit/b4/unique-gf.dat', note: 'v2.0/GridFins 结构完整' }),
];

function toTsv(rows) {
  const headers = ['模块', '组件名', '组件ID', '下载路径', 'MD5', '文件大小', '备注'];
  const lines = [headers.join('\t')];
  for (const r of rows) {
    lines.push(headers.map((h) => String(r[h] ?? '')).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

const expectedLocal = [
  { path: 'v1.0/Raptor/same.sh', md5: byRel['kit/a/same.sh'].md5, case: 'A1' },
  { path: 'v1.0/Raptor/collide.sh', md5: byRel['kit/collide/b/collide.sh'].md5, case: 'A2' },
  { path: 'v1.0/Raptor/【自动重命名1】collide.sh', md5: byRel['kit/collide/c/collide.sh'].md5, case: 'A2' },
  { path: 'v1.0/Raptor/【自动重命名2】collide.sh', md5: byRel['kit/collide/z/collide.sh'].md5, case: 'A2' },
  { path: 'v1.0/Raptor/alpha-old.sh', md5: byRel['kit/a/alpha-old.sh'].md5, case: 'A3', sameInodeAs: 'v1.0/Raptor/same.sh' },
  { path: 'v1.0/Raptor/one.bin', md5: byRel['kit/a4/one.bin'].md5, case: 'A4' },
  { path: 'v1.0/Raptor/two.tar.gz', md5: byRel['kit/a4/two.tar.gz'].md5, case: 'A4' },
  { path: 'v1.0/GridFins/same.sh', md5: byRel['kit/a/same.sh'].md5, case: 'B1', sameInodeAs: 'v1.0/Raptor/same.sh' },
  { path: 'v1.0/GridFins/collide.sh', md5: byRel['kit/b2/collide.sh'].md5, case: 'B2' },
  { path: 'v1.0/GridFins/fins-alias.sh', md5: byRel['kit/b3/fins-alias.sh'].md5, case: 'B3', sameInodeAs: 'v1.0/Raptor/same.sh' },
  { path: 'v1.0/GridFins/unique-gf.dat', md5: byRel['kit/b4/unique-gf.dat'].md5, case: 'B4' },
  { path: 'v2.0/Raptor/same.sh', md5: byRel['kit/a/same.sh'].md5, case: 'B1', sameInodeAs: 'v1.0/Raptor/same.sh' },
  { path: 'v2.0/Raptor/collide.sh', md5: byRel['kit/b2v2/collide.sh'].md5, case: 'B2' },
  { path: 'v2.0/Raptor/v2-alias.sh', md5: byRel['kit/b3v2/v2-alias.sh'].md5, case: 'B3', sameInodeAs: 'v1.0/Raptor/same.sh' },
  { path: 'v2.0/Raptor/unique-v2.dat', md5: byRel['kit/b4v2/unique-v2.dat'].md5, case: 'B4' },
  { path: 'v2.0/GridFins/unique-gf.dat', md5: byRel['kit/b4/unique-gf.dat'].md5, case: 'v2-GridFins', sameInodeAs: 'v1.0/GridFins/unique-gf.dat' },
];

const expected = {
  kitPrefix: 'startship-collision-kit',
  urlPlaceholder: '__IT_DL_BASE__',
  files: byRel,
  expectedLocal,
  feishu: {
    md5DedupMayOmitPaths: [
      'v1.0/Raptor/alpha-old.sh',
      'v1.0/GridFins/same.sh',
      'v1.0/GridFins/fins-alias.sh',
      'v2.0/Raptor/same.sh',
      'v2.0/Raptor/v2-alias.sh',
      'v2.0/GridFins/unique-gf.dat',
    ],
    note: '飞书按 MD5 全局去重，这些 destRel 行上 present 即可，云盘可以没有第二份文件',
  },
  ext: {
    mustHavePaths: expectedLocal.map((e) => e.path),
    note: 'ext checksum COPY 会落到本版路径，应有实文件',
  },
};

fs.writeFileSync(path.join(here, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
fs.writeFileSync(path.join(here, 'bom-v1.0.tsv'), toTsv(v1Rows));
fs.writeFileSync(path.join(here, 'bom-v2.0.tsv'), toTsv(v2Rows));

console.log('wrote', FILES.length, 'files; alpha md5', alpha);
