/**
 * 匹配核心单元测试（node tools/test-matcher.js）
 * 验证：词库加载、等级过滤、比例筛选、最长匹配、自定义词覆盖、功能词排除。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

eval(fs.readFileSync(path.join(ROOT, 'lib', 'matcher.js'), 'utf8'));
const M = globalThis.LE_MATCHER;
eval(fs.readFileSync(path.join(ROOT, 'lib', 'dict-core.js'), 'utf8'));
const CORE = globalThis.LE_DICT_CORE;
const EXT = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'dict-ext.json'), 'utf8'));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail || ''); }
}

function replaceAll(text, opts, custom) {
  const coreIdx = M.buildCoreIndex(CORE, custom || []);
  const extIdx = M.buildExtIndex(EXT, new Map());
  const hits = M.matchText(text, coreIdx, extIdx, opts);
  const parts = M.applyHits(text, hits);
  return parts.map(p => p.type === 'word' ? `[${p.zh}->${p.en}]` : p.v).join('');
}

const base = { level: 1, ratio: 100, seed: 'example.com', extDict: true };

// ---- 1. 基础替换 ----
assert('L1词替换', replaceAll('点击搜索按钮', base) === '[点击->Click][搜索->Search][按钮->Button]');
assert('L1词替换2', replaceAll('请先登录', base) === '请先[登录->Login]');

// ---- 2. 等级过滤 ----
assert('等级过滤L1不替换L2', replaceAll('请订阅我们', { ...base, level: 1 }) === '请订阅我们');
assert('等级过滤L3替换L2', replaceAll('请订阅我们', { ...base, level: 2 }) === '请[订阅->Subscribe]我们');

// ---- 3. 比例筛选 ----
assert('比例100', replaceAll('搜索登录', { ...base, ratio: 100 }) === '[搜索->Search][登录->Login]');
assert('比例0', replaceAll('搜索登录', { ...base, ratio: 0 }) === '搜索登录');
assert('比例50确定性', replaceAll('搜索登录', { ...base, ratio: 50 }) === replaceAll('搜索登录', { ...base, ratio: 50 }));

// ---- 4. 核心词优先于扩展词 ----
assert('核心词优先-商品', replaceAll('查看商品信息', { ...base, level: 3 }) === '[查看->View][商品->Product][信息->Info]');
assert('核心词优先-价格', replaceAll('查看价格', { ...base, level: 3 }) === '[查看->View][价格->Price]');

// ---- 5. 功能词不替换（扩展词库中已过滤）----
assert('功能词串不替换', replaceAll('我们因为但是什么已经可以一个一次上面', { ...base, level: 3 }) === '我们因为但是什么已经可以一个一次上面');

// ---- 5.1 等级屏障：core L2 词被等级过滤时，子词不被 ext 拆解 ----
assert('等级屏障-隐私政策不拆解', replaceAll('隐私政策', { ...base, level: 1 }) === '隐私政策');
assert('等级屏障-高级放开', replaceAll('隐私政策', { ...base, level: 2 }) === '[隐私政策->Privacy Policy]');

// ---- 6. 最长匹配优先 ----
assert('最长匹配', replaceAll('我的购物车', base) === '[我的->My][购物车->Cart]');

// ---- 7. 自定义词 ----
const custom = [['赛博朋克', 'Cyberpunk']];
assert('自定义词', replaceAll('玩赛博朋克', base, custom) === '玩[赛博朋克->Cyberpunk]');
assert('自定义覆盖core', replaceAll('点击搜索', base, [['搜索', 'Find']]) === '[点击->Click][搜索->Find]');

// ---- 8. 在线候选收集 ----
{
  const coreIdx = M.buildCoreIndex(CORE, []);
  const extIdx = M.buildExtIndex({}, new Map());
  const collected = new Map();
  const opts = { ...base, collect: (text, i) => {
    for (let L = 2; L <= 3; L++) {
      const cand = text.slice(i, i + L);
      if (/^[\u4e00-\u9fff]{2,3}$/.test(cand)) collected.set(cand, (collected.get(cand) || 0) + 1);
    }
  }};
  M.matchText('特种兵式旅游真好玩', coreIdx, extIdx, opts);
  assert('在线候选收集非空', collected.size > 0, JSON.stringify([...collected.keys()]));
}

// ---- 9. 混合文本 ----
assert('中英混合', replaceAll('Hello 搜索 world', base) === 'Hello [搜索->Search] world');

// ---- 10. 词库规模 ----
assert('核心词库>930', Object.keys(CORE).length > 930, String(Object.keys(CORE).length));
assert('扩展词库>80000', Object.keys(EXT).length > 80000, String(Object.keys(EXT).length));

// ---- 11. 词库释义格式（学习场景要求：无 to 前缀/无括号/无分号多义串）----
{
  const extBad = Object.entries(EXT).filter(([w, en]) =>
    /^to\s/i.test(en) || /[()（）;；]/.test(en)
  );
  assert('扩展词库释义格式干净', extBad.length === 0, extBad.slice(0, 8).map(([w, en]) => `${w}=${en}`).join(' | '));

  const coreBad = Object.entries(CORE).filter(([w, v]) =>
    /^to\s/i.test(v.en) || /[()（）;；]/.test(v.en)
  );
  assert('核心词库释义格式干净', coreBad.length === 0, coreBad.slice(0, 8).map(([w, v]) => `${w}=${v.en}`).join(' | '));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
