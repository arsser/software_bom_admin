import React, { useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Globe2, CheckCircle, XCircle, Clock } from 'lucide-react';
import { usePingStore } from '../stores/pingStore';

const StatCard = ({ icon: Icon, label, value, subtext, color }: any) => (
  <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex items-start justify-between">
    <div>
      <p className="text-sm font-medium text-slate-500 mb-1">{label}</p>
      <h3 className="text-2xl font-bold text-slate-800">{value}</h3>
      <div className="flex items-center gap-1 mt-2 text-xs font-medium text-slate-400">
        {subtext}
      </div>
    </div>
    <div className={`p-3 rounded-lg ${color} text-white`}>
      <Icon size={20} />
    </div>
  </div>
);

export const Dashboard: React.FC = () => {
  const { targets, fetchTargets } = usePingStore();

  useEffect(() => {
    fetchTargets();
  }, [fetchTargets]);

  // 计算统计数据
  const stats = useMemo(() => {
    const totalTargets = targets.length;
    const enabledTargets = targets.filter(t => t.enabled).length;

    let totalSuccess = 0;
    let totalFailure = 0;
    let totalLatency = 0;
    let successfulChecks = 0;

    targets.forEach(t => {
      totalSuccess += t.successCount;
      totalFailure += t.failureCount;
      if (t.successCount > 0) {
        totalLatency += t.totalLatencyMs;
        successfulChecks += t.successCount;
      }
    });

    const totalChecks = totalSuccess + totalFailure;
    const successRate = totalChecks > 0 ? Math.round((totalSuccess / totalChecks) * 100) : 0;
    const avgLatency = successfulChecks > 0 ? Math.round(totalLatency / successfulChecks) : 0;

    return {
      totalTargets,
      enabledTargets,
      successRate,
      avgLatency,
      totalChecks
    };
  }, [targets]);

  // 准备柱状图数据 - 显示各域名的成功率
  const chartData = useMemo(() => {
    return targets
      .filter(t => t.successCount + t.failureCount > 0)
      .map(t => {
        const total = t.successCount + t.failureCount;
        const rate = Math.round((t.successCount / total) * 100);
        return {
          name: t.label || t.domain.replace(/^https?:\/\//, ''),
          successRate: rate,
          domain: t.domain,
          checks: total
        };
      })
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 10)
      .map((item, index) => ({
        ...item,
        name: `${index + 1}. ${item.name}`
      }));
  }, [targets]);

  // 准备域名状态列表数据
  const statusList = useMemo(() => {
    return targets.map(t => {
      const total = t.successCount + t.failureCount;
      const rate = total > 0 ? Math.round((t.successCount / total) * 100) : null;
      const avgLat = t.successCount > 0 ? Math.round(t.totalLatencyMs / t.successCount) : null;
      return {
        ...t,
        rate,
        avgLat,
        total
      };
    });
  }, [targets]);

  const getBarColor = (rate: number) => {
    if (rate >= 95) return '#22c55e';
    if (rate >= 80) return '#eab308';
    return '#ef4444';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">仪表盘</h2>
        <p className="text-slate-500">系统概览</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <StatCard
          icon={Globe2}
          label="监测域名"
          value={stats.totalTargets}
          subtext={`${stats.enabledTargets} 个启用`}
          color="bg-blue-600"
        />
        <StatCard
          icon={CheckCircle}
          label="总成功率"
          value={`${stats.successRate}%`}
          subtext={`共 ${stats.totalChecks} 次检测`}
          color="bg-green-600"
        />
        <StatCard
          icon={Clock}
          label="平均延迟"
          value={stats.avgLatency > 0 ? `${stats.avgLatency}ms` : '-'}
          subtext="所有域名平均"
          color="bg-purple-600"
        />
        <StatCard
          icon={XCircle}
          label="异常域名"
          value={targets.filter(t => {
            const total = t.successCount + t.failureCount;
            return total > 0 && (t.successCount / total) < 0.8;
          }).length}
          subtext="成功率低于 80%"
          color="bg-red-500"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 域名成功率柱状图 */}
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-6">域名成功率</h3>
          <div className="h-[300px] w-full">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 10, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} vertical={true} stroke="#f1f5f9" />
                  <XAxis type="number" domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    width={160}
                    interval={0}
                    tick={(props: any) => {
                      const { y, payload } = props;
                      const maxLength = 18;
                      const text = payload.value || '';
                      const displayText = text.length > maxLength
                        ? `${text.substring(0, maxLength)}...`
                        : text;

                      return (
                        <g transform={`translate(0,${y})`}>
                          <title>{text}</title>
                          <text
                            x={10}
                            y={0}
                            dy={4}
                            textAnchor="start"
                            fill="#64748b"
                            fontSize={12}
                          >
                            {displayText}
                          </text>
                        </g>
                      );
                    }}
                  />
                  <Tooltip
                    formatter={(value: number) => [`${value}%`, '成功率']}
                    contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', backgroundColor: 'white', fontSize: '12px' }}
                  />
                  <Bar dataKey="successRate" radius={[0, 8, 8, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={getBarColor(entry.successRate)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-slate-400">
                暂无检测数据
              </div>
            )}
          </div>
        </div>

        {/* 域名状态列表 */}
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-4">域名状态</h3>
          <div className="overflow-auto max-h-[300px]">
            {statusList.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left text-slate-500 border-b">
                    <th className="pb-2 font-medium">域名</th>
                    <th className="pb-2 font-medium text-center">状态</th>
                    <th className="pb-2 font-medium text-right">成功率</th>
                    <th className="pb-2 font-medium text-right">延迟</th>
                  </tr>
                </thead>
                <tbody>
                  {statusList.map(t => (
                    <tr key={t.id} className="border-b border-gray-100 last:border-0">
                      <td className="py-2">
                        <div className="truncate max-w-[150px]" title={t.domain}>
                          {t.label || t.domain.replace(/^https?:\/\//, '')}
                        </div>
                      </td>
                      <td className="py-2 text-center">
                        {t.enabled ? (
                          t.rate !== null ? (
                            t.rate >= 80 ? (
                              <span className="inline-flex items-center gap-1 text-green-600">
                                <CheckCircle size={14} /> 正常
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-red-600">
                                <XCircle size={14} /> 异常
                              </span>
                            )
                          ) : (
                            <span className="text-slate-400">待检测</span>
                          )
                        ) : (
                          <span className="text-slate-400">已禁用</span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {t.rate !== null ? (
                          <span className={t.rate >= 80 ? 'text-green-600' : 'text-red-600'}>
                            {t.rate}%
                          </span>
                        ) : '-'}
                      </td>
                      <td className="py-2 text-right text-slate-600">
                        {t.avgLat !== null ? `${t.avgLat}ms` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-slate-400">
                暂无监测域名
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
