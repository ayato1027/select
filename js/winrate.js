(function () {
  const state = {
    brawlers: [],
    brawlersById: {},
    maps: [],
    mapsByMode: {},
    config: null,
    roles: null,
    meta: null,
    mapScores: null,
    view: 'overall', // 'overall' | 'map'
    mode: null,
    mapId: null,
    search: '',
  };

  function $(id) {
    return document.getElementById(id);
  }

  async function init() {
    const [config, roles, metaFile, mapScoresFile, mapNamesFile, brawlerNamesFile] = await Promise.all([
      BSApi.loadLocalJSON('data/config.json'),
      BSApi.loadLocalJSON('data/roles.json'),
      BSApi.loadLocalJSON('data/meta.json'),
      BSApi.loadLocalJSON('data/map_scores.json'),
      BSApi.loadLocalJSON('data/map_names_ja.json'),
      BSApi.loadLocalJSON('data/brawler_names_ja.json'),
    ]);
    const { brawlers } = await BSApi.loadBrawlers();
    const { maps } = await BSApi.loadMaps();

    state.config = config;
    state.roles = roles;
    state.meta = metaFile;
    state.mapScores = mapScoresFile;

    const brawlerNames = BSApi.mergeBrawlerNames(brawlerNamesFile.names, BSApi.readOverrides(BSApi.LS_KEYS.brawlerNamesJa));
    state.brawlers = brawlers.map((b) => ({ ...b, displayName: brawlerNames[b.nameEn] || b.name }));
    state.brawlersById = {};
    for (const b of state.brawlers) state.brawlersById[b.id] = b;

    const mapNames = BSApi.mergeMapNames(mapNamesFile.names, BSApi.readOverrides(BSApi.LS_KEYS.mapNamesJa));
    state.maps = maps.map((m) => ({ ...m, displayName: mapNames[m.name] || m.name }));
    state.mapsByMode = {};
    for (const m of state.maps) {
      if (!state.mapsByMode[m.modeId]) state.mapsByMode[m.modeId] = [];
      state.mapsByMode[m.modeId].push(m);
    }

    state.mode = config.modes[0].id;
    const modeMaps = state.mapsByMode[state.mode] || [];
    state.mapId = modeMaps[0] ? modeMaps[0].id : null;

    $('loading').hidden = true;
    $('wrApp').hidden = false;

    setupViewTabs();
    setupSearch();
    renderModeTabs();
    renderMapGrid();
    renderList();
  }

  function setupViewTabs() {
    const tabs = document.querySelectorAll('.wr-view-tab');
    tabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === state.view);
      tab.onclick = () => {
        state.view = tab.dataset.view;
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        $('wrMapPicker').hidden = state.view !== 'map';
        renderList();
      };
    });
    $('wrMapPicker').hidden = state.view !== 'map';
  }

  function setupSearch() {
    $('wrSearch').addEventListener('input', (e) => {
      state.search = e.target.value.trim();
      renderList();
    });
  }

  function renderModeTabs() {
    const el = $('wrModeTabs');
    el.innerHTML = '';
    for (const mode of state.config.modes) {
      const btn = document.createElement('button');
      btn.className = 'mode-tab' + (mode.id === state.mode ? ' active' : '');
      btn.textContent = mode.name;
      btn.onclick = () => {
        state.mode = mode.id;
        const modeMaps = state.mapsByMode[mode.id] || [];
        state.mapId = modeMaps[0] ? modeMaps[0].id : null;
        renderModeTabs();
        renderMapGrid();
        renderList();
      };
      el.appendChild(btn);
    }
  }

  function renderMapGrid() {
    const el = $('wrMapGrid');
    el.innerHTML = '';
    const modeMaps = state.mapsByMode[state.mode] || [];
    for (const map of modeMaps) {
      const card = document.createElement('div');
      card.className = 'map-card' + (map.id === state.mapId ? ' active' : '');
      card.innerHTML = `<img src="${map.imageUrl}" loading="lazy" alt="${map.displayName}" /><div class="map-name">${map.displayName}</div>`;
      card.onclick = () => {
        state.mapId = map.id;
        renderMapGrid();
        renderList();
      };
      el.appendChild(card);
    }
  }

  function buildOverallList() {
    const coefs = state.meta.coefficients || {};
    const rows = [];
    for (const b of state.brawlers) {
      const entry = coefs[b.id];
      rows.push({
        brawler: b,
        winRate: entry ? entry.winRate : null,
        battles: entry ? entry.battles : null,
      });
    }
    return rows;
  }

  function buildMapList(mapId) {
    const mapEntry = state.mapScores.maps ? state.mapScores.maps[mapId] : null;
    const scores = mapEntry ? mapEntry.scores : {};
    const rows = [];
    for (const b of state.brawlers) {
      const entry = scores[b.id];
      rows.push({
        brawler: b,
        winRate: entry ? entry.mapWinRate : null,
        battles: entry ? entry.battles : null,
      });
    }
    return rows;
  }

  function getConfidenceThreshold() {
    return state.view === 'overall'
      ? state.config.scoring.meta.confidenceThresholdN
      : state.config.scoring.mapScore.confidenceThresholdM;
  }

  function renderList() {
    let rows = state.view === 'overall' ? buildOverallList() : buildMapList(state.mapId);

    const search = state.search.toLowerCase();
    if (search) {
      rows = rows.filter(
        (r) => r.brawler.displayName.toLowerCase().includes(search) || r.brawler.nameEn.toLowerCase().includes(search)
      );
    }

    const threshold = getConfidenceThreshold();
    const isReliable = (r) => r.winRate != null && r.battles >= threshold;

    // 試合数が閾値未満のもの(データ不足)は、勝率の高さに関わらず信頼できる集団より後ろへ回す
    rows.sort((a, b) => {
      const aOk = isReliable(a);
      const bOk = isReliable(b);
      if (aOk !== bOk) return aOk ? -1 : 1;
      if (a.winRate == null && b.winRate == null) return 0;
      if (a.winRate == null) return 1;
      if (b.winRate == null) return -1;
      return b.winRate - a.winRate;
    });

    const reliableRows = rows.filter(isReliable);
    const maxRate = reliableRows.length ? Math.max(...reliableRows.map((r) => r.winRate)) : 100;
    const minRate = reliableRows.length ? Math.min(...reliableRows.map((r) => r.winRate)) : 0;
    const range = Math.max(maxRate - minRate, 0.01);

    const el = $('wrList');
    el.innerHTML = '';

    if (rows.length === 0) {
      el.innerHTML = '<div class="wr-empty">該当するキャラがいません</div>';
    }

    let reliableIdx = 0;
    rows.forEach((r) => {
      const roleName = (state.roles.roles.find((rr) => rr.id === r.brawler.role) || {}).name || r.brawler.role;
      const row = document.createElement('div');
      const reliable = isReliable(r);
      const lowData = r.winRate != null && !reliable;
      row.className = 'wr-row' + (lowData ? ' low-confidence' : '');

      let rankClass = '';
      let rankLabel = '―';
      if (reliable) {
        reliableIdx++;
        if (reliableIdx === 1) rankClass = 'top1';
        else if (reliableIdx === 2) rankClass = 'top2';
        else if (reliableIdx === 3) rankClass = 'top3';
        rankLabel = String(reliableIdx);
      }

      const rateStr = r.winRate != null ? `${r.winRate.toFixed(1)}%` : 'ー';
      const battlesStr = r.winRate != null ? `${r.battles.toLocaleString()}戦` : 'データなし';
      const lowBadge = lowData ? `<span class="wr-low-badge">⚠試合数不足(閾値${threshold.toLocaleString()})</span>` : '';
      const barWidth = reliable ? Math.max(4, ((r.winRate - minRate) / range) * 100) : lowData ? 4 : 0;

      row.innerHTML = `
        <div class="wr-rank ${rankClass}">${rankLabel}</div>
        <img class="wr-icon" src="${r.brawler.imageUrl}" loading="lazy" alt="${r.brawler.displayName}" />
        <div class="wr-main">
          <div class="wr-name-row">
            <span class="wr-name">${r.brawler.displayName}</span>
            <span class="wr-role">${roleName}</span>
          </div>
          <div class="wr-battles">${battlesStr}${lowBadge}</div>
          <div class="wr-rate-bar-track"><div class="wr-rate-bar-fill" style="width:${barWidth}%;"></div></div>
        </div>
        <div class="wr-rate">${rateStr}</div>
      `;
      el.appendChild(row);
    });

    const statusEl = $('wrStatus');
    const thresholdNote = `試合数${threshold.toLocaleString()}未満は「データ不足」として下に表示`;
    if (state.view === 'overall') {
      statusEl.textContent = state.meta.updatedAt
        ? `更新: ${state.meta.updatedAt} (直近シーズン, ガチバトル上級帯) / ${thresholdNote}`
        : '勝率データ未取得';
    } else {
      statusEl.textContent = state.mapScores.updatedAt
        ? `更新: ${state.mapScores.updatedAt} (直近シーズン, ガチバトル上級帯) / ${thresholdNote}`
        : '勝率データ未取得';
    }
  }

  init();
})();
