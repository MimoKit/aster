/**
 * 插件页：已加载插件与其规则。
 *
 * 当前插件在编译期加载，因此这里只做展示——
 * 启用/停用需要改配置并重新编译，界面不提供假的开关。
 */

import { PuzzlePiece } from '@phosphor-icons/react';
import { Badge, Card, Empty, ErrorState, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useQuery } from '../lib/useQuery';

export function PluginsPage() {
  const { data, loading, error, reload } = useQuery(() => api.plugins());

  if (loading && !data) return <PluginsSkeleton />;
  if (error && !data)
    return (
      <Card>
        <ErrorState message={error} onRetry={reload} />
      </Card>
    );

  const plugins = data?.plugins ?? [];

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <span className="font-medium">
            已加载 {data?.count ?? 0} 个插件、{data?.rules ?? 0} 条规则
          </span>
          <span className="ml-auto text-[12px]" style={{ color: 'var(--color-ink-soft)' }}>
            插件在编译期加载，新增插件后需重新构建
          </span>
        </div>
      </Card>

      {plugins.length === 0 ? (
        <Card>
          <Empty
            icon={<PuzzlePiece size={22} />}
            title="没有加载任何插件"
            description="检查配置中的 bot.builtin_plugins 是否为 true，或从插件市场挑选插件加入构建。"
          />
        </Card>
      ) : (
        plugins.map((plugin) => (
          <Card
            key={plugin.name}
            title={plugin.name}
            actions={
              <span className="flex items-center gap-2">
                <Badge tone={plugin.enabled ? 'ok' : 'warn'}>
                  {plugin.enabled ? '已启用' : '已停用'}
                </Badge>
                <Badge>优先级 {plugin.priority}</Badge>
              </span>
            }
            noPadding
          >
            <div className="px-4 pt-3">
              <p className="text-[13px]">{plugin.desc || '无描述'}</p>
              {plugin.author ? (
                <p className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-faint)' }}>
                  作者：{plugin.author}
                </p>
              ) : null}
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 160 }}>规则</th>
                    <th style={{ width: 220 }}>匹配</th>
                    <th style={{ width: 110 }}>权限</th>
                    <th>范围</th>
                  </tr>
                </thead>
                <tbody>
                  {plugin.rules.map((rule) => (
                    <tr key={`${plugin.name}-${rule.name}`}>
                      <td className="font-medium">{rule.name || '未命名'}</td>
                      <td>
                        <code className="mono-block">{rule.matcher}</code>
                      </td>
                      <td>{rule.permission}</td>
                      <td>{rule.scope}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

function PluginsSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <Skeleton width="30%" height={14} />
      </Card>
      {['p1', 'p2'].map((key) => (
        <Card key={key} title="加载中">
          <Skeleton width="45%" height={13} />
          <div className="mt-3">
            <Skeleton height={64} radius={6} />
          </div>
        </Card>
      ))}
    </div>
  );
}
