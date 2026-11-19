/**
 * An AI request Yaqatw is about to send from a Word document, shown before it goes (yaqatw's AI
 * gate: src/service/ai/aiGate.ts; the request reaches this window from the document's host page,
 * src/word-host/host.js, through the main process). Once per run: the rest of the run (the Code
 * Agent's other parts) goes the same way. Cancel, Esc or closing the window sends nothing.
 *
 * A Word document has no Clew names list, so names are not replaced here: the window says so.
 */
(function () {
  'use strict';

  const word = window.clewWord;
  const $ = (id) => document.getElementById(id);
  /** How much text is shown; the rest is counted. */
  const SHOWN = 6;
  let answered = false;

  function answer(send) {
    if (answered) return;
    answered = true;
    word.reviewAnswer(send);
  }

  function size(bytes) {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  async function load() {
    const r = await word.reviewData();
    if (!r) {
      answer(false);
      return;
    }
    const to = r.model ? `${r.provider} (${r.model})` : r.provider;
    $('heading').textContent = `Send this to ${r.host}?`;
    $('about').textContent = `Yaqatw's ${r.feature} wants to send this to ${to}, at ${r.host}.`;
    if (r.kind === 'audio') {
      $('names').textContent = `A recording of ${size(r.bytes || 0)}. What is said in it goes as it is.`;
    }
    const texts = Array.isArray(r.texts) ? r.texts : [];
    for (const text of texts.slice(0, SHOWN)) {
      const pre = document.createElement('pre');
      pre.className = 'review-text';
      pre.textContent = text;
      $('texts').appendChild(pre);
    }
    if (texts.length > SHOWN) {
      $('more').textContent = `And ${texts.length - SHOWN} more pieces of text.`;
      $('more').hidden = false;
    }
    $('cancel').focus();
  }

  $('send').addEventListener('click', () => answer(true));
  $('cancel').addEventListener('click', () => answer(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') answer(false);
  });

  load().catch(() => answer(false));
})();
