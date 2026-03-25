/**
 * 将 deployment-assistant 的 Artifactory 凭据迁移到 software_bom_admin 的 Supabase system_settings。
 *
 * 数据源优先级：
 * 1) 如果存在 sqlite 文件，则从 sqlite 读取（SystemConfig.id=1）。
 * 2) 否则尝试从 deployment-assistant 后端读取 GET /system-config。
 *
 * 写入目标：
 * - table: system_settings
 * - key: artifactory_config
 * - value: { artifactoryBaseUrl, artifactoryApiKey, artifactoryExtBaseUrl, artifactoryExtApiKey }
 *
 * 注意：脚本只做“脱敏日志”，不会在控制台输出密钥明文。
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..'); // deploy/production
const ENV_PATH = path.join(PROJECT_ROOT, '.deploy.env');

const DEFAULT_SUPABASE_URL = 'http://127.0.0.1:54321';
// 仅用于本地默认；生产环境请务必通过环境变量/部署配置提供自己的 key
const DEFAULT_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const DEPLOY_ASSISTANT_API_BASE_DEFAULT = 'http://localhost:4001';
const DEPLOY_ASSISTANT_SQLITE_DEFAULT = path.join(
  PROJECT_ROOT,
  '..',
  '..',
  '..',
  'deployment-assistant',
  'data',
  'deploy-assistant.sqlite',
);

const ARTIFACTORY_SETTINGS_KEY = 'artifactory_config';

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 6) return key.slice(0, 1) + '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
      loadedFromFile.add(key);
    }
  }
  return loadedFromFile;
}

const envLoadedKeys = loadEnvIfPresent();

function configSource(key: string, value: string, defaultVal: string): string {
  if (envLoadedKeys.has(key)) return '从 .deploy.env 读取';
  if (value === defaultVal) return '使用默认值';
  return '从环境变量读取';
}

const SUPABASE_URL = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || DEFAULT_SERVICE_ROLE_KEY;

const DEPLOY_ASSISTANT_API_BASE =
  process.env.DEPLOYMENT_ASSISTANT_API_BASE || DEPLOY_ASSISTANT_API_BASE_DEFAULT;

const DEPLOY_ASSISTANT_SQLITE_PATH =
  process.env.DEPLOY_ASSISTANT_SQLITE_PATH || DEPLOY_ASSISTANT_SQLITE_DEFAULT;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

type ArtifactoryConfig = {
  artifactoryBaseUrl?: string;
  artifactoryApiKey?: string;
  artifactoryExtBaseUrl?: string;
  artifactoryExtApiKey?: string;
};

async function loadSourceConfigFromApi(): Promise<ArtifactoryConfig | null> {
  const url = `${DEPLOY_ASSISTANT_API_BASE.replace(/\/+$/, '')}/system-config`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GET ${url} failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as any;
  return {
    artifactoryBaseUrl: data?.artifactoryBaseUrl ?? '',
    artifactoryApiKey: data?.artifactoryApiKey ?? '',
    artifactoryExtBaseUrl: data?.artifactoryExtBaseUrl ?? '',
    artifactoryExtApiKey: data?.artifactoryExtApiKey ?? '',
  };
}

function loadSourceConfigFromSqlite(): ArtifactoryConfig {
  if (!fs.existsSync(DEPLOY_ASSISTANT_SQLITE_PATH)) {
    throw new Error(`sqlite 文件不存在: ${DEPLOY_ASSISTANT_SQLITE_PATH}`);
  }

  // 使用 sqlite 的 json_object 输出，避免再手动切割分隔符。
  const sql = `
    SELECT json_object(
      'artifactoryBaseUrl', COALESCE(artifactoryBaseUrl, ''),
      'artifactoryApiKey', COALESCE(artifactoryApiKey, ''),
      'artifactoryExtBaseUrl', COALESCE(artifactoryExtBaseUrl, ''),
      'artifactoryExtApiKey', COALESCE(artifactoryExtApiKey, '')
    ) AS cfg
    FROM SystemConfig
    WHERE id = 1
    LIMIT 1;
  `.trim();

  const out = execFileSync('sqlite3', [DEPLOY_ASSISTANT_SQLITE_PATH, sql], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  if (!out) throw new Error('sqlite 查询结果为空');

  const cfg = JSON.parse(out) as ArtifactoryConfig;
  return cfg;
}

function ensureString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

async function main() {
  console.log('=== 开始迁移 Artifactory 设置到 Supabase ===');
  console.log(`SUPABASE_URL: ${SUPABASE_URL} (${configSource('SUPABASE_URL', SUPABASE_URL, DEFAULT_SUPABASE_URL)})`);
  console.log(
    `SUPABASE_SERVICE_ROLE_KEY: ${maskKey(SUPABASE_SERVICE_KEY)} (${configSource(
      'SUPABASE_SERVICE_ROLE_KEY',
      SUPABASE_SERVICE_KEY,
      DEFAULT_SERVICE_ROLE_KEY,
    )})`,
  );

  console.log(`Source sqlite: ${DEPLOY_ASSISTANT_SQLITE_PATH}`);
  console.log(`Source API: ${DEPLOY_ASSISTANT_API_BASE}`);

  let source: ArtifactoryConfig | null = null;
  if (fs.existsSync(DEPLOY_ASSISTANT_SQLITE_PATH)) {
    console.log('使用 sqlite 作为数据源...');
    source = loadSourceConfigFromSqlite();
  } else {
    console.log('sqlite 不存在，尝试使用 deployment-assistant API...');
    source = await loadSourceConfigFromApi();
  }

  const config: ArtifactoryConfig = {
    artifactoryBaseUrl: ensureString(source?.artifactoryBaseUrl),
    artifactoryApiKey: ensureString(source?.artifactoryApiKey),
    artifactoryExtBaseUrl: ensureString(source?.artifactoryExtBaseUrl),
    artifactoryExtApiKey: ensureString(source?.artifactoryExtApiKey),
  };

  console.log('从源系统读取完成（脱敏显示）：');
  console.log({
    artifactoryBaseUrl: config.artifactoryBaseUrl ? '[set]' : '',
    artifactoryApiKey: maskKey(config.artifactoryApiKey),
    artifactoryExtBaseUrl: config.artifactoryExtBaseUrl ? '[set]' : '',
    artifactoryExtApiKey: maskKey(config.artifactoryExtApiKey),
  });

  const value = {
    artifactoryBaseUrl: config.artifactoryBaseUrl.trim(),
    artifactoryApiKey: config.artifactoryApiKey,
    artifactoryExtBaseUrl: config.artifactoryExtBaseUrl.trim(),
    artifactoryExtApiKey: config.artifactoryExtApiKey,
  };

  const { error } = await supabase
    .from('system_settings')
    .upsert(
      {
        key: ARTIFACTORY_SETTINGS_KEY,
        value,
      },
      { onConflict: 'key' },
    );

  if (error) {
    throw error;
  }

  console.log('=== Supabase 写入完成 ===');
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('迁移失败:', msg);
  process.exit(1);
});

