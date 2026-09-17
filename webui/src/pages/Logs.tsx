/**
 * 日志页：历史回看 + 实时跟踪。
 *
 * 实时流默认暂停自动滚动，用户手动滚到底部才恢复——避免正在读日志时被拽走。
 */

import { ArrowDown, Pause, Play, Trash } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, ErrorState, Skeleton } from '../components/ui';
import { api, subscribe } from '../lib/api';
import { formatClock, LOG_LEVELS, levelTone } from '../lib/format';
import type { LogEntry } from '../lib/types';
import { useQuery } from '../lib/useQuery';

const MAX_ROWS = 2000;
/** 日志骨架屏的稳定 key */
const LOG_SKELETON_ROWS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'];

export function LogsPage() {
  const [level, setLevel] = useState<string>('all');
  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState<LogEntry[]>([]);
  const [atBottom, setAtBottom] = useState(true);

  const { data, loading, error, reload } = useQuery(
    () => api.logs({ limit: 500, level: level === 'all' ? undefined : level }),
    level,
  );

  const scroller = useRef<HTMLDivElement>(null);

  // 合并历史与实时：以 seq 去重，保持有序
  const rows = useMemo(() => {
    const merged = new Map<number, LogEntry>();
    for (const entry of data?.logs ?? []) merged.set(entry.seq, entry);
    for (const entry of live) merged.set(entry.seq, entry);
    const list = [...merged.values()].sort((a, b) => a.seq - b.seq);
    return list.slice(-MAX_ROWS);
  }, [data, live]);

  // 订阅实时日志
  useEffect(() => {
    if (!follow) return;
    return subscribe('/logs/stream', 'log', (raw) => {
      const entry = raw as LogEntry;
      setLive((prev) => [...prev, entry].slice(-MAX_ROWS));
    });
  }, [follow]);

  // 贴近底部时自动滚动（scroller 是 ref，引用稳定，无需进依赖）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上
  useEffect(() => {
    const el = scroller.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, atBottom]);

  // 切换级别时清空实时缓冲，避免混入其他级别
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 level 变化时重置
  useEffect(() => {
    setLive([]);
  }, [level]);

  const visible = useMemo(
    () => (level === 'all' ? rows : rows.filter((entry) => entry.level.toLowerCase() === level)),
    [rows, level],
  );

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 24);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {/* 级别筛选 */}
          <fieldset
            className="flex items-center gap-0.5 rounded-[6px] border p-0.5"
            style={{ borderColor: 'var(--color-line)', background: 'var(--color-canvas)' }}
            aria-label="日志级别"
          >
            <LevelChip active={level === 'all'} onClick={() => setLevel('all')}>
              全部
            </LevelChip>
            {LOG_LEVELS.map((item) => (
              <LevelChip key={item} active={level === item} onClick={() => setLevel(item)}>
                {item}
              </LevelChip>
            ))}
          </fieldset>

          <span className="text-[12px]" style={{ color: 'var(--color-ink-faint)' }}>
            {visible.length} 条
          </span>

          <div className="ml-auto flex items-center gap-2">
            {!atBottom ? (
              <Button
                size="sm"
                icon={<ArrowDown size={13} />}
                onClick={() => {
                  setAtBottom(true);
                  const el = scroller.current;
                  if (el) el.scrollTop = el.scrollHeight;
                }}
              >
                回到底部
              </Button>
            ) : null}

            <Button
              size="sm"
              variant={follow ? 'primary' : 'default'}
              icon={follow ? <Pause size={13} /> : <Play size={13} />}
              onClick={() => setFollow((v) => !v)}
            >
              {follow ? '暂停实时' : '开始实时'}
            </Button>

            <Button
              size="sm"
              icon={<Trash size={13} />}
              onClick={() => {
                setLive([]);
                reload();
              }}
            >
              清空
            </Button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <Badge tone={follow ? 'ok' : 'default'}>{follow ? '实时接收中' : '实时已暂停'}</Badge>
          {!atBottom ? (
            <span style={{ color: 'var(--color-ink-soft)' }}>已向上滚动，自动跟随已暂停</span>
          ) : null}
        </div>
      </Card>

      <Card noPadding>
        {loading && !data ? (
          <div className="p-4">
            {LOG_SKELETON_ROWS.map((key, index) => (
              <div key={key} className="py-1.5">
                <Skeleton width={`${45 + ((index * 13) % 45)}%`} height={12} />
              </div>
            ))}
          </div>
        ) : error && !data ? (
          <ErrorState message={error} onRetry={reload} />
        ) : visible.length === 0 ? (
          <p
            className="px-4 py-12 text-center text-[12px]"
            style={{ color: 'var(--color-ink-faint)' }}
          >
            没有符合条件的日志。
            {level !== 'all' ? '试试切换到「全部」级别。' : '有新日志时会实时出现在这里。'}
          </p>
        ) : (
          <div
            ref={scroller}
            onScroll={onScroll}
            className="overflow-auto"
            style={{ maxHeight: 'calc(100dvh - 280px)' }}
          >
            <table className="table">
              <tbody>
                {visible.map((entry) => (
                  <LogRow key={entry.seq} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const tone = levelTone(entry.level);
  const color =
    tone === 'danger'
      ? 'var(--color-danger)'
      : tone === 'warn'
        ? 'var(--color-warn)'
        : 'var(--color-ink-faint)';

  return (
    <tr>
      <td
        className="mono-block tnum"
        style={{ width: 104, color: 'var(--color-ink-faint)', whiteSpace: 'nowrap' }}
      >
        {formatClock(entry.timestamp)}
      </td>
      <td style={{ width: 62 }}>
        <span className="mono-block font-medium uppercase" style={{ color, fontSize: 11 }}>
          {entry.level}
        </span>
      </td>
      <td
        className="mono-block"
        style={{ width: 190, color: 'var(--color-ink-soft)', fontSize: 11 }}
      >
        {entry.target}
      </td>
      <td className="mono-block" style={{ wordBreak: 'break-word' }}>
        {entry.message}
      </td>
    </tr>
  );
}

function LevelChip({
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
      className="mono-block rounded-[4px] px-2 py-[3px] transition-colors"
      style={{
        background: active ? 'var(--color-surface)' : 'transparent',
        color: active ? 'var(--color-ink)' : 'var(--color-ink-faint)',
        border: active ? '1px solid var(--color-line)' : '1px solid transparent',
        boxShadow: active ? 'var(--shadow-card)' : 'none',
        cursor: 'pointer',
        fontSize: 11,
      }}
    >
      {children}
    </button>
  );
}
