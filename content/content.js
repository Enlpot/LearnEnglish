/**
 * 网页学英语 - 内容替换引擎
 * 扫描网页中文文本，按词库/等级/比例把部分中文词替换为英文，悬停显示浮层（中文+发音+生词本）。
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
    tooltip: true,      // 悬停显示浮层（中文原词 + 发音 + 生词本按钮）
    online: false,      // 在线翻译兜底
    baiduAppId: '',     // 百度翻译 APPID
    baiduKey: '',       // 百度翻译密钥
    customDict: '',     // 自定义词表（每行 中文=English）
    blacklist: '',      // 网站黑名单（每行一个域名）
    deferUntilVisible: true // 后台标签页暂不替换，切到前台才替换（省资源）
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
  let started = false;   // 是否已执行替换流程（幂等保护）
  let visBound = false;  // visibilitychange 只绑定一次

  // 首尾虚词（在线候选过滤）
  const EDGE_FUNCTION = new Set(
    '的了着过吗呢吧啊呀哦唉嗯哈哟嘛呗罢么呐哩咯哇啵啦诶呵这那哪谁何怎都是很更最太不没无有是从对向把被让给跟比为于由以及才只就还又再也个些几多少各每某上中下前里外间内请能会要可应须别勿莫未非之其所而但且或与及并'
  );
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'CANVAS', 'TITLE',
    'META', 'LINK', 'OBJECT', 'EMBED', 'IFRAME', 'HEAD', 'TEMPLATE'
  ]);

  // 替换词样式（content.css 内容，注入 Shadow DOM 用——页面级 CSS 不作用于 shadow 内部）
  const LE_CSS = '.le-word{border-bottom:1px dashed #e8a33d;cursor:pointer;padding:0 1px;border-radius:2px;position:relative}.le-word:hover{background-color:rgba(232,163,61,.14)}.le-word.le-saved{border-bottom:1px solid #2e9e5b}.le-word .le-toast{position:absolute;left:0;bottom:100%;margin-bottom:2px;background:#2e9e5b;color:#fff;font-size:11px;font-style:normal;line-height:1.4;padding:2px 6px;border-radius:3px;white-space:nowrap;z-index:2147483647;pointer-events:none}';

  // 递归收集所有 Shadow Root（含嵌套），用于注入样式/观察/收集词
  function collectShadowRoots(root, out) {
    if (!root || !root.querySelectorAll) return out;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        out.push(el.shadowRoot);
        collectShadowRoots(el.shadowRoot, out);
      }
    }
    return out;
  }

  // 递归收集所有 .le-word（含 Shadow DOM 内部），用于还原/统计
  function collectLeWords(root, out) {
    if (!root || !root.querySelectorAll) return out;
    out.push(...root.querySelectorAll('.le-word'));
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) collectLeWords(el.shadowRoot, out);
    }
    return out;
  }

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
      if (n.classList && n.classList.contains('le-tip')) return true; // 插件自身浮层，永不替换
    }
    return false;
  }

  // 文本 TreeWalker（Edge 不支持 openShadowRoots 选项：new TreeWalker 是 Illegal constructor，
  // document.createTreeWalker 不接受 options —— 因此对每个 open shadow root 单独遍历）
  function createTextWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
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
  }

  function processRoot(root) {
    if (!root) return;
    // Shadow DOM 支持：收集 root 下所有 open shadow root（含嵌套），逐个遍历
    const shadows = [];
    collectShadowRoots(root, shadows);
    const walkers = [createTextWalker(root)];
    for (const sr of shadows) walkers.push(createTextWalker(sr));
    const nodes = [];
    for (const w of walkers) {
      while (w.nextNode()) nodes.push(w.currentNode);
    }
    for (const node of nodes) processTextNode(node);
    // 向 Shadow Root 注入替换词样式（页面级 CSS 不影响 shadow 内部）
    for (const sr of shadows) {
      if (!sr._leStyled) {
        sr._leStyled = true;
        try {
          const st = document.createElement('style');
          st.textContent = LE_CSS;
          sr.appendChild(st);
        } catch (e) { /* 忽略 */ }
      }
    }
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
        span.dataset.zh = part.zh; // 始终记录中文原文（还原/换一批/浮层显示时使用，不依赖 tooltip 开关）
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
            if (node.closest && node.closest('.le-tip')) continue; // 插件自身浮层，永不处理
            pendingNodes.push(node);
          } else if (node.nodeType === 3) {
            if (node.parentNode && node.parentNode.closest && node.parentNode.closest('.le-tip')) continue;
            pendingNodes.push(node);
          }
        }
      }
      if (pendingNodes.length) scheduleProcess();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // 观察已有 Shadow Root（动态内容在 shadow 内部时也能触发处理）
    const roots = collectShadowRoots(document.documentElement, []);
    for (const sr of roots) {
      if (!sr._leObserved) {
        sr._leObserved = true;
        try { observer.observe(sr, { childList: true, subtree: true }); } catch (e) { /* 忽略 */ }
      }
    }
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

    // 开关开启且当前标签页在后台时：暂不替换，切到前台才执行（省资源）
    if (settings.deferUntilVisible && document.visibilityState === 'hidden') {
      if (!visBound) {
        visBound = true;
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') start();
        });
      }
      return;
    }
    start();
  }

  async function start() {
    if (started) return;
    started = true;

    // 随机种子：同页每次刷新/换一批时替换结果不同（学习时曝光更多词）；页面生命周期内保持不变
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

  // ============ 换一批词（不刷新页面） ============
  function reroll() {
    if (!started) { start(); return; }
    hideTip(); // 词即将被还原，隐藏浮层
    // 1. 还原已替换词为中文（用 dataset.zh，不依赖 tooltip；含 Shadow DOM）
    const spans = collectLeWords(document, []);
    for (const sp of spans) {
      const zh = sp.dataset.zh || '';
      if (!zh) continue;
      const txt = document.createTextNode(zh);
      sp.parentNode.replaceChild(txt, sp);
    }
    // 2. 生成新随机种子（同一页面，不重新加载）
    ratioSeed = location.hostname + ':' + Date.now() + ':' + Math.random();
    // 3. 按新种子重新替换
    processRoot(document.body);
  }

  // 消息：popup「换一批词」按钮
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'le-reroll') {
      reroll();
      sendResponse({ ok: true });
    }
  });

  // 测试钩子（isolated world，页面主世界无法访问；供 CDP 实测用）
  globalThis.__leTest = {
    reroll,
    count: () => collectLeWords(document, []).length,
    started: () => started,
    visibility: () => document.visibilityState
  };

  // ============ 悬停浮层（中文 + 发音 + 生词本） ============
  // 不采用点击/双击：替换词在超链接内时点击会与链接跳转冲突，改为悬停浮层按钮操作
  // 从事件路径找 .le-word（兼容 Shadow DOM：shadow 内事件 target 会被重定向为宿主）
  function findLeWord(ev) {
    const path = ev.composedPath ? ev.composedPath() : null;
    if (path) {
      for (const el of path) {
        if (el && el.nodeType === 1 && el.classList && el.classList.contains('le-word')) return el;
      }
      return null;
    }
    return ev.target && ev.target.closest ? ev.target.closest('.le-word') : null;
  }

  let tipEl = null;
  let tipSpan = null; // 当前浮层对应的 .le-word
  let tipHideTimer = null; // 延迟隐藏（鼠标移向浮层期间给缓冲，避免浮层一碰就消失）

  function hideTipSoon() {
    if (tipHideTimer) return;
    tipHideTimer = setTimeout(() => {
      tipHideTimer = null;
      hideTip();
    }, 220);
  }

  function cancelHideTip() {
    if (tipHideTimer) {
      clearTimeout(tipHideTimer);
      tipHideTimer = null;
    }
  }

  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'le-tip';
    tipEl.style.display = 'none';
    tipEl.innerHTML =
      '<span class="le-tip-zh"></span>' +
      '<button type="button" class="le-tip-btn le-tip-speak">发音</button>' +
      '<button type="button" class="le-tip-btn le-tip-save">＋生词本</button>';
    tipEl.querySelector('.le-tip-speak').addEventListener('click', (e) => {
      e.stopPropagation();
      if (tipSpan) speakWord(tipSpan.textContent);
    });
    tipEl.querySelector('.le-tip-save').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!tipSpan) return;
      const zh = tipSpan.dataset.zh || '';
      const en = tipSpan.textContent;
      addToVocab(zh, en).then((ok) => {
        tipSpan.classList.add('le-saved');
        const btn = tipEl.querySelector('.le-tip-save');
        btn.textContent = ok ? '✓已加' : '已在';
        btn.classList.add('le-tip-done');
        setTimeout(() => {
          if (tipSpan && tipEl && tipEl.parentNode) {
            btn.textContent = '＋生词本';
            btn.classList.remove('le-tip-done');
          }
        }, 900);
      });
    });
    document.documentElement.appendChild(tipEl);
    return tipEl;
  }

  function showTip(span, ev) {
    if (!settings.tooltip) return; // 开关「悬停显示原词」控制浮层显示
    const tip = ensureTip();
    tipSpan = span;
    const zh = span.dataset.zh || '';
    const en = span.textContent;
    tip.querySelector('.le-tip-zh').textContent = zh ? (zh + '：' + en) : en;
    const saveBtn = tip.querySelector('.le-tip-save');
    if (!span.classList.contains('le-saved')) {
      saveBtn.textContent = '＋生词本';
      saveBtn.classList.remove('le-tip-done');
    }
    // 定位：紧贴词上方居中（放不下则紧贴下方）——不留间隙，鼠标可平滑移入浮层
    const rect = span.getBoundingClientRect();
    if (!rect.width && !rect.height) { hideTip(); return; }
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    let top = rect.top - th - 1;
    if (top < 4) top = rect.bottom + 1;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip() {
    if (tipEl) tipEl.style.display = 'none';
    tipSpan = null;
  }

  function bindInteractions() {
    // mouseover：进入/移过词或浮层时，取消延迟隐藏并显示/更新浮层
    document.addEventListener('mouseover', (ev) => {
      const span = findLeWord(ev);
      if (span) {
        cancelHideTip();
        showTip(span, ev);
        return;
      }
      // 鼠标进入浮层本身（去点按钮）时取消隐藏
      if (tipEl && tipEl.contains(ev.target)) cancelHideTip();
    }, true);
    // mouseout：离开词或浮层时延迟隐藏（移入浮层/相邻词不隐藏；给 220ms 缓冲供鼠标跨过间隙）
    document.addEventListener('mouseout', (ev) => {
      const to = ev.relatedTarget;
      if (to && to.nodeType === 1) {
        if (tipEl && tipEl.contains(to)) return;
        if (to.classList && to.classList.contains('le-word')) return;
      }
      if (tipSpan && tipSpan.contains(ev.target)) hideTipSoon();
      else if (tipEl && tipEl.contains(ev.target)) hideTipSoon(); // 离开浮层内部任意元素（含按钮）都延迟隐藏
    }, true);
    // 滚动/窗口变化：定位失效，立即隐藏
    document.addEventListener('scroll', () => { cancelHideTip(); hideTip(); }, true);
    window.addEventListener('resize', () => { cancelHideTip(); hideTip(); });
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
