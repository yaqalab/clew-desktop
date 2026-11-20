'use strict';
/*
 * The tab strip: draws what the main process sends, and says which tab was chosen, closed or
 * moved. A tab is dragged along the strip as in a browser: the others slide aside to show where
 * it lands, and it is put there when the button is let go.
 */
(() => {
  const list = document.getElementById('tabs');
  const bridge = window.clewTabs;
  /** A press further than this along the strip is a drag, not a click. */
  const DRAG_FROM_PX = 5;

  /** The drag under way: `{ id, el, from, to, startX, rects, step, moved }`, or null. */
  let drag = null;
  /** A state that came in during a drag, drawn once it ends (redrawing would drop the tab held). */
  let pending = null;

  function tabEls() {
    return [...list.querySelectorAll('.tab')];
  }

  function startDrag(e, id, el) {
    const els = tabEls();
    const rects = els.map((t) => t.getBoundingClientRect());
    const from = els.indexOf(el);
    // How far a neighbour slides to make room: the tab's width and the gap after it.
    const next = rects[from + 1] ?? rects[from - 1];
    const gap = next ? Math.abs((next.left > rects[from].left ? next.left - rects[from].right : rects[from].left - next.right)) : 0;
    drag = { id, el, from, to: from, startX: e.clientX, rects, step: rects[from].width + gap, moved: false };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is not a real one (tests) is followed through the list instead.
    }
  }

  function moveDrag(e) {
    if (!drag) return;
    // The button was let go where the strip could not hear it (outside the window).
    if (e.buttons === 0) {
      endDrag(false);
      return;
    }
    const { rects, from } = drag;
    let dx = e.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_FROM_PX) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      list.classList.add('sorting');
    }
    // Kept within the strip's tabs.
    const first = rects[0];
    const last = rects[rects.length - 1];
    dx = Math.max(first.left - rects[from].left, Math.min(last.right - rects[from].right, dx));
    drag.el.style.transform = `translateX(${dx}px)`;
    const centre = rects[from].left + rects[from].width / 2 + dx;
    let to = 0;
    rects.forEach((r, i) => {
      if (i !== from && r.left + r.width / 2 < centre) to++;
    });
    drag.to = to;
    tabEls().forEach((t, i) => {
      if (i === from) return;
      let shift = 0;
      if (from < to && i > from && i <= to) shift = -drag.step;
      if (to < from && i >= to && i < from) shift = drag.step;
      t.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  }

  function endDrag(commit) {
    if (!drag) return;
    const { id, from, to, moved } = drag;
    drag = null;
    list.classList.remove('sorting');
    for (const t of tabEls()) {
      t.style.transform = '';
      t.classList.remove('dragging');
    }
    if (commit && moved && to !== from) bridge.move(id, to);
    // Only now does the keyboard go to the tab's page: had it gone on the press, the strip would
    // have lost focus under the pointer in the middle of the drag.
    bridge.activate(id, true);
    if (pending) {
      const state = pending;
      pending = null;
      render(state);
    }
  }

  function render(state) {
    if (drag) {
      pending = state;
      return;
    }
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
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        // In front at once, the keyboard left with the strip until the button is let go.
        bridge.activate(tab.id, false);
        if (state.tabs.length > 1) startDrag(e, tab.id, el);
        else bridge.activate(tab.id, true);
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
        // A press on × closes; it neither chooses the tab nor starts a drag.
        close.addEventListener('pointerdown', (e) => e.stopPropagation());
        close.addEventListener('click', () => bridge.close(tab.id));
        el.append(close);
      }
      list.append(el);
    }
  }

  // Heard on the whole page: a pointer that is captured reports here too, one that is not
  // (it left the strip) still ends the drag.
  window.addEventListener('pointermove', moveDrag);
  window.addEventListener('pointerup', () => endDrag(true));
  window.addEventListener('pointercancel', () => endDrag(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') endDrag(false);
  });

  bridge.onState(render);
  bridge.ready();
})();
