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
    draft: { mode: null, mapId: null, enemies: [], allies: [], bans: [], side: null, selfDone: false, selfPick: null },
    expandedRankId: null,
    showAll: false,
    personalBias: {},
    sortKey: 'total',
  };

  const PERSONAL_BIAS_KEY = 'bs_personal_bias_v1';
  const SORT_OPTIONS = [
    { key: 'total', label: 'スコア順' },
    { key: 'mapValue', label: 'マップ適性順' },
    { key: 'metaValue', label: 'メタ順' },
    { key: 'mapWinRate', label: 'マップ勝率順' },
    { key: 'metaWinRate', label: '全体勝率順' },
  ];

  // ガチバトルの実際のドラフト順序(1-2-2-1形式)。coin flipで先攻/後攻が決まり、
  // 先攻は1人目→(相手2人)→2人目3人目→(相手1人)、後攻はその逆順で3人ずつピックする。
  // 自チームの合計3人 = 自分1人(own_self, 専用の「自分」枠に記録するか「記録せずスキップ」で進む)
  // + 味方2人(own_ally, 既存のallyスロット2枠と対応)。この2種を分けないと、
  // 「own」計3人 と ally上限2枠が数として矛盾してしまう。
  const DRAFT_SEQUENCE = {
    first: [
      { team: 'own_self', count: 1 },
      { team: 'enemy', count: 2 },
      { team: 'own_ally', count: 2 },
      { team: 'enemy', count: 1 },
    ],
    second: [
      { team: 'enemy', count: 1 },
      { team: 'own_ally', count: 2 },
      { team: 'enemy', count: 2 },
      { team: 'own_self', count: 1 },
    ],
  };

  // 現在の味方/相手/自分ピック済み状況から、ドラフトの進行状況(今どの番か)を逆算する
  function getDraftProgress() {
    if (!state.draft.side) return null;
    const seq = DRAFT_SEQUENCE[state.draft.side];
    let allyRemaining = state.draft.allies.length;
    let enemyRemaining = state.draft.enemies.length;
    let selfRemaining = state.draft.selfDone || state.draft.selfPick != null ? 1 : 0;
    for (let i = 0; i < seq.length; i++) {
      const seg = seq[i];
      let pool;
      if (seg.team === 'enemy') pool = enemyRemaining;
      else if (seg.team === 'own_ally') pool = allyRemaining;
      else pool = selfRemaining;

      const consumed = Math.min(pool, seg.count);
      if (consumed < seg.count) {
        return { segmentIndex: i, team: seg.team, doneInSegment: consumed, totalInSegment: seg.count, seq, completed: false };
      }
      if (seg.team === 'enemy') enemyRemaining -= seg.count;
      else if (seg.team === 'own_ally') allyRemaining -= seg.count;
      else selfRemaining -= seg.count;
    }
    return { segmentIndex: seq.length, completed: true, seq };
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) Object.assign(state.draft, JSON.parse(raw));
    } catch (e) {}
  }

  function saveDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft));
  }

  function loadPersonalBias() {
    return BSApi.readOverrides(PERSONAL_BIAS_KEY);
  }

  function loadMyMatchups() {
    const raw = BSApi.readOverrides(BSApi.LS_KEYS.myMatchups);
    return { vsEnemy: raw.vsEnemy || {}, withAlly: raw.withAlly || {} };
  }

  function savePersonalBias(brawlerId, value, note) {
    const bias = loadPersonalBias();
    if (!value) {
      delete bias[brawlerId];
    } else {
      bias[brawlerId] = { value, note: note || '' };
    }
    BSApi.writeOverrides(PERSONAL_BIAS_KEY, bias);
    state.personalBias = bias;
  }

  function byId(list) {
    const map = {};
    for (const item of list) map[item.id] = item;
    return map;
  }

  async function init() {
    try {
      const [config, roles, roleMatchups, roleSynergy, pairOverridesRaw, compRules, mapScoresFile, mapOverridesFile, metaFile, rankedMapsFile, mapNamesFile, brawlerNamesFile, pairMatchupsFile, brawlerStatsFile] =
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
          BSApi.loadLocalJSON('data/pair_matchups.json'),
          BSApi.loadLocalJSON('data/brawler_stats.json'),
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
      state.pairMatchups = { vsEnemy: pairMatchupsFile.vsEnemy || {}, withAlly: pairMatchupsFile.withAlly || {} };
      state.brawlerStats = brawlerStatsFile;
      state.myMatchups = loadMyMatchups();
      state.personalBias = loadPersonalBias();

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
      if (state.draft.selfPick != null && !state.brawlersById[state.draft.selfPick]) state.draft.selfPick = null;

      document.getElementById('loading').hidden = true;
      document.getElementById('app').hidden = false;

      renderModeTabs();
      renderMapGrid();
      renderDraftSlots();
      renderRanking();
      setupPicker();
      setupBanToggle();
      setupScanButton();
      setupSortSelect();
      setupDraftSidePicker();

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
        renderCompAnalysis(); // モード依存の構成診断(回復不在など)を更新
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

  // activeIndices: null = 制限なし(自由入力モード)。Setの場合はそのインデックスの空きスロットのみ入力可
  function renderSlotRow(containerId, ids, max, onOpenPicker, activeIndices) {
    const el = document.getElementById(containerId);
    el.innerHTML = '';
    for (let i = 0; i < max; i++) {
      const id = ids[i];
      const isActive = !activeIndices || activeIndices.has(i);
      const slot = document.createElement('div');
      slot.className =
        'slot' +
        (id ? ' filled' : '') +
        (!id && !isActive ? ' locked' : '') +
        (!id && isActive && activeIndices ? ' turn-active' : '');
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
        if (isActive) slot.onclick = () => onOpenPicker(i);
      }
      el.appendChild(slot);
    }
  }

  // 全入力枠共通の除外セット(既にどこかで選ばれているキャラはピッカーで選べない)
  function draftExcludeSet() {
    return new Set([
      ...state.draft.enemies,
      ...state.draft.allies,
      ...state.draft.bans,
      ...(state.draft.selfPick != null ? [state.draft.selfPick] : []),
    ]);
  }

  function renderDraftSlots() {
    const progress = getDraftProgress();
    let enemyActive = null;
    let allyActive = null;
    let selfActive = null;

    if (state.draft.side) {
      enemyActive = new Set();
      allyActive = new Set();
      selfActive = new Set();
      if (progress && !progress.completed) {
        if (progress.team === 'own_self') {
          selfActive.add(0);
        } else {
          const remaining = progress.totalInSegment - progress.doneInSegment;
          const target = progress.team === 'enemy' ? enemyActive : allyActive;
          const base = progress.team === 'enemy' ? state.draft.enemies.length : state.draft.allies.length;
          for (let i = base; i < base + remaining; i++) target.add(i);
        }
      }
    }

    renderSlotRow(
      'enemySlots',
      state.draft.enemies,
      state.config.draft.maxEnemies,
      (i) => {
        openPicker({
          excludeIds: draftExcludeSet(),
          onSelect: (brawlerId) => {
            state.draft.enemies[i] = brawlerId;
            saveDraft();
            renderDraftSlots();
            renderRanking();
          },
        });
      },
      enemyActive
    );
    renderSlotRow(
      'allySlots',
      state.draft.allies,
      state.config.draft.maxAllies,
      (i) => {
        openPicker({
          excludeIds: draftExcludeSet(),
          onSelect: (brawlerId) => {
            state.draft.allies[i] = brawlerId;
            saveDraft();
            renderDraftSlots();
            renderRanking();
          },
        });
      },
      allyActive
    );
    renderSelfSlot(selfActive);
    const banCountEl = document.getElementById('banCount');
    banCountEl.textContent = state.draft.bans.length > 0 ? `(${state.draft.bans.length})` : '';

    renderDraftSideUI(progress);
    renderCompAnalysis();
  }

  // 自分のピック(1枠)。allies配列とは別管理のため専用レンダラを持つ
  function renderSelfSlot(activeSet) {
    const el = document.getElementById('selfSlot');
    el.innerHTML = '';
    const id = state.draft.selfPick;
    const isActive = !activeSet || activeSet.has(0);
    const slot = document.createElement('div');
    slot.className =
      'slot' +
      (id != null ? ' filled' : '') +
      (id == null && !isActive ? ' locked' : '') +
      (id == null && isActive && activeSet ? ' turn-active' : '');
    if (id != null && state.brawlersById[id]) {
      const b = state.brawlersById[id];
      slot.innerHTML = `<img src="${b.imageUrl}" alt="${b.displayName}" /><span class="remove-badge">×</span>`;
      slot.onclick = () => {
        state.draft.selfPick = null;
        state.draft.selfDone = false;
        saveDraft();
        renderDraftSlots();
        renderRanking();
      };
    } else {
      slot.textContent = '+';
      if (isActive) {
        slot.onclick = () => {
          openPicker({
            excludeIds: draftExcludeSet(),
            onSelect: (brawlerId) => {
              state.draft.selfPick = brawlerId;
              saveDraft();
              renderDraftSlots();
              renderRanking();
            },
          });
        };
      }
    }
    el.appendChild(slot);
  }

  // --- チーム構成分析 ---
  const RANGE_LABELS = { close: '近距離', mid: '中距離', long: '長射程' };

  // 射程帯はゲーム内の実射程(brawler_stats.jsonのrangeTiles)で判定する。
  // データ欠損時のみ役割からの近似にフォールバックする。
  const RANGE_BY_ROLE_FALLBACK = {
    dive_tank: 'close',
    anchor_tank: 'close',
    assassin: 'close',
    close_dps: 'close',
    mid_dps: 'mid',
    area_control: 'mid',
    trap: 'mid',
    heal_support: 'mid',
    buff_support: 'mid',
    sniper: 'long',
    thrower: 'long',
  };

  function statsOf(brawler) {
    const t = state.brawlerStats && state.brawlerStats.stats;
    return t ? t[brawler.id] : null;
  }

  function rangeBandOf(brawler) {
    const s = statsOf(brawler);
    if (s && s.rangeTiles > 0) {
      const { closeMax, midMax } = state.config.rangeBands;
      if (s.rangeTiles < closeMax) return 'close';
      if (s.rangeTiles < midMax) return 'mid';
      return 'long';
    }
    return RANGE_BY_ROLE_FALLBACK[brawler.role] || 'mid';
  }

  function roleNameOf(roleId) {
    return (state.roles.roles.find((r) => r.id === roleId) || {}).name || roleId;
  }

  // 味方チームの偏り診断。判定条件は data/comp_rules.json のルールと対応させている
  // (comp_rulesは「候補への加減点」用の宣言なので、表示用の文言はここで持つ)
  function analyzeOwnTeam(members, complete) {
    const count = (roleId) => members.filter((m) => m.role === roleId).length;
    const lacksAll = (...roles) => roles.every((r) => count(r) === 0);
    const warns = [];

    if (count('thrower') >= 2) warns.push('壁裏投げが2枚 — 接近されたときの自衛が薄い構成');
    if (count('assassin') >= 2) warns.push('アサシンが2枚 — 役割が重複しがち');
    if (count('dive_tank') >= 2) warns.push('突進タンクが2枚 — 前衛が渋滞しがち');

    if (complete) {
      const mode = state.draft.mode;
      if ((mode === 'gemGrab' || mode === 'hotZone') && lacksAll('sniper', 'area_control', 'mid_dps'))
        warns.push('撃ち合い役(スナイパー/範囲制圧/中射程)が不在 — 正面の陣地取りで押し込まれやすい');
      if (mode === 'heist' && lacksAll('dive_tank', 'anchor_tank')) warns.push('タンク不在 — 金庫前の壁役がいない');
      if (mode === 'bounty' && lacksAll('sniper', 'mid_dps')) warns.push('削り役不在 — キルを取る手段が乏しい');
      if (mode === 'knockOut' && lacksAll('heal_support')) warns.push('回復サポート不在 — 被弾がそのまま人数差につながる');
      if (members.length > 0 && members.every((m) => rangeBandOf(m) === 'close'))
        warns.push('全員近距離 — 射程差で一方的に削られる恐れ');
    }
    return warns;
  }

  function renderTeamBlock(title, members, maxCount, isOwn) {
    const block = document.createElement('div');
    block.className = 'comp-team';

    const complete = members.length >= maxCount;
    const memberHtml = members
      .map((m) => {
        const s = statsOf(m);
        const statLine = s ? `HP${s.hp} / 火力${s.damagePerShot} / ${s.rangeTiles}マス` : '';
        return `
        <div class="comp-member" title="${statLine}">
          <img src="${m.imageUrl}" alt="${m.displayName}" loading="lazy" />
          <div class="comp-member-name">${m.displayName}</div>
          <div class="comp-member-role">${roleNameOf(m.role)}</div>
          ${s ? `<div class="comp-member-stat">${s.rangeTiles}マス</div>` : ''}
        </div>`;
      })
      .join('');

    const rangeCounts = { close: 0, mid: 0, long: 0 };
    for (const m of members) rangeCounts[rangeBandOf(m)]++;
    const rangeHtml = ['close', 'mid', 'long']
      .map((k) => `<div class="comp-range-cell ${rangeCounts[k] === 0 ? 'empty' : ''}">${RANGE_LABELS[k]} ×${rangeCounts[k]}</div>`)
      .join('');

    // チーム平均の体力/火力/射程を全キャラ中央値と比べて相対表示する
    let statSummaryHtml = '';
    const summary = BSScore.summarizeTeamStats(members, (state.brawlerStats || {}).stats);
    const med = (state.brawlerStats || {}).medians;
    if (med && summary.hp != null) {
      const cell = (label, value, medianValue, unit) => {
        const ratio = value / medianValue;
        const cls = ratio >= 1.1 ? 'high' : ratio <= 0.9 ? 'low' : '';
        return `<div class="comp-stat-cell ${cls}"><span class="cs-label">平均${label}</span><span class="cs-value">${Math.round(value)}${unit}</span></div>`;
      };
      statSummaryHtml = `<div class="comp-stat-row">
        ${cell('体力', summary.hp, med.hp, '')}
        ${cell('火力', summary.damagePerShot, med.damagePerShot, '')}
        ${cell('射程', summary.rangeTiles, med.rangeTiles, 'マス')}
      </div>`;
    }

    let warnsHtml = '';
    if (isOwn) {
      const warns = analyzeOwnTeam(members, complete);
      if (warns.length > 0) {
        warnsHtml = `<ul class="comp-warns">${warns.map((w) => `<li>⚠ ${w}</li>`).join('')}</ul>`;
      } else if (complete) {
        warnsHtml = '<div class="comp-ok">✓ 大きな偏りはありません</div>';
      }
    }

    block.innerHTML = `
      <div class="comp-team-header">${title} <span class="comp-team-count">(${members.length}/${maxCount})</span></div>
      <div class="comp-members">${memberHtml || '<div class="comp-none">未入力</div>'}</div>
      ${members.length > 0 ? `<div class="comp-range-bar">${rangeHtml}</div>` : ''}
      ${statSummaryHtml}
      ${warnsHtml}
    `;
    return block;
  }

  function renderCompAnalysis() {
    const el = document.getElementById('compAnalysis');
    if (!el) return;
    const ownIds = [...(state.draft.selfPick != null ? [state.draft.selfPick] : []), ...state.draft.allies];
    const own = ownIds.map((id) => state.brawlersById[id]).filter(Boolean);
    const enemies = state.draft.enemies.map((id) => state.brawlersById[id]).filter(Boolean);

    el.innerHTML = '';
    if (own.length === 0 && enemies.length === 0) {
      el.innerHTML = '<div class="comp-empty">ピックを入力すると、チームの役割・射程バランスの診断が表示されます(自分のピックは「自分」枠に入力)</div>';
      return;
    }
    el.appendChild(renderTeamBlock('味方チーム', own, 3, true));
    el.appendChild(renderTeamBlock('相手チーム', enemies, 3, false));
  }

  function renderDraftSideUI(progress) {
    const sidePicker = document.getElementById('draftSidePicker');
    const turnBar = document.getElementById('draftTurnBar');
    const turnStatus = document.getElementById('draftTurnStatus');
    const resetBtn = document.getElementById('draftResetSideBtn');

    if (!state.draft.side) {
      sidePicker.hidden = false;
      turnBar.hidden = true;
      turnStatus.hidden = true;
      resetBtn.hidden = true;
      return;
    }

    sidePicker.hidden = true;
    turnBar.hidden = false;
    turnStatus.hidden = false;
    resetBtn.hidden = false;

    const TEAM_LABELS = { own_self: '自分', own_ally: '味方', enemy: '相手' };
    const seq = progress.seq;
    turnBar.innerHTML = seq
      .map((seg, i) => {
        let cls = 'draft-turn-segment';
        const isDone = progress.completed || i < progress.segmentIndex;
        if (isDone) cls += ' done';
        else if (i === progress.segmentIndex) cls += ' active';
        const undoable = isDone && seg.team === 'own_self';
        return `<div class="${cls}" data-seg="${i}" data-undoable="${undoable}">${TEAM_LABELS[seg.team]}${seg.count}人</div>`;
      })
      .join('');
    turnBar.querySelectorAll('[data-undoable="true"]').forEach((el) => {
      el.style.cursor = 'pointer';
      el.title = 'クリックで自分のピックを取り消す';
      el.onclick = () => {
        state.draft.selfDone = false;
        state.draft.selfPick = null;
        saveDraft();
        renderDraftSlots();
        renderRanking();
      };
    });

    const nextBtn = document.getElementById('draftSelfNextBtn');

    if (progress.completed) {
      turnStatus.textContent = '全ピック完了。ランキングは最終構成に基づく参考値です。';
      nextBtn.hidden = true;
    } else if (progress.team === 'own_self') {
      turnStatus.textContent = 'あなたの番です — 下のランキングを参考に、決めたキャラを「自分」枠に入力してください(構成分析に反映されます)';
      nextBtn.hidden = false;
    } else {
      nextBtn.hidden = true;
      const remaining = progress.totalInSegment - progress.doneInSegment;
      const teamLabel = progress.team === 'own_ally' ? '味方の番です' : '相手の番です';
      const teamHint =
        progress.team === 'own_ally'
          ? '味方が選んだキャラを「味方」欄に入力してください'
          : '相手が選んだキャラを「相手」欄に入力してください';
      turnStatus.textContent = `${teamLabel}(残り${remaining}人) — ${teamHint}`;
    }
  }

  function setupDraftSidePicker() {
    document.getElementById('sideFirstBtn').onclick = () => {
      state.draft.side = 'first';
      saveDraft();
      renderDraftSlots();
    };
    document.getElementById('sideSecondBtn').onclick = () => {
      state.draft.side = 'second';
      saveDraft();
      renderDraftSlots();
    };
    document.getElementById('sideFreeBtn').onclick = () => {
      state.draft.side = null;
      saveDraft();
      renderDraftSlots();
    };
    document.getElementById('draftResetSideBtn').onclick = () => {
      state.draft.side = null;
      saveDraft();
      renderDraftSlots();
    };
    // 次の試合に移る用。ピック・BAN・先行後攻を一括で白紙に戻す
    // (マップ/モードの選択は同じロテーション内で使い回すので残す)
    document.getElementById('draftResetAllBtn').onclick = () => {
      const hasInput =
        state.draft.enemies.length > 0 ||
        state.draft.allies.length > 0 ||
        state.draft.bans.length > 0 ||
        state.draft.selfPick != null ||
        state.draft.side != null;
      if (!hasInput) return;
      if (!confirm('相手・味方・自分のピックとBAN、先行/後攻の選択を全てリセットします。よろしいですか?')) return;
      state.draft.enemies = [];
      state.draft.allies = [];
      state.draft.bans = [];
      state.draft.selfPick = null;
      state.draft.selfDone = false;
      state.draft.side = null;
      state.expandedRankId = null;
      saveDraft();
      renderDraftSlots();
      renderRanking();
    };
    document.getElementById('draftSelfNextBtn').onclick = () => {
      state.draft.selfDone = true;
      saveDraft();
      renderDraftSlots();
    };
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
      const excludeIds = new Set([
        ...state.draft.enemies,
        ...state.draft.allies,
        ...(state.draft.selfPick != null ? [state.draft.selfPick] : []),
      ]);
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
        if (draftExcludeSet().has(brawlerId)) return; // 既にドラフト済み・BAN済みなら無視
        state.draft.bans = [...state.draft.bans, brawlerId];
        bumpBanFrequency(brawlerId);
        saveDraft();
        renderDraftSlots();
        renderRanking();
      });
    };
  }

  // --- ランキング ---
  function setupSortSelect() {
    const el = document.getElementById('sortSelect');
    if (!el) return;
    el.innerHTML = SORT_OPTIONS.map((o) => `<option value="${o.key}">${o.label}</option>`).join('');
    el.value = state.sortKey;
    el.onchange = () => {
      state.sortKey = el.value;
      renderRanking();
    };
  }

  function sortValueOf(r, key) {
    if (key === 'total') return r.total;
    if (key === 'mapWinRate' || key === 'metaWinRate') {
      const v = r.stats[key];
      return v == null ? -Infinity : v;
    }
    return r.breakdown[key];
  }

  function renderRanking() {
    const excludeSet = draftExcludeSet();
    const candidates = state.brawlers.filter((b) => !excludeSet.has(b.id));

    // 自分のピックを記録済みなら、以降のランキング(味方への提案)では味方として扱う
    const allyIds = state.draft.selfPick != null ? [state.draft.selfPick, ...state.draft.allies] : state.draft.allies;

    const ctx = {
      mode: state.draft.mode,
      mapId: state.draft.mapId,
      enemies: state.draft.enemies.map((id) => state.brawlersById[id]).filter(Boolean),
      allies: allyIds.map((id) => state.brawlersById[id]).filter(Boolean),
      mapScores: state.mapScores,
      mapOverrides: state.mapOverrides,
      meta: state.meta,
      roleMatchups: state.roleMatchups,
      roleSynergy: state.roleSynergy,
      pairOverrides: state.pairOverrides,
      pairMatchups: state.pairMatchups,
      brawlerStats: state.brawlerStats,
      myMatchups: state.myMatchups,
      compRules: state.compRules,
      config: state.config,
      personalBias: state.personalBias,
    };

    const results = BSScore.computeScores(candidates, ctx);
    if (state.sortKey !== 'total') {
      results.sort((a, b) => sortValueOf(b, state.sortKey) - sortValueOf(a, state.sortKey));
    }
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

      const mapWinRateStr = r.stats.mapWinRate != null
        ? `${r.stats.mapWinRate.toFixed(1)}%(全体${r.stats.mapGlobalWinRate.toFixed(1)}%, ${r.stats.mapBattles.toLocaleString()}戦)`
        : 'データなし';
      const metaWinRateStr = r.stats.metaWinRate != null
        ? `${r.stats.metaWinRate.toFixed(1)}%(${r.stats.metaBattles.toLocaleString()}戦)`
        : 'データなし';

      const existingBias = state.personalBias[r.brawler.id];

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
              <div class="breakdown-item"><div class="bd-label">対面構成</div><div class="bd-value">${fmtSigned(r.breakdown.enemyCompValue)}</div></div>
              <div class="breakdown-item"><div class="bd-label">自分</div><div class="bd-value">${fmtSigned(r.breakdown.biasValue)}</div></div>
            </div>
            <div class="stat-note">実勝率(このマップ): ${mapWinRateStr}</div>
            <div class="stat-note">実勝率(全体・ガチバトル上級帯): ${metaWinRateStr}</div>
            <ul class="all-reasons">${allReasonsHtml}</ul>
            <div class="bias-row">
              <input type="number" step="0.5" min="-3" max="3" class="bias-value-input" placeholder="±点" value="${existingBias ? existingBias.value : ''}" />
              <input type="text" class="bias-note-input" placeholder="理由(任意, 例: 外部Tier表でSランク)" value="${existingBias ? escapeAttr(existingBias.note) : ''}" />
              <button class="bias-save-btn">自分の評価を保存</button>
            </div>
          </div>
        </div>
        <div class="rank-score">${r.total.toFixed(1)}</div>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.bias-row')) return;
        state.expandedRankId = state.expandedRankId === r.brawler.id ? null : r.brawler.id;
        renderRanking();
      });
      const biasBtn = row.querySelector('.bias-save-btn');
      biasBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const valInput = row.querySelector('.bias-value-input');
        const noteInput = row.querySelector('.bias-note-input');
        const val = valInput.value.trim() === '' ? 0 : parseFloat(valInput.value);
        savePersonalBias(r.brawler.id, val, noteInput.value.trim());
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

  function escapeAttr(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtSigned(v) {
    const r = Math.round(v * 10) / 10;
    return `${r > 0 ? '+' : ''}${r}`;
  }

  init();
})();
