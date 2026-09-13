/**
 * 网页学英语 - 内容替换引擎
 * 扫描网页中文文本，按词库/等级/比例把部分中文词替换为英文，悬停显示原词。
 * 依赖：lib/matcher.js（匹配核心）、lib/dict-core.js（核心词库）。
 * 幂等设计：替换后文本为英文，不会再次命中中文词库；重复处理无副作用。
 */
(() => {
  'use strict';

  const M = globalThis.LE_MATCHER;
  if (!M) return;

  const CN_RE = /[\u4e00-\u9fff]/;

  // ============ 默认配置 ============
  const DEFAULTS = {
    enabled: true,      // 总开关
    level: 1,           // 难度等级 1=入门 2=进阶 3=高级
    ratio: 30,          // 替换比例 1-100（词级）
    extDict: true,      // 启用扩展词库(CC-CEDICT)
    tooltip: true,      // 悬停显示原词
    online: false,      // 在线翻译兜底
    baiduAppId: '',     // 百度翻译 APPID
    baiduKey: '',       // 百度翻译密钥
    customDict: '',     // 自定义词表（每行 中文=English）
    blacklist: ''       // 网站黑名单（每行一个域名）
  };

  // ============ 状态 ============
  let settings = { ...DEFAULTS };
  let coreIndex = null;
  let extIndex = null;
  let cacheMap = new Map();
  let ratioSeed = '';
  let candidates = new Map();
  let candidateTimer = null;
  let moTimer = null;
  let pendingNodes = [];
  let observer = null;

  // 首尾虚词（在线候选过滤）
  const EDGE_FUNCTION = new Set(
    '的了着过吗呢吧啊呀哦唉嗯哈哟嘛呗罢么呐哩咯哇啵啦诶呵这那哪谁何怎都是很更最太不没无有是从对向把被让给跟比为于由以及才只就还又再也个些几多少各每某上中下前里外间内请能会要可应须别勿莫未非之其所而但且或与及并'
  );
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'CANVAS', 'TITLE',
    'META', 'LINK', 'OBJECT', 'EMBED', 'IFRAME', 'HEAD', 'TEMPLATE'
  ]);

  // ============ 工具 ============
  function parseCustomDict(str) {
    const out = [];
    if (!str) return out;
    for (const line of str.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const m = t.match(/^([^=：:]{1,10})[=：:]\s*(.{1,60})$/);
      if (m) out.push([m[1].trim(), m[2].trim()]);
    }
    return out;
  }

  function isBlacklisted(host) {
    if (!settings.blacklist) return false;
    for (const line of settings.blacklist.split('\n')) {
      let e = line.trim().toLowerCase();
      if (!e) continue;
      e = e.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      if (!e) continue;
      if (e.startsWith('*.')) {
        const suf = e.slice(1);
        if (host === suf || host.endsWith(suf)) return true;
      } else if (host === e || host.endsWith('.' + e)) {
        return true;
      }
    }
    return false;
  }

  // ============ 词库 ============
  function buildIndexes() {
    coreIndex = M.buildCoreIndex(globalThis.LE_DICT_CORE, parseCustomDict(settings.customDict));
  }

  async function loadExtDict() {
    try {
      const url = chrome.runtime.getURL('lib/dict-ext.json');
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      extIndex = M.buildExtIndex(data, cacheMap);
    } catch (e) {
      // 扩展词库加载失败不影响核心词库
    }
  }

  function rebuildExtIndex() {
    // 将新缓存词并入现有索引
    for (const [w, en] of cacheMap) {
      const ch = w[0];
      if (!extIndex.has(ch)) extIndex.set(ch, []);
      const arr = extIndex.get(ch);
      if (!arr.some(x => x.w === w)) arr.push({ w, en });
    }
    for (const arr of extIndex.values()) arr.sort((a, b) => b.w.length - a.w.length);
  }

  // ============ 在线候选收集 ============
  function collectCandidate(text, i) {
    const n = text.length;
    let j = i;
    while (j < n && M.isCN(text[j])) j++;
    const run = text.slice(i, j);
    if (run.length < 2 || run.length > 12) return;
    const maxL = Math.min(4, run.length);
    for (let L = 2; L <= maxL; L++) {
      for (let s = 0; s + L <= run.length; s++) {
        const cand = run.slice(s, s + L);
        if (EDGE_FUNCTION.has(cand[0]) || EDGE_FUNCTION.has(cand[cand.length - 1])) continue;
        candidates.set(cand, (candidates.get(cand) || 0) + 1);
      }
    }
    if (candidates.size > 600) candidates.clear();
  }

  function scheduleCandidateFlush() {
    if (candidateTimer) return;
    candidateTimer = setTimeout(() => {
      candidateTimer = null;
      flushCandidates();
    }, 1200);
  }

  async function flushCandidates() {
    if (!settings.online || !settings.baiduAppId || !settings.baiduKey) return;
    const freq = [];
    for (const [w, c] of candidates) {
      if (c >= 2 && !(coreIndex.get(w[0]) || []).some(x => x.w === w)) freq.push(w);
    }
    candidates.clear();
    if (!freq.length) return;
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'le-translate', texts: freq });
    } catch (e) {
      return;
    }
    if (resp && resp.ok && Array.isArray(resp.results)) {
      let changed = false;
      for (const r of resp.results) {
        if (r && r.src && r.dst && r.dst !== r.src) {
          cacheMap.set(r.src, r.dst);
          changed = true;
        }
      }
      if (changed) {
        saveCache();
        rebuildExtIndex();
        processRoot(document.body);
      }
    }
  }

  // ============ 缓存 ============
  async function loadCache() {
    try {
      const s = await chrome.storage.local.get('cache');
      cacheMap = new Map(Object.entries(s.cache || {}));
    } catch (e) {
      cacheMap = new Map();
    }
  }

  let cacheSaveTimer = null;
  function saveCache() {
    if (cacheSaveTimer) return;
    cacheSaveTimer = setTimeout(() => {
      cacheSaveTimer = null;
      const obj = {};
      let n = 0;
      for (const [k, v] of cacheMap) {
        obj[k] = v;
        if (++n >= 20000) break;
      }
      chrome.storage.local.set({ cache: obj });
    }, 500);
  }

  // ============ DOM 处理 ============
  function shouldSkipElement(el) {
    let n = el;
    for (let i = 0; n && i < 8; i++, n = n.parentElement) {
      if (SKIP_TAGS.has(n.tagName)) return true;
      if (n.isContentEditable) return true;
    }
    return false;
  }

  function processRoot(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (shouldSkipElement(p)) return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('le-word')) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('.le-word')) return NodeFilter.FILTER_REJECT;
        if (!CN_RE.test(node.nodeValue || '')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) processTextNode(node);
  }

  function processTextNode(node) {
    const text = node.nodeValue;
    if (!text || !CN_RE.test(text)) return;
    const opts = {
      level: settings.level,
      ratio: settings.ratio,
      seed: ratioSeed,
      extDict: settings.extDict && !!extIndex,
      collect: (settings.online && settings.baiduAppId && settings.baiduKey)
        ? collectCandidate : null
    };
    const hits = M.matchText(text, coreIndex, extIndex, opts);
    if (!hits.length) return;
    const parent = node.parentNode;
    if (!parent) return;
    const parts = M.applyHits(text, hits);
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part.type === 'text') {
        frag.appendChild(document.createTextNode(part.v));
      } else {
        const span = document.createElement('span');
        span.className = 'le-word';
        if (settings.tooltip) span.title = part.zh;
        span.textContent = part.en;
        frag.appendChild(span);
      }
    }
    parent.replaceChild(frag, node);
  }

  // ============ 动态内容 ============
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node.nodeType === 1) {
            if (node.classList && node.classList.contains('le-word')) continue;
            pendingNodes.push(node);
          } else if (node.nodeType === 3) {
            pendingNodes.push(node);
          }
        }
      }
      if (pendingNodes.length) scheduleProcess();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function scheduleProcess() {
    if (moTimer) return;
    moTimer = setTimeout(() => {
      moTimer = null;
      const batch = pendingNodes;
      pendingNodes = [];
      for (const n of batch) {
        if (!n.isConnected) continue;
        if (n.nodeType === 3) processTextNode(n);
        else if (n.nodeType === 1) processRoot(n);
      }
      scheduleCandidateFlush();
    }, 200);
  }

  // ============ 设置变更 ============
  function onSettingsChanged(changes, area) {
    if (area !== 'local' || !changes.settings) return;
    location.reload();
  }

  // ============ 启动 ============
  async function init() {
    try {
      const s = await chrome.storage.local.get('settings');
      settings = { ...DEFAULTS, ...(s.settings || {}) };
    } catch (e) { /* 使用默认值 */ }
    if (!settings.enabled || isBlacklisted(location.hostname)) return;

    // 随机种子：同页每次刷新替换结果不同（学习时曝光更多词）；页面生命周期内保持不变
    ratioSeed = location.hostname + ':' + Date.now() + ':' + Math.random();
    buildIndexes();
    await loadCache();
    const finish = () => {
      processRoot(document.body);
      startObserver();
      chrome.storage.onChanged.addListener(onSettingsChanged);
    };
    if (settings.extDict) {
      await loadExtDict();
      finish();
    } else {
      extIndex = M.buildExtIndex({}, cacheMap);
      finish();
    }
    scheduleCandidateFlush();
  }

  // ============ 发音 & 生词本（事件委托） ============
  let clickTimer = null;
  function bindInteractions() {
    // 单击发音（250ms 防双击误触）
    document.addEventListener('click', (ev) => {
      const span = ev.target && ev.target.closest ? ev.target.closest('.le-word') : null;
      if (!span) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => speakWord(span.textContent), 250);
    }, true);
    // 双击收藏生词本
    document.addEventListener('dblclick', (ev) => {
      const span = ev.target && ev.target.closest ? ev.target.closest('.le-word') : null;
      if (!span) return;
      clearTimeout(clickTimer);
      const zh = span.title || '';
      const en = span.textContent;
      addToVocab(zh, en).then((ok) => {
        span.classList.add('le-saved');
        if (!span.dataset.toast) {
          span.dataset.toast = '1';
          const tip = document.createElement('i');
          tip.className = 'le-toast';
          tip.textContent = ok ? '已加入生词本' : '已在生词本';
          span.appendChild(tip);
          setTimeout(() => {
            if (tip.parentNode) tip.remove();
            span.dataset.toast = '';
          }, 1200);
        }
      });
    }, true);
  }

  function speakWord(en) {
    try {
      if (!('speechSynthesis' in window)) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(en);
      u.lang = 'en-US';
      u.rate = 0.9;
      speechSynthesis.speak(u);
    } catch (e) { /* 忽略不支持的环境 */ }
  }

  async function addToVocab(zh, en) {
    try {
      if (!zh) return false;
      const s = await chrome.storage.local.get('vocab');
      const list = Array.isArray(s.vocab) ? s.vocab : [];
      if (list.some(v => v.zh === zh)) return false;
      list.unshift({ zh, en, site: location.hostname, t: Date.now() });
      await chrome.storage.local.set({ vocab: list.slice(0, 500) });
      return true;
    } catch (e) { return false; }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // 交互事件委托不依赖词库加载，直接绑定
  bindInteractions();
})();
