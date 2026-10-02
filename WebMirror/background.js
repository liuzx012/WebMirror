// background.js — Service Worker (keep-alive + message routing)
// Manifest V3 自动休眠对抗：长连接端口 + alarms 定时唤醒 + 导航前 ping 唤醒

let keepAlivePorts = [];

// 每15秒闹钟唤醒 SW，防止空闲 30s 后被 Chrome 杀掉
chrome.alarms.create('keepalive', { periodInMinutes: 0.25 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // 空操作，仅维持 SW 活跃
  }
});

// 长连接保活：panel 打开 port 后只要不断开，SW 不会被判定为空闲
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    keepAlivePorts.push(port);
    port.onDisconnect.addListener(() => {
      keepAlivePorts = keepAlivePorts.filter(p => p !== port);
    });
  }
});

// 消息路由
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getTabId') {
    sendResponse({ tabId: sender.tab?.id || null });
    return true;
  }
  // ping 用于导航失败时唤醒 SW
  if (message.action === 'ping') {
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
