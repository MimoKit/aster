/**
 * 消息规范化测试。
 *
 * 覆盖三种输入形态、CQ 码转义、往返一致性，以及各种边界情况。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  atList,
  escapeCqParam,
  escapeCqText,
  hasImage,
  isAt,
  isAtAll,
  isEmpty,
  isPlainText,
  parseCq,
  parseMessage,
  readableText,
  replyId,
  seg,
  textOnly,
  toCq,
  unescapeCq,
} from './message.ts';

describe('CQ 码转义', () => {
  test('参数值转义四类字符', () => {
    assert.equal(escapeCqParam('a&b,c[d]e'), 'a&amp;b&#44;c&#91;d&#93;e');
  });

  test('文本段不转义逗号', () => {
    assert.equal(escapeCqText('a,b'), 'a,b');
    assert.equal(escapeCqText('[x]'), '&#91;x&#93;');
    assert.equal(escapeCqText('a&b'), 'a&amp;b');
  });

  test('反转义可还原', () => {
    for (const raw of ['a&b,c[d]e', '[CQ:at,qq=1]', 'plain', '&&&,,,']) {
      assert.equal(unescapeCq(escapeCqParam(raw)), raw);
    }
  });

  test('无 & 时不做无谓替换', () => {
    assert.equal(unescapeCq('hello'), 'hello');
  });
});

describe('CQ 码解析', () => {
  test('纯文本', () => {
    const segments = parseCq('你好世界');
    assert.equal(segments.length, 1);
    assert.equal(textOnly(segments), '你好世界');
  });

  test('文本与段混合', () => {
    const segments = parseCq('你好[CQ:at,qq=123] 看这个[CQ:image,file=a.jpg]');
    assert.equal(segments.length, 4);
    assert.equal(textOnly(segments), '你好 看这个');
    assert.deepEqual(atList(segments), ['123']);
    assert.equal(hasImage(segments), true);
  });

  test('转义的中括号不当作段', () => {
    const segments = parseCq('a&#91;CQ:at,qq=1&#93;b');
    assert.equal(segments.length, 1);
    assert.equal(textOnly(segments), 'a[CQ:at,qq=1]b');
  });

  test('参数值里的转义逗号', () => {
    const segments = parseCq('[CQ:image,file=a&#44;b.jpg,url=http://x/y]');
    const image = segments[0];
    assert.equal(image?.type, 'image');
    assert.equal(image?.data.file, 'a,b.jpg');
    assert.equal(image?.data.url, 'http://x/y');
  });

  test('未闭合的 CQ 码当作文本', () => {
    const segments = parseCq('前面[CQ:at,qq=123 后面');
    assert.equal(segments.length, 1);
    assert.equal(textOnly(segments), '前面[CQ:at,qq=123 后面');
  });

  test('未知段类型被保留', () => {
    const segments = parseCq('[CQ:mystery,a=1]');
    assert.equal(segments[0]?.type, 'mystery');
    assert.equal(segments[0]?.data.a, '1');
  });

  test('空类型的 CQ 码当作文本保留', () => {
    // 与未闭合同样处理：宁可原样显示，也不要静默吞掉用户内容
    const segments = parseCq('[CQ:]');
    assert.equal(segments.length, 1);
    assert.equal(textOnly(segments), '[CQ:]');
  });

  test('无参数的段', () => {
    const segments = parseCq('[CQ:shake]');
    assert.equal(segments[0]?.type, 'shake');
    assert.deepEqual(segments[0]?.data, {});
  });
});

describe('消息解析', () => {
  test('字符串形态按 CQ 码解析', () => {
    const segments = parseMessage('hi[CQ:at,qq=1]');
    assert.equal(segments.length, 2);
  });

  test('标准数组形态', () => {
    const segments = parseMessage([
      { type: 'text', data: { text: 'hi' } },
      { type: 'at', data: { qq: 123 } },
    ]);
    assert.equal(segments.length, 2);
    assert.equal(segments[1]?.data.qq, '123', '数字 qq 应归一为字符串');
  });

  test('扁平数组形态', () => {
    const segments = parseMessage([{ type: 'at', qq: '9' }]);
    assert.equal(segments[0]?.data.qq, '9');
  });

  test('单个段对象', () => {
    const segments = parseMessage({ type: 'text', data: { text: '单段' } });
    assert.equal(segments.length, 1);
    assert.equal(textOnly(segments), '单段');
  });

  test('缺失 type 但有 text', () => {
    const segments = parseMessage({ text: 'hi' });
    assert.equal(textOnly(segments), 'hi');
  });

  test('嵌套数组被展平', () => {
    const segments = parseMessage([
      [{ type: 'text', data: { text: 'a' } }],
      { type: 'text', data: { text: 'b' } },
    ]);
    assert.equal(textOnly(segments), 'ab');
  });

  test('null / undefined 得到空数组', () => {
    assert.deepEqual(parseMessage(null), []);
    assert.deepEqual(parseMessage(undefined), []);
  });

  test('裸数字当作文本', () => {
    assert.equal(textOnly(parseMessage(42)), '42');
  });

  test('raw 段会被拆开', () => {
    const segments = parseMessage([{ type: 'raw', data: { type: 'text', data: { text: 'x' } } }]);
    assert.equal(textOnly(segments), 'x');
  });

  test('字段别名归一', () => {
    // at 段的 user_id / uin 都归到 qq
    assert.equal(parseMessage([{ type: 'at', user_id: '7' }])[0]?.data.qq, '7');
    assert.equal(parseMessage([{ type: 'at', uin: '8' }])[0]?.data.qq, '8');
    // reply 段的 message_id 归到 id
    assert.equal(parseMessage([{ type: 'reply', message_id: '9' }])[0]?.data.id, '9');
  });

  test('字符串数字字段按需转数字', () => {
    const segments = parseMessage([{ type: 'image', data: { file: 'a.jpg', size: '1024' } }]);
    assert.equal(segments[0]?.data.size, 1024);
  });
});

describe('序列化', () => {
  test('段数组转 CQ 码', () => {
    const segments = [seg.text('hi'), seg.at('1')];
    assert.equal(toCq(segments), 'hi[CQ:at,qq=1]');
  });

  test('解析与序列化往返一致', () => {
    const raw = '[CQ:at,qq=123]看[CQ:image,file=a&#44;b.jpg]';
    assert.equal(toCq(parseCq(raw)), raw);
  });

  test('两种形态归一后结果相同', () => {
    const fromString = parseMessage('[CQ:at,qq=7]走');
    const fromArray = parseMessage([
      { type: 'at', data: { qq: '7' } },
      { type: 'text', data: { text: '走' } },
    ]);
    assert.deepEqual(fromString, fromArray);
  });
});

describe('可读文本', () => {
  test('不可读段变占位符', () => {
    const segments = parseMessage('你好[CQ:at,qq=all][CQ:image,file=a.jpg]');
    assert.equal(readableText(segments), '你好@全体成员[图片]');
  });

  test('at 优先用昵称', () => {
    const segments = parseMessage([{ type: 'at', data: { qq: '1', name: '小明' } }]);
    assert.equal(readableText(segments), '@小明');
  });

  test('文件段带文件名', () => {
    const segments = parseMessage([{ type: 'file', data: { name: 'a.zip' } }]);
    assert.equal(readableText(segments), '[文件:a.zip]');
  });

  test('未知段用类型名占位', () => {
    const segments = parseMessage([{ type: 'weird' }]);
    assert.equal(readableText(segments), '[weird]');
  });
});

describe('访问器', () => {
  test('atList 收集全部 at', () => {
    const segments = parseMessage('[CQ:at,qq=1][CQ:at,qq=all][CQ:at,qq=2]');
    assert.deepEqual(atList(segments), ['1', 'all', '2']);
  });

  test('replyId 取第一条引用', () => {
    const segments = parseMessage('[CQ:reply,id=99][CQ:reply,id=100]');
    assert.equal(replyId(segments), '99');
    assert.equal(replyId(parseMessage('hi')), null);
  });

  test('isAtAll 识别多种写法', () => {
    assert.equal(isAtAll(parseMessage('[CQ:at,qq=all]')), true);
    assert.equal(isAtAll(parseMessage('[CQ:at,qq=everyone]')), true);
    assert.equal(isAtAll(parseMessage('[CQ:at,qq=1]')), false);
  });

  test('isAt 判断指定账号', () => {
    const segments = parseMessage('[CQ:at,qq=1]');
    assert.equal(isAt(segments, '1'), true);
    assert.equal(isAt(segments, '2'), false);
  });

  test('isPlainText 只认文本段', () => {
    assert.equal(isPlainText(parseMessage('hello')), true);
    assert.equal(isPlainText(parseMessage('hi[CQ:at,qq=1]')), false);
  });

  test('isEmpty', () => {
    assert.equal(isEmpty(parseMessage('')), true);
    assert.equal(isEmpty(parseMessage('x')), false);
  });

  test('textOnly 只取文本', () => {
    assert.equal(textOnly(parseMessage('a[CQ:image,file=x]b')), 'ab');
  });
});

describe('段构造器', () => {
  test('构造的段与解析结果一致', () => {
    assert.deepEqual(seg.at('1'), parseMessage('[CQ:at,qq=1]')[0]);
    assert.deepEqual(seg.text('hi'), parseMessage('hi')[0]);
  });

  test('atAll 生成 all', () => {
    assert.equal(seg.atAll().data.qq, 'all');
  });

  test('node 提供默认值', () => {
    const node = seg.node([seg.text('hi')]);
    assert.equal(node.type, 'node');
    assert.equal(node.data.nickname, '匿名消息');
    assert.ok(Array.isArray(node.data.content));
  });

  test('数字 ID 会被转成字符串', () => {
    assert.equal(seg.at(123).data.qq, '123');
    assert.equal(seg.reply(456).data.id, '456');
  });
});
