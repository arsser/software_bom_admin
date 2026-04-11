import { supabase } from './supabase';
import { formatFunctionsInvokeError } from './supabaseFunctionsInvokeError';

export type FeishuAuthTestResult = {
  ok: boolean;
  action?: string;
  httpStatus?: number;
  expireSeconds?: number;
  error?: string;
};

export type FeishuListDriveTestResult = {
  ok: boolean;
  action?: string;
  error?: string;
  listHttpStatus?: number;
  itemCount?: number;
  items?: Array<{ name?: string; type?: string; token?: string }>;
  hasMore?: boolean;
  nextPageToken?: string | null;
  /** 飞书 list 接口解析后的 JSON（与 Edge 一致） */
  raw?: unknown;
};

export type FeishuCreateFolderTestResult = {
  ok: boolean;
  action?: string;
  error?: string;
  createHttpStatus?: number;
  /** 实际创建的文件夹名称（留空测试时由服务端生成） */
  usedName?: string;
  newFolderToken?: string;
  newFolderUrl?: string | null;
  raw?: unknown;
};

function assertFeishuInvokePayload(data: unknown): asserts data is Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('返回数据格式无效');
  }
}

/** 测试飞书换 token：请求体同时带非空 appId + appSecret 时用表单预览，否则读库 */
export async function testFeishuAuth(creds: { appId: string; appSecret: string }): Promise<FeishuAuthTestResult> {
  const { data, error } = await supabase.functions.invoke<FeishuAuthTestResult>('feishu-auth-test', {
    body: { action: 'auth', appId: creds.appId, appSecret: creds.appSecret },
  });

  if (error) {
    throw new Error(await formatFunctionsInvokeError(error));
  }
  assertFeishuInvokePayload(data);
  const d = data as FeishuAuthTestResult;
  if (typeof d.ok !== 'boolean') {
    throw new Error('返回数据格式无效');
  }
  return d;
}

/** 测试云盘目录：仅拉取 folder_token 下第一页文件列表；凭据规则同 testFeishuAuth */
export async function testFeishuListDrive(params: {
  appId: string;
  appSecret: string;
  folderToken: string;
}): Promise<FeishuListDriveTestResult> {
  const { data, error } = await supabase.functions.invoke<FeishuListDriveTestResult>('feishu-auth-test', {
    body: {
      action: 'list_drive',
      folderToken: params.folderToken.trim(),
      appId: params.appId,
      appSecret: params.appSecret,
    },
  });

  if (error) {
    throw new Error(await formatFunctionsInvokeError(error));
  }
  assertFeishuInvokePayload(data);
  const d = data as FeishuListDriveTestResult;
  if (typeof d.ok !== 'boolean') {
    throw new Error('返回数据格式无效');
  }
  return d;
}

/**
 * 在父 folder_token 下测试创建子文件夹（POST create_folder）。
 * childFolderName 为空时 Edge 会生成 `sbom-test-时间戳-随机串`；凭据规则同 testFeishuAuth。
 */
export async function testFeishuCreateChildFolder(params: {
  appId: string;
  appSecret: string;
  parentFolderToken: string;
  childFolderName?: string;
}): Promise<FeishuCreateFolderTestResult> {
  const body: Record<string, string> = {
    action: 'create_folder',
    folderToken: params.parentFolderToken.trim(),
    appId: params.appId,
    appSecret: params.appSecret,
  };
  const n = params.childFolderName?.trim();
  if (n) body.childFolderName = n;

  const { data, error } = await supabase.functions.invoke<FeishuCreateFolderTestResult>('feishu-auth-test', {
    body,
  });

  if (error) {
    throw new Error(await formatFunctionsInvokeError(error));
  }
  assertFeishuInvokePayload(data);
  const d = data as FeishuCreateFolderTestResult;
  if (typeof d.ok !== 'boolean') {
    throw new Error('返回数据格式无效');
  }
  return d;
}
