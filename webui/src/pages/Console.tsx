/**
 * 发送台：直接调 API 发消息，用于接入调试。
 *
 * 支持文本与 CQ 码两种输入；CQ 码会被后端按原样传给协议端。
 */

import { CheckCircle, PaperPlaneRight, XCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { Badge, Button, Card, Field, StatusDot } from '../components/ui';
import { api } from '../lib/api';
import { useQuery } from '../lib/useQuery';

export function ConsolePage() {
  const botsQuery = useQuery(() => api.bots());
  const bots = botsQuery.data?.bots ?? [];

  const [target, setTarget] = useState<'group' | 'private'>('group');
  const [id, setId] = useState('');
  const [message, setMessage] = useState('');
  const [selfId, setSelfId] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<
    { ok: true; data: unknown } | { ok: false; message: string } | null
  >(null);

  const canSend = id.trim() !== '' && message.trim() !== '' && !sending;

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setResult(null);
    try {
      const response = await api.send({
        target,
        id: id.trim(),
        message: message.trim(),
        ...(selfId ? { selfId: selfId } : {}),
      });
      setResult({ ok: true, data: response.data });
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex flex-col gap-5">
        <Card title="发送消息">
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="发送到" htmlFor="send-target">
                <div
                  className="flex items-center gap-0.5 rounded-[6px] border p-0.5"
                  style={{ borderColor: 'var(--color-line)', background: 'var(--color-canvas)' }}
                >
                  {(
                    [
                      ['group', '群聊'],
                      ['private', '私聊'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      id={value === 'group' ? 'send-target' : undefined}
                      type="button"
                      onClick={() => setTarget(value)}
                      aria-pressed={target === value}
                      className="flex-1 rounded-[4px] py-1 text-[13px] font-medium transition-colors"
                      style={{
                        background: target === value ? 'var(--color-surface)' : 'transparent',
                        color: target === value ? 'var(--color-ink)' : 'var(--color-ink-faint)',
                        border:
                          target === value
                            ? '1px solid var(--color-line)'
                            : '1px solid transparent',
                        cursor: 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={target === 'group' ? '群号' : '用户号'} htmlFor="send-id">
                <input
                  id="send-id"
                  className="field tnum"
                  inputMode="numeric"
                  placeholder={target === 'group' ? '例如 123456789' : '例如 10001'}
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                />
              </Field>
            </div>

            <Field
              label="消息内容"
              hint="支持 CQ 码，例如 你好[CQ:at,qq=123] ;图片[CQ:image,file=cat.jpg]"
              htmlFor="send-message"
            >
              <textarea
                id="send-message"
                className="field"
                rows={4}
                placeholder="输入要发送的内容"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>

            {bots.length > 1 ? (
              <Field label="使用账号" hint="留空则使用第一个在线账号" htmlFor="send-self">
                <select
                  id="send-self"
                  className="field"
                  value={selfId}
                  onChange={(e) => setSelfId(e.target.value)}
                >
                  <option value="">自动选择</option>
                  {bots.map((bot) => (
                    <option key={bot.selfId} value={bot.selfId}>
                      {bot.nickname ?? '未命名'}（{bot.selfId}）
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                icon={<PaperPlaneRight size={14} />}
                loading={sending}
                disabled={!canSend}
                onClick={handleSend}
              >
                发送
              </Button>
              {!canSend && !sending ? (
                <span className="text-[12px]" style={{ color: 'var(--color-ink-faint)' }}>
                  填写目标与内容后可发送
                </span>
              ) : null}
            </div>

            {result ? (
              <div
                className="flex items-start gap-2 rounded-[6px] border px-3 py-2"
                style={{
                  background: result.ok ? 'var(--color-ok-soft)' : 'var(--color-danger-soft)',
                  borderColor: result.ok ? 'var(--color-ok-line)' : 'var(--color-danger-line)',
                }}
              >
                {result.ok ? (
                  <CheckCircle size={15} style={{ color: 'var(--color-ok)', flex: 'none' }} />
                ) : (
                  <XCircle size={15} style={{ color: 'var(--color-danger)', flex: 'none' }} />
                )}
                <div className="min-w-0">
                  <p className="text-[12px] font-medium">{result.ok ? '发送成功' : '发送失败'}</p>
                  <p
                    className="mono-block mt-0.5 break-all text-[11px]"
                    style={{ color: 'var(--color-ink-soft)' }}
                  >
                    {result.ok ? JSON.stringify(result.data) : result.message}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <Card title="可用账号">
        {bots.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--color-ink-soft)' }}>
            没有在线账号，无法发送消息。先到「连接」页确认协议端已接入。
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {bots.map((bot) => (
              <li key={bot.selfId} className="flex items-center gap-2">
                <StatusDot tone={bot.online ? 'ok' : 'muted'} />
                <span className="truncate text-[13px]">{bot.nickname ?? '未命名'}</span>
                <span
                  className="tnum ml-auto text-[11px]"
                  style={{ color: 'var(--color-ink-faint)' }}
                >
                  {bot.selfId}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex items-center gap-2">
          <Badge tone={bots.length > 0 ? 'ok' : 'warn'}>
            {bots.length > 0 ? '可发送' : '不可发送'}
          </Badge>
        </div>
      </Card>
    </div>
  );
}
