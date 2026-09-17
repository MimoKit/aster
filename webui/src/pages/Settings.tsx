/**
 * 配置页。
 *
 * 表单由后端返回的 schema 驱动，分区展示；
 * 保存时只提交改动过的字段，避免整份配置读写冲突。
 */

import { useEffect, useMemo, useState } from 'react';
import { FloppyDisk, WarningCircle } from '@phosphor-icons/react';

import { api } from '../lib/api';
import type { ConfigField } from '../lib/types';
import { useQuery } from '../lib/useQuery';
import { Badge, Button, Card, ErrorState, Field, Skeleton, Switch } from '../components/ui';

type ConfigDoc = Record<string, unknown>;

export function SettingsPage() {
  const configQuery = useQuery(() => api.config(), []);
  const schemaQuery = useQuery(() => api.configSchema(), []);

  const [draft, setDraft] = useState<ConfigDoc | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // 首次加载后拷贝一份草稿
  useEffect(() => {
    if (configQuery.data && draft === null) {
      setDraft(structuredClone(configQuery.data.config));
    }
  }, [configQuery.data, draft]);

  const original = configQuery.data?.config;

  const grouped = useMemo(() => {
    const fields = schemaQuery.data?.fields ?? [];
    const map = new Map<string, ConfigField[]>();
    for (const field of fields) {
      const list = map.get(field.group) ?? [];
      list.push(field);
      map.set(field.group, list);
    }
    return [...map.entries()];
  }, [schemaQuery.data]);

  if (configQuery.loading || schemaQuery.loading) return <SettingsSkeleton />;
  if (configQuery.error || schemaQuery.error) {
    const message = configQuery.error ?? schemaQuery.error ?? '未知错误';
    return (
      <Card>
        <ErrorState
          message={message}
          onRetry={() => {
            configQuery.reload();
            schemaQuery.reload();
          }}
        />
      </Card>
    );
  }
  if (!draft || !original) return null;

  const readValue = (key: string): unknown => {
    const parts = key.split('.');
    let cursor: unknown = draft;
    for (const part of parts) {
      if (typeof cursor !== 'object' || cursor === null) return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
  };

  const writeValue = (key: string, value: unknown) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      const parts = key.split('.');
      let cursor: Record<string, unknown> = next;
      for (const part of parts.slice(0, -1)) {
        if (typeof cursor[part] !== 'object' || cursor[part] === null) {
          cursor[part] = {};
        }
        cursor = cursor[part] as Record<string, unknown>;
      }
      cursor[parts[parts.length - 1]!] = value;
      return next;
    });
    setDirty((prev) => new Set(prev).add(key));
    setSaved(false);
  };

  const handleSave = async () => {
    if (dirty.size === 0) return;
    setSaving(true);
    setSaveError(null);

    const values: Record<string, unknown> = {};
    for (const key of dirty) values[key] = readValue(key);

    try {
      await api.patchConfig(values);
      setDirty(new Set());
      setSaved(true);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDraft(structuredClone(original));
    setDirty(new Set());
    setSaveError(null);
    setSaved(false);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 保存条：有改动才出现，不常驻占位 */}
      {dirty.size > 0 || saveError || saved ? (
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            {saveError ? (
              <>
                <WarningCircle size={16} style={{ color: 'var(--color-danger)' }} />
                <span className="text-[13px]" style={{ color: 'var(--color-danger)' }}>
                  {saveError}
                </span>
              </>
            ) : saved ? (
              <span className="text-[13px]" style={{ color: 'var(--color-ok)' }}>
                配置已保存，重启后生效
              </span>
            ) : (
              <span className="text-[13px]">
                有 <strong className="tnum">{dirty.size}</strong> 项未保存的修改
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" onClick={handleReset} disabled={saving}>
                放弃修改
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<FloppyDisk size={13} />}
                loading={saving}
                disabled={dirty.size === 0}
                onClick={handleSave}
              >
                保存
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {grouped.map(([group, fields]) => (
        <Card key={group} title={group}>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <ConfigInput
                key={field.key}
                field={field}
                value={readValue(field.key)}
                changed={dirty.has(field.key)}
                onChange={(value) => writeValue(field.key, value)}
              />
            ))}
          </div>
        </Card>
      ))}

      <Card>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span style={{ color: 'var(--color-ink-soft)' }}>配置文件</span>
          <code className="mono-block">{configQuery.data?.path}</code>
          <Badge tone="warn">修改后需重启</Badge>
        </div>
      </Card>
    </div>
  );
}

/** 单个配置项输入 */
function ConfigInput({
  field,
  value,
  changed,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  changed: boolean;
  onChange: (value: unknown) => void;
}) {
  const id = `cfg-${field.key.replace(/\./g, '-')}`;

  // 布尔用开关：标签与控件同一行
  if (field.type === 'boolean') {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-[6px] px-2 py-1.5"
        style={{ background: changed ? 'var(--color-accent-soft)' : 'transparent' }}
      >
        <div className="min-w-0">
          <label className="label mb-0" htmlFor={id}>
            {field.label}
          </label>
          <p className="mono-block text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
            {field.key}
          </p>
        </div>
        <Switch
          checked={Boolean(value)}
          onChange={onChange}
          label={field.label}
        />
      </div>
    );
  }

  if (field.type === 'enum') {
    return (
      <Field label={field.label} hint={field.hint} htmlFor={id}>
        <select
          id={id}
          className="field"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          style={changed ? { borderColor: 'var(--color-accent)' } : undefined}
        >
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (field.type === 'string[]') {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Field
        label={field.label}
        hint={field.hint ?? '多个值用英文逗号分隔'}
        htmlFor={id}
      >
        <input
          id={id}
          className="field"
          value={list.join(', ')}
          placeholder="留空表示不限制"
          onChange={(e) =>
            onChange(
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          style={changed ? { borderColor: 'var(--color-accent)' } : undefined}
        />
      </Field>
    );
  }

  const inputType =
    field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text';

  return (
    <Field
      label={field.label}
      hint={field.hint ?? field.key}
      htmlFor={id}
    >
      <input
        id={id}
        className="field tnum"
        type={inputType}
        value={value === undefined || value === null ? '' : String(value)}
        autoComplete="off"
        onChange={(e) => {
          const raw = e.target.value;
          onChange(field.type === 'number' ? (raw === '' ? 0 : Number(raw)) : raw);
        }}
        style={changed ? { borderColor: 'var(--color-accent)' } : undefined}
      />
    </Field>
  );
}

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 3 }).map((_, groupIndex) => (
        <Card key={groupIndex} title="加载中">
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((__, fieldIndex) => (
              <div key={fieldIndex} className="flex flex-col gap-2">
                <Skeleton width="35%" height={11} />
                <Skeleton height={32} radius={6} />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
