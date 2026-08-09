#!/usr/bin/env node
// update-data: BrawlAPIからマスタデータを取得し data/brawlers.json, data/maps.json を更新する。
// 仕様書 4.3 参照。勝率データ(Brawl Time Ninja)取得は要検証のため未実装(TODO参照)。
//
// 実行方法: node scripts/update-data.js

const fs = require('fs');
const path = require('path');

const BRAWLAPI_BASE = 'https://api.brawlapi.com';
const DATA_DIR = path.join(__dirname, '..', 'data');

const RANKED_MODE_NAME_TO_ID = {
  'Gem Grab': 'gemGrab',
  'Brawl Ball': 'brawlBall',
  'Hot Zone': 'hotZone',
  'Bounty': 'bounty',
  'Heist': 'heist',
  'Knockout': 'knockOut',
};

function normalizeName(nameEn) {
  return (nameEn || '').replace(/[^a-zA-Z0-9]/g, '');
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function resolveRole(brawler, roleMap) {
  const norm = normalizeName(brawler.name);
  if (roleMap.roles[norm]) {
    return { role: roleMap.roles[norm], source: 'roleMap' };
  }
  const officialClass = brawler.class && brawler.class.name ? brawler.class.name : '';
  const fallback = roleMap.fallbackByOfficialClass[officialClass];
  if (fallback) {
    return { role: fallback, source: 'fallback' };
  }
  return { role: 'mid_dps', source: 'unknown' };
}

async function updateBrawlers() {
  const roleMap = readJSON(path.join(DATA_DIR, 'role_map.json'));
  const res = await fetch(`${BRAWLAPI_BASE}/v1/brawlers`);
  if (!res.ok) throw new Error(`brawlers fetch failed: ${res.status}`);
  const json = await res.json();
  const list = json.list || json;

  let unassignedCount = 0;
  const brawlers = list.map((b) => {
    const officialClass = b.class && b.class.name ? b.class.name : '';
    const resolved = resolveRole(b, roleMap);
    if (resolved.source !== 'roleMap') unassignedCount++;
    return {
      id: b.id,
      name: b.name,
      nameEn: b.name,
      normName: normalizeName(b.name),
      officialClass,
      role: resolved.role,
      roleSource: resolved.source,
      imageUrl: b.imageUrl2 || b.imageUrl || '',
    };
  });

  writeJSON(path.join(DATA_DIR, 'brawlers.json'), {
    updatedAt: new Date().toISOString(),
    brawlers,
  });

  if (unassignedCount > 0) {
    console.warn(
      `[update-data] 警告: ${unassignedCount}体のキャラがrole_map.jsonに未登録です(暫定推定または既定値で動作)。data/role_map.jsonのrolesに追記するか、管理画面(admin.html)で手動割り当ててください。`
    );
    brawlers
      .filter((b) => b.roleSource !== 'roleMap')
      .forEach((b) => console.warn(`  - ${b.name} (${b.normName}) -> ${b.role} [${b.roleSource}]`));
  }

  console.log(`[update-data] brawlers.json 更新完了 (${brawlers.length}体)`);
  return brawlers;
}

async function updateMaps() {
  const res = await fetch(`${BRAWLAPI_BASE}/v1/maps`);
  if (!res.ok) throw new Error(`maps fetch failed: ${res.status}`);
  const json = await res.json();
  const list = json.list || json;

  const maps = list
    .filter((m) => m.gameMode && RANKED_MODE_NAME_TO_ID[m.gameMode.name] && !m.disabled)
    .map((m) => ({
      id: String(m.id),
      name: m.name,
      modeId: RANKED_MODE_NAME_TO_ID[m.gameMode.name],
      imageUrl: m.imageUrl,
    }));

  writeJSON(path.join(DATA_DIR, 'maps.json'), {
    updatedAt: new Date().toISOString(),
    maps,
  });

  console.log(`[update-data] maps.json 更新完了 (${maps.length}マップ / ガチバトル対象6モード)`);
  return maps;
}

// TODO(仕様11.2): Brawl Time Ninja からの勝率取得。
// エンドポイント仕様・利用規約が未検証のため、フェーズ3着手時に実装する。
// 実装時はここで (a) キャラ全体勝率+試合数 (b) マップ別キャラ勝率+試合数 を取得し、
// 仕様2.2/2.5の変換式で data/map_scores.json / data/meta.json の自動生成値(value)のみを
// 書き換える。手動上書きフィールド(map_overrides.json全体、meta.jsonのmanualValue/note)は
// 絶対に上書きしないこと。
async function updateWinRates() {
  console.log('[update-data] 勝率データ取得(Brawl Time Ninja連携)は未実装です。仕様11.2を参照してください。スキップします。');
}

async function main() {
  console.log('[update-data] 開始');
  await updateBrawlers();
  await updateMaps();
  await updateWinRates();
  console.log('[update-data] 完了');
}

main().catch((e) => {
  console.error('[update-data] 失敗:', e);
  process.exit(1);
});
