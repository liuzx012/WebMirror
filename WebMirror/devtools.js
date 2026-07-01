chrome.devtools.panels.create(
  'WebMirror',
  'icons/icon16.png',
  'panel.html',
  (panel) => {
    panel.onShown.addListener((win) => {
      // Panel is visible
    });
  }
);
