(function () {
  const PERSONAL_BIAS_KEY = 'bs_personal_bias_v1';
  const TIER_ORDER = ['S', 'A', 'B', 'C', 'D', 'E'];
  const TIER_VALUES = { S: 3, A: 2, B: 1, C: -1, D: -2, E: -3 };
  const TIER_NAMES = { S: 'Sランク', A: 'Aランク', B: 'Bランク', C: 'Cランク', D: 'Dランク', E: 'Eランク' };

  const state = {
    brawlers: [],
    assignments: {}, // { [brawlerId]: 'S'|'A'|'B'|'C'|'D'|'E' }
    search: '',
  };

  let drag = null; // { brawlerId, pointerId, ghostEl }

  function $(id) {
    return document.getElementById(id);
  }

  function valueToTier(value) {
    if (value == null) return null;
    let closest = null;
    let closestDiff = Infinity;
    for (const tier of TIER_ORDER) {
      const diff = Math.abs(TIER_VALUES[tier] - value);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = tier;
      }
    }
    return closest;
  }

  function loadAssignments() {
    const bias = BSApi.readOverrides(PERSONAL_BIAS_KEY);
    const assignments = {};
    for (const [brawlerId, entry] of Object.entries(bias)) {
      const tier = valueToTier(entry.value);
      if (tier) assignments[brawlerId] = tier;
    }
    return assignments;
  }

  function persistTier(brawlerId, tier) {
    const bias = BSApi.readOverrides(PERSONAL_BIAS_KEY);
    if (tier == null) {
      delete bias[brawlerId];
    } else {
      bias[brawlerId] = { value: TIER_VALUES[tier], note: `Tier: ${tier}` };
    }
    BSApi.writeOverrides(PERSONAL_BIAS_KEY, bias);
    showSaveStatus();
  }

  let saveStatusTimer = null;
  function showSaveStatus() {
    const el = $('tierSaveStatus');
    el.textContent = '保存しました';
    el.classList.add('show');
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => el.classList.remove('show'), 1200);
  }

  async function init() {
    const [brawlerNamesFile] = await Promise.all([BSApi.loadLocalJSON('data/brawler_names_ja.json')]);
    const { brawlers } = await BSApi.loadBrawlers();
    const brawlerNames = BSApi.mergeBrawlerNames(brawlerNamesFile.names, BSApi.readOverrides(BSApi.LS_KEYS.brawlerNamesJa));
    state.brawlers = brawlers
      .map((b) => ({ ...b, displayName: brawlerNames[b.nameEn] || b.name }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
    state.assignments = loadAssignments();

    $('loading').hidden = true;
    $('tierApp').hidden = false;

    renderBoard();
    setupSearch();
    setupResetButton();
  }

  function renderBoard() {
    const board = $('tierBoard');
    board.innerHTML = '';

    for (const tier of TIER_ORDER) {
      const row = document.createElement('div');
      row.className = 'tier-row';
      row.innerHTML = `
        <div class="tier-label" data-tier="${tier}" title="${TIER_NAMES[tier]}">${tier}</div>
        <div class="tier-content" data-tier="${tier}"></div>
      `;
      board.appendChild(row);
    }

    const poolSection = document.createElement('div');
    poolSection.className = 'tier-pool-section';
    poolSection.innerHTML = `
      <div class="tier-pool-header">未評価(${state.brawlers.length - Object.keys(state.assignments).length}体)</div>
      <div class="tier-pool-content" data-tier=""></div>
    `;
    board.appendChild(poolSection);

    for (const b of state.brawlers) {
      const tier = state.assignments[b.id] || '';
      const container = board.querySelector(`[data-tier="${tier}"].tier-content, [data-tier="${tier}"].tier-pool-content`);
      container.appendChild(renderChip(b));
    }

    updatePoolCount();
    applySearchFilter();
  }

  function updatePoolCount() {
    const header = document.querySelector('.tier-pool-header');
    if (header) {
      const unranked = state.brawlers.length - Object.keys(state.assignments).length;
      header.textContent = `未評価(${unranked}体)`;
    }
  }

  function renderChip(b) {
    const chip = document.createElement('div');
    chip.className = 'tier-chip';
    chip.dataset.brawlerId = String(b.id);
    chip.title = b.displayName;
    chip.innerHTML = `<img src="${b.imageUrl}" alt="${b.displayName}" loading="lazy" />`;
    chip.addEventListener('pointerdown', onChipPointerDown);
    return chip;
  }

  // --- ドラッグ操作(Pointer Events、タッチ/マウス両対応) ---
  function onChipPointerDown(e) {
    const chip = e.currentTarget;
    e.preventDefault();
    const brawlerId = chip.dataset.brawlerId;
    drag = { brawlerId, pointerId: e.pointerId, chip };
    chip.classList.add('dragging');
    chip.setPointerCapture(e.pointerId);

    const ghost = $('tierDragGhost');
    const b = state.brawlers.find((bb) => String(bb.id) === brawlerId);
    ghost.innerHTML = `<img src="${b.imageUrl}" alt="" />`;
    ghost.hidden = false;
    positionGhost(e.clientX, e.clientY);

    chip.addEventListener('pointermove', onChipPointerMove);
    chip.addEventListener('pointerup', onChipPointerUp);
    chip.addEventListener('pointercancel', onChipPointerUp);
  }

  function positionGhost(x, y) {
    const ghost = $('tierDragGhost');
    ghost.style.left = `${x - 24}px`;
    ghost.style.top = `${y - 24}px`;
  }

  function onChipPointerMove(e) {
    if (!drag) return;
    positionGhost(e.clientX, e.clientY);

    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    const target = findDropTarget(e.clientX, e.clientY);
    if (target) target.classList.add('drag-over');
  }

  function onChipPointerUp(e) {
    if (!drag) return;
    const { chip, brawlerId } = drag;

    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    const target = findDropTarget(e.clientX, e.clientY);

    chip.classList.remove('dragging');
    chip.removeEventListener('pointermove', onChipPointerMove);
    chip.removeEventListener('pointerup', onChipPointerUp);
    chip.removeEventListener('pointercancel', onChipPointerUp);
    $('tierDragGhost').hidden = true;
    drag = null;

    if (target) {
      const tier = target.dataset.tier || null;
      if (tier) {
        state.assignments[brawlerId] = tier;
      } else {
        delete state.assignments[brawlerId];
      }
      persistTier(brawlerId, tier || null);
      renderBoard();
    }
  }

  function findDropTarget(x, y) {
    // ドラッグ中はゴースト要素がその座標を覆っている可能性があるため一時的に無視する
    const ghost = $('tierDragGhost');
    const prevPointerEvents = ghost.style.pointerEvents;
    ghost.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    ghost.style.pointerEvents = prevPointerEvents;
    if (!el) return null;

    // ランクの色ラベル部分に落とした場合も同じ行として拾えるよう、
    // 行(.tier-row)・未評価セクション(.tier-pool-section)単位で判定してから
    // 実際のコンテナ(.tier-content / .tier-pool-content)を返す
    const rowOrSection = el.closest('.tier-row, .tier-pool-section');
    if (!rowOrSection) return null;
    return rowOrSection.querySelector('.tier-content, .tier-pool-content');
  }

  // --- 検索 ---
  function setupSearch() {
    $('tierSearch').addEventListener('input', (e) => {
      state.search = e.target.value.trim();
      applySearchFilter();
    });
  }

  function applySearchFilter() {
    const search = state.search.toLowerCase();
    document.querySelectorAll('.tier-chip').forEach((chip) => {
      const b = state.brawlers.find((bb) => String(bb.id) === chip.dataset.brawlerId);
      const match = !search || b.displayName.toLowerCase().includes(search) || b.nameEn.toLowerCase().includes(search);
      chip.classList.toggle('hidden-by-search', !match);
    });
  }

  function setupResetButton() {
    $('tierResetBtn').addEventListener('click', () => {
      if (!confirm('全キャラのTier評価を未評価に戻します。よろしいですか?')) return;
      BSApi.writeOverrides(PERSONAL_BIAS_KEY, {});
      state.assignments = {};
      renderBoard();
      showSaveStatus();
    });
  }

  init();
})();
