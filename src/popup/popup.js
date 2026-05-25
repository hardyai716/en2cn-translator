/**
 * en2cn Translator — Popup v1.4
 *
 * 提供：全局开关、站点禁用、语言方向、自定义选择器、清空缓存、隐藏译文
 */

const STORAGE_KEY = 'en2cn-settings';

// DOM
const toggle = document.getElementById('toggle-enable');
const domainEl = document.getElementById('current-domain');
const siteToggleBtn = document.getElementById('btn-site-toggle');
const langSelect = document.getElementById('lang-direction');
const customSelectorsInput = document.getElementById('custom-selectors');
const btnExport = document.getElementById('btn-export');
const btnClear = document.getElementById('btn-clear-cache');
const btnHideAll = document.getElementById('btn-hide-all');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const statsText = document.getElementById('stats-text');

let enabled = true;
let direction = 'en|zh-CN';
let customSelectors = '';
let disabledDomains = [];
let currentDomain = '';

// ================================================================
//  设置
// ================================================================

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const s = stored[STORAGE_KEY];
    if (s) {
      enabled = s.enabled !== false;
      direction = s.direction || 'en|zh-CN';
      customSelectors = s.customSelectors || '';
      disabledDomains = Array.isArray(s.disabledDomains) ? s.disabledDomains : [];
    }
  } catch (_) { /* noop */ }
  applyUI();
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { enabled, direction, customSelectors, disabledDomains },
    });
  } catch (_) { /* noop */ }
}

function applyUI() {
  // 全局开关
  toggle.classList.toggle('active', enabled);
  toggle.setAttribute('aria-checked', enabled);

  // 语言方向
  langSelect.value = direction;

  // 自定义选择器
  customSelectorsInput.value = customSelectors;

  // 站点禁用
  const siteDisabled = disabledDomains.includes(currentDomain);
  if (currentDomain) {
    domainEl.textContent = currentDomain;
    if (siteDisabled) {
      siteToggleBtn.textContent = '已禁用';
      siteToggleBtn.className = 'site-btn danger';
    } else {
      siteToggleBtn.textContent = '禁用此站';
      siteToggleBtn.className = 'site-btn';
    }
  } else {
    domainEl.textContent = '无活跃标签页';
    siteToggleBtn.textContent = '—';
    siteToggleBtn.className = 'site-btn';
    siteToggleBtn.disabled = true;
  }

  // 状态栏
  if (!enabled) {
    statusDot.className = 'dot off';
    statusText.textContent = '已禁用（全局）';
  } else if (siteDisabled) {
    statusDot.className = 'dot site-off';
    statusText.textContent = `已禁用（${currentDomain}）`;
  } else {
    statusDot.className = 'dot on';
    statusText.textContent = '已启用';
  }
}

// ================================================================
//  获取当前标签页域名
// ================================================================

async function getCurrentDomain() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      try {
        const url = new URL(tabs[0].url);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          return url.hostname;
        }
      } catch (_) { /* noop */ }
    }
  } catch (_) { /* noop */ }
  return '';
}

// ================================================================
//  通知 content script
// ================================================================

async function notifyContent(data) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'SETTINGS_CHANGED', settings: data })
        .catch(() => { console.debug('[en2cn] 通知 content script 失败'); });
    }
  } catch (_) { /* noop */ }
}

// ================================================================
//  事件
// ================================================================

// 全局开关
toggle.addEventListener('click', async () => {
  enabled = !enabled;
  applyUI();
  await saveSettings();
  notifyContent({ enabled, direction, customSelectors, disabledDomains });
});

// 站点禁用切换
siteToggleBtn.addEventListener('click', async () => {
  if (!currentDomain) return;

  const idx = disabledDomains.indexOf(currentDomain);
  if (idx >= 0) {
    // 当前已禁用 → 移除
    disabledDomains.splice(idx, 1);
  } else {
    // 当前未禁用 → 加入
    disabledDomains.push(currentDomain);
  }
  applyUI();
  await saveSettings();
  notifyContent({ enabled, direction, customSelectors, disabledDomains });
});

// 语言方向
langSelect.addEventListener('change', async () => {
  direction = langSelect.value;
  await saveSettings();
  notifyContent({ enabled, direction, customSelectors, disabledDomains });
});

// 自定义选择器
customSelectorsInput.addEventListener('change', async () => {
  customSelectors = customSelectorsInput.value.trim();
  await saveSettings();
  notifyContent({ enabled, direction, customSelectors, disabledDomains });
});

// 导出译文
btnExport.addEventListener('click', async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'EXPORT_TRANSLATIONS' });
      btnExport.textContent = '✓ 已导出';
      setTimeout(() => { btnExport.textContent = '📥 导出译文 (Markdown)'; }, 2000);
    }
  } catch (_) { /* noop */ }
});

// 清空缓存
btnClear.addEventListener('click', async () => {
  try {
    await chrome.storage.local.remove('en2cn-cache-v1');
    btnClear.textContent = '✓ 已清空';
    setTimeout(() => { btnClear.textContent = '清空翻译缓存'; }, 1500);
  } catch (_) {
    btnClear.textContent = '清空失败';
  }
});

// 隐藏所有译文
btnHideAll.addEventListener('click', async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'COMMAND', command: 'hide-all-translations' })
        .catch(() => { console.debug('[en2cn] 发送隐藏命令失败'); });
    }
  } catch (_) { /* noop */ }
});

// ================================================================
//  启动
// ================================================================

document.addEventListener('DOMContentLoaded', async () => {
  currentDomain = await getCurrentDomain();
  await loadSettings();
  await fetchStats();
});

// ================================================================
//  获取页面统计
// ================================================================

async function fetchStats() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      const resp = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATS' });
      if (resp && resp.translated !== undefined) {
        statsText.textContent = `· ${resp.translated} 段已翻译`;
      }
    }
  } catch (_) { /* content script 可能未加载 */ }
}
