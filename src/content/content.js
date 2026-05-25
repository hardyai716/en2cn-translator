/**
 * en2cn Translator — Content Script v1.3
 *
 * 注入每个网页，实现段落级翻译交互：
 *   1. 鼠标悬停段落 → 浮出「译」按钮
 *   2. 点击按钮 → 调用 Service Worker 翻译（双引擎自动切换）
 *   3. 译文插入段落下方，原文保留，可收起
 *   4. 支持中英双向翻译（Popup 设置）
 *   5. 「翻译本页」批量翻译所有可见段落
 *   6. 译文复制按钮
 *   7. Alt+T 翻译 · Alt+H 隐藏译文
 *   8. 支持自定义 CSS 选择器（Popup 配置）
 */

(function () {
  'use strict';

  // ================================================================
  //  配置
  // ================================================================
  const CFG = {
    DEFAULT_SELECTORS: ['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th'],
    MIN_EN_CHARS: 12,
    MIN_ZH_CHARS: 8,
    HOVER_DELAY_MS: 400,
    HIDE_DELAY_MS: 300,
    CACHE_EXPIRY_DAYS: 7,
    MAX_RETRIES: 2,
    MAX_CACHE_SIZE: 500,
    BATCH_INTERVAL_MS: 600,
    NS: 'en2cn',
    CACHE_KEY: 'en2cn-cache-v1',
    SETTINGS_KEY: 'en2cn-settings',
  };

  // ================================================================
  //  多语言字符串
  // ================================================================
  function getMsg(direction) {
    const isEnToZh = direction === 'en|zh-CN';
    return {
      btnLabel: '译',
      btnTitle: isEnToZh ? '点击翻译此段落为中文' : 'Click to translate to English',
      resultLabel: isEnToZh ? '🇨🇳 中文' : '🇬🇧 English',
      resultCloseTitle: '收起译文',
      resultCopyTitle: '复制译文',
      batchIdle: '📄 翻译本页',
      batchProgress: (done, total) => `⏳ ${done}/${total}`,
      batchDone: '🗑 收起全部',
      hintNoEn: '此段落没有足够的英文内容',
      hintNoZh: '此段落没有足够的中文内容',
      errorPrefix: '翻译失败',
      errorEmpty: '翻译结果为空',
      errorNetwork: '网络请求失败',
    };
  }

  // ================================================================
  //  状态
  // ================================================================
  const state = {
    cache: new Map(),
    cacheKeys: [],
    pendingRequests: new Set(),
    currentPara: null,
    btnPara: null,
    isTranslating: false,
    showTimer: null,
    hideTimer: null,
    enabled: true,
    direction: 'en|zh-CN',
    scrollRafId: null,
    // 批量翻译
    batchState: 'idle',   // idle | translating | done
    batchTotal: 0,
    batchDone: 0,
    batchAbort: false,
    // 自定义选择器
    customSelectors: '',
    // 站点禁用列表
    disabledDomains: [],
  };

  let $btn = null;
  let $batchBtn = null;
  let eventsBound = false;
  let MSG = getMsg(state.direction);

  // ----- 动态合并的选择器列表 -----
  function getSelectors() {
    const list = [...CFG.DEFAULT_SELECTORS];
    if (state.customSelectors) {
      state.customSelectors.split(',').map(s => s.trim()).filter(Boolean).forEach(s => {
        if (!list.includes(s)) list.push(s);
      });
    }
    return list;
  }

  // ================================================================
  //  工具函数
  // ================================================================

  /** 元素是否匹配段落（默认标签 + 自定义选择器） */
  function isPara(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    const selectors = getSelectors();
    // 先检查标签名
    if (selectors.includes(tag)) return true;
    // 再检查自定义 CSS 选择器
    if (state.customSelectors) {
      try {
        return el.matches(state.customSelectors);
      } catch (_) { /* 非法选择器忽略 */ }
    }
    return false;
  }

  function findPara(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (isPara(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /** 收集页面上所有符合条件的段落（批量翻译用） */
  function collectParas() {
    const selectors = getSelectors();
    // 收集默认标签
    let all = [];
    for (const sel of selectors) {
      // 如果 sel 以 . 或 # 开头，是 CSS 选择器，用 querySelectorAll
      if (sel.startsWith('.') || sel.startsWith('#') || sel.includes('>') || sel.includes(' ')) {
        try {
          all.push(...document.querySelectorAll(sel));
        } catch (_) { /* noop */ }
      } else {
        // 否则是标签名
        all.push(...document.getElementsByTagName(sel));
      }
    }

    // 去重 + 过滤
    const seen = new Set();
    return all.filter(el => {
      if (seen.has(el)) return false;
      seen.add(el);

      // 可见性检查
      if (el.offsetParent === null && !el.closest('body')) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;

      const text = el.textContent.trim();
      if (!text) return false;

      // 方向 + 字数过滤
      if (!textMatchesDirection(text)) return false;
      if (!hasMinChars(text)) return false;

      // 不翻译已翻译的
      if (hasResult(el)) return false;

      return true;
    });
  }

  function countEnChars(text) {
    const m = text.match(/[\x20-\x7E]/g);
    return m ? m.length : 0;
  }

  function countZhChars(text) {
    const m = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
    return m ? m.length : 0;
  }

  function hasResult(para) {
    const next = para.nextElementSibling;
    return next && next.classList.contains(`${CFG.NS}-result`);
  }

  function hash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h) + text.charCodeAt(i);
      h |= 0;
    }
    return 'h' + Math.abs(h).toString(36);
  }

  function insideResult(el) {
    return el && el.closest(`.${CFG.NS}-result`);
  }

  function isOnBtn(el) {
    return el === $btn || ($btn && $btn.contains(el)) || el === $batchBtn || ($batchBtn && $batchBtn.contains(el));
  }

  function hasMinChars(text) {
    if (!text) return false;
    if (state.direction === 'en|zh-CN') return countEnChars(text) >= CFG.MIN_EN_CHARS;
    return countZhChars(text) >= CFG.MIN_ZH_CHARS;
  }

  function textMatchesDirection(text) {
    if (!text) return false;
    const enRatio = countEnChars(text) / Math.max(text.length, 1);
    const zhRatio = countZhChars(text) / Math.max(text.length, 1);
    if (state.direction === 'en|zh-CN') return enRatio > 0.4 && zhRatio < 0.1;
    return zhRatio > 0.4 && enRatio < 0.1;
  }

  /** 当前域名是否在站点禁用列表中 */
  function isSiteDisabled() {
    if (!state.disabledDomains || state.disabledDomains.length === 0) return false;
    try {
      return state.disabledDomains.includes(window.location.hostname);
    } catch (_) { return false; }
  }

  /** 是否真正可用（全局启用 && 站点未禁用） */
  function isEffectivelyEnabled() {
    return state.enabled && !isSiteDisabled();
  }

  // ================================================================
  //  缓存
  // ================================================================

  async function loadCache() {
    try {
      const stored = await chrome.storage.local.get(CFG.CACHE_KEY);
      if (stored[CFG.CACHE_KEY]) {
        const now = Date.now();
        for (const [k, v] of Object.entries(stored[CFG.CACHE_KEY])) {
          if (typeof v === 'string') setCache(k, v);
          else if (v && v.expiresAt && v.expiresAt > now) setCache(k, v.value);
        }
      }
    } catch (_) { /* noop */ }
  }

  async function saveCache() {
    try {
      const now = Date.now();
      const expireMs = CFG.CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
      const obj = {};
      for (const [k, v] of state.cache) obj[k] = { value: v, expiresAt: now + expireMs };
      await chrome.storage.local.set({ [CFG.CACHE_KEY]: obj });
    } catch (_) { /* noop */ }
  }

  function setCache(key, value) {
    if (state.cache.has(key)) { state.cache.set(key, value); return; }
    if (state.cacheKeys.length >= CFG.MAX_CACHE_SIZE) {
      const oldest = state.cacheKeys.shift();
      state.cache.delete(oldest);
    }
    state.cache.set(key, value);
    state.cacheKeys.push(key);
  }

  // ================================================================
  //  设置管理
  // ================================================================

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(CFG.SETTINGS_KEY);
      const s = stored[CFG.SETTINGS_KEY];
      if (s !== undefined) {
        state.enabled = s.enabled !== false;
        state.direction = s.direction || 'en|zh-CN';
        state.customSelectors = s.customSelectors || '';
        state.disabledDomains = Array.isArray(s.disabledDomains) ? s.disabledDomains : [];
        MSG = getMsg(state.direction);
        updateContextMenu(state.direction);
        return true; // 已有保存的设置
      }
    } catch (_) { /* noop */ }
    return false; // 首次运行，无设置
  }

  function listenSettings() {
    chrome.runtime.onMessage.addListener((request) => {
      if (request.type === 'SETTINGS_CHANGED') {
        const wasEnabled = state.enabled;
        const wasDir = state.direction;
        const wasDisabledDomains = state.disabledDomains;
        state.enabled = request.settings.enabled !== false;
        state.direction = request.settings.direction || 'en|zh-CN';
        state.customSelectors = request.settings.customSelectors || '';
        state.disabledDomains = Array.isArray(request.settings.disabledDomains) ? request.settings.disabledDomains : [];
        MSG = getMsg(state.direction);
        updateContextMenu(state.direction);

        const nowEffective = isEffectivelyEnabled();
        const wasEffective = wasEnabled && !(Array.isArray(wasDisabledDomains) && wasDisabledDomains.includes(window.location.hostname));

        if (nowEffective && !wasEffective) {
          bindEvents();
          createBtn();
          createBatchBtn();
        } else if (!nowEffective && wasEffective) {
          disableAll();
        } else if (nowEffective && (state.direction !== wasDir || state.customSelectors !== request.settings.customSelectors)) {
          updateBtnAria();
        }
      }
    });
  }

  function updateBtnAria() {
    if ($btn) $btn.setAttribute('aria-label', MSG.btnTitle);
  }

  function disableAll() {
    hideBtn();
    hideBatchBtn();
    document.querySelectorAll(`.${CFG.NS}-result, .${CFG.NS}-error, .${CFG.NS}-hint`).forEach((el) => el.remove());
    unbindEvents();
    if ($btn && $btn.parentNode) { $btn.remove(); $btn = null; }
    if ($batchBtn && $batchBtn.parentNode) { $batchBtn.remove(); $batchBtn = null; }
    state.batchState = 'idle';
  }

  // ================================================================
  //  按键命令监听
  // ================================================================

  function listenCommands() {
    chrome.runtime.onMessage.addListener((request) => {
      if (request.type === 'COMMAND') {
        switch (request.command) {
          case 'translate-paragraph': handleShortcutTranslate(); break;
          case 'hide-all-translations': handleShortcutHideAll(); break;
        }
      } else if (request.type === 'EXPORT_TRANSLATIONS') {
        handleExport();
      } else if (request.type === 'GET_STATS') {
        const translated = document.querySelectorAll(`.${CFG.NS}-result`).length;
        const hostname = window.location.hostname;
        return Promise.resolve({ translated, hostname, direction: state.direction });
      }
    });
  }

  function handleShortcutTranslate() {
    if (!isEffectivelyEnabled()) return;

    // 优先使用悬停的段落，其次从当前文本选择中查找
    let para = state.currentPara;
    if (!para || hasResult(para)) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const anchor = sel.anchorNode;
        if (anchor) {
          const el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
          para = findPara(el);
        }
      }
    }

    if (!para || hasResult(para)) return;
    state.btnPara = para;
    showBtn(para);
    onBtnClick({ stopPropagation() {} });
  }

  function handleShortcutHideAll() {
    document.querySelectorAll(`.${CFG.NS}-result`).forEach((el) => {
      const para = el.previousElementSibling;
      if (para) para.classList.remove(`${CFG.NS}-translated`);
      el.remove();
    });
    updateBadge();
    if ($batchBtn) {
      state.batchState = 'idle';
      updateBatchBtnUI();
    }
  }

  // ================================================================
  //  Badge 更新
  // ================================================================

  function updateBadge() {
    const count = document.querySelectorAll(`.${CFG.NS}-result`).length;
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count }).catch(() => {});
  }

  function updateContextMenu(direction) {
    const title = direction === 'en|zh-CN' ? '翻译为中文' : 'Translate to English';
    chrome.runtime.sendMessage({ type: 'UPDATE_CONTEXT_MENU', title }).catch(() => {});
  }

  // ================================================================
  //  自动语言检测（首次使用）
  // ================================================================

  function detectPageLanguage() {
    const paras = document.querySelectorAll('p, h1, h2, h3, h4, li, blockquote');
    let enScore = 0, zhScore = 0, sampled = 0;
    for (const p of paras) {
      if (sampled >= 10) break;
      const text = p.textContent.trim();
      if (!text || text.length < 20) continue;
      sampled++;
      if (countEnChars(text) > text.length * 0.5) enScore++;
      if (countZhChars(text) > text.length * 0.3) zhScore++;
    }
    return zhScore > enScore ? 'zh-CN|en' : 'en|zh-CN';
  }

  // ================================================================
  //  导出译文
  // ================================================================

  function handleExport() {
    const results = document.querySelectorAll(`.${CFG.NS}-result`);
    if (results.length === 0) return;

    const hostname = window.location.hostname;
    const date = new Date().toISOString().slice(0, 10);
    const lines = [`# 翻译导出 — ${hostname} — ${date}`, ''];

    results.forEach((div, i) => {
      const para = div.previousElementSibling;
      const original = para ? para.textContent.trim() : '';
      const translated = div.querySelector(`.${CFG.NS}-result-content`)?.textContent || '';

      if (original) {
        lines.push(`> ${original}`);
        lines.push('');
        lines.push(translated);
      } else {
        lines.push(translated);
      }
      if (i < results.length - 1) lines.push('', '---', '');
    });

    const markdown = lines.join('\n');
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `翻译导出-${hostname}-${date}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ================================================================
  //  段落按钮
  // ================================================================

  function createBtn() {
    if ($btn || !state.enabled) return;
    $btn = document.createElement('div');
    $btn.id = `${CFG.NS}-translate-btn`;
    $btn.setAttribute('role', 'button');
    $btn.setAttribute('tabindex', '-1');
    $btn.setAttribute('aria-label', MSG.btnTitle);
    $btn.title = 'Alt+T 翻译';
    $btn.innerHTML = `<span class="${CFG.NS}-btn-text">${MSG.btnLabel}</span>`;
    Object.assign($btn.style, {
      position: 'fixed', display: 'none', zIndex: '2147483647',
      width: '28px', height: '28px', borderRadius: '50%',
      background: 'rgba(66, 133, 244, 0.9)', color: '#fff',
      fontSize: '13px', fontWeight: '700',
      fontFamily: '-apple-system, sans-serif', lineHeight: '28px',
      textAlign: 'center', cursor: 'pointer', userSelect: 'none',
      boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
      transition: 'opacity 0.15s, transform 0.15s',
      opacity: '0', transform: 'scale(0.8)', pointerEvents: 'auto',
    });
    document.body.appendChild($btn);
    $btn.addEventListener('mouseenter', cancelHide);
    $btn.addEventListener('mouseleave', scheduleHide);
    $btn.addEventListener('click', onBtnClick);
  }

  function showBtn(para) {
    if (!para || !$btn || !state.enabled) return;
    state.btnPara = para;
    state.currentPara = para;
    const rect = para.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    $btn.style.left = Math.min(rect.right - 30, window.innerWidth - 38) + 'px';
    $btn.style.top = Math.max(rect.top + 4, 4) + 'px';
    $btn.style.display = 'block';
    requestAnimationFrame(() => { $btn.style.opacity = '1'; $btn.style.transform = 'scale(1)'; });
  }

  function hideBtn() {
    if (!$btn) return;
    $btn.style.opacity = '0';
    $btn.style.transform = 'scale(0.8)';
    setTimeout(() => { if ($btn && $btn.style.opacity === '0') $btn.style.display = 'none'; }, 150);
    state.btnPara = null;
    state.currentPara = null;
  }

  function setBtnLoading(loading) {
    if (!$btn) return;
    if (loading) {
      $btn.style.background = 'rgba(150, 150, 150, 0.8)';
      $btn.style.pointerEvents = 'none';
      $btn.innerHTML =
        `<svg class="${CFG.NS}-spinner" viewBox="0 0 24 24" width="16" height="16" style="display:block;margin:6px auto;">` +
        `<circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="3"/>` +
        `<circle cx="12" cy="12" r="10" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="31.4 31.4" ` +
        `stroke-linecap="round" style="animation:${CFG.NS}-spin .6s linear infinite;transform-origin:12px 12px;"/></svg>`;
    } else {
      $btn.style.background = 'rgba(66, 133, 244, 0.9)';
      $btn.style.pointerEvents = 'auto';
      $btn.innerHTML = `<span class="${CFG.NS}-btn-text">${MSG.btnLabel}</span>`;
    }
  }

  // ================================================================
  //  批量翻译按钮
  // ================================================================

  function createBatchBtn() {
    if ($batchBtn || !state.enabled) return;
    $batchBtn = document.createElement('div');
    $batchBtn.id = `${CFG.NS}-batch-btn`;
    $batchBtn.setAttribute('role', 'button');
    $batchBtn.setAttribute('tabindex', '0');
    Object.assign($batchBtn.style, {
      position: 'fixed', display: 'none', zIndex: '2147483646',
      bottom: '20px', right: '20px',
      padding: '8px 14px',
      borderRadius: '20px',
      background: 'rgba(66, 133, 244, 0.92)',
      color: '#fff',
      fontSize: '13px',
      fontWeight: '600',
      fontFamily: '-apple-system, "PingFang SC", sans-serif',
      lineHeight: '1.4',
      textAlign: 'center',
      cursor: 'pointer',
      userSelect: 'none',
      boxShadow: '0 2px 10px rgba(66, 133, 244, 0.35)',
      transition: 'opacity 0.2s',
      opacity: '0.85',
      pointerEvents: 'auto',
    });
    $batchBtn.textContent = MSG.batchIdle;
    $batchBtn.title = '翻译本页所有可见段落';
    document.body.appendChild($batchBtn);

    $batchBtn.addEventListener('mouseenter', () => { $batchBtn.style.opacity = '1'; });
    $batchBtn.addEventListener('mouseleave', () => { $batchBtn.style.opacity = '0.85'; });
    $batchBtn.addEventListener('click', onBatchBtnClick);
  }

  function showBatchBtn() {
    if (!$batchBtn) createBatchBtn();
    if ($batchBtn) {
      $batchBtn.style.display = 'block';
      updateBatchBtnUI();
    }
  }

  function hideBatchBtn() {
    if (!$batchBtn) return;
    $batchBtn.style.display = 'none';
  }

  function updateBatchBtnUI() {
    if (!$batchBtn) return;
    switch (state.batchState) {
      case 'idle':
        $batchBtn.textContent = MSG.batchIdle;
        $batchBtn.style.background = 'rgba(66, 133, 244, 0.92)';
        break;
      case 'translating':
        $batchBtn.textContent = MSG.batchProgress(state.batchDone, state.batchTotal);
        $batchBtn.style.background = 'rgba(150, 150, 150, 0.8)';
        break;
      case 'done':
        $batchBtn.textContent = MSG.batchDone;
        $batchBtn.style.background = 'rgba(52, 168, 83, 0.85)';
        break;
    }
  }

  /** 批量翻译按钮点击 */
  async function onBatchBtnClick() {
    if (!state.enabled) return;

    if (state.batchState === 'translating') return;

    if (state.batchState === 'done') {
      // 收起全部
      document.querySelectorAll(`.${CFG.NS}-result`).forEach((el) => el.remove());
      state.batchState = 'idle';
      updateBatchBtnUI();
      return;
    }

    // idle → 开始批量翻译
    const paras = collectParas();
    if (paras.length === 0) {
      // 没有可翻译段落
      $batchBtn.textContent = '无可用段落';
      setTimeout(() => { if (state.batchState === 'idle') updateBatchBtnUI(); }, 1500);
      return;
    }

    state.batchState = 'translating';
    state.batchTotal = paras.length;
    state.batchDone = 0;
    state.batchAbort = false;
    updateBatchBtnUI();

    for (const para of paras) {
      if (state.batchAbort || !state.enabled) break;
      if (hasResult(para)) {
        state.batchDone++;
        updateBatchBtnUI();
        continue;
      }

      const text = para.textContent.trim();
      const key = hash(text);

      if (state.cache.has(key)) {
        renderResult(para, state.cache.get(key), true);
        state.batchDone++;
        updateBatchBtnUI();
        continue;
      }

      if (state.pendingRequests.has(key)) {
        state.batchDone++;
        updateBatchBtnUI();
        continue;
      }

      state.pendingRequests.add(key);
      const result = await translateWithRetry(text, key, 0);
      state.pendingRequests.delete(key);

      if (result.success) {
        setCache(key, result.translated);
        saveCache();
        renderResult(para, result.translated, true);
      } else {
        renderError(para, result.error);
      }

      state.batchDone++;
      updateBatchBtnUI();

      // 限频间隔
      if (state.batchDone < state.batchTotal) {
        await new Promise((r) => setTimeout(r, CFG.BATCH_INTERVAL_MS));
      }
    }

    state.batchState = 'done';
    updateBatchBtnUI();
  }

  // ================================================================
  //  定时器
  // ================================================================

  function scheduleShow(para) { clearTimer('showTimer'); clearTimer('hideTimer'); state.showTimer = setTimeout(() => showBtn(para), CFG.HOVER_DELAY_MS); }
  function scheduleHide() { clearTimer('showTimer'); clearTimer('hideTimer'); state.hideTimer = setTimeout(hideBtn, CFG.HIDE_DELAY_MS); }
  function cancelHide() { clearTimer('hideTimer'); }
  function clearTimer(name) { if (state[name]) { clearTimeout(state[name]); state[name] = null; } }

  // ================================================================
  //  事件：段落 hover
  // ================================================================

  function onMouseOver(e) {
    if (!state.enabled) return;
    if (isOnBtn(e.target) || insideResult(e.target)) return;
    const para = findPara(e.target);
    if (!para) return;
    const text = para.textContent.trim();
    if (!textMatchesDirection(text)) {
      if (para === state.currentPara) { scheduleHide(); state.currentPara = null; }
      return;
    }
    if (para !== state.currentPara) { scheduleShow(para); state.currentPara = para; }
  }

  function onMouseOut(e) {
    if (!state.enabled) return;
    if (isOnBtn(e.relatedTarget)) { cancelHide(); return; }
    if (insideResult(e.relatedTarget)) return;
    const fromPara = findPara(e.target);
    const toPara = findPara(e.relatedTarget);
    if (fromPara && fromPara === toPara) return;
    if (fromPara && toPara && fromPara !== toPara) return;
    if (fromPara) scheduleHide();
  }

  // ================================================================
  //  翻译
  // ================================================================

  async function onBtnClick(e) {
    e.stopPropagation();
    if (state.isTranslating || !state.enabled) return;
    const para = state.btnPara || state.currentPara;
    if (!para || hasResult(para)) return;
    const text = para.textContent.trim();
    if (!hasMinChars(text)) {
      const hint = document.createElement('div');
      hint.className = `${CFG.NS}-hint`;
      hint.textContent = state.direction === 'en|zh-CN' ? MSG.hintNoEn : MSG.hintNoZh;
      para.parentNode.insertBefore(hint, para.nextSibling);
      setTimeout(() => { if (hint.parentNode) hint.remove(); }, 2000);
      return;
    }
    const key = hash(text);
    if (state.cache.has(key)) { renderResult(para, state.cache.get(key)); return; }
    if (state.pendingRequests.has(key)) return;
    state.isTranslating = true;
    state.pendingRequests.add(key);
    setBtnLoading(true);
    const result = await translateWithRetry(text, key, 0);
    state.pendingRequests.delete(key);
    state.isTranslating = false;
    setBtnLoading(false);
    if (result.success) { setCache(key, result.translated); saveCache(); renderResult(para, result.translated); }
    else { renderError(para, result.error); }
  }

  async function translateWithRetry(text, key, attempt) {
    const [sl, tl] = state.direction.split('|');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'TRANSLATE', text, sl, tl });
      if (resp && resp.success && resp.translated) return { success: true, translated: resp.translated };
      throw new Error(resp?.error || MSG.errorEmpty);
    } catch (err) {
      if (attempt < CFG.MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        return translateWithRetry(text, key, attempt + 1);
      }
      return { success: false, error: err.message || MSG.errorNetwork };
    }
  }

  // ================================================================
  //  渲染
  // ================================================================

  /**
   * 渲染译文
   * @param {boolean} noScroll - 设为 true 时不自动滚动（批量翻译用）
   */
  function renderResult(para, text, noScroll) {
    removeNextError(para);
    if (hasResult(para)) return;

    const div = document.createElement('div');
    div.className = `${CFG.NS}-result`;

    // 顶栏：语言标签 + 复制按钮 + 关闭按钮
    const topBar = document.createElement('div');
    topBar.className = `${CFG.NS}-result-topbar`;

    const label = document.createElement('span');
    label.className = `${CFG.NS}-result-label`;
    label.textContent = MSG.resultLabel;

    // 复制按钮（SVG 图标）
    const copyBtn = document.createElement('button');
    copyBtn.className = `${CFG.NS}-result-copy`;
    copyBtn.title = MSG.resultCopyTitle;
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

    // 复制反馈浮层（不改变按钮文本）
    const copyFeedback = document.createElement('span');
    copyFeedback.className = `${CFG.NS}-copy-feedback`;
    copyFeedback.textContent = '已复制';
    copyFeedback.style.display = 'none';

    copyBtn.appendChild(copyFeedback);
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        copyFeedback.style.display = 'block';
        copyBtn.classList.add(`${CFG.NS}-copied`);
        setTimeout(() => {
          copyFeedback.style.display = 'none';
          copyBtn.classList.remove(`${CFG.NS}-copied`);
        }, 1000);
      } catch (_) { /* clipboard 不可用时静默 */ }
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = `${CFG.NS}-result-close`;
    closeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    closeBtn.title = MSG.resultCloseTitle;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      para.classList.remove(`${CFG.NS}-translated`);
      div.remove();
      updateBadge();
    });

    topBar.appendChild(label);
    topBar.appendChild(copyBtn);
    topBar.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = `${CFG.NS}-result-content`;
    content.textContent = text;
    // 双击编辑译文
    content.addEventListener('dblclick', () => {
      content.contentEditable = 'true';
      content.classList.add(`${CFG.NS}-editing`);
      content.focus();
      // 全选文本
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(content);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    content.addEventListener('blur', () => {
      content.contentEditable = 'false';
      content.classList.remove(`${CFG.NS}-editing`);
      // 保存编辑后的文本到缓存
      const newText = content.textContent.trim();
      if (newText && newText !== text) {
        const paraKey = hash(para.textContent.trim());
        if (state.cache.has(paraKey)) {
          state.cache.set(paraKey, newText);
          saveCache();
        }
      }
    });
    content.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        content.blur();
      }
      if (e.key === 'Escape') {
        content.textContent = text; // 恢复原文
        content.blur();
      }
    });

    div.appendChild(topBar);
    div.appendChild(content);
    para.parentNode.insertBefore(div, para.nextSibling);

    // 只有非批量翻译时才自动滚动到译文
    if (!noScroll) {
      div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // 标记原文段落为「已翻译」
    para.classList.add(`${CFG.NS}-translated`);

    updateBadge();
  }

  function renderError(para, msg) {
    removeNextError(para);
    const div = document.createElement('div');
    div.className = `${CFG.NS}-error`;
    div.textContent = `${MSG.errorPrefix}：${msg}`;
    para.parentNode.insertBefore(div, para.nextSibling);
    setTimeout(() => { if (div.parentNode) div.remove(); }, 4000);
  }

  function removeNextError(para) {
    const next = para.nextElementSibling;
    if (next && next.classList.contains(`${CFG.NS}-error`)) next.remove();
  }

  // ================================================================
  //  滚动节流
  // ================================================================

  function onScroll() {
    if (state.scrollRafId) return;
    state.scrollRafId = requestAnimationFrame(() => {
      state.scrollRafId = null;
      if (!$btn || $btn.style.display === 'none' || !state.btnPara) return;
      const rect = state.btnPara.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) { hideBtn(); return; }
      $btn.style.left = Math.min(rect.right - 30, window.innerWidth - 38) + 'px';
      $btn.style.top = Math.max(rect.top + 4, 4) + 'px';
    });
  }

  // ================================================================
  //  事件绑定 / 解绑
  // ================================================================

  function bindEvents() {
    if (eventsBound) return;
    document.addEventListener('mouseover', onMouseOver, false);
    document.addEventListener('mouseout', onMouseOut, false);
    window.addEventListener('scroll', onScroll, { passive: true });
    eventsBound = true;
  }

  function unbindEvents() {
    document.removeEventListener('mouseover', onMouseOver, false);
    document.removeEventListener('mouseout', onMouseOut, false);
    window.removeEventListener('scroll', onScroll, { passive: true });
    eventsBound = false;
  }

  // ================================================================
  //  保活
  // ================================================================

  function setupKeepAlive() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.enabled && $btn && $btn.style.display !== 'none') {
        if (state.btnPara) showBtn(state.btnPara);
      }
    });
  }

  // ================================================================
  //  初始化
  // ================================================================

  async function init() {
    const [hasSettings] = await Promise.all([loadSettings(), loadCache()]);

    // 首次使用：自动检测页面语言并保存
    if (!hasSettings) {
      const detected = detectPageLanguage();
      if (detected !== state.direction) {
        state.direction = detected;
        MSG = getMsg(state.direction);
        try {
          await chrome.storage.local.set({
            [CFG.SETTINGS_KEY]: {
              enabled: state.enabled,
              direction: state.direction,
              customSelectors: state.customSelectors,
              disabledDomains: state.disabledDomains,
            },
          });
        } catch (_) { /* noop */ }
      }
    }

    listenSettings();
    listenCommands();
    if (isEffectivelyEnabled()) {
      createBtn();
      createBatchBtn();
      bindEvents();
      // 页面加载后延迟显示批量按钮
      setTimeout(showBatchBtn, 1500);
    }
    setupKeepAlive();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
