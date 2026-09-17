/**
 * 通用 UI 原子组件。
 *
 * 保持一致的可交互词汇：同一套按钮形状、同一套表单控件、同一套图标风格。
 */

import type { ReactNode } from 'react';
import { WarningCircle, ArrowsClockwise } from '@phosphor-icons/react';

/* ─────────────────────────── 状态点 ─────────────────────────── */

export function StatusDot({ tone = 'muted' }: { tone?: 'ok' | 'warn' | 'danger' | 'muted' }) {
  const color = {
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
    muted: 'var(--color-ink-faint)',
  }[tone];

  return (
    <span
      className="dot"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}

/* ─────────────────────────── 徽标 ─────────────────────────── */

export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'danger' | 'accent';
}) {
  const cls =
    tone === 'default' ? 'badge' : `badge badge-${tone}`;
  return <span className={cls}>{children}</span>;
}

/* ─────────────────────────── 按钮 ─────────────────────────── */

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger';
  size?: 'md' | 'sm';
  /** 加载中：禁用并显示指示，不改变按钮宽度 */
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  icon,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  const variantCls =
    variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : '';
  const sizeCls = size === 'sm' ? 'btn-sm' : '';

  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`btn ${variantCls} ${sizeCls} ${className}`.trim()}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

/** 内联加载指示，尺寸随字号 */
export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ animation: 'spin 700ms linear infinite', flex: 'none' }}
    >
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ─────────────────────────── 空 / 错 / 载 ─────────────────────────── */

/** 空状态：说明如何填充，而不是只说"暂无数据" */
export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon ? <div style={{ color: 'var(--color-ink-faint)' }}>{icon}</div> : null}
      <p className="text-[13px] font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-[12px]" style={{ color: 'var(--color-ink-faint)' }}>
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** 错误状态：说明问题与恢复方式 */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <WarningCircle size={22} style={{ color: 'var(--color-danger)' }} />
      <div>
        <p className="text-[13px] font-medium">加载失败</p>
        <p className="mt-1 max-w-md text-[12px]" style={{ color: 'var(--color-ink-soft)' }}>
          {message}
        </p>
      </div>
      {onRetry ? (
        <Button size="sm" icon={<ArrowsClockwise size={13} />} onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

/** 骨架块 */
export function Skeleton({
  width = '100%',
  height = 14,
  radius = 4,
}: {
  width?: string | number;
  height?: number;
  radius?: number;
}) {
  return <div className="skeleton" style={{ width, height, borderRadius: radius }} />;
}

/** 表格骨架：形状与最终表格一致 */
export function TableSkeleton({ rows = 4, cols = 3 }: { rows?: number; cols?: number }) {
  return (
    <div className="p-4">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-4 py-2.5">
          {Array.from({ length: cols }).map((__, colIndex) => (
            <Skeleton
              key={colIndex}
              width={colIndex === 0 ? '28%' : `${Math.floor(60 / cols)}%`}
              height={12}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────── 表单字段 ─────────────────────────── */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="error-text">{error}</p>
      ) : hint ? (
        <p className="hint">{hint}</p>
      ) : null}
    </div>
  );
}

/** 布尔开关 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-[20px] w-[34px] flex-none items-center rounded-full transition-colors"
      style={{
        background: checked ? 'var(--color-accent)' : 'var(--color-line-strong)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transitionDuration: '160ms',
      }}
    >
      <span
        className="block h-[14px] w-[14px] rounded-full bg-white transition-transform"
        style={{
          transform: checked ? 'translateX(17px)' : 'translateX(3px)',
          transitionDuration: '160ms',
          boxShadow: '0 1px 2px rgb(24 24 27 / 0.2)',
        }}
      />
    </button>
  );
}

/* ─────────────────────────── 卡片 ─────────────────────────── */

export function Card({
  title,
  actions,
  children,
  noPadding = false,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  noPadding?: boolean;
}) {
  return (
    <section className="card">
      {title ? (
        <header className="card-head">
          <h2 className="card-title">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={noPadding ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

/* ─────────────────────────── 指标 ─────────────────────────── */

/**
 * 单个指标。
 *
 * 刻意不做"大数字 + 小标签 + 装饰色"的仪表盘模板：
 * 数字与标签同一视觉层级，靠字重和等宽数字区分。
 */
export function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px]" style={{ color: 'var(--color-ink-soft)' }}>
        {label}
      </span>
      <span className="tnum text-[20px] font-semibold leading-none">{value}</span>
      {hint ? (
        <span className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
