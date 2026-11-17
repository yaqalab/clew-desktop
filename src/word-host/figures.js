/**
 * Figures for the pages of Word windows (host.js): the Word XML (a flat OPC package, the form
 * Word's InsertXML takes) of a figure as yaqatw's web add-in lays it out (yaqatw:
 * src/host/WordDocumentHost.ts, fillImageControl): its caption, the picture and its source line,
 * the caption above or below the picture. The picture is inserted at its own size (96 pixels an
 * inch); Word's side makes it fit the text column when it is wider (word-plugin/src/Citations.bas).
 */
(function () {
  'use strict';

  const EMU_PER_PX = 9525;
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const JC = { left: 'left', center: 'center', right: 'right' };

  function escapeXml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Base64 without a data: prefix or white space. */
  function cleanBase64(base64) {
    return String(base64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  }

  /** The first `n` bytes of base64 data (fewer when it is shorter). */
  function headBytes(base64, n) {
    const bin = atob(base64.slice(0, Math.ceil(n / 3) * 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  const be16 = (b, i) => (b[i] << 8) | b[i + 1];
  const be32 = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const le16 = (b, i) => b[i] | (b[i + 1] << 8);
  const le32 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

  // JPEG frame markers, which hold the size: SOF0-3, 5-7, 9-11, 13-15.
  const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

  function jpegSize(b) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (SOF.has(marker)) return { width: be16(b, i + 7), height: be16(b, i + 5) };
      i += 2 + be16(b, i + 2);
    }
    return null;
  }

  /** What the picture is and its size in pixels: {type, ext, width, height}; null if unknown. */
  function imageInfo(base64) {
    // A JPEG's size can come after its metadata (up to 64 KB, sometimes more).
    const b = headBytes(cleanBase64(base64), 256 * 1024);
    let size = null;
    let type = null;
    let ext = null;
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      [type, ext, size] = ['image/png', 'png', { width: be32(b, 16), height: be32(b, 20) }];
    } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      [type, ext, size] = ['image/jpeg', 'jpeg', jpegSize(b)];
    } else if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      [type, ext, size] = ['image/gif', 'gif', { width: le16(b, 6), height: le16(b, 8) }];
    } else if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
      [type, ext, size] = ['image/bmp', 'bmp', { width: le32(b, 18), height: Math.abs(le32(b, 22)) }];
    }
    if (!size || !(size.width > 0) || !(size.height > 0)) return null;
    return { type, ext, width: size.width, height: size.height };
  }

  /** The body of a flat OPC package (its paragraphs), or '' when there is none. */
  function bodyOf(pkg) {
    const m = /<w:body>([\s\S]*)<\/w:body>/.exec(String(pkg || ''));
    return m ? m[1] : '';
  }

  function alignment(a) {
    return `<w:pPr><w:jc w:val="${JC[a] || 'left'}"/></w:pPr>`;
  }

  function pictureXml(info, name, align) {
    const cx = Math.round(info.width * EMU_PER_PX);
    const cy = Math.round(info.height * EMU_PER_PX);
    return (
      `<w:p>${alignment(align)}<w:r><w:drawing>` +
      `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="1" name="${escapeXml(name)}"/>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="1" name="${escapeXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="rIdFigure"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    );
  }

  /**
   * The figure as one Word XML package. `opts` as yaqatw passes them to
   * insertArtifactImageAtCursor: captionOoxml, captionPosition, imageAlignment, sourceAlignment,
   * source, base64, title.
   */
  function figurePackage(opts) {
    const o = opts || {};
    const base64 = cleanBase64(o.base64);
    const info = imageInfo(base64);
    if (!info) throw new Error('This picture cannot be inserted in Word: it is not a PNG, JPEG, GIF or BMP image.');
    const caption = bodyOf(o.captionOoxml);
    const picture = pictureXml(info, o.title || 'Figure', o.imageAlignment || 'center');
    const source = o.source
      ? `<w:p>${alignment(o.sourceAlignment)}<w:r><w:t xml:space="preserve">${escapeXml(o.source)}</w:t></w:r></w:p>`
      : '';
    const body = (o.captionPosition === 'above' ? caption + picture : picture + caption) + source;
    const rels = 'application/vnd.openxmlformats-package.relationships+xml';
    return (
      `<?xml version="1.0" standalone="yes"?>` +
      `<?mso-application progid="Word.Document"?>` +
      `<pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage">` +
      `<pkg:part pkg:name="/_rels/.rels" pkg:contentType="${rels}"><pkg:xmlData>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>` +
      `</Relationships></pkg:xmlData></pkg:part>` +
      `<pkg:part pkg:name="/word/_rels/document.xml.rels" pkg:contentType="${rels}"><pkg:xmlData>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdFigure" Type="${R_NS}/image" Target="media/figure.${info.ext}"/>` +
      `</Relationships></pkg:xmlData></pkg:part>` +
      `<pkg:part pkg:name="/word/media/figure.${info.ext}" pkg:contentType="${info.type}" pkg:compression="store">` +
      `<pkg:binaryData>${base64}</pkg:binaryData></pkg:part>` +
      `<pkg:part pkg:name="/word/document.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml">` +
      `<pkg:xmlData><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R_NS}">` +
      `<w:body>${body}</w:body></w:document></pkg:xmlData></pkg:part>` +
      `</pkg:package>`
    );
  }

  window.ClewWordFigures = { imageInfo, figurePackage };
})();
