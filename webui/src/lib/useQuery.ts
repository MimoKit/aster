/**
 * 数据获取 hook。
 *
 * 一个极简的「加载 / 成功 / 失败 + 手动重载」状态机，
 * 不引入数据请求库——本项目的接口数量不需要它。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface QueryResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 鉴权失败时为 true，界面据此提示输入令牌 */
  unauthorized: boolean;
  reload: () => void;
}

/**
 * 拉取数据。
 *
 * @param fetcher 取数函数；引用变化不会触发重新请求，用 deps 控制
 * @param deps    依赖项，变化时重新拉取
 */
export function useQuery<T>(fetcher: () => Promise<T>, deps: unknown[] = []): QueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  // 组件卸载后不再 setState
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      if (!alive.current) return;
      setData(result);
      setUnauthorized(false);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.isUnauthorized) {
        setUnauthorized(true);
      }
      setError((err as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, unauthorized, reload: run };
}

/**
 * 定时轮询。
 *
 * 页面不可见时暂停，避免后台标签页白白消耗资源。
 */
export function useQueryPolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): QueryResult<T> {
  const result = useQuery(fetcher, deps);

  const runRef = useRef(result.reload);
  runRef.current = result.reload;

  useEffect(() => {
    if (intervalMs <= 0) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void runRef.current();
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [intervalMs]);

  return result;
}
