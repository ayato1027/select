// カメラでガチバトルのBAN画面を読み取り、自動でBANに反映する機能。
// 静的Webアプリ内で完結させるため、外部MLライブラリは使わず
// 「小さいグレースケールサムネイルの正規化相互相関(簡易ZNCC)」でテンプレートマッチングする。
// CDN画像はAccess-Control-Allow-Origin: *のため、canvas上での画素解析が可能。
(function () {
  const THUMB_SIZE = 24;
  const SAMPLE_INTERVAL_MS = 400;
  const STABLE_COUNT = 4; // 直近何フレーム連続で同じ判定なら確定するか
  const HISTORY_LEN = 5;
  const SCORE_THRESHOLD = 0.35; // 最良一致のスコア下限(これ未満は「該当なし」扱い)
  const MARGIN_THRESHOLD = 0.06; // 2位との差がこれ未満なら確信度不足として保留
  const REF_CACHE_KEY = 'bs_scan_ref_cache_v1';
  const GUIDE_KEY = 'bs_scan_guide_v1';

  let brawlers = [];
  let onApply = null;
  let refThumbs = null; // { [brawlerId]: Float32Array }
  let stream = null;
  let videoEl, overlayCanvas, workCanvas, workCtx;
  let cellCount = 6;
  let layout = '1x6'; // '1x6' | '2x3'
  let guideBox = { x: 0.1, y: 0.42, w: 0.8, h: 0.16 }; // video表示領域に対する比率(0-1)
  let cellHistory = [];
  let cellCommittedId = [];
  let pendingResults = []; // [{ i, brawlerId }] 確定はしたがまだ「反映」前の検出結果
  let tickTimer = null;
  let dragMode = null; // { type: 'move'|'corner', corner, startX, startY, startBox }

  function $(id) {
    return document.getElementById(id);
  }

  async function loadRefThumbs() {
    const cacheKeyData = brawlers.map((b) => b.id).sort().join(',');
    try {
      const cached = JSON.parse(localStorage.getItem(REF_CACHE_KEY) || 'null');
      if (cached && cached.key === cacheKeyData && cached.thumbs) {
        const map = {};
        for (const [id, arr] of Object.entries(cached.thumbs)) map[id] = Float32Array.from(arr);
        return map;
      }
    } catch (e) {}

    const map = {};
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    for (const b of brawlers) {
      try {
        const img = await loadImage(b.imageUrl);
        ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
        ctx.drawImage(img, 0, 0, THUMB_SIZE, THUMB_SIZE);
        const data = ctx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE).data;
        map[b.id] = normalize(toGrayscale(data));
      } catch (e) {
        // 1体読み込み失敗しても続行(その体は照合候補から外れるだけ)
      }
    }

    try {
      const serializable = {};
      for (const [id, arr] of Object.entries(map)) serializable[id] = Array.from(arr);
      localStorage.setItem(REF_CACHE_KEY, JSON.stringify({ key: cacheKeyData, thumbs: serializable }));
    } catch (e) {
      // 保存できなくても動作には影響しない
    }

    return map;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function toGrayscale(data) {
    const gray = new Float32Array(THUMB_SIZE * THUMB_SIZE);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return gray;
  }

  function normalize(gray) {
    let mean = 0;
    for (const v of gray) mean += v;
    mean /= gray.length;
    let variance = 0;
    for (const v of gray) variance += (v - mean) * (v - mean);
    variance /= gray.length;
    const std = Math.sqrt(variance) || 1;
    const out = new Float32Array(gray.length);
    for (let i = 0; i < gray.length; i++) out[i] = (gray[i] - mean) / std;
    return out;
  }

  function similarity(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum / a.length;
  }

  function findBestMatch(thumb) {
    let bestId = null;
    let bestScore = -Infinity;
    let secondScore = -Infinity;
    for (const [id, ref] of Object.entries(refThumbs)) {
      const score = similarity(thumb, ref);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestId = id;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    return { bestId, bestScore, secondScore };
  }

  function loadGuide() {
    try {
      const saved = JSON.parse(localStorage.getItem(GUIDE_KEY) || 'null');
      if (saved && saved.box) {
        guideBox = saved.box;
        layout = saved.layout || '1x6';
      }
    } catch (e) {}
  }

  function saveGuide() {
    localStorage.setItem(GUIDE_KEY, JSON.stringify({ box: guideBox, layout }));
  }

  function getCellRectsNative() {
    // videoの表示サイズ基準の比率(guideBox)を、実映像解像度(videoWidth/videoHeight)の座標へ変換
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    const bx = guideBox.x * vw;
    const by = guideBox.y * vh;
    const bw = guideBox.w * vw;
    const bh = guideBox.h * vh;

    const rects = [];
    if (layout === '2x3') {
      const cw = bw / 3;
      const ch = bh / 2;
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          rects.push({ x: bx + col * cw, y: by + row * ch, w: cw, h: ch });
        }
      }
    } else {
      const cw = bw / 6;
      for (let col = 0; col < 6; col++) {
        rects.push({ x: bx + col * cw, y: by, w: cw, h: bh });
      }
    }
    return rects;
  }

  function extractThumb(rect) {
    workCtx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    workCtx.drawImage(videoEl, rect.x, rect.y, rect.w, rect.h, 0, 0, THUMB_SIZE, THUMB_SIZE);
    const data = workCtx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE).data;
    return normalize(toGrayscale(data));
  }

  function pushHistory(i, idOrNull) {
    cellHistory[i].push(idOrNull);
    if (cellHistory[i].length > HISTORY_LEN) cellHistory[i].shift();
  }

  function isStable(i) {
    const h = cellHistory[i];
    if (h.length < STABLE_COUNT) return false;
    const recent = h.slice(-STABLE_COUNT);
    const first = recent[0];
    if (first == null) return false;
    return recent.every((v) => v === first);
  }

  function tick() {
    if (!videoEl || videoEl.readyState < 2) return;
    const rects = getCellRectsNative();

    rects.forEach((rect, i) => {
      if (cellCommittedId[i]) return;
      if (rect.w < 4 || rect.h < 4) return;
      const thumb = extractThumb(rect);
      const { bestId, bestScore, secondScore } = findBestMatch(thumb);
      const confident = bestScore > SCORE_THRESHOLD && bestScore - secondScore > MARGIN_THRESHOLD;
      pushHistory(i, confident ? bestId : null);
      updateCellIndicator(i, confident ? bestId : null, bestScore);

      if (isStable(i)) {
        cellCommittedId[i] = cellHistory[i][cellHistory[i].length - 1];
        markCellCommitted(i, cellCommittedId[i]);
        addToPending(i, cellCommittedId[i]);
      }
    });
  }

  function addToPending(i, brawlerId) {
    pendingResults.push({ i, brawlerId: Number(brawlerId) });
    renderPendingList();
    setStatus('検出しました。内容を確認して「反映する」を押してください。');
  }

  function removePending(idx) {
    const item = pendingResults[idx];
    pendingResults.splice(idx, 1);
    // 該当セルを再スキャン可能な状態に戻す
    if (item) {
      cellCommittedId[item.i] = null;
      cellHistory[item.i] = [];
      const el = document.querySelector(`.scan-cell[data-i="${item.i}"]`);
      if (el) {
        el.classList.remove('committed', 'tentative');
        el.querySelector('.scan-cell-label').textContent = '';
      }
    }
    renderPendingList();
  }

  function renderPendingList() {
    const list = $('scanPendingList');
    const applyBtn = $('scanApplyBtn');
    list.innerHTML = '';
    pendingResults.forEach((item, idx) => {
      const b = brawlers.find((bb) => String(bb.id) === String(item.brawlerId));
      if (!b) return;
      const chip = document.createElement('div');
      chip.className = 'scan-pending-chip';
      chip.innerHTML = `<img src="${b.imageUrl}" alt="${b.displayName}" /><span>${b.displayName}</span><span class="scan-pending-remove">×</span>`;
      chip.onclick = () => removePending(idx);
      list.appendChild(chip);
    });
    applyBtn.hidden = pendingResults.length === 0;
    applyBtn.textContent = `この${pendingResults.length}件をBANに反映する`;
  }

  function applyPending() {
    for (const item of pendingResults) {
      if (onApply) onApply(item.brawlerId);
    }
    pendingResults = [];
    renderPendingList();
    setStatus('反映しました。続けてスキャンできます。');
  }

  function updateCellIndicator(i, brawlerId, score) {
    const el = document.querySelector(`.scan-cell[data-i="${i}"]`);
    if (!el) return;
    if (brawlerId && brawlers.find((b) => String(b.id) === String(brawlerId))) {
      const b = brawlers.find((b) => String(b.id) === String(brawlerId));
      el.querySelector('.scan-cell-label').textContent = b.displayName;
      el.classList.add('tentative');
    } else {
      el.querySelector('.scan-cell-label').textContent = '';
      el.classList.remove('tentative');
    }
  }

  function markCellCommitted(i, brawlerId) {
    const el = document.querySelector(`.scan-cell[data-i="${i}"]`);
    if (!el) return;
    const b = brawlers.find((bb) => String(bb.id) === String(brawlerId));
    el.classList.remove('tentative');
    el.classList.add('committed');
    el.querySelector('.scan-cell-label').textContent = b ? b.displayName : '?';
  }

  function renderCells() {
    const container = $('scanCells');
    container.innerHTML = '';
    for (let i = 0; i < cellCount; i++) {
      const cell = document.createElement('div');
      cell.className = 'scan-cell';
      cell.dataset.i = String(i);
      cell.innerHTML = '<span class="scan-cell-label"></span>';
      container.appendChild(cell);
    }
    positionCells();
  }

  function positionCells() {
    const container = $('scanCells');
    const wrap = $('scanVideoWrap');
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    container.style.left = `${guideBox.x * w}px`;
    container.style.top = `${guideBox.y * h}px`;
    container.style.width = `${guideBox.w * w}px`;
    container.style.height = `${guideBox.h * h}px`;
    container.style.display = 'grid';
    container.style.gridTemplateColumns = layout === '2x3' ? 'repeat(3, 1fr)' : 'repeat(6, 1fr)';
    container.style.gridTemplateRows = layout === '2x3' ? 'repeat(2, 1fr)' : '1fr';
  }

  function setStatus(msg) {
    $('scanStatus').textContent = msg;
  }

  // --- ガイド枠のドラッグ操作(移動+四隅リサイズ) ---
  function setupGuideDrag() {
    const guide = $('scanGuideBox');
    const handles = guide.querySelectorAll('.scan-handle');

    guide.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('scan-handle')) return;
      dragMode = { type: 'move', startX: e.clientX, startY: e.clientY, startBox: { ...guideBox } };
      guide.setPointerCapture(e.pointerId);
    });

    handles.forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        dragMode = { type: 'corner', corner: handle.dataset.corner, startX: e.clientX, startY: e.clientY, startBox: { ...guideBox } };
        handle.setPointerCapture(e.pointerId);
      });
    });

    guide.addEventListener('pointermove', (e) => onGuidePointerMove(e));
    handles.forEach((handle) => handle.addEventListener('pointermove', (e) => onGuidePointerMove(e)));

    function endDrag() {
      if (dragMode) {
        dragMode = null;
        saveGuide();
      }
    }
    guide.addEventListener('pointerup', endDrag);
    guide.addEventListener('pointercancel', endDrag);
    handles.forEach((handle) => {
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);
    });
  }

  function onGuidePointerMove(e) {
    if (!dragMode) return;
    const wrap = $('scanVideoWrap');
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const dx = (e.clientX - dragMode.startX) / w;
    const dy = (e.clientY - dragMode.startY) / h;
    const sb = dragMode.startBox;

    if (dragMode.type === 'move') {
      guideBox.x = clamp(sb.x + dx, 0, 1 - sb.w);
      guideBox.y = clamp(sb.y + dy, 0, 1 - sb.h);
    } else {
      let { x, y, w: bw, h: bh } = sb;
      if (dragMode.corner === 'tl') {
        x = clamp(sb.x + dx, 0, sb.x + sb.w - 0.05);
        y = clamp(sb.y + dy, 0, sb.y + sb.h - 0.05);
        bw = sb.x + sb.w - x;
        bh = sb.y + sb.h - y;
      } else if (dragMode.corner === 'tr') {
        y = clamp(sb.y + dy, 0, sb.y + sb.h - 0.05);
        bw = clamp(sb.w + dx, 0.05, 1 - sb.x);
        bh = sb.y + sb.h - y;
      } else if (dragMode.corner === 'bl') {
        x = clamp(sb.x + dx, 0, sb.x + sb.w - 0.05);
        bw = sb.x + sb.w - x;
        bh = clamp(sb.h + dy, 0.05, 1 - sb.y);
      } else if (dragMode.corner === 'br') {
        bw = clamp(sb.w + dx, 0.05, 1 - sb.x);
        bh = clamp(sb.h + dy, 0.05, 1 - sb.y);
      }
      guideBox = { x, y, w: bw, h: bh };
    }
    positionCells();
    positionGuideBoxEl();
  }

  function positionGuideBoxEl() {
    const guide = $('scanGuideBox');
    const wrap = $('scanVideoWrap');
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    guide.style.left = `${guideBox.x * w}px`;
    guide.style.top = `${guideBox.y * h}px`;
    guide.style.width = `${guideBox.w * w}px`;
    guide.style.height = `${guideBox.h * h}px`;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // --- 起動・終了 ---
  async function open(brawlerList, applyCallback) {
    brawlers = brawlerList;
    onApply = applyCallback;
    loadGuide();
    cellHistory = Array.from({ length: 6 }, () => []);
    cellCommittedId = Array(6).fill(null);
    pendingResults = [];
    renderPendingList();

    $('scanOverlay').hidden = false;
    setStatus('アイコンを準備中...');
    $('scanLayoutToggle').value = layout;

    videoEl = $('scanVideo');
    workCanvas = document.createElement('canvas');
    workCanvas.width = THUMB_SIZE;
    workCanvas.height = THUMB_SIZE;
    workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

    try {
      refThumbs = await loadRefThumbs();
    } catch (e) {
      setStatus('アイコンの準備に失敗しました');
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      videoEl.srcObject = stream;
      await videoEl.play();
    } catch (e) {
      setStatus('カメラを起動できませんでした。カメラへのアクセスを許可してください。');
      return;
    }

    renderCells();
    positionGuideBoxEl();
    setStatus('ガイド枠をBAN表示に合わせてください(初回のみ調整・以降は記憶されます)');
    tickTimer = setInterval(tick, SAMPLE_INTERVAL_MS);
  }

  function close() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    $('scanOverlay').hidden = true;
  }

  function setupUi() {
    $('scanClose').onclick = close;
    $('scanLayoutToggle').onchange = (e) => {
      layout = e.target.value;
      saveGuide();
      renderCells();
      positionCells();
    };
    $('scanResetGuide').onclick = () => {
      guideBox = { x: 0.1, y: 0.42, w: 0.8, h: 0.16 };
      saveGuide();
      positionCells();
      positionGuideBoxEl();
    };
    $('scanApplyBtn').onclick = applyPending;
    setupGuideDrag();
    window.addEventListener('resize', () => {
      if (!$('scanOverlay').hidden) {
        positionCells();
        positionGuideBoxEl();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', setupUi);

  window.BSScan = { open, close };
})();
