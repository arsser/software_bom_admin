import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, ArrowUpDown, ArrowUp, ArrowDown, AlertCircle, CheckCircle, XCircle, Clock } from 'lucide-react';
import { usePingStore, PingLog, PingLogsSort } from '../stores/pingStore';
import { MultiSelect, MultiSelectOption } from './MultiSelect';

// 格式化时间
const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
};

export const PingLogs: React.FC = () => {
  // Filter States
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState({ start: '', end: '' });

  // Sort State
  const [sortConfig, setSortConfig] = useState<PingLogsSort | null>(null);

  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Data State
  const [logs, setLogs] = useState<PingLog[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const { targets, fetchTargets, fetchLogs } = usePingStore();

  // 获取域名列表
  useEffect(() => {
    fetchTargets();
  }, [fetchTargets]);

  // 构建筛选条件
  const filters = useMemo(() => {
    const f: any = {};
    if (selectedDomains.length > 0) {
      f.domains = selectedDomains;
    }
    if (selectedStatus.length === 1) {
      f.success = selectedStatus[0] === 'success';
    }
    if (dateRange.start) {
      f.dateStart = dateRange.start;
    }
    if (dateRange.end) {
      f.dateEnd = dateRange.end;
    }
    return f;
  }, [selectedDomains, selectedStatus, dateRange]);

  // 获取日志数据
  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchLogs({
        filters,
        sort: sortConfig,
        pagination: { page: currentPage, pageSize }
      });
      setLogs(result.logs);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch (err: any) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [fetchLogs, filters, sortConfig, currentPage, pageSize]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // 筛选变化时重置到第一页
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedDomains, selectedStatus, dateRange.start, dateRange.end]);

  // 排序请求处理
  const requestSort = (key: PingLogsSort['key']) => {
    let direction: 'asc' | 'desc' = 'desc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'desc') {
      direction = 'asc';
    }
    setSortConfig({ key, direction });
    setCurrentPage(1);
  };

  // 排序图标组件
  const SortIcon: React.FC<{ columnKey: PingLogsSort['key'] }> = ({ columnKey }) => {
    if (!sortConfig || sortConfig.key !== columnKey) {
      return <ArrowUpDown size={12} className="ml-1 inline-block opacity-30" />;
    }
    return sortConfig.direction === 'asc' ? (
      <ArrowUp size={12} className="ml-1 inline-block text-blue-600" />
    ) : (
      <ArrowDown size={12} className="ml-1 inline-block text-blue-600" />
    );
  };

  // 计算当前页起始索引
  const startIndex = (currentPage - 1) * pageSize;

  // 准备多选选项数据
  const domainOptions: MultiSelectOption[] = useMemo(() => {
    const uniqueDomains = Array.from(new Set(targets.map(t => t.domain)));
    return uniqueDomains.map(domain => ({
      value: domain,
      label: targets.find(t => t.domain === domain)?.label || domain
    }));
  }, [targets]);

  const statusOptions: MultiSelectOption[] = useMemo(() => [
    { value: 'success', label: '成功' },
    { value: 'failure', label: '失败' }
  ], []);

  return (
    <div className="h-[calc(100vh-2rem)] flex flex-col space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">监测日志</h2>
          <p className="text-slate-500">查看域名监测的历史记录</p>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <p className="text-red-700 font-medium">加载失败</p>
            <p className="text-red-600 text-sm mt-1">{error.message}</p>
          </div>
          <button
            onClick={loadLogs}
            className="px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded-md text-sm font-medium transition-colors"
          >
            重试
          </button>
        </div>
      )}

      {/* Filters Bar */}
      <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="flex flex-col">
          <label className="text-xs text-slate-500 mb-1">域名 (多选)</label>
          <MultiSelect
            options={domainOptions}
            value={selectedDomains}
            onChange={setSelectedDomains}
            placeholder="选择域名..."
            searchable={true}
            maxHeight="400px"
          />
        </div>

        <div className="flex flex-col">
          <label className="text-xs text-slate-500 mb-1">状态 (多选)</label>
          <MultiSelect
            options={statusOptions}
            value={selectedStatus}
            onChange={setSelectedStatus}
            placeholder="选择状态..."
            searchable={false}
            maxHeight="200px"
            widthOffset={0}
          />
        </div>

        <div className="col-span-2 flex flex-col">
          <label className="text-xs text-slate-500 mb-1">时间范围</label>
          <div className="flex gap-2 items-center">
            <input
              type="date"
              value={dateRange.start}
              onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
              className="w-[150px] px-2 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
            <span className="text-slate-400 text-sm">-</span>
            <input
              type="date"
              value={dateRange.end}
              onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
              className="w-[150px] px-2 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* 数据表格 */}
      <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col relative">
        {/* Loading 遮罩 */}
        {loading && logs.length > 0 && (
          <div className="absolute inset-0 bg-white/60 backdrop-blur-sm z-20 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
              <p className="text-sm text-slate-600">加载中...</p>
            </div>
          </div>
        )}

        <div className="overflow-auto flex-1 p-0">
          {loading && logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <div className="w-8 h-8 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin mb-4"></div>
              <p>正在加载日志...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <AlertCircle size={48} className="mb-4 opacity-20" />
              <p>加载失败，请查看上方错误信息</p>
            </div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <Search size={48} className="mb-4 opacity-20" />
              <p>未找到匹配的日志记录</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse min-w-[700px] table-fixed">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-16">#</th>
                  <th
                    className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 cursor-pointer hover:bg-gray-100 w-64"
                    onClick={() => requestSort('domain')}
                  >
                    域名 <SortIcon columnKey="domain" />
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 w-24">状态</th>
                  <th
                    className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 cursor-pointer hover:bg-gray-100 w-28"
                    onClick={() => requestSort('status_code')}
                  >
                    状态码 <SortIcon columnKey="status_code" />
                  </th>
                  <th
                    className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 cursor-pointer hover:bg-gray-100 w-28"
                    onClick={() => requestSort('latency_ms')}
                  >
                    延迟 <SortIcon columnKey="latency_ms" />
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100">错误信息</th>
                  <th
                    className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider border-b border-gray-100 cursor-pointer hover:bg-gray-100 w-44"
                    onClick={() => requestSort('checked_at')}
                  >
                    检测时间 <SortIcon columnKey="checked_at" />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log, index) => (
                  <tr key={log.id} className="hover:bg-blue-50/30 transition-colors">
                    <td className="px-4 py-3 text-xs text-slate-400 font-mono">
                      {startIndex + index + 1}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-slate-700">
                      <div className="truncate" title={log.domain}>
                        {log.domain}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {log.success ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                          <CheckCircle size={12} />
                          成功
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                          <XCircle size={12} />
                          失败
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {log.statusCode !== null ? (
                        <span className={`font-mono ${log.statusCode >= 200 && log.statusCode < 300 ? 'text-green-600' : log.statusCode >= 400 ? 'text-red-600' : 'text-slate-600'}`}>
                          {log.statusCode}
                        </span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {log.latencyMs !== null ? (
                        <span className={`font-mono ${log.latencyMs < 500 ? 'text-green-600' : log.latencyMs < 1500 ? 'text-yellow-600' : 'text-red-600'}`}>
                          {log.latencyMs}ms
                        </span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-red-600">
                      <div className="truncate" title={log.error || ''}>
                        {log.error || '-'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Clock size={12} className="text-slate-400" />
                        {formatTime(log.checkedAt)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination Controls */}
        <div className="flex items-center justify-between p-4 border-t border-gray-100 bg-gray-50">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">每页行数:</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="bg-white border border-gray-200 text-slate-700 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-1.5"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
            </select>
            <span className="text-sm text-slate-500">
              共 {total} 条
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-500">
              第 {currentPage} 页 / 共 {Math.max(1, totalPages)} 页
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-3 py-1 border border-gray-200 rounded-md bg-white text-slate-600 disabled:opacity-50 hover:bg-gray-50 text-sm"
              >
                上一页
              </button>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages || totalPages === 0}
                className="px-3 py-1 border border-gray-200 rounded-md bg-white text-slate-600 disabled:opacity-50 hover:bg-gray-50 text-sm"
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
