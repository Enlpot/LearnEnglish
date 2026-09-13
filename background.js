/**
 * 网页学英语 - 后台 Service Worker
 * 职责：调用百度翻译开放平台 API 做在线兜底翻译（本地词库未命中的词）。
 */
'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'le-translate') {
    handleTranslate(msg.texts).then(sendResponse);
    return true; // 异步响应
  }
});

async function handleTranslate(texts) {
  if (!Array.isArray(texts) || !texts.length) return { ok: false, error: 'EMPTY' };
  const s = await chrome.storage.local.get('settings');
  const cfg = s.settings || {};
  if (!cfg.baiduAppId || !cfg.baiduKey) return { ok: false, error: 'NO_KEY' };

  const q = texts.join('\n');
  const salt = String(Date.now());
  const sign = md5(cfg.baiduAppId + q + salt + cfg.baiduKey);
  const params = new URLSearchParams({
    q, from: 'zh', to: 'en',
    appid: cfg.baiduAppId,
    salt,
    sign
  });
  try {
    const resp = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate?' + params.toString());
    if (!resp.ok) return { ok: false, error: 'HTTP_' + resp.status };
    const data = await resp.json();
    if (data.error_code && data.error_code !== '0') {
      return { ok: false, error: data.error_code, msg: data.error_msg };
    }
    const results = (data.trans_result || []).map(r => ({ src: r.src, dst: r.dst }));
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: 'NETWORK' };
  }
}

/* ============ MD5（RFC 1321 标准实现）============ */
function md5(inputString) {
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bitRotateLeft(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }
  function md5cmn(q, a, b, x, s, t) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

  const x = [];
  let a, b, c, d;
  const str = unescape(encodeURIComponent(inputString)); // 转 UTF-8 字节
  const n = str.length;

  // 统一构建字节序列：内容 + 0x80 + 补零 + 64位长度（小端）
  const bytes = [];
  for (let i = 0; i < n; i++) bytes.push(str.charCodeAt(i));
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitLenLo = n * 8;
  const bitLenHi = Math.floor(n * 8 / 0x100000000);
  bytes.push(bitLenLo & 0xff, (bitLenLo >>> 8) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 24) & 0xff);
  bytes.push(bitLenHi & 0xff, (bitLenHi >>> 8) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 24) & 0xff);
  for (let i = 0; i < bytes.length; i += 4) {
    x.push(
      bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)
    );
  }

  a = 0x67452301; b = 0xefcdab89; c = 0x98badcfe; d = 0x10325476;
  for (let kk = 0; kk < x.length; kk += 16) {
    const aa = a, bb = b, cc = c, dd = d;
    a = md5ff(a, b, c, d, x[kk + 0], 7, -680876936);
    d = md5ff(d, a, b, c, x[kk + 1], 12, -389564586);
    c = md5ff(c, d, a, b, x[kk + 2], 17, 606105819);
    b = md5ff(b, c, d, a, x[kk + 3], 22, -1044525330);
    a = md5ff(a, b, c, d, x[kk + 4], 7, -176418897);
    d = md5ff(d, a, b, c, x[kk + 5], 12, 1200080426);
    c = md5ff(c, d, a, b, x[kk + 6], 17, -1473231341);
    b = md5ff(b, c, d, a, x[kk + 7], 22, -45705983);
    a = md5ff(a, b, c, d, x[kk + 8], 7, 1770035416);
    d = md5ff(d, a, b, c, x[kk + 9], 12, -1958414417);
    c = md5ff(c, d, a, b, x[kk + 10], 17, -42063);
    b = md5ff(b, c, d, a, x[kk + 11], 22, -1990404162);
    a = md5ff(a, b, c, d, x[kk + 12], 7, 1804603682);
    d = md5ff(d, a, b, c, x[kk + 13], 12, -40341101);
    c = md5ff(c, d, a, b, x[kk + 14], 17, -1502002290);
    b = md5ff(b, c, d, a, x[kk + 15], 22, 1236535329);
    a = md5gg(a, b, c, d, x[kk + 1], 5, -165796510);
    d = md5gg(d, a, b, c, x[kk + 6], 9, -1069501632);
    c = md5gg(c, d, a, b, x[kk + 11], 14, 643717713);
    b = md5gg(b, c, d, a, x[kk + 0], 20, -373897302);
    a = md5gg(a, b, c, d, x[kk + 5], 5, -701558691);
    d = md5gg(d, a, b, c, x[kk + 10], 9, 38016083);
    c = md5gg(c, d, a, b, x[kk + 15], 14, -660478335);
    b = md5gg(b, c, d, a, x[kk + 4], 20, -405537848);
    a = md5gg(a, b, c, d, x[kk + 9], 5, 568446438);
    d = md5gg(d, a, b, c, x[kk + 14], 9, -1019803690);
    c = md5gg(c, d, a, b, x[kk + 3], 14, -187363961);
    b = md5gg(b, c, d, a, x[kk + 8], 20, 1163531501);
    a = md5gg(a, b, c, d, x[kk + 13], 5, -1444681467);
    d = md5gg(d, a, b, c, x[kk + 2], 9, -51403784);
    c = md5gg(c, d, a, b, x[kk + 7], 14, 1735328473);
    b = md5gg(b, c, d, a, x[kk + 12], 20, -1926607734);
    a = md5hh(a, b, c, d, x[kk + 5], 4, -378558);
    d = md5hh(d, a, b, c, x[kk + 8], 11, -2022574463);
    c = md5hh(c, d, a, b, x[kk + 11], 16, 1839030562);
    b = md5hh(b, c, d, a, x[kk + 14], 23, -35309556);
    a = md5hh(a, b, c, d, x[kk + 1], 4, -1530992060);
    d = md5hh(d, a, b, c, x[kk + 4], 11, 1272893353);
    c = md5hh(c, d, a, b, x[kk + 7], 16, -155497632);
    b = md5hh(b, c, d, a, x[kk + 10], 23, -1094730640);
    a = md5hh(a, b, c, d, x[kk + 13], 4, 681279174);
    d = md5hh(d, a, b, c, x[kk + 0], 11, -358537222);
    c = md5hh(c, d, a, b, x[kk + 3], 16, -722521979);
    b = md5hh(b, c, d, a, x[kk + 6], 23, 76029189);
    a = md5hh(a, b, c, d, x[kk + 9], 4, -640364487);
    d = md5hh(d, a, b, c, x[kk + 12], 11, -421815835);
    c = md5hh(c, d, a, b, x[kk + 15], 16, 530742520);
    b = md5hh(b, c, d, a, x[kk + 2], 23, -995338651);
    a = md5ii(a, b, c, d, x[kk + 0], 6, -198630844);
    d = md5ii(d, a, b, c, x[kk + 7], 10, 1126891415);
    c = md5ii(c, d, a, b, x[kk + 14], 15, -1416354905);
    b = md5ii(b, c, d, a, x[kk + 5], 21, -57434055);
    a = md5ii(a, b, c, d, x[kk + 12], 6, 1700485571);
    d = md5ii(d, a, b, c, x[kk + 3], 10, -1894986606);
    c = md5ii(c, d, a, b, x[kk + 10], 15, -1051523);
    b = md5ii(b, c, d, a, x[kk + 1], 21, -2054922799);
    a = md5ii(a, b, c, d, x[kk + 8], 6, 1873313359);
    d = md5ii(d, a, b, c, x[kk + 15], 10, -30611744);
    c = md5ii(c, d, a, b, x[kk + 6], 15, -1560198380);
    b = md5ii(b, c, d, a, x[kk + 13], 21, 1309151649);
    a = md5ii(a, b, c, d, x[kk + 4], 6, -145523070);
    d = md5ii(d, a, b, c, x[kk + 11], 10, -1120210379);
    c = md5ii(c, d, a, b, x[kk + 2], 15, 718787259);
    b = md5ii(b, c, d, a, x[kk + 9], 21, -343485551);
    a = safeAdd(a, aa); b = safeAdd(b, bb); c = safeAdd(c, cc); d = safeAdd(d, dd);
  }
  // MD5 输出为小端字节序
  const toHex = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
    .map(b => ('0' + b.toString(16)).slice(-2)).join('');
  return [a, b, c, d].map(toHex).join('');
}
