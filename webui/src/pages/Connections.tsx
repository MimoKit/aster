/**
 * 连接页：已连接账号详情与接入指引。
 */

import { Copy, Plugs } from '@phosphor-icons/react';
import { useState } from 'react';

import { api } from '../lib/api';
import { copyText, formatDuration, formatNumber } from '../lib/format';
import { useQueryPolling } from '../lib/useQuery';
import { Badge, Button, Card, Empty, ErrorState, StatusDot, TableSkeleton } from '../components/ui';

export function ConnectionsPage() {
  const { data, loading, error, reload } = useQueryPolling(() => api.bots(), 4000, []);
  const { data: overview } = useQueryPolling(() => api.overview(), 8000, []);

  if (loading && !data) return <Card noPadding><TableSkeleton rows={2} cols={4} /></Card>;
  if (error && !data) return <Card><ErrorState message={error} onRetry={reload} /></Card>;

  const bots = data?.bots ?? [];
  const onebot = overview?.onebot11;
  const wsUrl = onebot
    ? `ws://${onebot.host === '0.0.0.0' ? '127.0.0.1' : onebot.host}:${onebot.port}${onebot.path}`
    : null;

  return (
    <div className="flex flex-col gap-5">
      {wsUrl ? <EndpointCard url={wsUrl} auth={onebot?.auth ?? false} /> : null}

      <Card title="已连接账号" noPadding>
        {bots.length === 0 ? (
          <Empty
            icon={<Plugs size={22} />}
            title="还没有账号连接"
            description="在协议端把反向 WebSocket 地址配置为上方地址，连接成功后这里会显示账号。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 200 }}>账号</th>
                  <th style={{ width: 130 }}>状态</th>
                  <th style={{ width: 100 }}>连接数</th>
                  <th style={{ width: 120 }}>在线时长</th>
                </tr>
              </thead>
              <tbody>
                {bots.map((bot) => (
                  <tr key={bot.self_id}>
                    <td>
                      <div className="flex items-center gap-2.5">
                        {bot.avatar ? (
                          <img
                            src={bot.avatar}
                            alt=""
                            width={26}
                            height={26}
                            className="flex-none rounded-full"
                            style={{ border: '1px solid var(--color-line)' }}
                          />
                        ) : (
                          <span
                            className="grid h-[26px] w-[26px] flex-none place-items-center rounded-full text-[11px] font-medium"
                            style={{ background: 'var(--color-panel)', color: 'var(--color-ink-faint)' }}
                          >
                            ?
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="truncate font-medium">{bot.nickname ?? '未获取昵称'}</p>
                          <p className="tnum text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
                            {bot.uin ?? bot.self_id}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="flex items-center gap-1.5">
                        <StatusDot tone={bot.online ? 'ok' : 'muted'} />
                        {bot.online ? '在线' : '离线'}
                      </span>
                    </td>
                    <td className="tnum">{formatNumber(bot.connections)}</td>
                    <td className="tnum">{formatDuration(bot.connected_secs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** 接入地址卡片：接入流程里唯一需要复制的东西 */
function EndpointCard({ url, auth }: { url: string; auth: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <Card title="反向 WebSocket 地址">
      <div className="flex flex-wrap items-center gap-2">
        <code
          className="mono-block flex-1 rounded-[6px] border px-2.5 py-2"
          style={{
            background: 'var(--color-canvas)',
            borderColor: 'var(--color-line)',
            minWidth: 0,
          }}
        >
          {url}
        </code>
        <Button
          size="sm"
          icon={<Copy size={13} />}
          onClick={handleCopy}
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
        <Badge tone={auth ? 'ok' : 'warn'}>{auth ? '需要 Token' : '未启用鉴权'}</Badge>
        <span style={{ color: 'var(--color-ink-soft)' }}>
          {auth
            ? '适配器需在 Authorization 头或 access_token 参数中携带 Token'
            : '任何能访问该端口的程序都可连接，建议设置 access_token'}
        </span>
      </div>
    </Card>
  );
}
