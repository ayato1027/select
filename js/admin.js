(function () {
  const state = {
    brawlers: [],
    roles: null,
    config: null,
    maps: [],
    mapScoresFile: null,
    mapOverridesFile: null,
    metaFile: null,
    meta: null, // merged
    mapOverrides: [], // merged
    rankedMapsFile: null,
    rankedMapsByMode: {}, // merged
    rankedWorkingSet: new Set(), // 選定セクションの編集中の一時選択(保存前)
    mapNames: {}, // merged 英語名->日本語名
    brawlerNames: {}, // merged nameEn->日本語名
  };

  async function init() {
    const [config, roles, mapScoresFile, mapOverridesFile, metaFile, rankedMapsFile, mapNamesFile, brawlerNamesFile] = await Promise.all([
      BSApi.loadLocalJSON('data/config.json'),
      BSApi.loadLocalJSON('data/roles.json'),
      BSApi.loadLocalJSON('data/map_scores.json'),
      BSApi.loadLocalJSON('data/map_overrides.json'),
      BSApi.loadLocalJSON('data/meta.json'),
      BSApi.loadLocalJSON('data/ranked_maps.json'),
      BSApi.loadLocalJSON('data/map_names_ja.json'),
      BSApi.loadLocalJSON('data/brawler_names_ja.json'),
    ]);

    const { brawlers } = await BSApi.loadBrawlers();
    const { maps } = await BSApi.loadMaps();

    state.config = config;
    state.roles = roles;
    state.brawlerNames = BSApi.mergeBrawlerNames(brawlerNamesFile.names, BSApi.readOverrides(BSApi.LS_KEYS.brawlerNamesJa));
    state.brawlers = brawlers
      .map((b) => ({ ...b, displayName: state.brawlerNames[b.nameEn] || b.name }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
    state.mapScoresFile = mapScoresFile;
    state.mapOverridesFile = mapOverridesFile;
    state.metaFile = metaFile;
    state.meta = BSApi.mergeMetaOverrides(metaFile, BSApi.readOverrides(BSApi.LS_KEYS.metaOverrides));
    state.mapOverrides = BSApi.mergeMapOverrides(mapOverridesFile.overrides, BSApi.readOverrides(BSApi.LS_KEYS.mapOverrides));
    state.rankedMapsFile = rankedMapsFile;
    state.rankedMapsByMode = BSApi.mergeRankedMaps(rankedMapsFile.modes, BSApi.readOverrides(BSApi.LS_KEYS.rankedMaps));
    state.mapNames = BSApi.mergeMapNames(mapNamesFile.names, BSApi.readOverrides(BSApi.LS_KEYS.mapNamesJa));
    state.maps = maps.map((m) => ({ ...m, displayName: state.mapNames[m.name] || m.name }));

    document.getElementById('loading').hidden = true;
    document.getElementById('admin').hidden = false;

    renderStatus();
    renderRankedModeSelect();
    renderRoleWarnings();
    renderMapNameTable();
    renderBrawlerNameTable();
    renderMetaTable();
    renderMapSelect();
    renderMapOverrideTable();
    setupExports();
    setupSearches();
    setupRankedMapActions();
    setupBackup();
  }

  function backupStatusEl() {
    return document.getElementById('backupStatus');
  }

  function setupBackup() {
    document.getElementById('backupDownloadBtn').onclick = () => {
      const payload = BSApi.downloadBackup();
      const count = Object.keys(payload.data).length;
      backupStatusEl().textContent = `${count}件の設定をダウンロードしました`;
    };

    document.getElementById('backupRestoreInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = ''; // 同じファイルを連続で選び直せるようにする
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        const count = Object.keys(payload.data || {}).length;
        if (
          !confirm(
            `このファイルには${count}件の設定が含まれています。復元すると、この端末の現在の設定は上書きされます。よろしいですか?`
          )
        )
          return;
        BSApi.restoreBackup(payload);
        alert('復元しました。ページを再読み込みします。');
        location.reload();
      } catch (err) {
        backupStatusEl().textContent = `復元に失敗しました: ${err.message}`;
      }
    });
  }

  function renderStatus() {
    const el = document.getElementById('statusList');
    const curatedModeCount = state.config.modes.filter((m) => (state.rankedMapsByMode[m.id] || []).length > 0).length;
    el.innerHTML = `
      <li>brawlers: BrawlAPIから取得 (${state.brawlers.length}体)</li>
      <li>maps: BrawlAPIから取得 (${state.maps.length}マップ)</li>
      <li>map_scores.json: ${state.mapScoresFile.updatedAt || '未取得(Brawl Time Ninja連携はフェーズ3で実装予定)'}</li>
      <li>meta.json: ${state.metaFile.updatedAt || '未取得(Brawl Time Ninja連携はフェーズ3で実装予定)'}</li>
      <li>ガチバトル現在ロテーション選定: ${curatedModeCount}/${state.config.modes.length}モード選定済み</li>
    `;
  }

  function renderRankedModeSelect() {
    const el = document.getElementById('rankedModeSelect');
    el.innerHTML = '';
    for (const mode of state.config.modes) {
      const opt = document.createElement('option');
      opt.value = mode.id;
      const count = (state.rankedMapsByMode[mode.id] || []).length;
      opt.textContent = `${mode.name}${count > 0 ? ` (選定済み ${count})` : ' (未選定)'}`;
      el.appendChild(opt);
    }
    el.onchange = () => renderRankedMapGrid();
    renderRankedMapGrid();
  }

  function renderRankedMapGrid() {
    const modeId = document.getElementById('rankedModeSelect').value;
    const current = state.rankedMapsByMode[modeId] || [];
    state.rankedWorkingSet = new Set(current);

    const el = document.getElementById('rankedMapGrid');
    el.innerHTML = '';
    const modeMaps = state.maps.filter((m) => m.modeId === modeId);
    for (const map of modeMaps) {
      const cell = document.createElement('div');
      cell.className = 'ranked-map-cell' + (state.rankedWorkingSet.has(map.id) ? ' selected' : '');
      cell.innerHTML = `<img src="${map.imageUrl}" loading="lazy" alt="${map.displayName}" /><div class="rm-name">${map.displayName}</div>`;
      cell.onclick = () => {
        if (state.rankedWorkingSet.has(map.id)) state.rankedWorkingSet.delete(map.id);
        else state.rankedWorkingSet.add(map.id);
        cell.classList.toggle('selected');
      };
      el.appendChild(cell);
    }
  }

  function setupRankedMapActions() {
    document.getElementById('rankedMapSave').onclick = () => {
      const modeId = document.getElementById('rankedModeSelect').value;
      const overrides = BSApi.readOverrides(BSApi.LS_KEYS.rankedMaps);
      overrides[modeId] = [...state.rankedWorkingSet];
      BSApi.writeOverrides(BSApi.LS_KEYS.rankedMaps, overrides);
      state.rankedMapsByMode[modeId] = overrides[modeId];
      renderStatus();
      renderRankedModeSelect();
      alert(`保存しました(${overrides[modeId].length}マップ選定)`);
    };

    document.getElementById('rankedMapReset').onclick = () => {
      const modeId = document.getElementById('rankedModeSelect').value;
      const overrides = BSApi.readOverrides(BSApi.LS_KEYS.rankedMaps);
      delete overrides[modeId];
      BSApi.writeOverrides(BSApi.LS_KEYS.rankedMaps, overrides);
      state.rankedMapsByMode[modeId] = state.rankedMapsFile.modes[modeId] || [];
      renderStatus();
      renderRankedModeSelect();
      alert('未選定に戻しました(メイン画面は全マップ表示になります)');
    };
  }

  function roleSelectHtml(currentRole) {
    return state.roles.roles
      .map((r) => `<option value="${r.id}" ${r.id === currentRole ? 'selected' : ''}>${r.name}</option>`)
      .join('');
  }

  function renderRoleWarnings() {
    const el = document.getElementById('roleWarningList');
    const targets = state.brawlers.filter((b) => b.roleSource !== 'roleMap');
    if (targets.length === 0) {
      el.innerHTML = '<div class="hint">未割り当てキャラはありません。</div>';
      return;
    }
    el.innerHTML = '';
    for (const b of targets) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const badge = b.roleSource === 'manual' ? '' : `<span class="badge">${b.roleSource === 'unknown' ? '未割当' : '暫定推定'}</span>`;
      row.innerHTML = `
        <img src="${b.imageUrl}" alt="${b.displayName}" />
        <span class="ar-name">${b.displayName}</span>
        ${badge}
        <select data-norm="${b.normName}">${roleSelectHtml(b.role)}</select>
        <button class="save-btn">保存</button>
      `;
      row.querySelector('.save-btn').onclick = () => {
        const select = row.querySelector('select');
        const overrides = BSApi.readOverrides(BSApi.LS_KEYS.roleOverrides);
        overrides[b.normName] = select.value;
        BSApi.writeOverrides(BSApi.LS_KEYS.roleOverrides, overrides);
        b.role = select.value;
        b.roleSource = 'manual';
        renderRoleWarnings();
      };
      el.appendChild(row);
    }
  }

  function renderMapNameTable(filter) {
    const el = document.getElementById('mapNameTable');
    if (!el) return;
    el.innerHTML = '';
    const list = state.maps.filter((m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase()) || (state.mapNames[m.name] || '').includes(filter));

    for (const m of list) {
      const current = state.mapNames[m.name] || '';
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `
        <img src="${m.imageUrl}" alt="${m.name}" />
        <span class="ar-name">${m.name}</span>
        <input type="text" class="note-input" placeholder="日本語名(未入力なら英語名を表示)" value="${escapeHtml(current)}" />
        <button class="save-btn">保存</button>
      `;
      const input = row.querySelector('.note-input');
      row.querySelector('.save-btn').onclick = () => {
        const overrides = BSApi.readOverrides(BSApi.LS_KEYS.mapNamesJa);
        const val = input.value.trim();
        if (val === '') {
          delete overrides[m.name];
        } else {
          overrides[m.name] = val;
        }
        BSApi.writeOverrides(BSApi.LS_KEYS.mapNamesJa, overrides);
        state.mapNames[m.name] = val || undefined;
        m.displayName = val || m.name;
        alert(`${m.name} の日本語名を保存しました`);
      };
      el.appendChild(row);
    }
  }

  function renderBrawlerNameTable(filter) {
    const el = document.getElementById('brawlerNameTable');
    if (!el) return;
    el.innerHTML = '';
    const list = state.brawlers.filter(
      (b) => !filter || b.nameEn.toLowerCase().includes(filter.toLowerCase()) || (state.brawlerNames[b.nameEn] || '').includes(filter)
    );

    for (const b of list) {
      const current = state.brawlerNames[b.nameEn] || '';
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `
        <img src="${b.imageUrl}" alt="${b.nameEn}" />
        <span class="ar-name">${b.nameEn}</span>
        <input type="text" class="note-input" placeholder="日本語名(未入力なら英語名を表示)" value="${escapeHtml(current)}" />
        <button class="save-btn">保存</button>
      `;
      const input = row.querySelector('.note-input');
      row.querySelector('.save-btn').onclick = () => {
        const overrides = BSApi.readOverrides(BSApi.LS_KEYS.brawlerNamesJa);
        const val = input.value.trim();
        if (val === '') {
          delete overrides[b.nameEn];
        } else {
          overrides[b.nameEn] = val;
        }
        BSApi.writeOverrides(BSApi.LS_KEYS.brawlerNamesJa, overrides);
        state.brawlerNames[b.nameEn] = val || undefined;
        b.displayName = val || b.name;
        alert(`${b.nameEn} の日本語名を保存しました`);
      };
      el.appendChild(row);
    }
  }

  function renderMetaTable(filter) {
    const el = document.getElementById('metaTable');
    el.innerHTML = '';
    const warnDiff = state.config.scoring.overrideWarnDiff;
    const list = state.brawlers.filter((b) => !filter || b.displayName.includes(filter) || b.name.includes(filter) || b.nameEn.toLowerCase().includes(filter.toLowerCase()));

    for (const b of list) {
      const entry = state.meta.coefficients[b.id];
      const autoValue = entry ? entry.value : 0;
      const manualValue = entry && entry.manualValue != null ? entry.manualValue : '';
      const note = entry ? entry.note || '' : '';

      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `
        <img src="${b.imageUrl}" alt="${b.displayName}" />
        <span class="ar-name">${b.displayName}</span>
        <span style="font-size:11px;color:var(--text-dim);">自動:${autoValue.toFixed(1)}</span>
        <input type="number" step="0.1" min="-3" max="3" class="manual-input" placeholder="手動値" value="${manualValue}" />
        <input type="text" class="note-input" placeholder="上書き理由(必須)" value="${escapeHtml(note)}" />
        <button class="save-btn">保存</button>
      `;
      const diffWarn = document.createElement('div');
      diffWarn.className = 'diff-warn';
      diffWarn.hidden = true;
      row.appendChild(diffWarn);

      const manualInput = row.querySelector('.manual-input');
      const noteInput = row.querySelector('.note-input');

      row.querySelector('.save-btn').onclick = () => {
        const overrides = BSApi.readOverrides(BSApi.LS_KEYS.metaOverrides);
        const val = manualInput.value.trim();
        if (val === '') {
          delete overrides[b.id];
          BSApi.writeOverrides(BSApi.LS_KEYS.metaOverrides, overrides);
          diffWarn.hidden = true;
          alert(`${b.displayName} のメタ係数上書きを解除しました`);
          return;
        }
        const num = parseFloat(val);
        if (Number.isNaN(num)) { alert('数値を入力してください'); return; }
        if (!noteInput.value.trim()) { alert('上書き理由(note)は必須です'); return; }
        overrides[b.id] = { manualValue: num, note: noteInput.value.trim() };
        BSApi.writeOverrides(BSApi.LS_KEYS.metaOverrides, overrides);
        if (Math.abs(num - autoValue) >= warnDiff) {
          diffWarn.hidden = false;
          diffWarn.textContent = `⚠ 自動値(${autoValue.toFixed(1)})との差が${warnDiff}以上あります。見直しを推奨します。`;
        } else {
          diffWarn.hidden = true;
        }
        alert(`${b.displayName} のメタ係数を上書きしました`);
      };

      el.appendChild(row);
    }
  }

  function renderMapSelect() {
    const el = document.getElementById('mapSelect');
    el.innerHTML = '';
    const byMode = {};
    for (const m of state.maps) {
      if (!byMode[m.modeId]) byMode[m.modeId] = [];
      byMode[m.modeId].push(m);
    }
    for (const mode of state.config.modes) {
      const group = document.createElement('optgroup');
      group.label = mode.name;
      for (const m of byMode[mode.id] || []) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.displayName;
        group.appendChild(opt);
      }
      el.appendChild(group);
    }
    el.onchange = () => renderMapOverrideTable();
  }

  function renderMapOverrideTable(filter) {
    const el = document.getElementById('mapOverrideTable');
    el.innerHTML = '';
    const mapId = document.getElementById('mapSelect').value;
    if (!mapId) return;
    const warnDiff = state.config.scoring.overrideWarnDiff;
    const mapEntry = state.mapScoresFile.maps[mapId];

    const list = state.brawlers.filter((b) => !filter || b.displayName.includes(filter) || b.name.includes(filter) || b.nameEn.toLowerCase().includes(filter.toLowerCase()));

    for (const b of list) {
      const scoreEntry = mapEntry && mapEntry.scores ? mapEntry.scores[b.id] : null;
      const autoValue = scoreEntry ? scoreEntry.value : 5;
      const existing = state.mapOverrides.find((o) => String(o.mapId) === String(mapId) && String(o.brawlerId) === String(b.id));

      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `
        <img src="${b.imageUrl}" alt="${b.displayName}" />
        <span class="ar-name">${b.displayName}</span>
        <span style="font-size:11px;color:var(--text-dim);">自動:${autoValue.toFixed(1)}</span>
        <input type="number" step="0.1" min="0" max="10" class="manual-input" placeholder="手動値" value="${existing ? existing.value : ''}" />
        <input type="text" class="note-input" placeholder="上書き理由(必須)" value="${existing ? escapeHtml(existing.note) : ''}" />
        <button class="save-btn">保存</button>
      `;
      const diffWarn = document.createElement('div');
      diffWarn.className = 'diff-warn';
      diffWarn.hidden = true;
      row.appendChild(diffWarn);

      const manualInput = row.querySelector('.manual-input');
      const noteInput = row.querySelector('.note-input');

      row.querySelector('.save-btn').onclick = () => {
        const overrides = BSApi.readOverrides(BSApi.LS_KEYS.mapOverrides);
        const key = `${mapId}_${b.id}`;
        const val = manualInput.value.trim();
        if (val === '') {
          delete overrides[key];
          BSApi.writeOverrides(BSApi.LS_KEYS.mapOverrides, overrides);
          diffWarn.hidden = true;
          alert(`${b.displayName} のマップ適性上書きを解除しました`);
          return;
        }
        const num = parseFloat(val);
        if (Number.isNaN(num)) { alert('数値を入力してください'); return; }
        if (!noteInput.value.trim()) { alert('上書き理由(note)は必須です'); return; }
        overrides[key] = { value: num, note: noteInput.value.trim() };
        BSApi.writeOverrides(BSApi.LS_KEYS.mapOverrides, overrides);
        if (Math.abs(num - autoValue) >= warnDiff) {
          diffWarn.hidden = false;
          diffWarn.textContent = `⚠ 自動値(${autoValue.toFixed(1)})との差が${warnDiff}以上あります。見直しを推奨します。`;
        } else {
          diffWarn.hidden = true;
        }
        alert(`${b.displayName} のマップ適性を上書きしました`);
      };

      el.appendChild(row);
    }
  }

  function setupSearches() {
    document.getElementById('metaSearch').addEventListener('input', (e) => renderMetaTable(e.target.value));
    document.getElementById('mapOverrideSearch').addEventListener('input', (e) => renderMapOverrideTable(e.target.value));
    const mapNameSearch = document.getElementById('mapNameSearch');
    if (mapNameSearch) mapNameSearch.addEventListener('input', (e) => renderMapNameTable(e.target.value));
    const brawlerNameSearch = document.getElementById('brawlerNameSearch');
    if (brawlerNameSearch) brawlerNameSearch.addEventListener('input', (e) => renderBrawlerNameTable(e.target.value));
  }

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function setupExports() {
    document.getElementById('exportRoles').onclick = () => {
      const overrides = BSApi.readOverrides(BSApi.LS_KEYS.roleOverrides);
      downloadJSON('role_overrides_export.json', overrides);
    };
    document.getElementById('exportMapOverrides').onclick = () => {
      downloadJSON('map_overrides.json', { overrides: state.mapOverrides });
    };
    document.getElementById('exportMeta').onclick = () => {
      downloadJSON('meta.json', state.meta);
    };
    document.getElementById('exportRankedMaps').onclick = () => {
      downloadJSON('ranked_maps.json', { updatedAt: new Date().toISOString(), modes: state.rankedMapsByMode });
    };
    document.getElementById('exportMapNames').onclick = () => {
      downloadJSON('map_names_ja.json', { names: state.mapNames });
    };
    document.getElementById('exportBrawlerNames').onclick = () => {
      downloadJSON('brawler_names_ja.json', { names: state.brawlerNames });
    };
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  init();
})();
