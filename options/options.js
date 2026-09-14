/**
 * 网页学英语 - 设置页逻辑
 */
'use strict';

const DEFAULTS = {
  enabled: true,
  level: 1,
  ratio: 30,
  extDict: true,
  tooltip: true,
  online: false,
  baiduAppId: '',
  baiduKey: '',
  customDict: '',
  blacklist: '',
  deferUntilVisible: true
};

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get('settings');
  const cfg = { ...DEFAULTS, ...(s.settings || {}) };
  $('enabled').checked = cfg.enabled;
  const radio = document.querySelector(`input[name="level"][value="${cfg.level}"]`);
  if (radio) radio.checked = true;
  $('ratio').value = cfg.ratio;
  $('ratioVal').textContent = cfg.ratio + '%';
  $('extDict').checked = cfg.extDict;
  $('tooltip').checked = cfg.tooltip;
  $('deferUntilVisible').checked = cfg.deferUntilVisible;
  $('online').checked = cfg.online;
  $('baiduAppId').value = cfg.baiduAppId;
  $('baiduKey').value = cfg.baiduKey;
  $('customDict').value = cfg.customDict;
  $('blacklist').value = cfg.blacklist;
}

async function save() {
  const level = parseInt(document.querySelector('input[name="level"]:checked')?.value || '1', 10);
  const cfg = {
    enabled: $('enabled').checked,
    level,
    ratio: parseInt($('ratio').value, 10),
    extDict: $('extDict').checked,
    tooltip: $('tooltip').checked,
    deferUntilVisible: $('deferUntilVisible').checked,
    online: $('online').checked,
    baiduAppId: $('baiduAppId').value.trim(),
    baiduKey: $('baiduKey').value.trim(),
    customDict: $('customDict').value,
    blacklist: $('blacklist').value
  };
  await chrome.storage.local.set({ settings: cfg });
  const st = $('status');
  st.textContent = '已保存，已打开的网页立即生效（无需刷新）';
  st.className = 'status ok';
  setTimeout(() => { st.textContent = ''; st.className = 'status'; }, 3000);
}

$('ratio').addEventListener('input', () => {
  $('ratioVal').textContent = $('ratio').value + '%';
});
$('saveBtn').addEventListener('click', save);

// ============ 生词本 ============
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadVocab() {
  const s = await chrome.storage.local.get('vocab');
  const list = Array.isArray(s.vocab) ? s.vocab : [];
  $('vocabCount').textContent = list.length ? `${list.length} 词` : '';
  const box = $('vocabList');
  if (!list.length) {
    box.innerHTML = '<p class="empty">还没有收藏单词。在网页上双击替换出的英文词即可加入。</p>';
    return;
  }
  box.innerHTML = list.map(v => {
    const d = new Date(v.t || 0);
    const md = isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
    return `<div class="vocab-item">
      <span class="v-en">${escapeHtml(v.en)}</span>
      <span class="v-zh">${escapeHtml(v.zh)}</span>
      <span class="v-site">${escapeHtml(v.site || '')}</span>
      <span class="v-time">${escapeHtml(md)}</span>
    </div>`;
  }).join('');
}

$('exportVocab').addEventListener('click', async () => {
  const s = await chrome.storage.local.get('vocab');
  const list = Array.isArray(s.vocab) ? s.vocab : [];
  if (!list.length) return;
  const csv = '\ufeff中文,英文,来源网站,收藏时间\n' + list.map(v =>
    `${v.zh},${v.en},${v.site || ''},${new Date(v.t || 0).toISOString()}`
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '网页学英语-生词本.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('clearVocab').addEventListener('click', async () => {
  if (!confirm('确定清空生词本？此操作不可恢复。')) return;
  await chrome.storage.local.set({ vocab: [] });
  loadVocab();
});

load();
loadVocab();
