/**
 * 网页学英语 - 匹配核心（纯逻辑，无 DOM 依赖，可独立测试）
 * 提供：词库索引构建、中文分词匹配、比例筛选。
 */
globalThis.LE_MATCHER = (() => {
  'use strict';

  const isCN = (ch) => ch >= '\u4e00' && ch <= '\u9fff';

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  // 确定性比例：同一词在同一网站表现一致，不同网站替换词轮换
  function shouldReplace(word, ratio, seed) {
    return (hashStr(word + '|' + seed) % 100) < ratio;
  }

  // 核心词库索引（含自定义词，lv<=level 才可替换；自定义词覆盖 core 同词）
  function buildCoreIndex(dict, customEntries) {
    const idx = new Map();
    const add = (w, en, lv) => {
      const ch = w[0];
      let arr = idx.get(ch);
      if (!arr) { arr = []; idx.set(ch, arr); }
      const existing = arr.find(x => x.w === w);
      if (existing) { existing.en = en; existing.lv = lv; return; }
      arr.push({ w, en, lv });
    };
    for (const [w, v] of Object.entries(dict || {})) {
      if (v && v.en) add(w, v.en, v.lv || 1);
    }
    for (const [w, en] of customEntries || []) {
      if (w && en) add(w, en, 1);
    }
    for (const arr of idx.values()) arr.sort((a, b) => b.w.length - a.w.length);
    return idx;
  }

  // 扩展词库索引（CC-CEDICT + 在线翻译缓存）
  function buildExtIndex(extObj, cacheMap) {
    const idx = new Map();
    const add = (w, en) => {
      if (!w || !en) return;
      const ch = w[0];
      if (!idx.has(ch)) idx.set(ch, []);
      idx.get(ch).push({ w, en });
    };
    if (cacheMap) {
      for (const [w, en] of cacheMap) add(w, en);
    }
    for (const [w, en] of Object.entries(extObj || {})) add(w, en);
    for (const arr of idx.values()) arr.sort((a, b) => b.w.length - a.w.length);
    return idx;
  }

  /**
   * 匹配文本，返回命中区间 [{start, end, en}]
   * opts: { level, ratio, seed, extDict, collect(text,i) }
   * 原则：
   * 1) 每个位置找最长可用词；
   * 2) core 中收录但被等级过滤的词形成"整词屏障"，其子词（含 ext）不降级替换；
   * 3) 整词命中后无论是否替换都跳过整词，避免子词破碎替换。
   */
  function matchText(text, coreIndex, extIndex, opts) {
    const hits = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      const ch = text[i];
      if (!isCN(ch)) { i++; continue; }
      let best = null;
      let bestLen = 0;
      let barrier = 0; // core 中最长匹配词长（无论等级），用于阻挡子词拆解
      const coreCands = coreIndex.get(ch);
      if (coreCands) {
        for (const c of coreCands) {
          if (text.startsWith(c.w, i) && c.w.length > barrier) {
            barrier = c.w.length;
            if (c.lv <= opts.level && c.w.length > bestLen) {
              best = c; bestLen = c.w.length;
            }
          }
        }
      }
      if (opts.extDict && extIndex) {
        const extCands = extIndex.get(ch);
        if (extCands) {
          for (const c of extCands) {
            if (c.w.length <= barrier) continue; // core 屏障词覆盖，不降级
            if (c.w.length > bestLen && text.startsWith(c.w, i)) {
              // core 已收录该词但被等级排除时，ext 同名词也不可用
              const inCore = coreCands && coreCands.find(x => x.w === c.w);
              if (inCore && inCore.lv > opts.level) continue;
              best = c; bestLen = c.w.length;
            }
          }
        }
      }
      if (best) {
        if (shouldReplace(best.w, opts.ratio, opts.seed)) {
          hits.push({ start: i, end: i + bestLen, en: best.en });
        }
        i += bestLen; // 整词跳过，不降级匹配子词
      } else if (barrier > 0) {
        i += barrier; // 等级屏障：整词保持中文，不拆解子词
      } else {
        if (opts.collect) opts.collect(text, i);
        i++;
      }
    }
    return hits;
  }

  // 将命中应用到文本，生成 [{type:'text',v}|{type:'word',en,zh}] 片段
  function applyHits(text, hits) {
    const parts = [];
    let pos = 0;
    for (const h of hits) {
      if (h.start > pos) parts.push({ type: 'text', v: text.slice(pos, h.start) });
      parts.push({ type: 'word', en: h.en, zh: text.slice(h.start, h.end) });
      pos = h.end;
    }
    if (pos < text.length) parts.push({ type: 'text', v: text.slice(pos) });
    return parts;
  }

  return { isCN, hashStr, shouldReplace, buildCoreIndex, buildExtIndex, matchText, applyHits };
})();
