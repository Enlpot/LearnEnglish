/**
 * 网页学英语 - popup 快速开关
 */
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { enabled: true, level: 1, ratio: 30 };

async function init() {
  const s = await chrome.storage.local.get('settings');
  const cfg = { ...DEFAULTS, ...(s.settings || {}) };
  const sw = $('enabled');
  sw.checked = !!cfg.enabled;
  const levelName = { 1: '入门', 2: '进阶', 3: '高级' }[cfg.level] || '入门';
  $('state').textContent = cfg.enabled
    ? `已开启 · ${levelName} · 比例 ${cfg.ratio}%`
    : '已关闭（本页不替换）';

  // 生词本计数
  const s2 = await chrome.storage.local.get('vocab');
  const vocab = Array.isArray(s2.vocab) ? s2.vocab : [];
  if (vocab.length) {
    $('vocabCount').textContent = String(vocab.length);
    $('vocabLine').hidden = false;
  }

  sw.addEventListener('change', async () => {
    await chrome.storage.local.set({
      settings: { ...cfg, enabled: sw.checked }
    });
    // 变更会触发 content script 重载页面应用/还原
    const t = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t[0] && t[0].id != null) {
      chrome.tabs.reload(t[0].id);
    }
  });
}

$('optionsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 换一批词（不刷新页面）：通知当前标签页还原并按新随机种子重新替换
$('rerollBtn').addEventListener('click', async () => {
  const btn = $('rerollBtn');
  const reset = () => { btn.textContent = '换一批词（不刷新）'; };
  try {
    const t = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = t[0];
    if (!tab || tab.id == null) throw new Error('no-tab');
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'le-reroll' });
    if (resp && resp.ok) {
      btn.textContent = '已换一批';
    } else {
      btn.textContent = '本页不可用';
    }
  } catch (e) {
    btn.textContent = '本页不可用';
  }
  setTimeout(reset, 1200);
});

init();
