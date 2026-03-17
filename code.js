figma.showUI(__html__, { width: 560, height: 780, title: '카드뉴스 제작기' });

// ─── 폰트 로드 ────────────────────────────────────────────────────────────────
async function loadFonts(family) {
  for (const style of ['Regular', 'Bold', 'Medium', 'SemiBold', 'Light']) {
    try { await figma.loadFontAsync({ family, style }); } catch (_) {}
  }
}

// ─── hex → RGB ────────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  hex = (hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

// ─── 생성된 프레임 ID 저장 ────────────────────────────────────────────────────
let lastFrameIds = [];

// ─── 메시지 처리 ──────────────────────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'cancel') { figma.closePlugin(); return; }

  // 슬라이드 생성
  if (msg.type === 'generate') {
    try {
      await loadFonts(msg.settings.fontFamily || 'Inter');

      const frames = [];
      lastFrameIds = [];
      let xOffset = 0;

      for (let i = 0; i < msg.slides.length; i++) {
        const frame = await buildSlide(msg.slides[i], i, msg.slides.length, msg.settings);
        frame.x = xOffset;
        frame.y = 0;
        figma.currentPage.appendChild(frame);
        xOffset += frame.width + 40;
        frames.push(frame);
        lastFrameIds.push(frame.id);
      }

      figma.viewport.scrollAndZoomIntoView(frames);
      figma.ui.postMessage({ type: 'generate-done', count: frames.length, frameIds: lastFrameIds });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: e.message });
    }
  }

  // PNG 내보내기
  if (msg.type === 'export-png') {
    try {
      const ids = msg.frameIds && msg.frameIds.length > 0 ? msg.frameIds : lastFrameIds;
      const results = [];

      for (const id of ids) {
        const node = figma.getNodeById(id);
        if (node && node.type === 'FRAME') {
          const bytes = await node.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: 2 },
          });
          results.push({ name: node.name, bytes: Array.from(bytes) });
        }
      }

      figma.ui.postMessage({ type: 'export-done', results });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: e.message });
    }
  }
};

// ─── 슬라이드 프레임 생성 ──────────────────────────────────────────────────────
async function buildSlide(slide, index, total, settings) {
  const W       = Number(settings.width)     || 1080;
  const H       = Number(settings.height)    || 1080;
  const PAD     = Number(settings.padding)   || 60;
  const FONT    = settings.fontFamily        || 'Inter';
  const T_SIZE  = Number(settings.titleSize) || 72;
  const B_SIZE  = Number(settings.bodySize)  || 32;
  const TAG_H   = 44;
  const TAG_FS  = 22;
  const INNER_W = W - PAD * 2;

  const frame = figma.createFrame();
  frame.name = `Slide ${index + 1}`;
  frame.resize(W, H);
  frame.clipsContent = true;

  // ── 배경 ──────────────────────────────────────────────────────────────────
  if (slide.bgType === 'image' && slide.bgImageBytes && slide.bgImageBytes.length > 0) {
    const imgBytes = new Uint8Array(slide.bgImageBytes);
    const image = figma.createImage(imgBytes);
    frame.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];

    // 어두운 오버레이
    const overlay = figma.createRectangle();
    overlay.name = 'Overlay';
    overlay.resize(W, H);
    const op = slide.overlayOpacity != null ? slide.overlayOpacity / 100 : 0.55;
    overlay.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: op }];
    frame.appendChild(overlay);
  } else {
    frame.fills = [{ type: 'SOLID', color: hexToRgb(slide.bgColor || '#1a1a1a') }];
  }

  const textRgb   = hexToRgb(slide.textColor   || '#ffffff');
  const accentRgb = hexToRgb(slide.accentColor  || '#7C5CFC');

  // ── 슬라이드 번호 (우상단) ──────────────────────────────────────────────────
  if (total > 1) {
    const numNode = figma.createText();
    try { numNode.fontName = { family: FONT, style: 'Regular' }; } catch (_) {}
    numNode.fontSize = 20;
    numNode.textAutoResize = 'WIDTH_AND_HEIGHT';
    numNode.characters = `${index + 1} / ${total}`;
    numNode.fills = [{ type: 'SOLID', color: textRgb, opacity: 0.45 }];
    numNode.x = W - PAD - numNode.width;
    numNode.y = PAD;
    frame.appendChild(numNode);
  }

  // ── 콘텐츠 영역 높이 추정 (하단 정렬용) ──────────────────────────────────────
  const tags    = (slide.tags || []).filter(t => t.trim());
  const hasTags = tags.length > 0;
  const hasBody = !!(slide.body && slide.body.trim());

  const tagsH   = hasTags ? TAG_H + 24 : 0;
  const cpl     = Math.max(1, Math.floor(INNER_W / (T_SIZE * 0.55)));
  const tLines  = Math.max(1, Math.ceil((slide.title || '').length / cpl));
  const estTH   = tLines * Math.round(T_SIZE * 1.35);
  let   estBH   = 0;
  if (hasBody) {
    const bcpl  = Math.max(1, Math.floor(INNER_W / (B_SIZE * 0.55)));
    const bLines = Math.max(1, Math.ceil(slide.body.length / bcpl));
    estBH = bLines * Math.round(B_SIZE * 1.5) + 24;
  }

  let curY = Math.max(H * 0.48, H - PAD - tagsH - estTH - estBH);

  // ── 태그/뱃지 ───────────────────────────────────────────────────────────────
  if (hasTags) {
    let tagX = PAD;

    for (const tag of tags) {
      const TPADX = 16;

      // 텍스트 먼저 생성해 너비 측정
      const tagTxt = figma.createText();
      try { tagTxt.fontName = { family: FONT, style: 'Medium' }; } catch (_) {}
      tagTxt.fontSize = TAG_FS;
      tagTxt.textAutoResize = 'WIDTH_AND_HEIGHT';
      tagTxt.characters = tag.trim();
      tagTxt.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];

      const tagW = tagTxt.width + TPADX * 2;

      // 배경 박스
      const tagBg = figma.createRectangle();
      tagBg.cornerRadius = 8;
      tagBg.resize(tagW, TAG_H);
      tagBg.fills = [{ type: 'SOLID', color: accentRgb, opacity: 0.9 }];
      tagBg.x = tagX;
      tagBg.y = curY;

      tagTxt.x = tagX + TPADX;
      tagTxt.y = curY + Math.round((TAG_H - tagTxt.height) / 2);

      frame.appendChild(tagBg);
      frame.appendChild(tagTxt);
      tagX += tagW + 12;
    }
    curY += TAG_H + 24;
  }

  // ── 제목 ───────────────────────────────────────────────────────────────────
  const titleNode = figma.createText();
  try { titleNode.fontName = { family: FONT, style: 'Bold' }; } catch (_) {}
  titleNode.fontSize = T_SIZE;
  titleNode.fills = [{ type: 'SOLID', color: textRgb }];
  titleNode.textAutoResize = 'HEIGHT';
  titleNode.lineHeight = { unit: 'PERCENT', value: 135 };
  titleNode.resize(INNER_W, 100);
  titleNode.characters = slide.title || ' ';
  titleNode.x = PAD;
  titleNode.y = curY;
  frame.appendChild(titleNode);
  curY += titleNode.height + 20;

  // ── 본문 ───────────────────────────────────────────────────────────────────
  if (hasBody) {
    const bodyNode = figma.createText();
    try { bodyNode.fontName = { family: FONT, style: 'Regular' }; } catch (_) {}
    bodyNode.fontSize = B_SIZE;
    bodyNode.fills = [{ type: 'SOLID', color: textRgb, opacity: 0.75 }];
    bodyNode.textAutoResize = 'HEIGHT';
    bodyNode.lineHeight = { unit: 'PERCENT', value: 150 };
    bodyNode.resize(INNER_W, 100);
    bodyNode.characters = slide.body;
    bodyNode.x = PAD;
    bodyNode.y = curY;
    frame.appendChild(bodyNode);
  }

  return frame;
}
