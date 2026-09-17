/**
 * 总览页：运行状态、事件统计、在线账号、实时事件流。
 */

import { useEffect, useRef, useState } from 'react';
import { Broadcast, Plugs, PuzzlePiece, Timer } from '@phosphor-icons/react';

import { api, subscribe } from '../lib/api';
import type { LiveEvent } from '../lib/types';
import { formatNumber } from '../lib/format';
import { useQueryPolling } from '../lib/useQuery';
import { Badge, Card, ErrorState, Metric, Skeleton, StatusDot } from '../components/ui';

export function OverviewPage() {
  const { data, loading, error, reload } = useQueryPolling(() => api.overview(), 5000, []);

  if (loading && !data) return <OverviewSkeleton />;
  if (error && !data) return <Card><ErrorState message={error} onRetry={reload} /></Card>;
  if (!data) return null;

  const { bot, stats, plugins, onebot11, bots } = data;
  const online = bots.filter((b) => b.online).length;
  const wsUrl = `ws://${onebot11.host === '0.0.0.0' ? '127.0.0.1' : onebot11.host}:${onebot11.port}${onebot11.path}`;

  return (
    <div className="flex flex-col gap-5">
      {/* 状态条：一句话说清当前状态与关键动作 */}
      <Card>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusDot tone={online > 0 ? 'ok' : 'warn'} />
          <span className="text-[13px] font-medium">
            {online > 0 ? `${online} 个账号在线` : '等待协议端连接'}
          </span>
          <span aria-hidden="true" style={{ color: 'var(--color-ink-faint)' }}>
            ·
          </span>
          <span className="text-[13px]" style={{ color: 'var(--color-ink-soft)' }}>
            已运行 {bot.uptime}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Badge tone={onebot11.enable ? 'ok' : 'warn'}>
              OneBot v11 {onebot11.enable ? '已启用' : '已停用'}
            </Badge>
            <Badge>{onebot11.auth ? '已鉴权' : '无鉴权'}</Badge>
          </span>
        </div>

        {/* 连接地址：这是接入时唯一需要复制的信息 */}
        <div
          className="mt-3 flex items-center gap-2 rounded-[6px] border px-2.5 py-2"
          style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-line)' }}
        >
          <Plugs size={14} style={{ color: 'var(--color-ink-faint)', flex: 'none' }} />
          <code className="mono-block truncate">{wsUrl}</code>
          <span className="ml-auto text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
            协议端反向连接此地址
          </span>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-5">
          {/* 事件统计 */}
          <Card title="事件统计">
            <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
              <Metric label="事件总数" value={formatNumber(stats.events)} />
              <Metric label="消息" value={formatNumber(stats.messages)} />
              <Metric label="通知" value={formatNumber(stats.notices)} />
              <Metric label="请求" value={formatNumber(stats.requests)} />
              <Metric label="元事件" value={formatNumber(stats.meta_events)} />
              <Metric label="命令命中" value={formatNumber(stats.commands)} />
            </div>
          </Card>

          <LiveEventPanel />
        </div>

        <div className="flex flex-col gap-5">
          <Card title="运行信息">
            <dl className="flex flex-col gap-3 text-[13px]">
              <Row label="版本" value={`v${bot.version}`} mono />
              <Row label="启动时间" value={bot.started_at} mono />
              <Row
                label="插件"
                value={`${plugins.count} 个 / ${plugins.rules} 条规则`}
                icon={<PuzzlePiece size={13} />}
              />
              <Row
                label="日志缓冲"
                value={`${formatNumber(data.log_count)} 条`}
                icon={<Timer size={13} />}
              />
            </dl>
          </Card>

          <Card
            title="在线账号"
            actions={
              bots.length > 0 ? (
                <span className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
                  {bots.length} 个
                </span>
              ) : null
            }
          >
            {bots.length === 0 ? (
              <p className="text-[12px]" style={{ color: 'var(--color-ink-soft)' }}>
                还没有账号连接。在协议端配置反向 WebSocket 指向上方地址即可。
              </p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {bots.map((botItem) => (
                  <li key={botItem.self_id} className="flex items-center gap-2.5">
                    <StatusDot tone={botItem.online ? 'ok' : 'muted'} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">
                        {botItem.nickname ?? '未获取昵称'}
                      </p>
                      <p
                        className="tnum truncate text-[11px]"
                        style={{ color: 'var(--color-ink-faint)' }}
                      >
                        {botItem.self_id}
                      </p>
                    </div>
                    {botItem.connections > 1 ? (
                      <Badge tone="warn">{botItem.connections} 连接</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-1.5" style={{ color: 'var(--color-ink-soft)' }}>
        {icon}
        {label}
      </dt>
      <dd className={mono ? 'mono-block tnum' : 'tnum'}>{value}</dd>
    </div>
  );
}

/** 实时事件流：只显示最近若干条，滚动不打扰用户 */
function LiveEventPanel() {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(0);

  useEffect(() => {
    const close = subscribe(
      '/events/stream',
      'event',
      (raw) => {
        // 环形保留最近 12 条
        setEvents((prev) => {
          const next = [raw as LiveEvent, ...prev];
          return next.slice(0, 12);
        });
        seen.current += 1;
      },
      () => setConnected(false),
    );
    setConnected(true);
    return close;
  }, []);

  return (
    <Card
      title="实时事件"
      actions={
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
          <Broadcast size={12} />
          {connected ? '监听中' : '未连接'}
        </span>
      }
      noPadding
    >
      {events.length === 0 ? (
        <p className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--color-ink-faint)' }}>
          暂无事件。协议端上报后这里会实时显示。
        </p>
      ) : (
        <ul>
          {events.map((event, index) => (
            <li
              key={`${event.time}-${index}`}
              className="flex items-center gap-3 border-b px-4 py-2 last:border-b-0"
              style={{ borderColor: 'var(--color-line)' }}
            >
              <span
                className="mono-block tnum flex-none text-[11px]"
                style={{ color: 'var(--color-ink-faint)' }}
              >
                {new Date(event.time * 1000).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
              <span className="mono-block truncate text-[12px]">{event.name}</span>
              <span
                className="tnum ml-auto flex-none text-[11px]"
                style={{ color: 'var(--color-ink-faint)' }}
              >
                {event.self_id ?? '-'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <Skeleton width="40%" height={14} />
        <div className="mt-3">
          <Skeleton height={32} />
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card title="事件统计">
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton width="50%" height={11} />
                <Skeleton width="35%" height={20} />
              </div>
            ))}
          </div>
        </Card>
        <Card title="运行信息">
          <div className="flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={13} />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
