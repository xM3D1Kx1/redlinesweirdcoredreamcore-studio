/* DREZZDON AI — студия разметки.
 *
 * Один файл, без зависимостей:
 *   фото -> /api/analyze (локальный сервер -> Gemini) -> векторная разметка на холсте
 *   рамки можно таскать, подписи — править двойным кликом.
 */
(function () {
  'use strict';

  /* ------------------------------- DOM ------------------------------- */

  var $ = function (id) { return document.getElementById(id); };

  var canvas = $('editorCanvas');
  var ctx = canvas.getContext('2d');
  var stage = $('stage');
  var fileInput = $('fileInput');
  var btnSave = $('btnSave');
  var btnRedo = $('btnRedo');
  var btnNext = $('btnNext');
  var btnCompare = $('btnCompare');
  var langSel = $('captionLang');
  var emptyHint = $('emptyHint');
  var statusDot = $('statusDot');
  var statusText = $('statusText');
  var statSession = $('statSession');
  var statVariant = $('statVariant');
  var statRes = $('statRes');
  var confBadge = $('confBadge');
  var elCount = $('elCount');
  var elementList = $('elementList');
  var toasts = $('toasts');

  /* ------------------------------ состояние ------------------------------ */

  var LS_PHOTO = 'drezzdon_last_photo_v2';
  var LS_LANG = 'drezzdon_lang_v1';

  var state = {
    image: null,
    fileName: '',
    elements: [],
    selected: null,
    compare: false,
    busy: false,
    session: 0,
    variant: 1,
    model: '',
    analysis: null,
    history: [],
    hIndex: -1
  };

  // отношение «пикселей холста» к «пикселям на экране»: нужно, чтобы подписи
  // оставались читаемыми на телефоне, где картинка показывается мелко
  var displayScale = 1;

  /* ------------------------------- утилиты ------------------------------- */

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var SCENE_RU = {
    sky_signal: 'Небо и сигнал',
    urban_silhouette: 'Городской силуэт',
    vehicle_street: 'Машина на улице',
    brutalist_architecture: 'Архитектура',
    portrait: 'Портрет',
    nature_landscape: 'Пейзаж',
    object_detail: 'Деталь объекта',
    interior: 'Интерьер'
  };

  var KIND_NAMES = {
    box_with_arrow: 'Рамка + стрелка + подпись',
    bracket_frame: 'Угловые маркеры + текст',
    dashed_contour: 'Пунктирный контур',
    center_glyph: 'Центральный глиф + подпись',
    technical_tag: 'Технический тег',
    puddle_outline: 'Пунктирный овал'
  };

  /* -------------------------------- тосты -------------------------------- */

  function toast(text, kind) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
    el.textContent = text;
    toasts.appendChild(el);
    setTimeout(function () {
      el.classList.add('hide');
      setTimeout(function () { el.remove(); }, 300);
    }, kind === 'warn' ? 6000 : 3800);
  }

  /* --------------------------- статус и конвейер --------------------------- */

  function setStatus(text, kind, badge) {
    statusText.textContent = text;
    statusDot.className = 'dot' + (kind && kind !== 'idle' ? ' ' + kind : '');
    statusDot.textContent = badge == null ? '' : String(badge);
  }

  function setStep(n, st, text) {
    var li = document.querySelector('.steps li[data-step="' + n + '"]');
    if (!li) return;
    li.className = st || '';
    var ico = li.querySelector('.ico');
    if (st === 'done') ico.textContent = '✓';
    else if (st === 'err') ico.textContent = '!';
    else ico.textContent = String(n);
    if (text) li.querySelector('p').textContent = text;
  }

  function resetPipeline() {
    setStep(1, '', 'Ожидание фото');
    setStep(2, '', 'Ожидание анализа');
    setStep(3, '', 'Ожидание разметки');
    confBadge.textContent = 'уверенность —';
  }

  function setConfidence(v) {
    var n = v === null || v === undefined || v === '' ? NaN : Number(v);
    confBadge.textContent = isFinite(n) && n > 0 ? 'уверенность ' + Math.round(n * 100) + '%' : 'уверенность —';
  }

  function updateStats() {
    statSession.textContent = 'Сессия: ' + state.session + ' фото';
    statVariant.textContent = 'Вариант: #' + state.variant;
    statRes.textContent = state.image ? canvas.width + '×' + canvas.height + ' px' : '—';
  }

  function setBusyUI(v) {
    state.busy = v;
    btnSave.disabled = v;
    btnRedo.disabled = v;
    btnNext.disabled = v;
    btnRedo.style.opacity = v ? '0.5' : '1';
  }

  /* ------------------------------- картинка ------------------------------- */

  function readFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        state.session += 1;
        applyImage(img, file.name);
        rememberPhoto(img);
        analyze(false);
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  }

  function fitCanvasToStage() {
    if (!state.image) {
      canvas.style.width = '';
      canvas.style.height = '';
      return;
    }
    var chrome = window.innerWidth <= 700 ? 372 : 306;
    var availH = Math.max(200, window.innerHeight - chrome);
    var availW = Math.max(200, stage.clientWidth - 28);
    var ratio = canvas.width / canvas.height;
    var w = Math.min(availW, availH * ratio);
    var h = w / ratio;
    canvas.style.width = Math.round(w) + 'px';
    canvas.style.height = Math.round(h) + 'px';
    displayScale = w / canvas.width;
  }

  function applyImage(img, name) {
    var MAX = 1200;
    var w = img.width || img.naturalWidth;
    var h = img.height || img.naturalHeight;
    if (Math.max(w, h) > MAX) {
      var k = MAX / Math.max(w, h);
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    canvas.width = w;
    canvas.height = h;
    state.image = img;
    state.fileName = name || 'фото';
    state.elements = [];
    state.selected = null;
    state.compare = false;
    state.history = [];
    state.hIndex = -1;
    pushHistory();
    btnCompare.textContent = 'Показать оригинал';
    btnCompare.classList.remove('on');
    $('fileName').textContent = state.fileName;
    emptyHint.classList.add('hide');
    resetPipeline();
    updateStats();
    fitCanvasToStage();
    render();
    renderList();
  }

  function rememberPhoto(img) {
    try {
      localStorage.setItem(LS_PHOTO, compressToDataUrl(img, 900, 0.8));
    } catch (e) {
      /* не влезло — не страшно */
    }
  }

  function compressToDataUrl(img, maxSide, quality) {
    var w = img.width || img.naturalWidth;
    var h = img.height || img.naturalHeight;
    var k = Math.min(1, maxSide / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    var g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  function restoreLastPhoto() {
    var saved = null;
    try { saved = localStorage.getItem(LS_PHOTO); } catch (e) { return; }
    if (!saved) return;
    var img = new Image();
    img.onload = function () {
      applyImage(img, 'восстановленное фото');
      setStatus('Прошлое фото восстановлено. Нажмите «Переделать оформление», чтобы разметить.', 'idle', 0);
      toast('Прошлое фото на месте — можно разметить заново');
    };
    img.src = saved;
  }

  /* ------------------------------- отрисовка ------------------------------- */

  var placedRects = [];
  var boxRects = [];

  function rectsOverlap(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }

  function hitsPlaced(r) {
    for (var i = 0; i < placedRects.length; i++) {
      if (rectsOverlap(r, placedRects[i])) return true;
    }
    return false;
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    placedRects = [];
    boxRects = [];
    if (!state.image) {
      drawPlaceholder();
      return;
    }
    ctx.save();
    ctx.filter = state.compare ? 'none' : 'contrast(1.05) saturate(0.9) brightness(0.96)';
    ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    if (state.compare) return;

    for (var i = 0; i < state.elements.length; i++) drawElement(state.elements[i]);
    if (state.selected) drawSelection(state.selected);
  }

  function drawPlaceholder() {
    var W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#0d0d13';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,.035)';
    ctx.lineWidth = 1;
    var step = 60;
    for (var x = step; x < W; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (var y = step; y < H; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,43,43,.10)';
    ctx.font = '400 ' + Math.round(W * 0.18) + 'px ' + FONT_HEAD;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DZ', W / 2, H / 2);
  }

  function applyRedStyle(lw, glow) {
    ctx.strokeStyle = '#ff1e1e';
    ctx.fillStyle = '#ff1e1e';
    ctx.lineWidth = lw;
    ctx.shadowColor = 'rgba(255, 20, 20, 0.85)';
    ctx.shadowBlur = glow;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function drawArrowHead(x1, y1, x2, y2, size) {
    var angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function baseFontPx() {
    return Math.max(16, Math.round(canvas.width * 0.032));
  }

  function drawElement(el) {
    ctx.save();
    applyRedStyle(Math.max(2.5, canvas.width * 0.005), 12);
    if (el.type === 'aiBox') drawBox(el);
    else if (el.type === 'aiHeadline') drawHeadline(el);
    else if (el.type === 'aiLink') drawLink(el);
    else if (el.type === 'dashedPath') drawPath(el);
    ctx.restore();
  }

  function drawPath(el) {
    if (!el.pts || el.pts.length < 2) return;
    ctx.setLineDash([12, 10]);
    ctx.beginPath();
    el.pts.forEach(function (p, i) {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }

  function drawBrackets(x, y, w, h, len, lw) {
    ctx.save();
    ctx.lineWidth = lw;
    ctx.setLineDash([]);
    var corners = [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
    corners.forEach(function (c) {
      ctx.beginPath();
      ctx.moveTo(c[0], c[1] + c[3] * len);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0] + c[2] * len, c[1]);
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawBox(el) {
    var W = canvas.width;
    var lw = Math.max(2, W * 0.0035);
    ctx.lineWidth = lw;
    var g = el.graphic;
    boxRects.push({ x: el.x, y: el.y, w: el.w, h: el.h });

    if (g === 'bracket_frame') {
      drawBrackets(el.x, el.y, el.w, el.h, Math.min(el.w, el.h) * 0.3, lw);
    } else if (g === 'puddle_outline') {
      ctx.setLineDash([6, 7]);
      ctx.beginPath();
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (g === 'dashed_contour') {
      ctx.setLineDash([12, 10]);
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      ctx.setLineDash([]);
    } else if (g === 'center_glyph') {
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      var cx = el.x + el.w / 2;
      var cy = el.y + el.h / 2;
      var r = Math.min(el.w, el.h) * 0.12;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.7, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.setLineDash([]);
      ctx.strokeRect(el.x, el.y, el.w, el.h);
    }

    drawCaption(el);
  }

  var FONT_HEAD = "'Anton','Arial Narrow',Arial,sans-serif";
  var FONT_CAP = "'Oswald','Arial Narrow',Arial,sans-serif";
  var FONT_SERIF = "Georgia,'Times New Roman',serif";

  function fitFont(text, maxWidth, startSize, minSize) {
    var fs = startSize;
    var floor = minSize || 10;
    ctx.font = '500 ' + fs + 'px ' + FONT_CAP;
    while (fs > floor && ctx.measureText(text).width > maxWidth) {
      fs -= 1;
      ctx.font = '500 ' + fs + 'px ' + FONT_CAP;
    }
    return fs;
  }

  // минимальный размер шрифта в пикселях холста, чтобы на экране было не мельче ~11px
  function minChromeFont() {
    return Math.round(10 / Math.max(0.2, displayScale));
  }

  // тёмная плашка под подписью — если места мало и текст ложится на графику
  function drawPlate(r) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(6,6,10,.76)';
    ctx.strokeStyle = 'rgba(255,60,60,.30)';
    ctx.lineWidth = 1;
    var rad = 4;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(r.x, r.y, r.w, r.h, rad);
    } else {
      ctx.rect(r.x, r.y, r.w, r.h);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  var OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

  function captionGeometry(el, side, fs, tw) {
    var W = canvas.width, H = canvas.height;
    var g = { side: side, align: 'center', fits: false };
    if (side === 'top') {
      g.tx = el.x + el.w / 2;
      g.ty = el.y - 10;
      g.fits = el.y - 10 - fs > 4 && g.tx - tw / 2 > 4 && g.tx + tw / 2 < W - 4;
    } else if (side === 'bottom') {
      g.tx = el.x + el.w / 2;
      g.ty = el.y + el.h + fs + 8;
      g.fits = g.ty < H - 4 && g.tx - tw / 2 > 4 && g.tx + tw / 2 < W - 4;
    } else if (side === 'left') {
      g.tx = el.x - 8;
      g.ty = el.y + el.h / 2 + fs * 0.35;
      g.align = 'right';
      g.fits = g.tx - tw > 4;
    } else {
      g.side = 'right';
      g.tx = el.x + el.w + 8;
      g.ty = el.y + el.h / 2 + fs * 0.35;
      g.align = 'left';
      g.fits = g.tx + tw < W - 4;
    }
    // ручной сдвиг подписи относительно рамки
    if (el.capDx) g.tx += el.capDx;
    if (el.capDy) g.ty += el.capDy;
    var rx = g.align === 'center' ? g.tx - tw / 2 : g.align === 'right' ? g.tx - tw : g.tx;
    g.fits = rx > 4 && rx + tw < W - 4 && g.ty - fs > 2 && g.ty < H - 4;
    return g;
  }

  function captionRect(g, fs, tw) {
    var x = g.align === 'center' ? g.tx - tw / 2 : g.align === 'right' ? g.tx - tw : g.tx;
    return { x: x - 2, y: g.ty - fs * 1.1, w: tw + 4, h: fs * 1.35 };
  }

  function drawCaption(el) {
    if (!el.caption) return;
    var W = canvas.width, H = canvas.height;
    var fs = fitFont(
      el.caption,
      W * 0.52,
      Math.max(minChromeFont(), Math.round(baseFontPx() * 0.5)),
      Math.round(minChromeFont() * 0.7)
    );
    var tw = ctx.measureText(el.caption).width;
    var wish = el.side || 'bottom';
    var order = [wish, OPPOSITE[wish], 'top', 'bottom', 'right', 'left'];

    var g = null;
    for (var i = 0; i < order.length; i++) {
      var cand = captionGeometry(el, order[i], fs, tw);
      if (cand.fits && !hitsPlaced(captionRect(cand, fs, tw))) { g = cand; break; }
    }
    // свободного места рядом нет — берём заказанную сторону, но поджимаем внутрь кадра
    if (!g) {
      for (var j = 0; j < order.length; j++) {
        var c2 = captionGeometry(el, order[j], fs, tw);
        if (c2.fits) { g = c2; break; }
      }
    }
    if (!g) {
      g = captionGeometry(el, wish, fs, tw);
      if (g.align === 'center') g.tx = clamp(g.tx, tw / 2 + 6, W - tw / 2 - 6);
      else if (g.align === 'right') g.tx = Math.max(tw + 6, g.tx);
      else g.tx = Math.min(W - tw - 6, g.tx);
      g.ty = clamp(g.ty, fs + 4, H - 6);
    }
    var capBox = captionRect(g, fs, tw);
    el._capRect = capBox;
    var onGraphics = false;
    for (var b = 0; b < boxRects.length; b++) {
      if (rectsOverlap(capBox, boxRects[b])) { onGraphics = true; break; }
    }
    if (onGraphics || hitsPlaced(capBox)) drawPlate(capBox);
    placedRects.push(capBox);

    var prevColor = ctx.strokeStyle;
    ctx.beginPath();
    if (g.side === 'top' || g.side === 'bottom') {
      var ay = g.side === 'top' ? el.y : el.y + el.h;
      var dir = g.side === 'top' ? -1 : 1;
      ctx.moveTo(el.x + el.w / 2, ay);
      ctx.lineTo(el.x + el.w / 2, ay + dir * 5);
    } else {
      var ax = g.side === 'left' ? el.x : el.x + el.w;
      var dx = g.side === 'left' ? -1 : 1;
      ctx.moveTo(ax, el.y + el.h / 2);
      ctx.lineTo(ax + dx * 5, el.y + el.h / 2);
    }
    ctx.stroke();

    ctx.font = '600 ' + fs + 'px ' + FONT_CAP;
    ctx.textAlign = g.align;
    ctx.textBaseline = 'alphabetic';
    ctx.setLineDash([]);

    var prevWidth = ctx.lineWidth;
    ctx.lineWidth = Math.max(2, fs * 0.22);
    ctx.strokeStyle = 'rgba(4,4,7,.82)';
    ctx.strokeText(el.caption, g.tx, g.ty);
    ctx.lineWidth = prevWidth;
    ctx.strokeStyle = prevColor;
    ctx.fillText(el.caption, g.tx, g.ty);
  }

  function drawHeadline(el) {
    var W = canvas.width, H = canvas.height;
    var fs1 = fitFont(
      el.l1 || '',
      W * 0.7,
      Math.max(Math.round(minChromeFont() * 1.7), Math.round(baseFontPx() * 1.15)),
      Math.round(minChromeFont())
    );
    var fs2 = Math.round(fs1 * 0.62);
    var tx = clamp(el.x, 6, W * 0.6);
    var ty = clamp(el.y, fs1 + 8, H * 0.85);

    ctx.textAlign = 'left';
    ctx.setLineDash([]);
    var w1 = 0, w2 = 0;
    if (el.l1) {
      ctx.font = '400 ' + fs1 + 'px ' + FONT_HEAD;
      ctx.fillText(String(el.l1).toUpperCase(), tx, ty);
      w1 = ctx.measureText(String(el.l1).toUpperCase()).width;
    }
    if (el.l2) {
      ctx.font = 'italic 500 ' + fs2 + 'px ' + FONT_SERIF;
      ctx.fillText(el.l2, tx, ty + fs2 + 6);
      w2 = ctx.measureText(el.l2).width;
      ctx.lineWidth = Math.max(1.5, W * 0.0022);
      ctx.beginPath();
      ctx.moveTo(tx, ty + fs2 + 12);
      ctx.lineTo(tx + w2, ty + fs2 + 12);
      ctx.stroke();
    }
    placedRects.push({
      x: tx - 4,
      y: ty - fs1 - 4,
      w: Math.max(w1, w2) + 10,
      h: fs1 + fs2 + 24
    });
  }

  function drawLink(el) {
    var midX = el.bx;
    var midY = el.ay;
    ctx.setLineDash(el.dashed ? [8, 7] : []);
    ctx.beginPath();
    ctx.moveTo(el.ax, el.ay);
    ctx.lineTo(midX, midY);
    ctx.lineTo(el.bx, el.by);
    ctx.stroke();
    drawArrowHead(midX, midY, el.bx, el.by, 14);
  }

  function drawSelection(el) {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = Math.max(1, canvas.width * 0.0018);
    ctx.setLineDash([7, 6]);
    if (el.type === 'aiBox') {
      ctx.strokeRect(el.x - 7, el.y - 7, el.w + 14, el.h + 14);
      // ручки изменения размера
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      var hs = Math.max(6, canvas.width * 0.008);
      [[el.x, el.y], [el.x + el.w, el.y], [el.x, el.y + el.h], [el.x + el.w, el.y + el.h]].forEach(
        function (c) {
          ctx.fillRect(c[0] - hs / 2, c[1] - hs / 2, hs, hs);
        }
      );
    } else if (el.type === 'aiHeadline') {
      var fs = Math.round(baseFontPx() * 1.15);
      ctx.strokeRect(el.x - 8, el.y - fs - 8, Math.min(canvas.width * 0.72, 320), fs * 2.2);
    }
    ctx.restore();
  }

  /* --------------------- ответ Gemini -> элементы --------------------- */

  function buildElements(analysis) {
    var W = canvas.width, H = canvas.height;
    var out = [];
    var byId = {};
    var boxEls = [];

    var dets = Array.isArray(analysis && analysis.detections) ? analysis.detections.slice(0, 3) : [];

    dets.forEach(function (d, i) {
      var b = d && d.box_2d;
      if (!Array.isArray(b) || b.length !== 4) return;
      var ymin = Number(b[0]), xmin = Number(b[1]), ymax = Number(b[2]), xmax = Number(b[3]);
      if (!isFinite(ymin + xmin + ymax + xmax)) return;

      var x = (Math.min(xmin, xmax) / 1000) * W;
      var y = (Math.min(ymin, ymax) / 1000) * H;
      var w = (Math.abs(xmax - xmin) / 1000) * W;
      var h = (Math.abs(ymax - ymin) / 1000) * H;

      w = clamp(w, W * 0.045, W * 0.92);
      h = clamp(h, H * 0.03, H * 0.92);
      x = clamp(x, 6, W - w - 6);
      y = clamp(y, 6, H - h - 6);

      var caption = String((d.caption || d.label || '')).replace(/\s+/g, ' ').trim();
      if (caption.length > 40) caption = caption.slice(0, 39) + '…';

      // дубли по площади выбрасываем: две рамки на одном объекте — визуальный мусор
      var dup = false;
      for (var bi = 0; bi < boxEls.length; bi++) {
        var b2 = boxEls[bi];
        var ix = Math.max(0, Math.min(x + w, b2.x + b2.w) - Math.max(x, b2.x));
        var iy = Math.max(0, Math.min(y + h, b2.y + b2.h) - Math.max(y, b2.y));
        var inter = ix * iy;
        var union = w * h + b2.w * b2.h - inter;
        if (union > 0 && inter / union > 0.45) {
          dup = true;
          break;
        }
      }
      if (dup) return;

      // --- ремонт геометрии ---
      // Модель любит обводить «регион»: полосу горизонта, провода, полкадра.
      // Тонкая длинная полоса — это линия, а не рамка: рисуем пунктир по её оси.
      var midX = x + w / 2;
      var midY = y + h / 2;
      var nearEdge =
        midX < W * 0.07 || midX > W * 0.93 || midY < H * 0.07 || midY > H * 0.93;

      if (h > H * 0.55 && w < W * 0.12) {
        // вертикальная полоса на всю высоту (девушка лежит, «линия» справа)
        if (midX < W * 0.15 || midX > W * 0.85) return; // у края кадра — артефакт
        out.push({
          type: 'dashedPath',
          pts: [{ x: midX, y: y }, { x: midX, y: y + h }]
        });
        return;
      }
      if (w > W * 0.55 && h < H * 0.12) {
        if (midY < H * 0.15 || midY > H * 0.85) return;
        out.push({
          type: 'dashedPath',
          pts: [{ x: x, y: midY }, { x: x + w, y: midY }]
        });
        return;
      }
      // Слишком крупную рамку ужимаем к её центру: 50% стороны и 20% площади — предел.
      if (w > W * 0.5) {
        x = x + (w - W * 0.5) / 2;
        w = W * 0.5;
      }
      if (h > H * 0.5) {
        y = y + (h - H * 0.5) / 2;
        h = H * 0.5;
      }
      var areaFrac = (w * h) / (W * H);
      if (areaFrac > 0.2) {
        var k = Math.sqrt(0.2 / areaFrac);
        var nw = w * k;
        var nh = h * k;
        x = x + (w - nw) / 2;
        y = y + (h - nh) / 2;
        w = nw;
        h = nh;
      }

      var el = {
        type: 'aiBox',
        x: x, y: y, w: w, h: h,
        caption: caption,
        label: String(d.label || '').replace(/\s+/g, ' ').trim(),
        graphic: d.graphic_type || 'box_with_arrow',
        side: d.preferred_label_side || 'bottom',
        index: i + 1,
        confidence: Number(d.confidence) || null
      };
      out.push(el);
      boxEls.push(el);
      if (d.id) byId[d.id] = el;
    });

    var conns = Array.isArray(analysis && analysis.connections) ? analysis.connections : [];
    conns.slice(0, 1).forEach(function (c) {
      var a = byId[c && c.from_id];
      var b = byId[c && c.to_id];
      if (!a || !b) return;
      out.push({
        type: 'aiLink',
        ax: a.x + a.w / 2, ay: a.y + a.h / 2,
        bx: b.x + b.w / 2, by: b.y + b.h / 2,
        dashed: c.style === 'dashed_line',
        caption: c.label || ''
      });
    });

    var persp = Array.isArray(analysis && analysis.perspective_lines) ? analysis.perspective_lines : [];
    persp.slice(0, 1).forEach(function (p) {
      if (!p || !Array.isArray(p.points) || p.points.length < 2) return;
      var pts = p.points.slice(0, 4).map(function (pt) {
        return { x: clamp(Number(pt[0]) / 1000 * W, 0, W), y: clamp(Number(pt[1]) / 1000 * H, 0, H) };
      });
      var mx = 0, my = 0;
      pts.forEach(function (q) { mx += q.x; my += q.y; });
      mx /= pts.length;
      my /= pts.length;
      // линия, прижатая к краю кадра, или короткая — почти всегда артефакт
      if (mx < W * 0.12 || mx > W * 0.88 || my < H * 0.12 || my > H * 0.88) return;
      var dx = pts[pts.length - 1].x - pts[0].x;
      var dy = pts[pts.length - 1].y - pts[0].y;
      if (Math.hypot(dx, dy) < Math.max(W, H) * 0.12) return;
      out.push({ type: 'dashedPath', pts: pts });
    });

    var hc = analysis && analysis.headline_caption;
    if (hc && (hc.text_line_1 || hc.text_line_2)) {
      var anchor = Array.isArray(hc.anchor_box) ? hc.anchor_box : [80, 80, 200, 400];
      var head = {
        type: 'aiHeadline',
        x: clamp(Number(anchor[1]) / 1000 * W, 0, W * 0.6),
        y: clamp(Number(anchor[0]) / 1000 * H, 0, H * 0.7),
        l1: String(hc.text_line_1 || '').trim(),
        l2: String(hc.text_line_2 || '').trim()
      };
      placeHeadline(head, boxEls);
      out.unshift(head); // заголовок рисуется первым — подписи обходят его стороной
    }

    return out;
  }

  // Заголовок ставим туда, где меньше всего пересечений с рамками:
  // перебираем сетку позиций + точку от модели, ничьи разрешаем в пользу модели.
  function placeHeadline(el, boxes) {
    var W = canvas.width, H = canvas.height;
    var fs = Math.round(baseFontPx() * 1.15);
    ctx.font = '400 ' + fs + 'px ' + FONT_HEAD;
    var tw = Math.max(
      ctx.measureText(String(el.l1 || '').toUpperCase()).width,
      ctx.measureText(el.l2 || '').width
    );
    var th = fs * 2.15;
    var m = 12;

    var cands = [{ x: el.x, y: el.y }];
    var cols = 6, rows = 6;
    var mx = Math.max(14, W * 0.04);
    var my = Math.max(14, H * 0.05);
    for (var c = 0; c < cols; c++) {
      for (var r = 0; r < rows; r++) {
        var cx = mx + (c / (cols - 1)) * Math.max(0, W - tw - mx * 2);
        var cy = fs + my + (r / (rows - 1)) * Math.max(0, H - th - fs - my * 2);
        cands.push({ x: cx, y: cy });
      }
    }

    var best = null;
    var bestScore = Infinity;
    var frameArea = W * H;

    cands.forEach(function (cand, idx) {
      var r = { x: cand.x, y: cand.y - fs * 1.15, w: tw + 8, h: th };
      if (r.x < mx * 0.6 || r.y < my * 0.6 || r.x + r.w > W - mx * 0.6 || r.y + r.h > H - my * 0.6) return;
      var score = 0;
      boxes.forEach(function (b) {
        var ow = Math.max(0, Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x));
        var oh = Math.max(0, Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y));
        score += ow * oh;
      });
      // композиция как на референсах: ближе к верху и к центру по горизонтали
      var cxr = (r.x + r.w / 2) / W;
      score += Math.abs(cxr - 0.5) * 0.07 * frameArea;
      score += Math.abs(r.y / H - 0.10) * 0.05 * frameArea;
      // небольшая премия позиции, которую предложила модель
      if (idx === 0) score *= 0.9;
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    });

    if (best) {
      el.x = best.x;
      el.y = best.y;
    }
  }

  /* ------------------------- список элементов ------------------------- */

  function itemTitle(el) {
    if (el.type === 'aiHeadline') return 'Типографика (заголовок)';
    if (el.type === 'aiLink') return 'Связь между деталями';
    if (el.type === 'dashedPath') return 'Линия перспективы';
    return KIND_NAMES[el.graphic] || 'Рамка';
  }

  function itemSub(el) {
    if (el.type === 'aiHeadline') return el.l2 ? 'Вторая строка: ' + el.l2 : 'Крупный заголовок в свободной зоне';
    if (el.type === 'aiLink') return 'Ортогональная связь между рамками';
    if (el.type === 'dashedPath') return 'Пунктир по грани кадра';
    return el.label || 'Деталь сцены';
  }

  function itemCaption(el) {
    if (el.type === 'aiHeadline') return '«' + (el.l1 || '') + '»';
    if (el.type === 'dashedPath') return '';
    return el.caption ? '«' + el.caption + '»' : '';
  }

  function renderList() {
    elementList.innerHTML = '';
    var drawable = state.elements.filter(function (e) { return e.type !== 'aiLink' && e.type !== 'dashedPath'; });
    var total = state.elements.length;
    elCount.textContent = total === 0 ? '0 элементов' : total + ' элементов';

    if (!state.elements.length) {
      var p = document.createElement('p');
      p.className = 'list-empty';
      p.textContent = state.image
        ? 'Разметки пока нет — нажмите «Переделать оформление».'
        : 'Здесь появится список того, что модель нашла на фото.';
      elementList.appendChild(p);
      return;
    }

    state.elements.forEach(function (el, i) {
      var row = document.createElement('div');
      row.className = 'item' + (state.selected === el ? ' on' : '');

      var top = document.createElement('div');
      top.className = 'item-top';
      var name = document.createElement('span');
      name.textContent = (i + 1) + '. ' + itemTitle(el);
      top.appendChild(name);
      var confNum = el.confidence || (el.type === 'aiHeadline' && state.analysis ? state.analysis.overall_confidence : null);
      var conf = confNum ? Math.round(Number(confNum) * 100) + '%' : '';
      if (conf) {
        var c = document.createElement('span');
        c.className = 'item-conf';
        c.textContent = conf;
        top.appendChild(c);
      }

      var sub = document.createElement('div');
      sub.className = 'item-sub';
      sub.textContent = itemSub(el);

      row.appendChild(top);
      row.appendChild(sub);

      var cap = itemCaption(el);
      if (cap) {
        var cc = document.createElement('div');
        cc.className = 'item-cap';
        cc.textContent = cap;
        row.appendChild(cc);
      }

      row.addEventListener('click', function () {
        state.selected = el;
        render();
        renderList();
      });

      elementList.appendChild(row);
    });

    // подсветить выбранный
    var sel = elementList.querySelector('.item.on');
    if (sel && drawable.length) sel.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------- анализ ------------------------------- */

  function currentLang() {
    return langSel && langSel.value === 'ru' ? 'ru' : 'drezzdon_en';
  }

  function describeScene(a) {
    var t = SCENE_RU[a.scene_type] || a.scene_type || 'сцена';
    var mood = a.dominant_mood ? ' · ' + a.dominant_mood : '';
    return t.charAt(0).toUpperCase() + t.slice(1) + mood;
  }

  async function analyze(isRedo) {
    if (!state.image || state.busy) {
      if (!state.image) toast('Сначала загрузите фото', 'warn');
      return;
    }

    setBusyUI(true);
    state.variant = isRedo ? state.variant + 1 : 1;
    updateStats();
    setStatus('Анализирую фото…', 'busy', 1);
    setStep(1, 'active', 'Gemini смотрит на кадр…');
    setStep(2, '', 'Ожидание анализа');
    setStep(3, '', 'Ожидание разметки');

    try {
      var res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: compressToDataUrl(state.image, 1024, 0.85),
          mimeType: 'image/jpeg',
          variantSeed: (state.variant - 1) % 4,
          langMode: currentLang()
        })
      });

      var payload = null;
      try { payload = await res.json(); } catch (e) { payload = null; }
      if (!res.ok || !payload || !payload.analysis) {
        throw new Error((payload && payload.error) || 'HTTP ' + res.status);
      }

      var a = payload.analysis;
      state.analysis = a;
      state.model = payload.model || '';

      setStep(1, 'done', describeScene(a));

      setStep(2, 'active', 'Формирую подписи…');
      setStatus('Генерирую подписи…', 'busy', 2);
      await sleep(150);

      state.elements = buildElements(a);
      state.selected = null;
      pushHistory();
      var boxes = state.elements.filter(function (e) { return e.type === 'aiBox'; }).length;
      setStep(2, 'done', 'Сформировано ' + boxes + ' осмысленных акцентов (вариант #' + state.variant + ')');

      setStep(3, 'active', 'Векторный рендеринг…');
      setStatus('Отрисовываю разметку…', 'busy', 3);
      render();
      renderList();
      await sleep(160);

      setStep(3, 'done', 'Отрисовано в ' + canvas.width + '×' + canvas.height + ' px' + (state.model ? ' · ' + state.model : ''));
      setConfidence(a.overall_confidence);
      setStatus('Готово! Можно сохранить фото или загрузить следующее.', 'done', 3);
      toast('Анализ и красная разметка DREZZDON завершены');
    } catch (err) {
      var msg = String(err && err.message ? err.message : err);
      var drewLocally = localFallback(msg);
      setStatus(
        (drewLocally ? 'Gemini недоступен — нарисовал локально. ' : 'Ошибка: ') + msg.slice(0, 110),
        'err',
        '!'
      );
      toast(
        drewLocally
          ? 'Gemini не ответил — включил локальный режим. Проверьте VPN и попробуйте «Переделать».'
          : 'Gemini не ответил: ' + msg.slice(0, 160),
        'warn'
      );
    } finally {
      setBusyUI(false);
    }
  }

  /* --------------------------- локальный режим --------------------------- */
  // Если Gemini недоступен (нет связи, VPN, квота) — размечаем сами:
  // ищем самый контрастный участок кадра и ставим рамки по нему.
  // Хуже, чем ИИ, но фото никогда не остаётся пустым.

  var LOCAL = {
    headline: [
      ['still here', 'after all'],
      ['the same', 'place again'],
      ['nothing moved', 'since then'],
      ['quiet signal', 'from far away']
    ],
    subject: ['still waiting <3', 'do not look back', 'someone is here', 'i remember this'],
    technical: ['0.0° // silent line', 'field // empty', '24V // static', 'ground // level'],
    detail: ['soft edge', 'cold light', 'slow drift', 'warm noise']
  };

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function localFallback(reason) {
    if (!state.image) return false;
    var W = canvas.width, H = canvas.height;

    var off = document.createElement('canvas');
    off.width = 100;
    off.height = 100;
    var octx = off.getContext('2d');
    octx.drawImage(state.image, 0, 0, 100, 100);
    var data;
    try {
      data = octx.getImageData(0, 0, 100, 100).data;
    } catch (e) {
      return false;
    }

    var best = -1, bx = 50, by = 45;
    for (var y = 25; y < 75; y++) {
      for (var x = 20; x < 80; x++) {
        var i = (y * 100 + x) * 4;
        var lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        var j = (y * 100 + Math.min(99, x + 2)) * 4;
        var lum2 = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
        var grad = Math.abs(lum - lum2);
        var cw = 1 - Math.hypot(x - 50, y - 48) / 60;
        var score = ((255 - lum) * 0.6 + grad * 1.8) * Math.max(0.2, cw);
        if (score > best) {
          best = score;
          bx = x;
          by = y;
        }
      }
    }

    var sx = (bx / 100) * W;
    var sy = (by / 100) * H;
    var hs = Math.max(W * 0.09, 40);
    var els = [];

    var hl = pick(LOCAL.headline);
    els.push({ type: 'aiHeadline', x: W * 0.08, y: H * 0.10, l1: hl[0], l2: hl[1] });

    els.push({
      type: 'aiBox',
      x: clamp(sx - hs / 2, 8, W - hs - 8),
      y: clamp(sy - hs * 0.9, 8, H - hs - 8),
      w: hs,
      h: hs,
      caption: pick(LOCAL.subject),
      label: 'главный объект',
      graphic: 'box_with_arrow',
      side: 'left',
      index: 1,
      confidence: null
    });

    var tw = Math.max(W * 0.05, 24);
    els.push({
      type: 'aiBox',
      x: clamp(sx + W * 0.16, 8, W - tw * 2.2 - 8),
      y: clamp(sy + H * 0.10, 8, H - tw - 8),
      w: tw * 2.2,
      h: tw,
      caption: pick(LOCAL.technical),
      label: 'деталь',
      graphic: 'technical_tag',
      side: 'right',
      index: 2,
      confidence: null
    });

    els.push({
      type: 'aiBox',
      x: W * 0.10,
      y: H * 0.72,
      w: W * 0.3,
      h: H * 0.12,
      caption: pick(LOCAL.detail),
      label: 'передний план',
      graphic: 'dashed_contour',
      side: 'bottom',
      index: 3,
      confidence: null
    });

    els.push({
      type: 'dashedPath',
      pts: [
        { x: clamp(sx + W * 0.14, 0, W), y: clamp(sy + H * 0.22, 0, H) },
        { x: W * 0.22, y: H * 0.98 }
      ]
    });

    state.elements = els;
    state.selected = null;
    state.analysis = null;
    state.model = 'локально';
    pushHistory();
    fitCanvasToStage();
    render();
    renderList();
    setConfidence(null);
    setStep(1, 'err', 'Gemini недоступен: ' + String(reason || '').slice(0, 90));
    setStep(2, 'done', 'Локальный движок: контраст и композиция');
    setStep(3, 'done', 'Отрисовано в ' + W + '×' + H + ' px · без Gemini');
    return true;
  }

  /* ------------------------------- действия ------------------------------- */

  function save() {
    if (!state.image) { toast('Сначала загрузите фото', 'warn'); return; }
    var wasCompare = state.compare;
    if (wasCompare) { state.compare = false; render(); }
    var url = canvas.toDataURL('image/png');
    if (wasCompare) { state.compare = true; render(); }
    var a = document.createElement('a');
    a.href = url;
    a.download = 'drezzdon_' + (state.fileName || 'photo').replace(/\.[^.]+$/, '') + '_v' + state.variant + '.png';
    a.click();
    toast('PNG сохранён в «Загрузки»');
  }

  function toggleCompare() {
    if (!state.image) return;
    state.compare = !state.compare;
    btnCompare.textContent = state.compare ? 'Показать разметку' : 'Показать оригинал';
    btnCompare.classList.toggle('on', state.compare);
    render();
  }

  /* ------------------------------ мышь/палец ------------------------------ */

  function canvasPos(e) {
    var r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height)
    };
  }

  function hitTest(p) {
    for (var i = state.elements.length - 1; i >= 0; i--) {
      var el = state.elements[i];
      if (el.type === 'aiBox') {
        if (p.x >= el.x - 6 && p.x <= el.x + el.w + 6 && p.y >= el.y - 6 && p.y <= el.y + el.h + 6) return el;
      } else if (el.type === 'aiHeadline') {
        var fs = Math.round(baseFontPx() * 1.15);
        if (Math.abs(p.x - el.x) < 260 && p.y > el.y - fs - 10 && p.y < el.y + fs * 1.6) return el;
      }
    }
    return null;
  }

  function captionHit(p) {
    for (var i = state.elements.length - 1; i >= 0; i--) {
      var r = state.elements[i]._capRect;
      if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return state.elements[i];
    }
    return null;
  }

  function handleHit(p) {
    var el = state.selected;
    if (!el || el.type !== 'aiBox') return null;
    var d = Math.max(12, canvas.width * 0.014);
    var corners = [
      ['nw', el.x, el.y],
      ['ne', el.x + el.w, el.y],
      ['sw', el.x, el.y + el.h],
      ['se', el.x + el.w, el.y + el.h]
    ];
    for (var i = 0; i < corners.length; i++) {
      if (Math.hypot(p.x - corners[i][1], p.y - corners[i][2]) < d) return corners[i][0];
    }
    return null;
  }

  /* ------------------------------- история ------------------------------- */

  function snapshot() { return JSON.parse(JSON.stringify(state.elements)); }

  function pushHistory() {
    state.history = state.history.slice(0, state.hIndex + 1);
    state.history.push(snapshot());
    if (state.history.length > 60) state.history.shift();
    state.hIndex = state.history.length - 1;
  }

  function restoreHistory(i) {
    if (i < 0 || i >= state.history.length) return;
    state.hIndex = i;
    state.elements = JSON.parse(JSON.stringify(state.history[i]));
    state.selected = null;
    render();
    renderList();
  }

  var drag = null;

  canvas.addEventListener('pointerdown', function (e) {
    if (!state.elements.length) return;
    var p = canvasPos(e);
    var corner = handleHit(p);
    if (corner) {
      drag = { mode: 'resize', corner: corner, el: state.selected, moved: false };
    } else {
      var capEl = captionHit(p);
      if (capEl) {
        state.selected = capEl;
        drag = { mode: 'caption', el: capEl, last: p, moved: false };
      } else {
        var hit = hitTest(p);
        if (hit) {
          state.selected = hit;
          drag = { mode: 'move', el: hit, dx: p.x - hit.x, dy: p.y - hit.y, moved: false };
        } else {
          state.selected = null;
        }
      }
    }
    if (drag && canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    canvas.classList.toggle('dragging', Boolean(drag));
    render();
    renderList();
  });

  canvas.addEventListener('pointermove', function (e) {
    var p = canvasPos(e);
    if (!drag) {
      canvas.classList.toggle('hover', Boolean(handleHit(p) || captionHit(p) || hitTest(p)));
      return;
    }
    var el = drag.el;

    if (drag.mode === 'move') {
      var w = el.w || 0;
      var h = el.h || 0;
      el.x = clamp(p.x - drag.dx, -w * 0.5, canvas.width - w * 0.5 - 4);
      el.y = clamp(p.y - drag.dy, -h * 0.5, canvas.height - h * 0.5 - 4);
      drag.moved = true;
    } else if (drag.mode === 'resize') {
      var right = el.x + el.w;
      var bottom = el.y + el.h;
      var min = Math.max(20, canvas.width * 0.02);
      var c = drag.corner;
      if (c.indexOf('n') >= 0) {
        var ny = Math.min(p.y, bottom - min);
        el.y = Math.max(0, ny);
        el.h = bottom - el.y;
      }
      if (c.indexOf('s') >= 0) el.h = Math.max(min, p.y - el.y);
      if (c.indexOf('w') >= 0) {
        var nx = Math.min(p.x, right - min);
        el.x = Math.max(0, nx);
        el.w = right - el.x;
      }
      if (c.indexOf('e') >= 0) el.w = Math.max(min, p.x - el.x);
      el.w = Math.min(el.w, canvas.width - el.x);
      el.h = Math.min(el.h, canvas.height - el.y);
      drag.moved = true;
    } else if (drag.mode === 'caption') {
      el.capDx = (el.capDx || 0) + (p.x - drag.last.x);
      el.capDy = (el.capDy || 0) + (p.y - drag.last.y);
      drag.last = p;
      drag.moved = true;
    }
    render();
  });

  function endDrag() {
    if (drag && drag.moved) pushHistory();
    drag = null;
    canvas.classList.remove('dragging');
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('dblclick', function (e) {
    var p = canvasPos(e);
    var hit = captionHit(p) || hitTest(p);
    if (!hit) return;
    if (hit.type === 'aiBox') {
      var v = prompt('Подпись к рамке:', hit.caption || '');
      if (v !== null) hit.caption = v.trim();
    } else if (hit.type === 'aiHeadline') {
      var t = prompt('Заголовок (перенос строки = Enter):', (hit.l1 || '') + '\n' + (hit.l2 || ''));
      if (t !== null) {
        var parts = t.split('\n');
        hit.l1 = (parts[0] || '').trim();
        hit.l2 = (parts.slice(1).join(' ') || '').trim();
      }
    }
    pushHistory();
    render();
    renderList();
  });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    var mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      restoreHistory(e.shiftKey ? state.hIndex + 1 : state.hIndex - 1);
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      restoreHistory(state.hIndex + 1);
      return;
    }
    if (mod && e.key.toLowerCase() === 'd' && state.selected) {
      e.preventDefault();
      var copy = JSON.parse(JSON.stringify(state.selected));
      copy.x += 16;
      copy.y += 16;
      copy.caption = (copy.caption || '') + ' 2';
      state.elements.push(copy);
      state.selected = copy;
      pushHistory();
      render();
      renderList();
      return;
    }

    if (!state.selected) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      state.elements = state.elements.filter(function (el) { return el !== state.selected; });
      state.selected = null;
      pushHistory();
      render();
      renderList();
      return;
    }

    var step = e.shiftKey ? 10 : 2;
    var moved = false;
    if (e.key === 'ArrowLeft') { state.selected.x -= step; moved = true; }
    if (e.key === 'ArrowRight') { state.selected.x += step; moved = true; }
    if (e.key === 'ArrowUp') { state.selected.y -= step; moved = true; }
    if (e.key === 'ArrowDown') { state.selected.y += step; moved = true; }
    if (moved) {
      e.preventDefault();
      render();
    }
  });

  /* ---------------------------- добавить вручную ---------------------------- */

  function addManual(kind) {
    var W = canvas.width;
    var H = canvas.height;
    var el;
    if (kind === 'box') {
      el = {
        type: 'aiBox',
        x: W * 0.42,
        y: H * 0.42,
        w: W * 0.16,
        h: H * 0.14,
        caption: 'новая рамка',
        label: 'вручную',
        graphic: 'box_with_arrow',
        side: 'bottom',
        index: 0,
        confidence: null
      };
    } else {
      el = {
        type: 'aiBox',
        x: W * 0.46,
        y: H * 0.46,
        w: W * 0.06,
        h: W * 0.06,
        caption: 'твоя подпись',
        label: 'вручную',
        graphic: 'center_glyph',
        side: 'top',
        index: 0,
        confidence: null
      };
    }
    state.elements.push(el);
    state.selected = el;
    pushHistory();
    render();
    renderList();
    toast('Добавлено: тащите мышкой, двойной клик — текст');
  }

  /* -------------------------------- события -------------------------------- */

  fileInput.addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) readFile(f);
    e.target.value = '';
  });

  btnSave.addEventListener('click', save);
  btnCompare.addEventListener('click', toggleCompare);
  btnRedo.addEventListener('click', function () { analyze(true); });
  btnNext.addEventListener('click', function () { fileInput.click(); });
  $('btnAddBox').addEventListener('click', function () { addManual('box'); });
  $('btnAddText').addEventListener('click', function () { addManual('text'); });

  window.addEventListener('resize', function () {
    fitCanvasToStage();
    render();
  });

  ['dragenter', 'dragover'].forEach(function (t) {
    stage.addEventListener(t, function (e) { e.preventDefault(); });
  });
  stage.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  if (langSel) {
    try {
      var savedLang = localStorage.getItem(LS_LANG);
      if (savedLang === 'ru' || savedLang === 'drezzdon_en') langSel.value = savedLang;
    } catch (e) { /* ignore */ }
    langSel.addEventListener('change', function () {
      try { localStorage.setItem(LS_LANG, langSel.value); } catch (e) { /* ignore */ }
      if (state.image && state.elements.length) toast('Язык подписей изменится при следующей разметке');
    });
  }

  /* --------------------------------- старт --------------------------------- */

  resetPipeline();
  updateStats();
  render();
  renderList();
  restoreLastPhoto();

  // тестовая отладка: открыть страницу с ?test, чтобы дёргать buildElements извне
  if (location.search.indexOf('test') >= 0) {
    window.__build = buildElements;
    window.__state = state;
  }
})();
