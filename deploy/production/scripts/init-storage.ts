/**
 * 初始化 Storage 脚本
 * 用于在 supabase db reset 后上传图片到 Storage
 * 图片从本地 seed-data/sample-images 目录读取，上传到对应的 storage_path
 *
 * 使用方式：在 deploy/production 下执行 pnpm run init-storage
 * 配置：复制 .deploy.env.example 为 .deploy.env 并填写 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（不复制则使用默认本地值）
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// 脚本所在 deploy/production/scripts 目录，PROJECT_ROOT 为 deploy/production
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.deploy.env');
const SAMPLE_IMAGES_DIR = path.join(PROJECT_ROOT, 'scripts', 'seed-data', 'sample-images');

const DEFAULT_SUPABASE_URL = 'http://127.0.0.1:54321';
const DEFAULT_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

/** 从 .deploy.env 加载并返回本次从文件中写入的 key 集合（不覆盖已有 process.env） */
function loadEnvIfPresent(): Set<string> {
  const loadedFromFile = new Set<string>();
  if (!fs.existsSync(ENV_PATH)) return loadedFromFile;
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (!process.env[key]) {
      process.env[key] = value;
      loadedFromFile.add(key);
    }
  }
  return loadedFromFile;
}

const envLoadedKeys = loadEnvIfPresent();

// 从 .deploy.env 或环境变量读取（默认本地 Supabase）
const SUPABASE_URL = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || DEFAULT_SERVICE_ROLE_KEY;

function configSource(key: string, value: string, defaultVal: string): string {
  if (envLoadedKeys.has(key)) return '从 .deploy.env 读取';
  if (value === defaultVal) return '使用默认值';
  return '从环境变量读取';
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 14) return `${key.slice(0, 3)}***${key.slice(-3)}`;
  return `${key.slice(0, 7)}***${key.slice(-7)}`;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// 数据库 file_name 到本地文件名的映射
const LOCAL_FILE_MAP: Record<string, string> = {
  '6ca60740-df07-11ef-ab1e-5bd06fea511f.jpg.webp': 'maori.webp',
  '1c543320-df07-11ef-ab1e-5bd06fea511f.jpg.webp': 'river.webp',
};

async function initStorage() {
  console.log('🚀 开始初始化 Storage...\n');
  console.log(`   SUPABASE_URL: ${SUPABASE_URL}`);
  console.log(`      来源: ${configSource('SUPABASE_URL', SUPABASE_URL, DEFAULT_SUPABASE_URL)}`);
  console.log(`   SUPABASE_SERVICE_ROLE_KEY: ${maskKey(SUPABASE_SERVICE_KEY)}`);
  console.log(`      来源: ${configSource('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_KEY, DEFAULT_SERVICE_ROLE_KEY)}`);
  console.log(`   本地图片目录: ${SAMPLE_IMAGES_DIR}\n`);

  if (!fs.existsSync(SAMPLE_IMAGES_DIR)) {
    console.error('❌ 本地图片目录不存在:', SAMPLE_IMAGES_DIR);
    process.exit(1);
  }

  const { data: images, error: fetchError } = await supabase
    .from('downloaded_images')
    .select('id, original_url, storage_path, file_name, mime_type')
    .eq('status', 'completed');

  if (fetchError) {
    console.error('❌ 获取图片列表失败:', fetchError.message);
    process.exit(1);
  }

  if (!images || images.length === 0) {
    console.log('ℹ️  没有需要上传的图片');
    return;
  }

  console.log(`📋 找到 ${images.length} 张图片需要上传\n`);

  let successCount = 0;
  let failCount = 0;

  for (const image of images) {
    try {
      console.log(`\n📥 处理: ${image.file_name}`);

      const localFileName = LOCAL_FILE_MAP[image.file_name];
      if (!localFileName) {
        console.error(`   ❌ 未找到本地文件映射: ${image.file_name}`);
        failCount++;
        continue;
      }

      const localFilePath = path.join(SAMPLE_IMAGES_DIR, localFileName);
      if (!fs.existsSync(localFilePath)) {
        console.error(`   ❌ 本地文件不存在: ${localFilePath}`);
        failCount++;
        continue;
      }

      const { data: existingFile } = await supabase.storage
        .from('downloaded-images')
        .list(image.storage_path.split('/')[0], {
          search: image.storage_path.split('/')[1]
        });

      if (existingFile && existingFile.length > 0) {
        console.log(`   ⏭️  文件已存在，跳过`);
        successCount++;
        continue;
      }

      const buffer = fs.readFileSync(localFilePath);
      console.log(`   📂 读取本地文件: ${localFileName} (${(buffer.length / 1024).toFixed(1)} KB)`);

      const { error: uploadError } = await supabase.storage
        .from('downloaded-images')
        .upload(image.storage_path, buffer, {
          contentType: image.mime_type || 'image/webp',
          upsert: true
        });

      if (uploadError) {
        console.error(`   ❌ 上传失败: ${uploadError.message}`);
        failCount++;
        continue;
      }

      console.log(`   ✅ 上传成功: ${image.storage_path}`);
      successCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`   ❌ 处理失败: ${msg}`);
      failCount++;
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`🎉 Storage 初始化完成！`);
  console.log(`   成功: ${successCount} 张`);
  if (failCount > 0) {
    console.log(`   失败: ${failCount} 张`);
  }
  console.log('\n现在可以访问图片管理页面查看图片。');
}

initStorage().catch(err => {
  console.error('初始化失败:', err);
  process.exit(1);
});
