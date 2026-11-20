'use strict';
/* The tab strip: draws what the main process sends, and says which tab was chosen or closed. */
(() => {
  const list = document.getElementById('tabs');
  const bridge = window.clewTabs;

  function render(state) {
    list.textContent = '';
    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab';
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(tab.active));
      el.tabIndex = tab.active ? 0 : -1;
      el.title = tab.label;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = tab.label;
      el.append(label);
      el.addEventListener('mousedown', (e) => {
        if (e.button === 0) bridge.activate(tab.id);
      });
      // The middle button closes a tab, as in a browser.
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1 && state.closable) bridge.close(tab.id);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') bridge.activate(tab.id);
      });
      if (state.closable) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'close';
        close.textContent = '×';
        close.title = 'Close tab';
        close.setAttribute('aria-label', `Close ${tab.label}`);
        close.addEventListener('mousedown', (e) => e.stopPropagation());
        close.addEventListener('click', () => bridge.close(tab.id));
        el.append(close);
      }
      list.append(el);
    }
  }

  bridge.onState(render);
  bridge.ready();
})();
