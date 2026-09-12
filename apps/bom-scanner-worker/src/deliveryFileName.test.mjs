import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDeliveryAutoRenamePrefix,
  resolveUniqueDeliveryFileName,
  stripDeliveryAutoRenamePrefix,
} from './deliveryFileName.mjs';
import {
  createEmptyPackageManifest,
  packageManifestNameTakenByOtherMd5,
  packageManifestToJson,
  upsertPackageManifestEntry,
} from './feishuPackageManifest.mjs';

test('strip / apply 【自动重命名N】 prefix', () => {
  const orig = 'website-release_4.0.4_50594472.tar.gz';
  assert.equal(applyDeliveryAutoRenamePrefix(orig, 1), '【自动重命名1】website-release_4.0.4_50594472.tar.gz');
  assert.equal(applyDeliveryAutoRenamePrefix(orig, 2), '【自动重命名2】website-release_4.0.4_50594472.tar.gz');
  assert.equal(
    stripDeliveryAutoRenamePrefix('【自动重命名1】website-release_4.0.4_50594472.tar.gz'),
    orig,
  );
  assert.equal(stripDeliveryAutoRenamePrefix(orig), orig);
  assert.equal(
    applyDeliveryAutoRenamePrefix('【自动重命名3】foo.tar.gz', 1),
    '【自动重命名1】foo.tar.gz',
  );
});

test('resolveUniqueDeliveryFileName: same dir numbers, keep tar.gz', async () => {
  const taken = new Set(['website-release_4.0.4_50594472.tar.gz', '【自动重命名1】website-release_4.0.4_50594472.tar.gz']);
  const name = await resolveUniqueDeliveryFileName({
    baseName: 'website-release_4.0.4_50594472.tar.gz',
    md5: 'c9a0f398bff33d9955c56666eb738869',
    isTakenByOther: (n) => taken.has(n),
  });
  assert.equal(name, '【自动重命名2】website-release_4.0.4_50594472.tar.gz');
});

test('resolveUniqueDeliveryFileName: original free → no prefix', async () => {
  const name = await resolveUniqueDeliveryFileName({
    baseName: 'utk',
    md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    isTakenByOther: () => false,
  });
  assert.equal(name, 'utk');
});

test('package-manifest PK is rel_path: same file_name two dirs both kept', () => {
  const state = createEmptyPackageManifest();
  upsertPackageManifestEntry(state, {
    relPath: '3.1.8b4.7/天问-解析--天问-平台/website-release_4.0.4_50594472.tar.gz',
    fileName: 'website-release_4.0.4_50594472.tar.gz',
    md5: '4595de141055d6fd4284d5767aedf2aa',
    sizeBytes: 10,
    fileToken: 'token47',
  });
  upsertPackageManifestEntry(state, {
    relPath: '3.1.8b4.8/天问-解析--天问-平台/website-release_4.0.4_50594472.tar.gz',
    fileName: 'website-release_4.0.4_50594472.tar.gz',
    md5: 'c9a0f398bff33d9955c56666eb738869',
    sizeBytes: 11,
    fileToken: 'token48',
  });
  const json = packageManifestToJson(state);
  assert.equal(json.entries.length, 2);
  assert.equal(
    packageManifestNameTakenByOtherMd5(
      state,
      '3.1.8b4.8/天问-解析--天问-平台/website-release_4.0.4_50594472.tar.gz',
      'c9a0f398bff33d9955c56666eb738869',
    ),
    false,
  );
  assert.equal(
    packageManifestNameTakenByOtherMd5(
      state,
      '3.1.8b4.8/天问-解析--天问-平台/website-release_4.0.4_50594472.tar.gz',
      '4595de141055d6fd4284d5767aedf2aa',
    ),
    true,
  );
  assert.equal(
    packageManifestNameTakenByOtherMd5(
      state,
      '3.1.8b4.8/天问-解析--天问-平台/website-release_4.0.4_50594472.tar.gz',
      'ffffffffffffffffffffffffffffffff',
    ),
    true,
  );
  assert.equal(
    packageManifestNameTakenByOtherMd5(
      state,
      '3.1.8b4.9/天问-解析--天问-平台/website-release_4.0.4_50594472.tar.gz',
      'ffffffffffffffffffffffffffffffff',
    ),
    false,
  );
});

test('startship A2: same dir collide.sh three MD5s number in order', async () => {
  /** @type {Map<string, string>} */
  const claimed = new Map();
  const md5s = [
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'cccccccccccccccccccccccccccccccc',
    'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  ];
  const names = [];
  for (const md5 of md5s) {
    const name = await resolveUniqueDeliveryFileName({
      baseName: 'collide.sh',
      md5,
      isTakenByOther: (n, m) => {
        const prev = claimed.get(`v1.0/Raptor/${n}`);
        return Boolean(prev && prev !== m);
      },
    });
    claimed.set(`v1.0/Raptor/${name}`, md5);
    names.push(name);
  }
  assert.deepEqual(names, [
    'collide.sh',
    '【自动重命名1】collide.sh',
    '【自动重命名2】collide.sh',
  ]);
});

test('startship B2: other dir keeps original collide.sh', async () => {
  /** @type {Map<string, string>} */
  const claimed = new Map();
  claimed.set('v1.0/Raptor/collide.sh', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const name = await resolveUniqueDeliveryFileName({
    baseName: 'collide.sh',
    md5: 'tttttttttttttttttttttttttttttttt',
    isTakenByOther: (n, m) => {
      const prev = claimed.get(`v1.0/GridFins/${n}`);
      return Boolean(prev && prev !== m);
    },
  });
  assert.equal(name, 'collide.sh');
});

test('A1 same destRel same MD5 is not taken', async () => {
  /** @type {Map<string, string>} */
  const claimed = new Map();
  claimed.set('v1.0/Raptor/same.sh', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const name = await resolveUniqueDeliveryFileName({
    baseName: 'same.sh',
    md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    isTakenByOther: (n, m) => {
      const prev = claimed.get(`v1.0/Raptor/${n}`);
      return Boolean(prev && prev !== m);
    },
  });
  assert.equal(name, 'same.sh');
});

test('load JSON keeps duplicate file_name at different rel_path', () => {
  const text = JSON.stringify({
    version: 1,
    entries: [
      {
        rel_path: 'a/foo.tar.gz',
        file_name: 'foo.tar.gz',
        md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        size_bytes: 1,
        file_token: 'ta',
      },
      {
        rel_path: 'b/foo.tar.gz',
        file_name: 'foo.tar.gz',
        md5: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        size_bytes: 2,
        file_token: 'tb',
      },
    ],
  });
  const state = createEmptyPackageManifest(text);
  assert.equal(state.byRelPath.size, 2);
  assert.equal(state.entries.length, 2);
});
