// background.js — Service Worker
// 处理扩展图标点击和消息路由

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getTabId') {
    sendResponse({ tabId: sender.tab?.id || null });
    return true;
  }
  return false;
});
