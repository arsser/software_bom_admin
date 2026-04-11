import { supabase } from './supabase';
import type { ArtifactoryConfig } from './artifactorySettings';
import { formatFunctionsInvokeError } from './supabaseFunctionsInvokeError';

export interface ApiInfo {
  repo?: string;
  path?: string;
  created?: string;
  createdBy?: string;
  lastModified?: string;
  modifiedBy?: string;
  downloadUri?: string;
  mimeType?: string;
  size?: number;
  checksums?: {
    sha1: string;
    sha256: string;
    md5: string;
  };
  originalChecksums?: {
    sha1: string;
    sha256: string;
    md5: string;
  };
  uri?: string;
}

export interface ApiInfoResult {
  url: string;
  ok: boolean;
  info?: ApiInfo;
  error?: string;
  status?: number;
}

export async function getArtifactoryApiInfo(payload: {
  urls: string[];
  /** 与表单一致；非空字段在 Edge 内覆盖本次 Storage 请求用配置，不写库 */
  previewConfig?: Partial<ArtifactoryConfig>;
}): Promise<ApiInfoResult[]> {
  const { data, error } = await supabase.functions.invoke('artifactory-api-info', {
    body: { urls: payload.urls, previewConfig: payload.previewConfig },
  });

  if (error) {
    throw new Error(await formatFunctionsInvokeError(error));
  }

  if (data && typeof data === 'object' && 'error' in data && !Array.isArray(data)) {
    const err = (data as { error?: string }).error;
    throw new Error(err || '未知错误');
  }

  if (!Array.isArray(data)) {
    throw new Error('返回数据格式无效');
  }

  return data as ApiInfoResult[];
}
