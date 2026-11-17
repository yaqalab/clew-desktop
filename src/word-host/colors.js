/**
 * Word's highlight colours, for the pages of Word windows (host.js, picker.js): a copy of
 * yaqatw's wordColor (src/service/wordColors.ts). Word highlights take only these 16 colours,
 * which are yaqatw's swatch colours; a palette colour is itself, any other the Word colour of its
 * hue, bright or dark by its lightness, or a grey when it has little colour. Only highlights are
 * limited: everything else keeps the code's own colour.
 */
(function () {
  'use strict';

  const PALETTE = [
    ['#FFFFFF', 'White'], ['#FFFF00', 'Yellow'], ['#00FF00', 'Lime'], ['#00FFFF', 'Turquoise'],
    ['#FF00FF', 'Pink'], ['#0000FF', 'Blue'], ['#FF0000', 'Red'], ['#000080', 'DarkBlue'],
    ['#008080', 'Teal'], ['#008000', 'Green'], ['#800080', 'Purple'], ['#800000', 'DarkRed'],
    ['#808000', 'Olive'], ['#808080', 'Gray'], ['#C0C0C0', 'LightGray'], ['#000000', 'Black'],
  ].map(([hex, label]) => ({ hex, label }));
  const BY_LABEL = Object.fromEntries(PALETTE.map((c) => [c.label.toLowerCase(), c.hex]));
  const BRIGHT = ['#FF0000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF'];
  const DARK = ['#800000', '#808000', '#008000', '#008080', '#000080', '#800080'];

  /** The Word highlight colour (#RRGGBB) for `color`, or '' when there is none. */
  function wordColor(color) {
    if (typeof color !== 'string') return '';
    const s = color.trim();
    const hex = BY_LABEL[s.toLowerCase()] || s;
    let m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
    if (m) m = [m[0], m[1] + m[1], m[2] + m[2], m[3] + m[3]];
    else m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return '';
    const [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 48) return '#000000';
    if ((max - min) / max < 0.2) {
      if (max >= 224) return '#FFFFFF';
      if (max >= 160) return '#C0C0C0';
      if (max >= 64) return '#808080';
      return '#000000';
    }
    let hue;
    if (max === r) hue = (60 * (g - b)) / (max - min);
    else if (max === g) hue = (60 * (b - r)) / (max - min) + 120;
    else hue = (60 * (r - g)) / (max - min) + 240;
    if (hue < 0) hue += 360;
    const slot = Math.floor((hue + 30) / 60) % 6;
    return max >= 160 ? BRIGHT[slot] : DARK[slot];
  }

  window.ClewWordColors = { PALETTE, wordColor };
})();
