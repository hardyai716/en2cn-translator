/**
 * en2cn Translator — Service Worker v1.2
 *
 * 职责：
 *   1. 接收 content script 的翻译请求，双引擎自动切换
 *   2. 转发键盘快捷键命令到 content script
 *
 * 翻译引擎：
 *   主引擎 — Google Translate（免费 API，无需 Key）
 *   备用引擎 — MyMemory（免费 API，无需 Key，有限额）
 *
 * 消息类型：
 *   TRANSLATE       content → service worker  翻译请求
 *   COMMAND         service worker → content  键盘命令转发
 */

// ================================================================
//  引擎配置
// ================================================================

const ENGINES = {
  google: {
    name: 'Google',
    buildUrl(text, sl, tl) {
      return `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
    },
    parseResponse(data) {
      if (!Array.isArray(data) || !Array.isArray(data[0])) {
        throw new Error('Google: 意外的响应格式');
      }
      return data[0].map((item) => (item[0] || '')).join('');
    },
  },
  mymemory: {
    name: 'MyMemory',
    buildUrl(text, sl, tl) {
      const pair = `${sl}|${tl}`;
      return `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pair}`;
    },
    parseResponse(data) {
      if (data && data.responseData && data.responseData.translatedText) {
        return data.responseData.translatedText;
      }
      throw new Error('MyMemory: 意外的响应格式');
    },
  },
};

const ENGINE_ORDER = ['google', 'mymemory'];

const MAX_CHUNK_SIZE = 3000;

// ================================================================
//  消息：翻译请求
// ================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TRANSLATE') {
    const sl = request.sl || 'en';
    const tl = request.tl || 'zh-CN';
    translateText(request.text, sl, tl)
      .then((result) => sendResponse({ success: true, translated: result }))
      .catch((err) => {
        console.error('[en2cn] 翻译失败:', err);
        sendResponse({ success: false, error: err.message || '翻译失败' });
      });
    return true; // 异步响应
  }
});

// ================================================================
//  键盘快捷键转发
// ================================================================

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'COMMAND', command }).catch(() => {
        // content script 可能还没加载
      });
    }
  });
});

// ================================================================
//  右键菜单
// ================================================================

// 安装/更新时注册右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translate-paragraph',
    title: '翻译此段落',
    contexts: ['selection'],
  });
});

// 点击右键菜单项 → 转发到 content script
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translate-paragraph' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'COMMAND', command: 'translate-paragraph' }).catch(() => {
      // content script 可能还没加载
    });
  }
});

// ================================================================
//  翻译逻辑（双引擎 + 自动切换 + 长文本分片）
// ================================================================

async function translateText(text, sl, tl) {
  if (!text || !text.trim()) return '';
  const trimmed = text.trim();

  if (trimmed.length <= MAX_CHUNK_SIZE) {
    return await translateWithFallback(trimmed, sl, tl);
  }

  // 长文本分片后合并
  const chunks = splitText(trimmed, MAX_CHUNK_SIZE);
  const results = await Promise.all(
    chunks.map((chunk) => translateWithFallback(chunk, sl, tl))
  );
  return results.join('');
}

/**
 * 按引擎优先级依次尝试，前一个失败则自动切换下一个。
 */
async function translateWithFallback(text, sl, tl) {
  let lastError = null;

  for (const name of ENGINE_ORDER) {
    try {
      return await translateSingle(text, sl, tl, name);
    } catch (err) {
      console.warn(`[en2cn] ${ENGINES[name].name} 失败，切换备用引擎:`, err.message);
      lastError = err;
      // 继续尝试下一个引擎
    }
  }

  // 所有引擎都失败
  throw lastError || new Error('所有翻译引擎均不可用');
}

/**
 * 使用指定引擎执行单次翻译请求。
 */
async function translateSingle(text, sl, tl, engineName) {
  const engine = ENGINES[engineName];
  const url = engine.buildUrl(text, sl, tl);

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000), // 8 秒超时
  });

  if (!response.ok) {
    throw new Error(`${engine.name}: HTTP ${response.status}`);
  }

  const data = await response.json();
  return engine.parseResponse(data);
}

// ================================================================
//  长文本分片
// ================================================================

function splitText(text, maxLen) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxLen;

    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }

    // 尽量在句子边界分割（改善翻译质量）
    const boundary = text.lastIndexOf('.', end);
    const breakPos = text.lastIndexOf('\n', end);

    let splitPos = end;
    if (boundary > start && boundary > end - 500) splitPos = boundary + 1;
    else if (breakPos > start && breakPos > end - 500) splitPos = breakPos + 1;

    chunks.push(text.slice(start, splitPos));
    start = splitPos;
  }

  return chunks;
}
