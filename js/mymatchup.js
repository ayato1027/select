(function () {
  // 7段階。値はスコア計算にそのまま使われる
  const LEVELS = [
    { v: 3, text: '超有利' },
    { v: 2, text: '有利' },
    { v: 1, text: 'やや有利' },
    { v: 0, text: '五分' },
    { v: -1, text: 'やや不利' },
    { v: -2, text: '不利' },
    { v: -3, text: '超不利' },
  ];
  // 味方タブでは「有利/不利」ではなく相性の良し悪しとして読ませる
  const ALLY_TEXT = {
    3: '最高',
    2: '良い',
    1: 'やや良',
    0: '普通',
    '-1': 'やや悪',
    '-2': '悪い',
    '-3': '最悪',
  };

  const state = {
    brawlers: [],
    brawlersById: {},
    roles: null,
    meta: null,
    pairMatchups: null,
    config: null,
    my: { vsEnemy: {}, withAlly: {} },
    selected: null,
    view: 'vsEnemy',
    pickerSearch: '',
    pickerSort: 'progress',
    listSearch: '',
    listRoleFilter: null,
    selected2: new Set(), // 一括移動用に選択中のキャラid(文字列)
  };

  let drag = null;
  // ドラッグ開始位置からほとんど動かなかった場合はタップ(選択)として扱う
  const TAP_THRESHOLD_PX = 8;

  function $(id) {
    return document.getElementById(id);
  }

  function save() {
    BSApi.writeOverrides(BSApi.LS_KEYS.myMatchups, state.my);
    showSaved();
  }

  let savedTimer = null;
  function showSaved() {
    const el = $('mmSaveStatus');
    el.textContent = '保存しました';
    el.classList.add('show');
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove('show'), 1200);
  }

  async function init() {
    const [config, roles, metaFile, pairFile, namesFile] = await Promise.all([
      BSApi.loadLocalJSON('data/config.json'),
      BSApi.loadLocalJSON('data/roles.json'),
      BSApi.loadLocalJSON('data/meta.json'),
      BSApi.loadLocalJSON('data/pair_matchups.json'),
      BSApi.loadLocalJSON('data/brawler_names_ja.json'),
    ]);
    const { brawlers } = await BSApi.loadBrawlers();

    state.config = config;
    state.roles = roles;
    state.meta = metaFile;
    state.pairMatchups = { vsEnemy: pairFile.vsEnemy || {}, withAlly: pairFile.withAlly || {} };

    const names = BSApi.mergeBrawlerNames(namesFile.names, BSApi.readOverrides(BSApi.LS_KEYS.brawlerNamesJa));
    state.brawlers = brawlers.map((b) => ({ ...b, displayName: names[b.nameEn] || b.name }));
    for (const b of state.brawlers) state.brawlersById[b.id] = b;

    const raw = BSApi.readOverrides(BSApi.LS_KEYS.myMatchups);
    state.my = { vsEnemy: raw.vsEnemy || {}, withAlly: raw.withAlly || {} };

    $('loading').hidden = true;
    $('mmApp').hidden = false;

    setupPicker();
    setupViewTabs();
    setupListSearch();
    setupRoleFilter();
    setupSelectBar();
    setupReset();
    setupResetAll();
    $('mmChangeBtn').onclick = () => selectBase(null);
    renderPickerGrid();
  }

  function roleName(id) {
    return (state.roles.roles.find((r) => r.id === id) || {}).name || id;
  }

  // その基準キャラについて何体分を自分で設定済みか(進捗表示用)
  function progressOf(base) {
    let n = 0;
    for (const other of state.brawlers) {
      if (other.id === base.id) continue;
      if (BSScore.lookupMyMatchup(state.my, state.view, base.id, other.id) != null) n++;
    }
    return n;
  }

  function setupPicker() {
    $('mmPickerSearch').addEventListener('input', (e) => {
      state.pickerSearch = e.target.value.trim();
      renderPickerGrid();
    });
    const sel = $('mmPickerSort');
    sel.value = state.pickerSort;
    sel.addEventListener('change', (e) => {
      state.pickerSort = e.target.value;
      renderPickerGrid();
    });
  }

  function winRateOf(b) {
    const e = state.meta.coefficients ? state.meta.coefficients[b.id] : null;
    return e ? e.winRate : null;
  }

  function renderPickerGrid() {
    const el = $('mmPickerGrid');
    el.innerHTML = '';
    const q = state.pickerSearch.toLowerCase();
    let list = state.brawlers.filter(
      (b) => !q || b.displayName.toLowerCase().includes(q) || b.nameEn.toLowerCase().includes(q)
    );

    const total = state.brawlers.length - 1;
    const progressCache = new Map();
    const prog = (b) => {
      if (!progressCache.has(b.id)) progressCache.set(b.id, progressOf(b));
      return progressCache.get(b.id);
    };

    if (state.pickerSort === 'winRate') {
      list.sort((a, b) => (winRateOf(b) ?? -1) - (winRateOf(a) ?? -1));
    } else if (state.pickerSort === 'name') {
      list.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
    } else {
      // 未設定が多いキャラを前に出して、作業の続きから入れるようにする
      list.sort((a, b) => prog(a) - prog(b) || a.displayName.localeCompare(b.displayName, 'ja'));
    }

    for (const b of list) {
      const p = prog(b);
      const cell = document.createElement('div');
      cell.className = 'mu-picker-cell';
      // 設定済みのキャラだけ、その場でリセットできるボタンを出す
      const resetBtn = p > 0 ? '<button class="pc-reset" title="このキャラの相性をリセット">✕</button>' : '';
      cell.innerHTML = `
        ${resetBtn}
        <img src="${b.imageUrl}" loading="lazy" alt="${b.displayName}" />
        <div class="pc-name">${b.displayName}</div>
        <div class="pc-progress ${p >= total ? 'done' : ''}">${p}/${total}</div>`;
      cell.onclick = (e) => {
        if (e.target.closest('.pc-reset')) {
          e.stopPropagation();
          resetBrawler(b);
          return;
        }
        selectBase(b);
      };
      el.appendChild(cell);
    }

    updatePickerStatus();
  }

  // 対面・味方の両方について、そのキャラが絡む設定を全て消す。
  // ペアは双方向で共有しているため、相手側の表からも同時に消える点を明示する。
  function resetBrawler(b) {
    const vs = progressIn(b, 'vsEnemy');
    const ally = progressIn(b, 'withAlly');
    if (vs + ally === 0) return;
    if (
      !confirm(
        `${b.displayName}の相性設定(対面${vs}件・味方${ally}件)を消去します。\n` +
          `相性はペアで共有しているため、相手キャラ側の表からも同時に消えます。よろしいですか?`
      )
    )
      return;
    for (const other of state.brawlers) {
      if (other.id === b.id) continue;
      BSScore.setMyMatchup(state.my, 'vsEnemy', b.id, other.id, null);
      BSScore.setMyMatchup(state.my, 'withAlly', b.id, other.id, null);
    }
    save();
    renderPickerGrid();
  }

  function progressIn(base, kind) {
    let n = 0;
    for (const other of state.brawlers) {
      if (other.id === base.id) continue;
      if (BSScore.lookupMyMatchup(state.my, kind, base.id, other.id) != null) n++;
    }
    return n;
  }

  function updatePickerStatus() {
    const vs = Object.keys(state.my.vsEnemy || {}).length;
    const ally = Object.keys(state.my.withAlly || {}).length;
    $('mmPickerStatus').textContent = vs + ally === 0 ? '未設定' : `設定済み: 対面${vs}ペア / 味方${ally}ペア`;
  }

  function setupResetAll() {
    $('mmResetAll').onclick = () => {
      const vs = Object.keys(state.my.vsEnemy || {}).length;
      const ally = Object.keys(state.my.withAlly || {}).length;
      if (vs + ally === 0) return;
      if (!confirm(`自分で設定した相性(対面${vs}ペア・味方${ally}ペア)を全て消去します。よろしいですか?`)) return;
      state.my = { vsEnemy: {}, withAlly: {} };
      save();
      renderPickerGrid();
    };
  }

  function selectBase(b) {
    state.selected = b;
    if (!b) {
      $('mmPickSection').hidden = false;
      $('mmEditSection').hidden = true;
      $('mmBoardSection').hidden = true;
      renderPickerGrid();
      return;
    }
    $('mmPickSection').hidden = true;
    $('mmEditSection').hidden = false;
    $('mmBoardSection').hidden = false;
    $('mmSelectedIcon').src = b.imageUrl;
    $('mmSelectedName').textContent = b.displayName;
    $('mmSelectedRole').textContent = roleName(b.role);
    renderBoard();
  }

  function setupViewTabs() {
    const tabs = document.querySelectorAll('.wr-view-tab');
    tabs.forEach((t) => {
      t.onclick = () => {
        state.view = t.dataset.view;
        state.listSearch = '';
        $('mmListSearch').value = '';
        tabs.forEach((x) => x.classList.toggle('active', x === t));
        renderBoard();
      };
      t.classList.toggle('active', t.dataset.view === state.view);
    });
  }

  function setupListSearch() {
    $('mmListSearch').addEventListener('input', (e) => {
      state.listSearch = e.target.value.trim();
      applyFilter();
    });
  }

  function viewLabel() {
    return state.view === 'vsEnemy' ? '対面' : '味方';
  }

  function setupReset() {
    // 選択中のキャラだけを未設定に戻す
    $('mmResetSelected').onclick = () => {
      if (state.selected2.size === 0) return;
      applyToMany([...state.selected2], null);
    };

    // 表示中(検索・ロール絞り込みの結果)を未設定に戻す
    $('mmResetVisible').onclick = () => {
      const ids = [...document.querySelectorAll('#mmBoard .tier-chip:not(.hidden-by-search)')].map(
        (c) => c.dataset.brawlerId
      );
      if (ids.length === 0) return;
      if (!confirm(`表示中の${ids.length}体を未設定に戻します。よろしいですか?`)) return;
      applyToMany(ids, null);
    };

    // この基準キャラの現在のタブ全体を未設定に戻す
    $('mmResetBtn').onclick = () => {
      const base = state.selected;
      if (!base) return;
      if (!confirm(`${base.displayName}を基準にした${viewLabel()}相性を全て未設定に戻します。よろしいですか?`)) return;
      const ids = state.brawlers.filter((b) => b.id !== base.id).map((b) => b.id);
      applyToMany(ids, null);
    };
  }

  function labelText(v) {
    return state.view === 'withAlly' ? ALLY_TEXT[String(v)] : LEVELS.find((l) => l.v === v).text;
  }

  function renderBoard() {
    const base = state.selected;
    if (!base) return;

    const noticeEl = $('mmNotice');
    noticeEl.textContent =
      state.view === 'vsEnemy'
        ? `${base.displayName}から見た有利・不利です。ここで「${base.displayName} vs 相手 = 有利」に置くと、相手側の表では自動的に同じだけ「不利」になります(逆も同様)。`
        : `${base.displayName}と組んだ時の相性です。味方相性は双方向に同じ値が入ります。`;

    const board = $('mmBoard');
    board.innerHTML = '';

    for (const lv of LEVELS) {
      const row = document.createElement('div');
      row.className = 'tier-row';
      row.innerHTML = `
        <div class="tier-label" data-tier="${lv.v}">
          <div class="mm-label-inner">
            <span class="mm-label-value">${lv.v > 0 ? '+' : ''}${lv.v}</span>
            <span class="mm-label-text">${labelText(lv.v)}</span>
          </div>
        </div>
        <div class="tier-content" data-tier="${lv.v}"></div>`;
      board.appendChild(row);
    }

    const pool = document.createElement('div');
    pool.className = 'tier-pool-section';
    pool.innerHTML = `
      <div class="tier-pool-header"></div>
      <div class="tier-pool-content" data-tier=""></div>`;
    board.appendChild(pool);

    for (const other of state.brawlers) {
      if (other.id === base.id) continue;
      const v = BSScore.lookupMyMatchup(state.my, state.view, base.id, other.id);
      const container = board.querySelector(
        v == null ? '.tier-pool-content' : `.tier-content[data-tier="${v}"]`
      );
      if (container) container.appendChild(renderChip(other, v == null));
    }

    // 選択中に段(行)をタップすればまとめて設定できるようにする
    board.querySelectorAll('.tier-row, .tier-pool-section').forEach((row) => {
      row.addEventListener('click', onRowClick);
    });

    updatePoolHeader();
    applyFilter();
    refreshSelectionUI();
  }

  function updatePoolHeader() {
    const header = document.querySelector('#mmBoard .tier-pool-header');
    if (!header) return;
    const n = document.querySelectorAll('#mmBoard .tier-pool-content .tier-chip').length;
    header.textContent = `未設定(${n}体) — ドラッグして上の段に振り分けてください`;
  }

  function renderChip(b, unset) {
    const chip = document.createElement('div');
    chip.className = 'tier-chip';
    chip.dataset.brawlerId = String(b.id);
    chip.title = b.displayName;
    chip.innerHTML = `<img src="${b.imageUrl}" alt="${b.displayName}" loading="lazy" />`;
    chip.addEventListener('pointerdown', onPointerDown);
    return chip;
  }

  // --- ドラッグ(Tier表と同じ方式。タッチ/マウス両対応) ---
  function onPointerDown(e) {
    const chip = e.currentTarget;
    e.preventDefault();
    drag = {
      chip,
      brawlerId: chip.dataset.brawlerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    chip.setPointerCapture(e.pointerId);

    chip.addEventListener('pointermove', onPointerMove);
    chip.addEventListener('pointerup', onPointerUp);
    chip.addEventListener('pointercancel', onPointerUp);
  }

  // 実際に動き始めた時点で初めてドラッグ扱いにする(それまではタップの可能性を残す)
  function beginDragVisual(e) {
    const b = state.brawlersById[drag.brawlerId];
    drag.chip.classList.add('dragging');
    const ghost = $('mmDragGhost');
    ghost.innerHTML = `<img src="${b.imageUrl}" alt="" />`;
    ghost.hidden = false;
    moveGhost(e.clientX, e.clientY);
  }

  function moveGhost(x, y) {
    const g = $('mmDragGhost');
    g.style.left = `${x - 24}px`;
    g.style.top = `${y - 24}px`;
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.moved) {
      const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (dist < TAP_THRESHOLD_PX) return;
      drag.moved = true;
      beginDragVisual(e);
    }
    moveGhost(e.clientX, e.clientY);
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    const t = findDropTarget(e.clientX, e.clientY);
    if (t) t.classList.add('drag-over');
  }

  function onPointerUp(e) {
    if (!drag) return;
    const { chip, brawlerId, moved } = drag;
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));

    chip.classList.remove('dragging');
    chip.removeEventListener('pointermove', onPointerMove);
    chip.removeEventListener('pointerup', onPointerUp);
    chip.removeEventListener('pointercancel', onPointerUp);
    $('mmDragGhost').hidden = true;

    if (!moved) {
      // 動かさずに離した = タップ。選択のオン/オフを切り替える
      drag = null;
      toggleSelect(brawlerId);
      return;
    }

    const target = findDropTarget(e.clientX, e.clientY);
    drag = null;
    if (!target) return;

    const raw = target.dataset.tier;
    const value = raw === '' ? null : Number(raw);
    // 選択中のチップをドラッグした場合は、選択されている全員をまとめて移動する
    const ids = state.selected2.has(String(brawlerId)) ? [...state.selected2] : [brawlerId];
    applyToMany(ids, value);
  }

  // --- 複数選択 ---
  function toggleSelect(brawlerId) {
    const id = String(brawlerId);
    if (state.selected2.has(id)) state.selected2.delete(id);
    else state.selected2.add(id);
    refreshSelectionUI();
  }

  function applyToMany(ids, value) {
    for (const id of ids) {
      BSScore.setMyMatchup(state.my, state.view, state.selected.id, id, value);
    }
    state.selected2.clear();
    save();
    renderBoard();
  }

  function refreshSelectionUI() {
    const n = state.selected2.size;
    document.querySelectorAll('#mmBoard .tier-chip').forEach((chip) => {
      chip.classList.toggle('selected', state.selected2.has(chip.dataset.brawlerId));
    });
    const countEl = $('mmSelectCount');
    countEl.textContent = n > 0 ? `${n}体を選択中` : 'タップで複数選択できます';
    countEl.classList.toggle('has-selection', n > 0);

    const hint = $('mmBulkHint');
    hint.hidden = n === 0;
    hint.textContent = `移動先の段をタップすると、選択中の${n}体をまとめて設定します`;
    $('mmBoard').classList.toggle('mm-bulk-mode', n > 0);
    $('mmResetSelected').hidden = n === 0;
  }

  function setupSelectBar() {
    $('mmSelectVisible').onclick = () => {
      document.querySelectorAll('#mmBoard .tier-chip:not(.hidden-by-search)').forEach((chip) => {
        state.selected2.add(chip.dataset.brawlerId);
      });
      refreshSelectionUI();
    };
    $('mmSelectClear').onclick = () => {
      state.selected2.clear();
      refreshSelectionUI();
    };
  }

  // 選択がある状態で段(行)をタップしたら一括適用する
  function onRowClick(e) {
    if (state.selected2.size === 0) return;
    if (e.target.closest('.tier-chip')) return; // チップのタップは選択操作なので除外
    const container = e.currentTarget.querySelector('.tier-content, .tier-pool-content');
    if (!container) return;
    const raw = container.dataset.tier;
    applyToMany([...state.selected2], raw === '' ? null : Number(raw));
  }

  function findDropTarget(x, y) {
    const ghost = $('mmDragGhost');
    const prev = ghost.style.pointerEvents;
    ghost.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    ghost.style.pointerEvents = prev;
    if (!el) return null;
    // ラベル部分に落としても同じ行として拾えるよう、行単位で判定する
    const rowOrPool = el.closest('.tier-row, .tier-pool-section');
    if (!rowOrPool) return null;
    return rowOrPool.querySelector('.tier-content, .tier-pool-content');
  }

  function applyFilter() {
    const q = state.listSearch.toLowerCase();
    document.querySelectorAll('#mmBoard .tier-chip').forEach((chip) => {
      const b = state.brawlersById[chip.dataset.brawlerId];
      const nameHit = !q || b.displayName.toLowerCase().includes(q) || b.nameEn.toLowerCase().includes(q);
      const roleHit = !state.listRoleFilter || b.role === state.listRoleFilter;
      chip.classList.toggle('hidden-by-search', !(nameHit && roleHit));
    });
  }

  // ロールで絞り込めると「アサシン全員をまとめて不利にする」といった一括設定がしやすい
  function setupRoleFilter() {
    const el = $('mmRoles');
    const chips = [{ id: null, name: 'すべて' }, ...state.roles.roles];
    el.innerHTML = '';
    for (const r of chips) {
      const chip = document.createElement('div');
      chip.className = 'mm-role-chip' + (state.listRoleFilter === r.id ? ' active' : '');
      chip.textContent = r.name;
      chip.onclick = () => {
        state.listRoleFilter = r.id;
        el.querySelectorAll('.mm-role-chip').forEach((c) => c.classList.toggle('active', c === chip));
        applyFilter();
      };
      el.appendChild(chip);
    }
  }

  init();
})();
