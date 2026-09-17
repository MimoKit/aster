/**
 * 应用外壳：侧边导航 + 顶栏 + 内容区。
 *
 * 布局是结构化的响应式：窄屏收起侧栏，而不是把字号缩小。
 */

import {
  ChartLineUp,
  ChatsCircle,
  GearSix,
  List,
  PlugsConnected,
  PuzzlePiece,
  Scroll,
  Storefront,
  X,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api, getToken, setToken } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { Button, StatusDot } from './ui';

interface NavEntry {
  to: string;
  label: string;
  icon: typeof ChartLineUp;
}

const NAV: NavEntry[] = [
  { to: '/', label: '总览', icon: ChartLineUp },
  { to: '/connections', label: '连接', icon: PlugsConnected },
  { to: '/plugins', label: '插件', icon: PuzzlePiece },
  { to: '/market', label: '插件市场', icon: Storefront },
  { to: '/console', label: '发送台', icon: ChatsCircle },
  { to: '/logs', label: '日志', icon: Scroll },
  { to: '/settings', label: '配置', icon: GearSix },
];

export function Shell() {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex min-h-[100dvh]">
      {/* 侧栏：桌面常驻，窄屏抽屉 */}
      <aside
        className={[
          'fixed inset-y-0 left-0 z-40 flex w-[212px] flex-none flex-col border-r',
          'transition-transform duration-200 ease-out lg:static lg:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-line)' }}
      >
        <Brand />

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-4">
          {NAV.map((entry) => (
            <NavLink
              key={entry.to}
              to={entry.to}
              end={entry.to === '/'}
              className="nav-item"
              // 点了就收起抽屉，比用 effect 监听路由更直接
              onClick={() => setNavOpen(false)}
            >
              <entry.icon size={16} weight="regular" />
              {entry.label}
            </NavLink>
          ))}
        </nav>

        <SidebarFooter />
      </aside>

      {/* 抽屉遮罩 */}
      {navOpen ? (
        <button
          type="button"
          aria-label="关闭导航"
          className="fixed inset-0 z-30 lg:hidden"
          style={{ background: 'rgb(24 24 27 / 0.28)' }}
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onToggleNav={() => setNavOpen((v) => !v)} navOpen={navOpen} />
        <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-5 sm:px-6 sm:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex h-[52px] items-center gap-2.5 px-4">
      <span
        className="grid h-6 w-6 flex-none place-items-center rounded-[6px] text-[12px] font-semibold text-white"
        style={{ background: 'var(--color-accent)' }}
        aria-hidden="true"
      >
        A
      </span>
      <span className="text-[14px] font-semibold tracking-tight">Aster</span>
      <span className="badge ml-auto">v{__APP_VERSION__}</span>
    </div>
  );
}

function SidebarFooter() {
  const { data } = useQuery(() => api.health());
  const online = Boolean(data);

  return (
    <div
      className="flex items-center gap-2 border-t px-4 py-3 text-[12px]"
      style={{ borderColor: 'var(--color-line)', color: 'var(--color-ink-soft)' }}
    >
      <StatusDot tone={online ? 'ok' : 'danger'} />
      {online ? '后端已连接' : '后端未响应'}
    </div>
  );
}

function TopBar({ onToggleNav, navOpen }: { onToggleNav: () => void; navOpen: boolean }) {
  const { pathname } = useLocation();
  const current = NAV.find((entry) =>
    entry.to === '/' ? pathname === '/' : pathname.startsWith(entry.to),
  );

  return (
    <header
      className="sticky top-0 z-20 flex h-[52px] items-center gap-3 border-b px-4 sm:px-6"
      style={{
        background: 'color-mix(in srgb, var(--color-canvas) 88%, transparent)',
        backdropFilter: 'blur(8px)',
        borderColor: 'var(--color-line)',
      }}
    >
      <button
        type="button"
        className="btn btn-sm lg:hidden"
        onClick={onToggleNav}
        aria-label={navOpen ? '关闭导航' : '打开导航'}
        aria-expanded={navOpen}
      >
        {navOpen ? <X size={15} /> : <List size={15} />}
      </button>

      <h1 className="text-[14px] font-semibold">{current?.label ?? 'Aster'}</h1>

      <div className="ml-auto">
        <TokenButton />
      </div>
    </header>
  );
}

/** 访问令牌设置：未配置时提示，配置后可清除 */
function TokenButton() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(getToken());
  const configured = Boolean(getToken());

  if (!open) {
    return (
      <Button
        size="sm"
        variant={configured ? 'default' : 'primary'}
        onClick={() => {
          setDraft(getToken());
          setOpen(true);
        }}
      >
        {configured ? '访问令牌已设置' : '设置访问令牌'}
      </Button>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setToken(draft.trim());
        setOpen(false);
        window.location.reload();
      }}
    >
      <input
        className="field"
        style={{ width: 190 }}
        type="password"
        // biome-ignore lint/a11y/noAutofocus: 用户主动点开这个浮层，焦点理所应当落在输入框
        autoFocus
        placeholder="粘贴访问令牌"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <Button size="sm" variant="primary" type="submit">
        保存
      </Button>
      <Button
        size="sm"
        type="button"
        onClick={() => {
          setToken('');
          setDraft('');
          setOpen(false);
          window.location.reload();
        }}
      >
        清除
      </Button>
    </form>
  );
}
