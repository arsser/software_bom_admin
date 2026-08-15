import { supabase } from './supabase';
import { formatBytesHuman } from './bytesFormat';
import { formatSpeedLabel } from './bomJobTransferStats';
import { formatFunctionsInvokeError } from './supabaseFunctionsInvokeError';
import { fetchFeishuSettings } from './feishuSettings';

export type FeishuSendImResult = {
  ok: boolean;
  action?: string;
  sent?: number;
  failed?: Array<{ openId: string; error: string }>;
  error?: string;
};

function formatEtaSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s > 0 ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

/** 若未启用通知则静默跳过；失败不抛错（避免打断流水线） */
export async function sendFeishuNotify(text: string): Promise<FeishuSendImResult> {
  const msg = String(text ?? '').trim();
  if (!msg) return { ok: false, error: '空消息' };

  try {
    const cfg = await fetchFeishuSettings();
    if (!cfg?.notifyEnabled || !cfg.notifyOpenIds.length) {
      return { ok: true, sent: 0 };
    }

    const { data, error } = await supabase.functions.invoke<FeishuSendImResult>('feishu-auth-test', {
      body: {
        action: 'send_im',
        msg,
        openIds: cfg.notifyOpenIds,
      },
    });
    if (error) {
      console.warn('[feishuNotify]', await formatFunctionsInvokeError(error));
      return { ok: false, error: await formatFunctionsInvokeError(error) };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, error: '返回数据格式无效' };
    }
    return data;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.warn('[feishuNotify]', err);
    return { ok: false, error: err };
  }
}

export function formatPipelineStepPrefix(stepIndex?: number | null, stepTotal?: number | null): string {
  if (
    stepIndex == null ||
    stepTotal == null ||
    !Number.isFinite(stepIndex) ||
    !Number.isFinite(stepTotal) ||
    stepIndex < 1 ||
    stepTotal < 1
  ) {
    return '';
  }
  return `${Math.floor(stepIndex)}/${Math.floor(stepTotal)} `;
}

export type PipelineNotifyStepOpts = {
  stepIndex?: number | null;
  stepTotal?: number | null;
};

export function buildJobProgressNotifyText(opts: {
  title: string;
  batchName?: string;
  jobId?: string;
  progressPct?: number | null;
  bytesTotal?: number | null;
  bytesDone?: number | null;
  speedBps?: number | null;
  etaSec?: number | null;
  progressCurrent?: number | null;
  progressTotal?: number | null;
  extra?: string;
} & PipelineNotifyStepOpts): string {
  const step = formatPipelineStepPrefix(opts.stepIndex, opts.stepTotal);
  const lines = [`【BOM】${step}${opts.title}`];
  if (opts.batchName?.trim()) lines.push(`版本：${opts.batchName.trim()}`);
  if (opts.jobId?.trim()) lines.push(`任务：${opts.jobId.trim().slice(0, 8)}…`);
  if (opts.progressPct != null && Number.isFinite(opts.progressPct)) {
    lines.push(`进度：${opts.progressPct.toFixed(1)}%`);
  }
  if (opts.progressTotal != null && opts.progressTotal > 0) {
    lines.push(`行数：${opts.progressCurrent ?? 0}/${opts.progressTotal}`);
  }
  if (opts.bytesTotal != null && opts.bytesTotal > 0) {
    const done = opts.bytesDone != null ? formatBytesHuman(opts.bytesDone) : '—';
    lines.push(`大小：${done} / ${formatBytesHuman(opts.bytesTotal)}`);
  }
  if (opts.speedBps != null && opts.speedBps > 0) {
    lines.push(`速度：${formatSpeedLabel(opts.speedBps)}`);
  }
  if (opts.etaSec != null) {
    lines.push(`ETA：${formatEtaSec(opts.etaSec)}`);
  }
  if (opts.extra?.trim()) lines.push(opts.extra.trim());
  return lines.join('\n');
}

export function buildJobEndNotifyText(opts: {
  title: string;
  batchName?: string;
  jobId?: string;
  ok: boolean;
  elapsedSec?: number | null;
  bytesTotal?: number | null;
  avgSpeedBps?: number | null;
  detail?: string;
} & PipelineNotifyStepOpts): string {
  const step = formatPipelineStepPrefix(opts.stepIndex, opts.stepTotal);
  const lines = [`【BOM】${step}${opts.title} · ${opts.ok ? '成功' : '失败'}`];
  if (opts.batchName?.trim()) lines.push(`版本：${opts.batchName.trim()}`);
  if (opts.jobId?.trim()) lines.push(`任务：${opts.jobId.trim().slice(0, 8)}…`);
  if (opts.elapsedSec != null && Number.isFinite(opts.elapsedSec) && opts.elapsedSec >= 0) {
    lines.push(`耗时：${formatEtaSec(opts.elapsedSec)}`);
  }
  if (opts.bytesTotal != null && opts.bytesTotal > 0) {
    lines.push(`总大小：${formatBytesHuman(opts.bytesTotal)}`);
  }
  if (opts.avgSpeedBps != null && opts.avgSpeedBps > 0) {
    lines.push(`平均速度：${formatSpeedLabel(opts.avgSpeedBps)}`);
  }
  if (opts.detail?.trim()) lines.push(opts.detail.trim());
  return lines.join('\n');
}

/** 阶段跳过（未入队任务） */
export function buildPipelineSkipNotifyText(opts: {
  title: string;
  batchName?: string;
  detail?: string;
} & PipelineNotifyStepOpts): string {
  const step = formatPipelineStepPrefix(opts.stepIndex, opts.stepTotal);
  const lines = [`【BOM】${step}${opts.title} · 跳过`];
  if (opts.batchName?.trim()) lines.push(`版本：${opts.batchName.trim()}`);
  if (opts.detail?.trim()) lines.push(opts.detail.trim());
  return lines.join('\n');
}

export function buildPipelineDoneNotifyText(opts: {
  batchName: string;
  rowCount: number;
  doExt: boolean;
  doFeishu: boolean;
  versionSheetUrl?: string | null;
} & PipelineNotifyStepOpts): string {
  const step = formatPipelineStepPrefix(opts.stepIndex, opts.stepTotal);
  const stages = ['本地'];
  if (opts.doExt) stages.push('Artifactory-ext');
  if (opts.doFeishu) stages.push('飞书');
  const lines = [
    `【BOM】${step}同步流水线完成`,
    `版本：${opts.batchName}`,
    `行数：${opts.rowCount}`,
    `阶段：${stages.join(' → ')}`,
  ];
  if (opts.versionSheetUrl?.trim()) {
    lines.push(`软件包清单：${opts.versionSheetUrl.trim()}`);
  }
  return lines.join('\n');
}
