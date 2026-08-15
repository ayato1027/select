(function () {
  const state = {
    brawlers: [],
    brawlersById: {},
    brawlersByNormName: {},
    roles: null,
    config: null,
    pairMatchups: null,
    pairOverrides: { vsEnemy: [], withAlly: [] },
    selected: null, // 選択中のキャラ(self)
    view: 'enemy', // 'enemy' | 'ally'
    pickerSearch: '',
    listSearch: '',
    pickerSort: 'winRate', // 'winRate' | 'name'
    listSort: 'value', // 'value' | 'winRate' | 'battles' | 'name'
    meta: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  async function init() {
    const [config, roles, pairMatchupsFile, pairOverridesRaw, brawlerNamesFile, metaFile] = await Promise.all([
      BSApi.loadLocalJSON('data/config.json'),
      BSApi.loadLocalJSON('data/roles.json'),
      BSApi.loadLocalJSON('data/pair_matchups.json'),
      BSApi.loadLocalJSON('data/pair_overrides.json'),
      BSApi.loadLocalJSON('data/brawler_names_ja.json'),
      BSApi.loadLocalJSON('data/meta.json'),
    ]);
    const { brawlers } = await BSApi.loadBrawlers();

    state.config = config;
    state.roles = roles;
    state.pairMatchups = { vsEnemy: pairMatchupsFile.vsEnemy || {}, withAlly: pairMatchupsFile.withAlly || {} };
    const myRaw = BSApi.readOverrides(BSApi.LS_KEYS.myMatchups);
    state.myMatchups = { vsEnemy: myRaw.vsEnemy || {}, withAlly: myRaw.withAlly || {} };
    state.meta = metaFile;

    const brawlerNames = BSApi.mergeBrawlerNames(brawlerNamesFile.names, BSApi.readOverrides(BSApi.LS_KEYS.brawlerNamesJa));
    state.brawlers = brawlers.map((b) => ({ ...b, displayName: brawlerNames[b.nameEn] || b.name }));
    state.brawlersById = {};
    state.brawlersByNormName = {};
    for (const b of state.brawlers) {
      state.brawlersById[b.id] = b;
      state.brawlersByNormName[b.normName] = b;
    }

    state.pairOverrides = BSScore.resolvePairOverrides(pairOverridesRaw, state.brawlersByNormName);

    $('loading').hidden = true;
    $('muApp').hidden = false;

    setupPickerSearch();
    renderPickerGrid();
    setupViewTabs();
    setupListSearch();
    $('muChangeBtn').onclick = () => selectBrawler(null);
  }

  function roleName(roleId) {
    return (state.roles.roles.find((r) => r.id === roleId) || {}).name || roleId;
  }

  function setupPickerSearch() {
    $('muPickerSearch').addEventListener('input', (e) => {
      state.pickerSearch = e.target.value.trim();
      renderPickerGrid();
    });
    const sortSelect = $('muPickerSort');
    sortSelect.value = state.pickerSort;
    sortSelect.addEventListener('change', (e) => {
      state.pickerSort = e.target.value;
      renderPickerGrid();
    });
  }

  function winRateOf(b) {
    const entry = state.meta.coefficients ? state.meta.coefficients[b.id] : null;
    return entry ? entry.winRate : null;
  }

  function renderPickerGrid() {
    const el = $('muPickerGrid');
    el.innerHTML = '';
    const search = state.pickerSearch.toLowerCase();
    let list = state.brawlers.filter(
      (b) => !search || b.displayName.toLowerCase().includes(search) || b.nameEn.toLowerCase().includes(search)
    );

    if (state.pickerSort === 'winRate') {
      list = [...list].sort((a, b) => {
        const wa = winRateOf(a);
        const wb = winRateOf(b);
        if (wa == null && wb == null) return a.displayName.localeCompare(b.displayName, 'ja');
        if (wa == null) return 1;
        if (wb == null) return -1;
        return wb - wa;
      });
    } else {
      list = [...list].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
    }

    for (const b of list) {
      const wr = winRateOf(b);
      const wrStr = state.pickerSort === 'winRate' && wr != null ? `<div class="pc-winrate">${wr.toFixed(1)}%</div>` : '';
      const cell = document.createElement('div');
      cell.className = 'mu-picker-cell';
      cell.innerHTML = `<img src="${b.imageUrl}" loading="lazy" alt="${b.displayName}" /><div class="pc-name">${b.displayName}</div>${wrStr}`;
      cell.onclick = () => selectBrawler(b);
      el.appendChild(cell);
    }
  }

  function selectBrawler(b) {
    state.selected = b;
    if (!b) {
      $('muPickSection').hidden = false;
      $('muResultSection').hidden = true;
      return;
    }
    $('muPickSection').hidden = true;
    $('muResultSection').hidden = false;
    $('muSelectedIcon').src = b.imageUrl;
    $('muSelectedIcon').alt = b.displayName;
    $('muSelectedName').textContent = b.displayName;
    $('muSelectedRole').textContent = roleName(b.role);
    renderList();
  }

  function setupViewTabs() {
    const tabs = document.querySelectorAll('.wr-view-tab');
    tabs.forEach((tab) => {
      tab.onclick = () => {
        state.view = tab.dataset.view;
        state.listSearch = '';
        $('muListSearch').value = '';
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        renderList();
      };
    });
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
  }

  function setupListSearch() {
    $('muListSearch').addEventListener('input', (e) => {
      state.listSearch = e.target.value.trim();
      renderList();
    });
    const sortSelect = $('muListSort');
    sortSelect.value = state.listSort;
    sortSelect.addEventListener('change', (e) => {
      state.listSort = e.target.value;
      renderList();
    });
  }

  // 手動pair_overrides(あれば最優先)と実データを合わせて、実際のスコア計算と同じ内容を表示する
  function resolvePair(self, other, view) {
    const overridesList = view === 'enemy' ? state.pairOverrides.vsEnemy : state.pairOverrides.withAlly;
    // 自分で作った相性表(mymatchup.html)が常に最優先
    const kind = view === 'enemy' ? 'vsEnemy' : 'withAlly';
    const mine = BSScore.lookupMyMatchup(state.myMatchups, kind, self.id, other.id);
    if (mine != null) {
      return { value: mine, manual: true, note: '自分の相性表', winRate: null, battles: null };
    }

    const otherKey = view === 'enemy' ? 'enemyId' : 'allyId';
    const manual = overridesList.find((o) => String(o.selfId) === String(self.id) && String(o[otherKey]) === String(other.id));
    if (manual) {
      return { value: manual.value, manual: true, note: manual.note, winRate: null, battles: null };
    }
    const table = view === 'enemy' ? state.pairMatchups.vsEnemy : state.pairMatchups.withAlly;
    const entry = table[self.id] && table[self.id][other.id];
    if (entry) {
      // スコア計算と同じ基準: 試合数が足りないものは参考値として区別する
      const cfg = state.config.scoring[view === 'enemy' ? 'pairMatchup' : 'pairSynergy'];
      const unreliable = cfg.minBattles && entry.battles < cfg.minBattles;
      return {
        value: entry.value,
        manual: false,
        unreliable,
        winRate: entry.winRate,
        expectedWinRate: entry.expectedWinRate,
        battles: entry.battles,
      };
    }
    return null;
  }

  function renderList() {
    const self = state.selected;
    if (!self) return;

    const scoringKey = state.view === 'enemy' ? 'pairMatchup' : 'pairSynergy';
    const threshold = state.config.scoring[scoringKey].confidenceThreshold;

    const search = state.listSearch.toLowerCase();
    let rows = state.brawlers
      .filter((b) => b.id !== self.id)
      .filter((b) => !search || b.displayName.toLowerCase().includes(search) || b.nameEn.toLowerCase().includes(search))
      .map((b) => ({ other: b, pair: resolvePair(self, b, state.view) }))
      .filter((r) => r.pair != null);

    rows.sort((a, b) => {
      if (state.listSort === 'name') {
        return a.other.displayName.localeCompare(b.other.displayName, 'ja');
      }
      if (state.listSort === 'winRate' || state.listSort === 'battles') {
        const key = state.listSort;
        const va = a.pair[key];
        const vb = b.pair[key];
        if (va == null && vb == null) return b.pair.value - a.pair.value;
        if (va == null) return 1;
        if (vb == null) return -1;
        return vb - va;
      }
      return b.pair.value - a.pair.value; // 'value'(相性順, 既定)
    });

    const el = $('muList');
    el.innerHTML = '';

    if (rows.length === 0) {
      el.innerHTML = '<div class="mu-empty">データがありません</div>';
    }

    for (const r of rows) {
      const { other, pair } = r;
      // unreliable = スコア計算でも採用されない水準。それ以外でも閾値未満なら参考値扱い
      const lowData = !pair.manual && (pair.unreliable || (pair.battles != null && pair.battles < threshold));
      const row = document.createElement('div');
      row.className = 'mu-row' + (lowData ? ' low-confidence' : '');

      const valueCls = pair.value > 0 ? 'positive' : pair.value < 0 ? 'negative' : 'neutral';
      const valueStr = `${pair.value > 0 ? '+' : ''}${pair.value}`;

      let subHtml = '';
      if (pair.manual) {
        subHtml = `<span class="mu-manual-badge">手動指定</span>${pair.note ? ` ${pair.note}` : ''}`;
      } else if (pair.winRate != null) {
        // 期待値 = 双方の地力から算出される想定勝率。実績がこれをどれだけ上回る/下回るかが相性
        const exp = pair.expectedWinRate != null ? ` (期待値${pair.expectedWinRate.toFixed(1)}%)` : '';
        subHtml = `実績勝率 ${pair.winRate.toFixed(1)}%${exp} / ${pair.battles.toLocaleString()}戦${
          lowData
            ? ` <span class="mu-low-badge">⚠試合数不足${pair.unreliable ? '(スコアには不採用)' : ''}</span>`
            : ''
        }`;
      }

      row.innerHTML = `
        <img class="mu-icon" src="${other.imageUrl}" loading="lazy" alt="${other.displayName}" />
        <div class="mu-main">
          <div class="mu-name-row">
            <span class="mu-name">${other.displayName}</span>
            <span class="mu-role">${roleName(other.role)}</span>
          </div>
          <div class="mu-sub">${subHtml}</div>
        </div>
        <div class="mu-value ${valueCls}">${valueStr}</div>
      `;
      el.appendChild(row);
    }

    const statusEl = $('muStatus');
    const viewLabel = state.view === 'enemy' ? '対面' : '味方';
    statusEl.textContent = `${self.displayName}が${viewLabel}にいる時の相性 (${rows.length}件) — 手動指定 > 実データ > ロール既定値の優先順位のうち、実データ登録済み・手動指定済みの分のみ表示`;
  }

  init();
})();
