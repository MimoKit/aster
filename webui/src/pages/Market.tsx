/**
 * 插件市场：浏览组织下发布的插件。
 *
 * 清单来自插件市场仓库的 `index.json`（纯静态文件，无后端）。
 * 当前插件在编译期加载，因此这里的操作是「复制安装命令」，
 * 而不是假的开关按钮。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowSquareOut,
  Copy,
  MagnifyingGlass,
  Storefront,
} from '@phosphor-icons/react';

import { copyText } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorState, Skeleton } from '../components/ui';

/** 市场清单地址，可用 VITE_ASTER_MARKET 覆盖 */
const MARKET_URL =
  (import.meta.env.VITE_ASTER_MARKET as string | undefined) ??
  'https://raw.githubusercontent.com/xlinxt/aster-plugins/main/index.json';

/** 清单条目 */
interface MarketPlugin {
  name: string;
  repo: string;
  desc: string;
  author: string;
  tags?: string[];
  version?: string;
}

interface MarketIndex {
  version: number;
  updated?: string;
  plugins: MarketPlugin[];
}

export function MarketPage() {
  const [state, setState] = useState<{
    data: MarketIndex | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [keyword, setKeyword] = useState('');
  const [tag, setTag] = useState<string | null>(null);

  // 首次进入时加载清单
  useEffect(() => {
    let alive = true;
    fetch(MARKET_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<MarketIndex>;
      })
      .then((data) => {
        if (alive) setState({ data, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (alive) setState({ data: null, loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, []);

  const plugins = state.data?.plugins ?? [];

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const plugin of plugins) for (const item of plugin.tags ?? []) set.add(item);
    return [...set].sort();
  }, [plugins]);

  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return plugins.filter((plugin) => {
      if (tag && !(plugin.tags ?? []).includes(tag)) return false;
      if (!text) return true;
      return (
        plugin.name.toLowerCase().includes(text) ||
        plugin.desc.toLowerCase().includes(text) ||
        plugin.author.toLowerCase().includes(text)
      );
    });
  }, [plugins, keyword, tag]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--color-ink-faint)' }}
            />
            <input
              className="field"
              style={{ paddingLeft: 28 }}
              placeholder="搜索插件名称、描述或作者"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>

          {tags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <TagChip active={tag === null} onClick={() => setTag(null)}>
                全部
              </TagChip>
              {tags.map((item) => (
                <TagChip key={item} active={tag === item} onClick={() => setTag(item)}>
                  {item}
                </TagChip>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <span style={{ color: 'var(--color-ink-soft)' }}>
            共 {plugins.length} 个插件
            {filtered.length !== plugins.length ? `，筛选出 ${filtered.length} 个` : ''}
          </span>
          {state.data?.updated ? (
            <span className="ml-auto" style={{ color: 'var(--color-ink-faint)' }}>
              清单更新于 {state.data.updated}
            </span>
          ) : null}
        </div>
      </Card>

      {state.loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <Skeleton width="40%" height={14} />
              <div className="mt-3">
                <Skeleton height={12} />
              </div>
              <div className="mt-2">
                <Skeleton width="70%" height={12} />
              </div>
            </Card>
          ))}
        </div>
      ) : state.error ? (
        <Card>
          <ErrorState
            message={`无法加载插件清单：${state.error}。请检查网络，或确认市场仓库已发布 index.json。`}
            onRetry={() => window.location.reload()}
          />
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <Empty
            icon={<Storefront size={22} />}
            title={plugins.length === 0 ? '市场还没有插件' : '没有匹配的插件'}
            description={
              plugins.length === 0
                ? '插件市场仓库尚未发布任何插件。'
                : '换个关键词或清除标签筛选试试。'
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filtered.map((plugin) => (
            <PluginCard key={plugin.name} plugin={plugin} />
          ))}
        </div>
      )}
    </div>
  );
}

function PluginCard({ plugin }: { plugin: MarketPlugin }) {
  const [copied, setCopied] = useState(false);
  const installCommand = `git clone ${plugin.repo} plugins/${plugin.name}`;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold">{plugin.name}</h3>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-faint)' }}>
            {plugin.author}
          </p>
        </div>
        {plugin.version ? <Badge>v{plugin.version}</Badge> : null}
      </div>

      <p className="mt-2.5 text-[13px]" style={{ color: 'var(--color-ink-soft)' }}>
        {plugin.desc}
      </p>

      {plugin.tags?.length ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {plugin.tags.map((item) => (
            <Badge key={item}>{item}</Badge>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <Button
          size="sm"
          icon={<Copy size={13} />}
          onClick={async () => {
            if (await copyText(installCommand)) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            }
          }}
        >
          {copied ? '已复制' : '复制安装命令'}
        </Button>
        <a
          className="btn btn-sm no-underline"
          href={plugin.repo.replace(/\.git$/, '')}
          target="_blank"
          rel="noreferrer"
        >
          <ArrowSquareOut size={13} />
          仓库
        </a>
      </div>

      <code
        className="mono-block mt-3 block truncate rounded-[6px] border px-2 py-1.5 text-[11px]"
        style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-line)' }}
        title={installCommand}
      >
        {installCommand}
      </code>
    </Card>
  );
}

function TagChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="rounded-[4px] border px-2 py-[3px] text-[11px] transition-colors"
      style={{
        background: active ? 'var(--color-accent-soft)' : 'transparent',
        borderColor: active ? 'var(--color-accent-line)' : 'var(--color-line)',
        color: active ? 'var(--color-accent)' : 'var(--color-ink-soft)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
