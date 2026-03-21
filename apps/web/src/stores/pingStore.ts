import { create } from 'zustand';
import { supabase } from '../lib/supabase';

export interface PingTarget {
  id: string;
  domain: string;
  label?: string;
  enabled: boolean;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  firstCheckedAt: number | null;
  lastCheckedAt: number | null;
  createdAt: number;
}

export interface PingSettings {
  enabled: boolean;
  cronExpression: string;
  timeoutMs: number;
  maxLatencyMs: number;
  maxTargetsPerRun: number;
}

export interface PingLog {
  id: number;
  targetId: string;
  domain: string;
  success: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
  checkedAt: number;
}

export interface PingLogsFilter {
  domains?: string[];
  success?: boolean | null;
  dateStart?: string;
  dateEnd?: string;
}

export interface PingLogsSort {
  key: 'checked_at' | 'domain' | 'latency_ms' | 'status_code';
  direction: 'asc' | 'desc';
}

export interface PingLogsPagination {
  page: number;
  pageSize: number;
}

export interface PingLogsResult {
  logs: PingLog[];
  total: number;
  totalPages: number;
}

interface PingState {
  targets: PingTarget[];
  settings: PingSettings | null;
  loading: boolean;
  error: string | null;
  fetchTargets: () => Promise<void>;
  addTarget: (target: { domain: string; label?: string }) => Promise<void>;
  updateTarget: (id: string, updates: { domain?: string; label?: string; enabled?: boolean }) => Promise<void>;
  deleteTarget: (id: string) => Promise<void>;
  fetchSettings: () => Promise<void>;
  saveSettings: (settings: PingSettings) => Promise<void>;
  toggleTarget: (id: string, enabled: boolean) => Promise<void>;
  pingNow: (id: string) => Promise<{ success: boolean; status_code: number | null; latency_ms: number | null; error?: string }>;
  resetCounts: (id: string) => Promise<void>;
  fetchLogs: (options: { filters?: PingLogsFilter; sort?: PingLogsSort | null; pagination: PingLogsPagination }) => Promise<PingLogsResult>;
}

const PING_SETTINGS_KEY = 'ping_settings';

const defaultSettings: PingSettings = {
  enabled: true,
  cronExpression: '*/5 * * * *',
  timeoutMs: 5000,
  maxLatencyMs: 1500,
  maxTargetsPerRun: 50
};

export const usePingStore = create<PingState>((set, get) => ({
  targets: [],
  settings: null,
  loading: false,
  error: null,

  fetchTargets: async () => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase
        .from('ping_targets')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      const targets: PingTarget[] = (data || []).map((item: any) => ({
        id: item.id,
        domain: item.domain,
        label: item.label || '',
        enabled: item.enabled ?? true,
        successCount: item.success_count ?? 0,
        failureCount: item.failure_count ?? 0,
        totalLatencyMs: item.total_latency_ms ?? 0,
        firstCheckedAt: item.first_checked_at ? new Date(item.first_checked_at).getTime() : null,
        lastCheckedAt: item.last_checked_at ? new Date(item.last_checked_at).getTime() : null,
        createdAt: new Date(item.created_at).getTime()
      }));

      set({ targets, loading: false });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  addTarget: async ({ domain, label }) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const { error } = await supabase.from('ping_targets').insert([{
      domain: domain.trim(),
      label: label?.trim() || null,
      enabled: true,
      user_id: user.id
    }]);
    if (error) throw error;
    await get().fetchTargets();
  },

  updateTarget: async (id, updates) => {
    const payload: any = {};
    if (updates.domain !== undefined) payload.domain = updates.domain.trim();
    if (updates.label !== undefined) payload.label = updates.label?.trim() || null;
    if (updates.enabled !== undefined) payload.enabled = updates.enabled;

    const { error } = await supabase
      .from('ping_targets')
      .update(payload)
      .eq('id', id);
    if (error) throw error;
    await get().fetchTargets();
  },

  deleteTarget: async (id) => {
    const { error } = await supabase.from('ping_targets').delete().eq('id', id);
    if (error) throw error;
    set({ targets: get().targets.filter(t => t.id !== id) });
  },

  toggleTarget: async (id, enabled) => {
    await get().updateTarget(id, { enabled });
  },

  fetchSettings: async () => {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', PING_SETTINGS_KEY)
      .single();

    if (error && error.code !== 'PGRST116') {
      set({ error: error.message });
      return;
    }

    const value = data?.value || {};
    const settings: PingSettings = {
      enabled: value.enabled ?? defaultSettings.enabled,
      cronExpression: value.cronExpression ?? defaultSettings.cronExpression,
      timeoutMs: value.timeoutMs ?? defaultSettings.timeoutMs,
      maxLatencyMs: value.maxLatencyMs ?? defaultSettings.maxLatencyMs,
      maxTargetsPerRun: value.maxTargetsPerRun ?? defaultSettings.maxTargetsPerRun
    };

    set({ settings });
  },

  saveSettings: async (settings) => {
    set({ loading: true, error: null });
    try {
      const { error } = await supabase.from('system_settings').upsert({
        key: PING_SETTINGS_KEY,
        value: settings
      }, { onConflict: 'key' });
      if (error) throw error;

      const { error: cronError } = await supabase.rpc('update_ping_cron_job', {
        p_cron_expression: settings.cronExpression,
        p_enabled: settings.enabled
      });
      if (cronError) {
        console.warn('Failed to update ping cron job:', cronError.message);
      }

      set({ settings, loading: false });
    } catch (err: any) {
      set({ error: err.message, loading: false });
      throw err;
    }
  },

  pingNow: async (id) => {
    const { data, error } = await supabase.rpc('ping_domain_now', { p_target_id: id });
    if (error) throw error;
    await get().fetchTargets();
    const res = Array.isArray(data) && data[0] ? data[0] : data;
    return {
      success: Boolean(res?.success),
      status_code: res?.status_code ?? null,
      latency_ms: res?.latency_ms ?? null,
      error: res?.error
    };
  },

  resetCounts: async (id) => {
    const { error } = await supabase.rpc('reset_ping_counts', { p_target_id: id });
    if (error) throw error;
    await get().fetchTargets();
  },

  fetchLogs: async ({ filters, sort, pagination }) => {
    let query = supabase
      .from('ping_logs')
      .select('*', { count: 'exact' });

    // 应用筛选条件
    if (filters?.domains && filters.domains.length > 0) {
      query = query.in('domain', filters.domains);
    }
    if (filters?.success !== undefined && filters.success !== null) {
      query = query.eq('success', filters.success);
    }
    if (filters?.dateStart) {
      query = query.gte('checked_at', filters.dateStart);
    }
    if (filters?.dateEnd) {
      // 日期范围包含结束日期当天
      query = query.lte('checked_at', filters.dateEnd + 'T23:59:59.999Z');
    }

    // 应用排序
    if (sort) {
      query = query.order(sort.key, { ascending: sort.direction === 'asc' });
    } else {
      query = query.order('checked_at', { ascending: false });
    }

    // 应用分页
    const { page, pageSize } = pagination;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    query = query.range(from, to);

    const { data, error, count } = await query;
    if (error) throw error;

    const logs: PingLog[] = (data || []).map((item: any) => ({
      id: item.id,
      targetId: item.target_id,
      domain: item.domain,
      success: item.success,
      statusCode: item.status_code,
      latencyMs: item.latency_ms,
      error: item.error,
      checkedAt: new Date(item.checked_at).getTime()
    }));

    const total = count || 0;
    const totalPages = Math.ceil(total / pageSize);

    return { logs, total, totalPages };
  }
}));
