/**
 * 事件归一化测试。
 *
 * 重点是字段类型差异的容忍度：协议端可能下发数字或字符串 ID、
 * 可能缺字段、可能用非标准键名。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { asBoolean, asId, asNumber, asString, eventName, normalizeEvent } from './event.ts';

describe('宽松取值', () => {
  test('asString 接受多种类型', () => {
    assert.equal(asString('a'), 'a');
    assert.equal(asString(42), '42');
    assert.equal(asString(true), 'true');
    assert.equal(asString(null), null);
    assert.equal(asString(undefined), null);
    assert.equal(asString({}), null);
    assert.equal(asString(Number.NaN), null);
  });

  test('asId 归一数字与字符串', () => {
    assert.equal(asId(123), '123');
    assert.equal(asId('123'), '123');
    assert.equal(asId(' 123 '), '123');
    assert.equal(asId('g1-c1'), 'g1-c1');
    assert.equal(asId(''), null);
    assert.equal(asId(null), null);
  });

  test('asNumber 解析数字字符串', () => {
    assert.equal(asNumber(42), 42);
    assert.equal(asNumber('42'), 42);
    assert.equal(asNumber('abc'), null);
  });

  test('asBoolean 识别常见写法', () => {
    assert.equal(asBoolean(true), true);
    assert.equal(asBoolean(1), true);
    assert.equal(asBoolean(0), false);
    assert.equal(asBoolean('true'), true);
    assert.equal(asBoolean('false'), false);
    assert.equal(asBoolean('maybe'), null);
  });
});

describe('消息事件', () => {
  test('群消息字段', () => {
    const event = normalizeEvent({
      time: 1700000000,
      self_id: 10001,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1234,
      user_id: 20002,
      group_id: 30003,
      raw_message: '你好[CQ:at,qq=10001]',
      message: '你好[CQ:at,qq=10001]',
      sender: { user_id: 20002, nickname: '小明', card: '群名片', role: 'member' },
    });

    assert.equal(event.type, 'message');
    if (event.type !== 'message') return;

    assert.equal(event.isGroup, true);
    assert.equal(event.isPrivate, false);
    assert.equal(event.groupId, '30003');
    assert.equal(event.userId, '20002');
    assert.equal(event.selfId, '10001');
    assert.equal(event.sessionId, '30003');
    assert.equal(event.displayName, '群名片', '优先群名片');
    assert.equal(event.isAtSelf, true);
    assert.equal(event.text, '你好@10001');
    assert.equal(event.rawMessage, '你好[CQ:at,qq=10001]');
    assert.equal(event.sender.role, 'member');
  });

  test('私聊消息没有群号', () => {
    const event = normalizeEvent({
      time: 1,
      self_id: 1,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 1,
      user_id: 2,
      message: 'hi',
      sender: { user_id: 2, nickname: '小明' },
    });

    if (event.type !== 'message') throw new Error('应为消息事件');
    assert.equal(event.isPrivate, true);
    assert.equal(event.groupId, null);
    assert.equal(event.sessionId, '2');
    assert.equal(event.displayName, '小明');
  });

  test('字符串 ID 被归一', () => {
    const event = normalizeEvent({
      time: 1,
      self_id: '10001',
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: '555',
      user_id: '20002',
      message: 'hi',
      sender: { nickname: '小明' },
    });

    if (event.type !== 'message') throw new Error('应为消息事件');
    assert.equal(event.selfId, '10001');
    assert.equal(event.messageId, '555');
    assert.equal(event.userId, '20002');
  });

  test('缺失 raw_message 时自动推导', () => {
    const event = normalizeEvent({
      time: 1,
      self_id: 1,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1,
      user_id: 2,
      group_id: 3,
      message: '看这个[CQ:image,file=a.jpg]',
    });

    if (event.type !== 'message') throw new Error('应为消息事件');
    assert.equal(event.rawMessage, '看这个[CQ:image,file=a.jpg]');
    assert.equal(event.hasImage, true);
  });

  test('数组形态的 message', () => {
    const event = normalizeEvent({
      time: 1,
      self_id: 1,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1,
      user_id: 2,
      group_id: 3,
      message: [
        { type: 'text', data: { text: 'hi' } },
        { type: 'image', data: { file: 'x.jpg' } },
      ],
    });

    if (event.type !== 'message') throw new Error('应为消息事件');
    assert.equal(event.segments.length, 2);
    assert.equal(event.hasImage, true);
    assert.equal(event.isPlainText, false);
  });

  test('message_sent 被标记', () => {
    const event = normalizeEvent({
      time: 1,
      self_id: 1,
      post_type: 'message_sent',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1,
      user_id: 1,
      target_id: 3,
      message: '我发的',
      sender: { user_id: 1 },
    });

    if (event.type !== 'message') throw new Error('应为消息事件');
    assert.equal(event.messageSent, true);
    assert.equal(event.postType, 'message_sent');
  });

  test('频道场景用 guild-channel 拼会话 ID', () => {
    const event = normalizeEvent({
      time: 1,
      self_id: 1,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1,
      user_id: 2,
      guild_id: 'g1',
      channel_id: 'c1',
      message: 'hi',
    });

    if (event.type !== 'message') throw new Error('应为消息事件');
    assert.equal(event.groupId, 'g1-c1');
  });

  test('缺失 sender 不崩', () => {
    const event = normalizeEvent({
      time: 1,
      self_id: 1,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 1,
      user_id: 2,
      message: 'hi',
    });

    if (event.type !== 'message') throw new Error('应为消息事件');
    assert.deepEqual(event.sender, {});
    assert.equal(event.displayName, '2', '回落到账号');
  });

  test('匿名消息信息被保留', () => {
    const event = normalizeEvent({
      time: 1,
      self_id: 1,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'anonymous',
      message_id: 1,
      user_id: 2,
      group_id: 3,
      message: 'hi',
      anonymous: { id: 9, name: '匿名', flag: 'f' },
    });

    if (event.type !== 'message') throw new Error('应为消息事件');
    assert.equal(event.anonymous?.name, '匿名');
  });
});

describe('通知事件', () => {
  test('群撤回', () => {
    const event = normalizeEvent({
      time: 2,
      self_id: 1,
      post_type: 'notice',
      notice_type: 'group_recall',
      group_id: 3,
      user_id: 2,
      operator_id: 4,
      message_id: 99,
    });

    if (event.type !== 'notice') throw new Error('应为通知事件');
    assert.equal(event.noticeType, 'group_recall');
    assert.equal(event.groupId, '3');
    assert.equal(event.operatorId, '4');
    assert.equal(event.messageId, '99');
  });

  test('戳一戳带 target_id', () => {
    const event = normalizeEvent({
      time: 3,
      self_id: 1,
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      group_id: 3,
      user_id: 2,
      target_id: 1,
    });

    if (event.type !== 'notice') throw new Error('应为通知事件');
    assert.equal(event.subType, 'poke');
    assert.equal(event.targetId, '1');
  });

  test('禁言带时长', () => {
    const event = normalizeEvent({
      time: 3,
      self_id: 1,
      post_type: 'notice',
      notice_type: 'group_ban',
      sub_type: 'ban',
      group_id: 3,
      user_id: 2,
      duration: 600,
    });

    if (event.type !== 'notice') throw new Error('应为通知事件');
    assert.equal(event.duration, 600);
  });
});

describe('请求与元事件', () => {
  test('加群请求', () => {
    const event = normalizeEvent({
      time: 4,
      self_id: 1,
      post_type: 'request',
      request_type: 'group',
      sub_type: 'invite',
      group_id: 3,
      user_id: 2,
      comment: '来玩',
      flag: 'abc',
    });

    if (event.type !== 'request') throw new Error('应为请求事件');
    assert.equal(event.requestType, 'group');
    assert.equal(event.subType, 'invite');
    assert.equal(event.flag, 'abc');
    assert.equal(event.comment, '来玩');
  });

  test('生命周期', () => {
    const event = normalizeEvent({
      time: 5,
      self_id: 1,
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
    });

    if (event.type !== 'meta') throw new Error('应为元事件');
    assert.equal(event.isConnect, true);
    assert.equal(event.isHeartbeat, false);
  });

  test('心跳', () => {
    const event = normalizeEvent({
      time: 5,
      self_id: 1,
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      interval: 5000,
      status: { online: true },
    });

    if (event.type !== 'meta') throw new Error('应为元事件');
    assert.equal(event.isHeartbeat, true);
    assert.equal(event.raw.interval, 5000);
  });
});

describe('未识别事件', () => {
  test('保留 post_type 与原始数据', () => {
    const event = normalizeEvent({ post_type: 'future_thing', x: 1 });
    assert.equal(event.type, 'unknown');
    if (event.type !== 'unknown') return;
    assert.equal(event.postType, 'future_thing');
    assert.equal(event.raw.x, 1);
  });

  test('非对象输入不崩', () => {
    assert.equal(normalizeEvent('nonsense').type, 'unknown');
    assert.equal(normalizeEvent(null).type, 'unknown');
    assert.equal(normalizeEvent(42).type, 'unknown');
  });
});

describe('事件路由名', () => {
  test('消息事件', () => {
    const event = normalizeEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      time: 1,
      self_id: 1,
      message_id: 1,
      user_id: 2,
      group_id: 3,
      message: 'hi',
    });
    assert.equal(eventName(event), 'message.group.normal');
  });

  test('通知事件拆出前缀与后缀', () => {
    const event = normalizeEvent({
      post_type: 'notice',
      notice_type: 'group_recall',
      time: 1,
      self_id: 1,
    });
    assert.equal(eventName(event), 'notice.group.recall');
  });

  test('notify 用 sub_type 作后缀', () => {
    const event = normalizeEvent({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      time: 1,
      self_id: 1,
    });
    assert.equal(eventName(event), 'notice.notify.poke');
  });

  test('请求事件', () => {
    const event = normalizeEvent({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'invite',
      time: 1,
      self_id: 1,
    });
    assert.equal(eventName(event), 'request.group.invite');
  });

  test('元事件', () => {
    const event = normalizeEvent({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
      time: 1,
      self_id: 1,
    });
    assert.equal(eventName(event), 'meta_event.lifecycle.connect');
  });

  test('未识别事件', () => {
    assert.equal(eventName(normalizeEvent({ post_type: 'x' })), 'unknown.x');
  });
});
