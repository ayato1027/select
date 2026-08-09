(function () {
  const DRAFT_KEY = 'bs_draft_v1';

  const state = {
    brawlers: [],
    brawlersById: {},
    brawlersByNormName: {},
    maps: [],
    mapsByMode: {},
    rankedMapsByMode: {},
    config: null,
    roles: null,
    roleMatchups: null,
    roleSynergy: null,
    pairOverrides: { vsEnemy: [], withAlly: [] },
    compRules: null,
    mapScores: null,
    mapOverrides: [],
    meta: null,
    draft: { mode: null, mapId: null, enemies: [], allies: [], bans: [] },
    expandedRankId: null,
    showAll: false,
  };

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) Object.assign(state.draft, JSON.parse(raw));
    } catch (e) {}
  }

  function saveDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft));
  }

  function byId(list) {
    const map = {};
    for (const item of list) map[item.id] = item;
    return map;
  }

  async function init() {
    try {
      const [config, roles, roleMatchups, roleSynergy, pairOverridesRaw, compRules, mapScoresFile, mapOverridesFile, metaFile, rankedMapsFile, mapNamesFile, brawlerNamesFile] =
        await Promise.all([
          BSApi.loadLocalJSON('data/config.json'),
          BSApi.loadLocalJSON('data/roles.json'),
          BSApi.loadLocalJSON('data/role_matchups.json'),
          BSApi.loadLocalJSON('data/role_synergy.json'),
          BSApi.loadLocalJSON('data/pair_overrides.json'),
          BSApi.loadLocalJSON('data/comp_rules.json'),
          BSApi.loadLocalJSON('data/map_scores.json'),
          BSApi.loadLocalJSON('data/map_overrides.json'),
          BSApi.loadLocalJSON('data/meta.json'),
          BSApi.loadLocalJSON('data/ranked_maps.json'),
          BSApi.loadLocalJSON('data/map_names_ja.json'),
          BSApi.loadLocalJSON('data/brawler_names_ja.json'),
        ]);

      const { brawlers, updatedAt: brawlersUpdatedAt } = await BSApi.loadBrawlers();
      const { maps } = await BSApi.loadMaps();

      state.config = config;
      state.roles = roles;
      state.roleMatchups = roleMatchups;
      state.roleSynergy = roleSynergy;
      state.compRules = compRules;
      state.mapScores = mapScoresFile;
      state.meta = BSApi.mergeMetaOverrides(metaFile, BSApi.readOverrides(BSApi.LS_KEYS.metaOverrides));
      state.mapOverrides = BSApi.mergeMapOverrides(mapOverridesFile.overrides, BSApi.readOverrides(BSApi.LS_KEYS.mapOverrides));

      const brawlerNames = BSApi.mergeBrawlerNames(brawlerNamesFile.names, BSApi.readOverrides(BSApi.LS_KEYS.brawlerNamesJa));
      state.brawlers = brawlers.map((b) => ({ ...b, displayName: brawlerNames[b.nameEn] || b.name }));
      state.brawlersById = byId(state.brawlers);
      state.brawlersByNormName = {};
      for (const b of state.brawlers) state.brawlersByNormName[b.normName] = b;

      state.pairOverrides = BSScore.resolvePairOverrides(pairOverridesRaw, state.brawlersByNormName);

      const mapNames = BSApi.mergeMapNames(mapNamesFile.names, BSApi.readOverrides(BSApi.LS_KEYS.mapNamesJa));
      state.maps = maps.map((m) => ({ ...m, displayName: mapNames[m.name] || m.name }));
      state.mapsByMode = {};
      for (const m of state.maps) {
        if (!state.mapsByMode[m.modeId]) state.mapsByMode[m.modeId] = [];
        state.mapsByMode[m.modeId].push(m);
      }
      state.rankedMapsByMode = BSApi.mergeRankedMaps(rankedMapsFile.modes, BSApi.readOverrides(BSApi.LS_KEYS.rankedMaps));

      loadDraft();
      if (!state.draft.mode || !state.mapsByMode[state.draft.mode]) {
        state.draft.mode = config.modes[0].id;
      }
      const modeMaps = getDisplayMaps(state.draft.mode);
      if (!state.draft.mapId || !modeMaps.find((m) => m.id === state.draft.mapId)) {
        state.draft.mapId = modeMaps[0] ? modeMaps[0].id : null;
      }
      state.draft.enemies = (state.draft.enemies || []).filter((id) => state.brawlersById[id]);
      state.draft.allies = (state.draft.allies || []).filter((id) => state.brawlersById[id]);
      state.draft.bans = (state.draft.bans || []).filter((id) => state.brawlersById[id]);

      document.getElementById('loading').hidden = true;
      document.getElementById('app').hidden = false;

      renderModeTabs();
      renderMapGrid();
      renderDraftSlots();
      renderRanking();
      setupPicker();
      setupBanToggle();
      setupScanButton();

      BSApi.checkForBrawlerUpdate(brawlers.length).then((result) => {
        if (result.hasUpdate) {
          showBanner(
            `新キャラを検出しました(同梱データ${result.bundledCount}体 → 最新${result.liveCount}体)。npm run update-data(scripts/update-data.js)の実行を推奨します。`,
            false
          );
        }
      });
    } catch (e) {
      console.error(e);
      document.getElementById('loading').hidden = true;
      showBanner('データの取得に失敗しました。通信環境を確認してリロードしてください。', true);
    }
  }

  function showBanner(msg, isError) {
    const el = document.getElementById('errorBanner');
    el.textContent = msg;
    el.hidden = false;
    el.style.color = isError ? 'var(--bad)' : 'var(--text-dim)';
  }

  function renderModeTabs() {
    const el = document.getElementById('modeTabs');
    el.innerHTML = '';
    for (const mode of state.config.modes) {
      const btn = document.createElement('button');
      btn.className = 'mode-tab' + (mode.id === state.draft.mode ? ' active' : '');
      btn.textContent = mode.name;
      btn.onclick = () => {
        state.draft.mode = mode.id;
        const modeMaps = getDisplayMaps(mode.id);
        state.draft.mapId = modeMaps[0] ? modeMaps[0].id : null;
        saveDraft();
        renderModeTabs();
        renderMapGrid();
        renderRanking();
      };
      el.appendChild(btn);
    }
  }

  // ガチバトル(ランク戦)の現在ロテーションが選定済みならそのマップのみ、未選定なら全マップを返す
  function getDisplayMaps(modeId) {
    const all = state.mapsByMode[modeId] || [];
    const curatedIds = state.rankedMapsByMode[modeId];
    if (curatedIds && curatedIds.length > 0) {
      const idSet = new Set(curatedIds);
      return all.filter((m) => idSet.has(m.id));
    }
    return all;
  }

  function renderMapGrid() {
    const el = document.getElementById('mapGrid');
    el.innerHTML = '';
    const allModeMaps = state.mapsByMode[state.draft.mode] || [];
    const modeMaps = getDisplayMaps(state.draft.mode);
    const isCurated = (state.rankedMapsByMode[state.draft.mode] || []).length > 0;

    const notice = document.getElementById('mapGridNotice');
    if (notice) {
      if (allModeMaps.length > 0 && !isCurated) {
        notice.hidden = false;
        notice.textContent = `⚠ このモードのガチバトル現在ロテーションが未選定のため、全${allModeMaps.length}マップを表示中です。管理画面(⚙)で選定できます。`;
      } else {
        notice.hidden = true;
      }
    }

    if (modeMaps.length === 0) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px;">このモードのマップ情報が取得できませんでした</div>';
      return;
    }
    for (const map of modeMaps) {
      const card = document.createElement('div');
      card.className = 'map-card' + (map.id === state.draft.mapId ? ' active' : '');
      card.innerHTML = `<img src="${map.imageUrl}" loading="lazy" alt="${map.displayName}" /><div class="map-name">${map.displayName}</div>`;
      card.onclick = () => {
        state.draft.mapId = map.id;
        saveDraft();
        renderMapGrid();
        renderRanking();
      };
      el.appendChild(card);
    }
  }

  function renderSlotRow(containerId, ids, max, onOpenPicker) {
    const el = document.getElementById(containerId);
    el.innerHTML = '';
    for (let i = 0; i < max; i++) {
      const id = ids[i];
      const slot = document.createElement('div');
      slot.className = 'slot' + (id ? ' filled' : '');
      if (id && state.brawlersById[id]) {
        const b = state.brawlersById[id];
        slot.innerHTML = `<img src="${b.imageUrl}" alt="${b.displayName}" /><span class="remove-badge">×</span>`;
        slot.onclick = () => {
          ids.splice(i, 1);
          saveDraft();
          renderDraftSlots();
          renderRanking();
        };
      } else {
        slot.textContent = '+';
        slot.onclick = () => onOpenPicker(i);
      }
      el.appendChild(slot);
    }
  }

  function renderDraftSlots() {
    renderSlotRow('enemySlots', state.draft.enemies, state.config.draft.maxEnemies, (i) => {
      openPicker({
        excludeIds: new Set([...state.draft.enemies, ...state.draft.allies, ...state.draft.bans]),
        onSelect: (brawlerId) => {
          state.draft.enemies[i] = brawlerId;
          saveDraft();
          renderDraftSlots();
          renderRanking();
        },
      });
    });
    renderSlotRow('allySlots', state.draft.allies, state.config.draft.maxAllies, (i) => {
      openPicker({
        excludeIds: new Set([...state.draft.enemies, ...state.draft.allies, ...state.draft.bans]),
        onSelect: (brawlerId) => {
          state.draft.allies[i] = brawlerId;
          saveDraft();
          renderDraftSlots();
          renderRanking();
        },
      });
    });
    const banCountEl = document.getElementById('banCount');
    banCountEl.textContent = state.draft.bans.length > 0 ? `(${state.draft.bans.length})` : '';
  }

  // --- キャラピッカー ---
  let pickerState = { excludeIds: new Set(), onSelect: null, multi: false, roleFilter: null, search: '', quickIds: [] };

  function openPicker(opts) {
    pickerState = {
      excludeIds: opts.excludeIds || new Set(),
      selectedIds: opts.selectedIds || null, // multi用
      onSelect: opts.onSelect || null,
      onToggle: opts.onToggle || null,
      multi: !!opts.multi,
      roleFilter: null,
      search: '',
      quickIds: opts.quickIds || [],
    };
    document.getElementById('pickerSearch').value = '';
    renderPickerQuick();
    renderPickerRoles();
    renderPickerGrid();
    document.getElementById('pickerOverlay').hidden = false;
  }

  // よく使うBAN候補(使用頻度の高い順)を上部にワンタップ選択できるようにする
  const BAN_FREQ_KEY = 'bs_ban_frequency_v1';

  function loadBanFrequency() {
    try {
      return JSON.parse(localStorage.getItem(BAN_FREQ_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function bumpBanFrequency(brawlerId) {
    const freq = loadBanFrequency();
    freq[brawlerId] = (freq[brawlerId] || 0) + 1;
    localStorage.setItem(BAN_FREQ_KEY, JSON.stringify(freq));
  }

  function getFrequentBanIds(excludeSet, limit) {
    const freq = loadBanFrequency();
    return Object.entries(freq)
      .filter(([id]) => !excludeSet.has(Number(id)) && state.brawlersById[id])
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => Number(id));
  }

  function renderPickerQuick() {
    const el = document.getElementById('pickerQuick');
    if (!pickerState.quickIds || pickerState.quickIds.length === 0) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = '<div class="picker-quick-label">よく使うBAN候補</div><div class="picker-quick-grid"></div>';
    const grid = el.querySelector('.picker-quick-grid');
    for (const id of pickerState.quickIds) {
      const b = state.brawlersById[id];
      if (!b) continue;
      const selected = pickerState.selectedIds && pickerState.selectedIds.has(id);
      const cell = document.createElement('div');
      cell.className = 'picker-cell' + (selected ? ' selected' : '');
      cell.innerHTML = `<img src="${b.imageUrl}" loading="lazy" alt="${b.displayName}" /><div class="pc-name">${b.displayName}</div>`;
      cell.onclick = () => {
        pickerState.onToggle(id);
        renderPickerQuick();
        renderPickerGrid();
      };
      grid.appendChild(cell);
    }
  }

  function closePicker() {
    document.getElementById('pickerOverlay').hidden = true;
  }

  function renderPickerRoles() {
    const el = document.getElementById('pickerRoles');
    el.innerHTML = '';
    const allChip = document.createElement('div');
    allChip.className = 'picker-role-chip' + (pickerState.roleFilter === null ? ' active' : '');
    allChip.textContent = 'すべて';
    allChip.onclick = () => {
      pickerState.roleFilter = null;
      renderPickerRoles();
      renderPickerGrid();
    };
    el.appendChild(allChip);
    for (const role of state.roles.roles) {
      const chip = document.createElement('div');
      chip.className = 'picker-role-chip' + (pickerState.roleFilter === role.id ? ' active' : '');
      chip.textContent = role.name;
      chip.onclick = () => {
        pickerState.roleFilter = role.id;
        renderPickerRoles();
        renderPickerGrid();
      };
      el.appendChild(chip);
    }
  }

  function renderPickerGrid() {
    const el = document.getElementById('pickerGrid');
    el.innerHTML = '';
    const search = pickerState.search.trim();
    const list = state.brawlers
      .filter((b) => (pickerState.roleFilter ? b.role === pickerState.roleFilter : true))
      .filter((b) => (search ? b.displayName.includes(search) || b.name.includes(search) || b.nameEn.toLowerCase().includes(search.toLowerCase()) : true))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));

    for (const b of list) {
      const cell = document.createElement('div');
      const disabled = pickerState.excludeIds.has(b.id) && !(pickerState.selectedIds && pickerState.selectedIds.has(b.id));
      const selected = pickerState.selectedIds && pickerState.selectedIds.has(b.id);
      cell.className = 'picker-cell' + (disabled ? ' disabled' : '') + (selected ? ' selected' : '');
      cell.innerHTML = `<img src="${b.imageUrl}" loading="lazy" alt="${b.displayName}" /><div class="pc-name">${b.displayName}</div>`;
      cell.onclick = () => {
        if (pickerState.multi) {
          pickerState.onToggle(b.id);
          renderPickerGrid();
          renderPickerQuick();
        } else {
          pickerState.onSelect(b.id);
          closePicker();
        }
      };
      el.appendChild(cell);
    }
  }

  function setupPicker() {
    document.getElementById('pickerClose').onclick = closePicker;
    document.getElementById('pickerOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'pickerOverlay') closePicker();
    });
    document.getElementById('pickerSearch').addEventListener('input', (e) => {
      pickerState.search = e.target.value;
      renderPickerGrid();
    });
  }

  function setupBanToggle() {
    document.getElementById('banToggle').onclick = () => {
      const selected = new Set(state.draft.bans);
      const excludeIds = new Set([...state.draft.enemies, ...state.draft.allies]);
      openPicker({
        multi: true,
        excludeIds,
        selectedIds: selected,
        quickIds: getFrequentBanIds(excludeIds, 10),
        onToggle: (brawlerId) => {
          if (selected.has(brawlerId)) {
            selected.delete(brawlerId);
          } else {
            selected.add(brawlerId);
            bumpBanFrequency(brawlerId);
          }
          state.draft.bans = [...selected];
          saveDraft();
          renderDraftSlots();
          renderRanking();
        },
      });
    };
  }

  function setupScanButton() {
    const btn = document.getElementById('scanOpenBtn');
    if (!btn || !window.BSScan) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      btn.hidden = true; // カメラAPI非対応環境では表示しない
      return;
    }
    btn.onclick = () => {
      window.BSScan.open(state.brawlers, (brawlerId) => {
        const excludeSet = new Set([...state.draft.enemies, ...state.draft.allies, ...state.draft.bans]);
        if (excludeSet.has(brawlerId)) return; // 既にドラフト済み・BAN済みなら無視
        state.draft.bans = [...state.draft.bans, brawlerId];
        bumpBanFrequency(brawlerId);
        saveDraft();
        renderDraftSlots();
        renderRanking();
      });
    };
  }

  // --- ランキング ---
  function renderRanking() {
    const excludeSet = new Set([...state.draft.enemies, ...state.draft.allies, ...state.draft.bans]);
    const candidates = state.brawlers.filter((b) => !excludeSet.has(b.id));

    const ctx = {
      mode: state.draft.mode,
      mapId: state.draft.mapId,
      enemies: state.draft.enemies.map((id) => state.brawlersById[id]).filter(Boolean),
      allies: state.draft.allies.map((id) => state.brawlersById[id]).filter(Boolean),
      mapScores: state.mapScores,
      mapOverrides: state.mapOverrides,
      meta: state.meta,
      roleMatchups: state.roleMatchups,
      roleSynergy: state.roleSynergy,
      pairOverrides: state.pairOverrides,
      compRules: state.compRules,
      config: state.config,
    };

    const results = BSScore.computeScores(candidates, ctx);
    const topN = state.config.ranking.topDisplay;
    const displayed = state.showAll ? results : results.slice(0, topN);

    const el = document.getElementById('rankingList');
    el.innerHTML = '';
    displayed.forEach((r, idx) => {
      const row = document.createElement('div');
      row.className = 'rank-row' + (state.expandedRankId === r.brawler.id ? ' expanded' : '');
      const roleName = (state.roles.roles.find((rr) => rr.id === r.brawler.role) || {}).name || r.brawler.role;
      const reasonsHtml = r.reasons.map((txt) => `<span class="rank-reason-tag">${txt}</span>`).join('');
      const allReasonsHtml = r.allReasons.length
        ? r.allReasons.map((rr) => `<li>${rr.label}</li>`).join('')
        : '<li>特筆すべき補正要素なし</li>';

      row.innerHTML = `
        <div class="rank-num">${idx + 1}</div>
        <img class="rank-icon" src="${r.brawler.imageUrl}" loading="lazy" alt="${r.brawler.displayName}" />
        <div class="rank-main">
          <div class="rank-name-row">
            <span class="rank-name">${r.brawler.displayName}</span>
            <span class="rank-role">${roleName}</span>
          </div>
          <div class="rank-reasons">${reasonsHtml}</div>
          <div class="rank-detail">
            <div class="breakdown-grid">
              <div class="breakdown-item"><div class="bd-label">適性</div><div class="bd-value">${r.breakdown.mapValue.toFixed(1)}</div></div>
              <div class="breakdown-item"><div class="bd-label">対敵</div><div class="bd-value">${fmtSigned(r.breakdown.enemySum)}</div></div>
              <div class="breakdown-item"><div class="bd-label">シナジー</div><div class="bd-value">${fmtSigned(r.breakdown.allySum)}</div></div>
              <div class="breakdown-item"><div class="bd-label">メタ</div><div class="bd-value">${fmtSigned(r.breakdown.metaValue)}</div></div>
            </div>
            <ul class="all-reasons">${allReasonsHtml}</ul>
          </div>
        </div>
        <div class="rank-score">${r.total.toFixed(1)}</div>
      `;
      row.addEventListener('click', (e) => {
        state.expandedRankId = state.expandedRankId === r.brawler.id ? null : r.brawler.id;
        renderRanking();
      });
      el.appendChild(row);
    });

    const showAllBtn = document.getElementById('showAllBtn');
    if (results.length > topN) {
      showAllBtn.hidden = false;
      showAllBtn.textContent = state.showAll ? '上位のみ表示' : `すべて表示 (${results.length}体)`;
      showAllBtn.onclick = () => {
        state.showAll = !state.showAll;
        renderRanking();
      };
    } else {
      showAllBtn.hidden = true;
    }

    const statusEl = document.getElementById('dataStatus');
    const updated = state.mapScores.updatedAt;
    statusEl.textContent = updated ? `マップデータ更新: ${updated}` : 'マップ勝率データ未取得(中立値で表示中)';
  }

  function fmtSigned(v) {
    const r = Math.round(v * 10) / 10;
    return `${r > 0 ? '+' : ''}${r}`;
  }

  init();
})();
