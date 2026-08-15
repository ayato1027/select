// 同梱データ(data/brawlers.json, data/maps.json)を既定ソースとし、
// 外部BrawlAPIへのfetchは起動時の更新チェックのみに留める(仕様8章 非機能要件)。
// 同梱データは scripts/update-data.js で生成する。
const BRAWLAPI_BASE = 'https://api.brawlapi.com';

const LS_KEYS = {
  roleOverrides: 'bs_role_overrides_v1', // 管理画面での手動ロール割り当て { [normName]: roleId }
  mapOverrides: 'bs_map_overrides_v1',   // 管理画面での手動マップ適性上書き
  metaOverrides: 'bs_meta_overrides_v1', // 管理画面での手動メタ係数上書き
  rankedMaps: 'bs_ranked_maps_v1',       // 管理画面でのガチバトル現在ロテーション選定 { [modeId]: mapId[] }
  mapNamesJa: 'bs_map_names_ja_v1',      // 管理画面でのマップ日本語名の追加・修正 { [英語名]: 日本語名 }
  brawlerNamesJa: 'bs_brawler_names_ja_v1', // 管理画面でのキャラ日本語名の追加・修正 { [nameEn]: 日本語名 }
  // 自分で作る相性表。{ vsEnemy: { "<selfId>": { "<otherId>": value } }, withAlly: {...} }
  // 統計データより優先され、スコア計算・相性表ページの両方で使われる
  myMatchups: 'bs_my_matchups_v1',
};

// --- バックアップ/復元 ---
// このアプリの全設定(Tier表・自分の相性表・各種手動上書き)はサーバーを持たない
// 静的アプリの性質上ブラウザのlocalStorageにしか存在しない。ブラウザデータの消去や
// 機種変更で失われるため、ファイルに書き出して復元できるようにする。
// 個別にキーを列挙せず「bs_」で始まる全キーを対象にすることで、今後キーが増えても
// このコードを直す必要がない。
const BACKUP_PREFIX = 'bs_';

function collectBackupData() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(BACKUP_PREFIX)) {
      data[key] = localStorage.getItem(key);
    }
  }
  return data;
}

function downloadBackup() {
  const exportedAt = new Date().toISOString();
  const payload = { app: 'brawstar-pick-assistant', version: 1, exportedAt, data: collectBackupData() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `brawstar-backup-${exportedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return payload;
}

// 復元は現在の設定を全て上書きするため、呼び出し側で確認を取ってから呼ぶこと
function restoreBackup(payload) {
  if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') {
    throw new Error('バックアップファイルの形式が正しくありません');
  }
  let count = 0;
  for (const [key, value] of Object.entries(payload.data)) {
    // 万一改変されたファイルでも他アプリのlocalStorageを汚染しないよう、対象キーを制限する
    if (!key.startsWith(BACKUP_PREFIX)) continue;
    localStorage.setItem(key, value);
    count++;
  }
  return count;
}

function normalizeName(nameEn) {
  return (nameEn || '').replace(/[^a-zA-Z0-9]/g, '');
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${url} (${res.status})`);
  return res.json();
}

// 同梱JSONはupdate-data実行やデータ調整で頻繁に変わるため、
// ブラウザキャッシュに古い版を掴まれないようキャッシュを無効化して取得する
async function loadLocalJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`fetch failed: ${path} (${res.status})`);
  return res.json();
}

function readOverrides(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function writeOverrides(key, obj) {
  localStorage.setItem(key, JSON.stringify(obj));
}

// 同梱 data/brawlers.json を読み込み、管理画面での手動ロール上書き(localStorage)を最優先で適用する
async function loadBrawlers() {
  const file = await loadLocalJSON('data/brawlers.json');
  const manualOverrides = readOverrides(LS_KEYS.roleOverrides);

  const brawlers = file.brawlers.map((b) => {
    const manual = manualOverrides[b.normName];
    return {
      ...b,
      role: manual || b.role,
      roleSource: manual ? 'manual' : b.roleSource,
    };
  });

  return { brawlers, updatedAt: file.updatedAt };
}

// 同梱 data/maps.json を読み込む(ガチバトル対象6モードのみ、非公開マップは除外済み)
async function loadMaps() {
  const file = await loadLocalJSON('data/maps.json');
  return { maps: file.maps, updatedAt: file.updatedAt };
}

// BrawlAPIのgameMode.nameは表示名("Gem Grab"等)なのでconfigのid体系へ変換
const MODE_NAME_TO_ID = {
  'Gem Grab': 'gemGrab',
  'Brawl Ball': 'brawlBall',
  'Hot Zone': 'hotZone',
  'Bounty': 'bounty',
  'Heist': 'heist',
  'Knockout': 'knockOut',
  'Knock Out': 'knockOut',
};

// 起動時の軽い更新チェック(仕様8章)。失敗しても静かに無視する(オフライン耐性)。
// 新キャラ数が同梱データと異なる場合のみ通知し、実データの取り込みは update-data 実行に委ねる。
async function checkForBrawlerUpdate(currentCount) {
  try {
    const json = await fetchJSON(`${BRAWLAPI_BASE}/v1/brawlers`);
    const liveList = json.list || json;
    if (liveList.length !== currentCount) {
      return { hasUpdate: true, liveCount: liveList.length, bundledCount: currentCount };
    }
    return { hasUpdate: false };
  } catch (e) {
    return { hasUpdate: false, checkFailed: true };
  }
}

// data/map_overrides.json (ファイル資産) + 管理画面での手動上書き(localStorage)をマージ
// lsOverrides: { "<mapId>_<brawlerId>": { value, note } }
function mergeMapOverrides(fileOverrides, lsOverrides) {
  const lsList = Object.entries(lsOverrides).map(([key, v]) => {
    const [mapId, brawlerId] = key.split('_');
    return { mapId, brawlerId, value: v.value, note: v.note };
  });
  const lsKeySet = new Set(Object.keys(lsOverrides));
  const fileFiltered = (fileOverrides || []).filter(
    (o) => !lsKeySet.has(`${o.mapId}_${o.brawlerId}`)
  );
  return [...fileFiltered, ...lsList];
}

// data/meta.json (ファイル資産) + 管理画面での手動係数上書き(localStorage)をマージ
// lsOverrides: { "<brawlerId>": { manualValue, note } }
function mergeMetaOverrides(fileMeta, lsOverrides) {
  const coefficients = { ...(fileMeta.coefficients || {}) };
  for (const [brawlerId, v] of Object.entries(lsOverrides)) {
    const base = coefficients[brawlerId] || { value: 0, winRate: null, battles: 0, manualValue: null, note: '' };
    coefficients[brawlerId] = { ...base, manualValue: v.manualValue, note: v.note };
  }
  return { ...fileMeta, coefficients };
}

// data/ranked_maps.json (ファイル資産) + 管理画面での選定(localStorage)をマージ
// lsModes: { [modeId]: mapId[] } ※そのモードのキーが存在する場合のみファイル側を上書きする
// 戻り値: { [modeId]: mapId[] }。空配列 = そのモードは未選定(呼び出し側で全マップ表示にフォールバックする)
function mergeRankedMaps(fileModes, lsModes) {
  const result = { ...(fileModes || {}) };
  for (const [modeId, ids] of Object.entries(lsModes || {})) {
    result[modeId] = ids;
  }
  return result;
}

// data/map_names_ja.json (ファイル資産) + 管理画面での追加・修正(localStorage)をマージ。ls側が優先。
function mergeMapNames(fileNames, lsNames) {
  return { ...(fileNames || {}), ...(lsNames || {}) };
}

// data/brawler_names_ja.json (ファイル資産) + 管理画面での追加・修正(localStorage)をマージ。ls側が優先。
function mergeBrawlerNames(fileNames, lsNames) {
  return { ...(fileNames || {}), ...(lsNames || {}) };
}

window.BSApi = {
  LS_KEYS,
  normalizeName,
  loadLocalJSON,
  loadBrawlers,
  loadMaps,
  checkForBrawlerUpdate,
  readOverrides,
  writeOverrides,
  mergeMapOverrides,
  mergeMetaOverrides,
  mergeRankedMaps,
  mergeMapNames,
  mergeBrawlerNames,
  collectBackupData,
  downloadBackup,
  restoreBackup,
};
