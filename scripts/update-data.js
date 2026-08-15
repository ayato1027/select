#!/usr/bin/env node
// update-data: BrawlAPIからマスタデータを、Brawl Time Ninjaから勝率データを取得し
// data/brawlers.json, data/maps.json, data/map_scores.json, data/meta.json を更新する。
// 仕様書 4.3 参照。
//
// 実行方法: node scripts/update-data.js
//
// Brawl Time Ninja連携について(仕様11.2の検証結果):
// - 認証: POST https://brawltime.ninja/api/auth.getToken で短命JWTを取得(tRPC経由、公開エンドポイント)
// - データ: GET https://cube.brawltime.ninja/cubejs-api/v1/load?query=<JSON> (Cube.js REST API)
//   Authorizationヘッダに上記トークンを付与。cube名は "map"(map.brawler_dimension等)。
// - 「ガチバトル(ランク戦)」は map.powerplay_dimension="1" で判定できる
//   (powerplayは旧名称パワーリーグ=現ガチバトルの内部識別子。0/1件数比較で妥当性を確認済み)。
// - 直近の環境を反映するため、直近2シーズン(約4週間, map.season_dimension)に絞って集計する。
// - マナーとして低頻度実行を前提とし、マップ毎のクエリ間に待機を入れる。

const fs = require('fs');
const path = require('path');

const BRAWLAPI_BASE = 'https://api.brawlapi.com';
const BRAWLTIME_ORIGIN = 'https://brawltime.ninja';
const CUBE_BASE = 'https://cube.brawltime.ninja';
// ゲーム本体のCSV(体力・攻撃力・射程などの生パラメータ)。マップ名/キャラ名の日本語化と同じ資料元。
const GAME_ASSETS_BASE = 'https://raw.githubusercontent.com/tailsjs/brawl-stars-assets/master';
const GAME_ASSETS_VERSION = '68.250';
const DATA_DIR = path.join(__dirname, '..', 'data');

const RANKED_MODE_NAME_TO_ID = {
  'Gem Grab': 'gemGrab',
  'Brawl Ball': 'brawlBall',
  'Hot Zone': 'hotZone',
  'Bounty': 'bounty',
  'Heist': 'heist',
  'Knockout': 'knockOut',
};

// 仕様書のmodeId -> Brawl Time Ninjaのmode dimension値
const MODE_ID_TO_BTN_MODE = {
  gemGrab: 'gemGrab',
  brawlBall: 'brawlBall',
  hotZone: 'hotZone',
  bounty: 'bounty',
  heist: 'heist',
  knockOut: 'knockout', // BTN側は小文字o
};

const RECENT_SEASON_COUNT = 2; // メタ係数・マップ適性用。今の環境を反映したいので短期
// キャラ同士の相性用。仕様書2.3の通り対敵相性は「ほぼ不変(構造的相性)」なので長期で集計する。
// 短期(2シーズン)だとペアの72%が1000戦未満となり、数ポイントの相性差を統計的に判別できない
// (勝率差2ポイントの検出には約2400戦必要)。6シーズンにすると1ペアあたり概ね9倍の試合数になる。
const PAIR_SEASON_COUNT = 6;
const MAP_QUERY_DELAY_MS = 300; // マップ毎のクエリ間隔(マナー)

// map.trophyRange_dimensionの下限(これ未満の低トロフィー帯を除外する)。
// 実データ確認: ガチバトル全体を無選別で平均すると、低トロフィー帯で一方的に勝てる
// (が上級者帯では並程度の)キャラの勝率が過大評価される(例: ミスターPは1-3帯で87-92%、
// 16-18帯では54-59%まで下がる)。値域は概ね1〜22で、16以上は上位23%程度のピック数を持つ
// 帯であることを確認済み。低ければ低いほど「初心者にも刺さる強さ」を含み、
// 高すぎるとサンプル数が減りすぎる。
const MIN_TROPHY_RANGE = '16';

function normalizeName(nameEn) {
  return (nameEn || '').replace(/[^a-zA-Z0-9]/g, '');
}

function normalizeBtnName(name) {
  return (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// --- Brawl Time Ninja連携 ---

async function getAuthToken() {
  const res = await fetch(`${BRAWLTIME_ORIGIN}/api/auth.getToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: null }),
  });
  if (!res.ok) throw new Error(`認証トークン取得失敗: ${res.status}`);
  const json = await res.json();
  return json.result.data.json.token;
}

async function cubeQuery(token, query) {
  const encoded = encodeURIComponent(JSON.stringify(query));
  const res = await fetch(`${CUBE_BASE}/cubejs-api/v1/load?query=${encoded}`, {
    headers: { Authorization: token },
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`cubeクエリ失敗: ${res.status} ${json.error || ''}`);
  }
  return json.data;
}

async function getRecentSeasons(token, count = RECENT_SEASON_COUNT) {
  const data = await cubeQuery(token, {
    dimensions: ['map.season_dimension'],
    order: { 'map.season_dimension': 'desc' },
    limit: count,
  });
  // cube側はDate型のため "YYYY-MM-DD" のみ受け付ける(時刻部分があると型エラーになる)
  return data.map((r) => r['map.season_dimension'].slice(0, 10));
}

// キャラごとの全体勝率(ガチバトル対象6モード合算・直近シーズン)を取得
async function getOverallWinRates(token, seasons) {
  const data = await cubeQuery(token, {
    measures: ['map.winRate_measure', 'map.picks_measure'],
    dimensions: ['map.brawler_dimension'],
    filters: [
      { member: 'map.mode_dimension', operator: 'equals', values: Object.values(MODE_ID_TO_BTN_MODE) },
      { member: 'map.powerplay_dimension', operator: 'equals', values: ['1'] },
      { member: 'map.season_dimension', operator: 'equals', values: seasons },
      { member: 'map.trophyRange_dimension', operator: 'gte', values: [MIN_TROPHY_RANGE] },
    ],
    limit: 1000,
  });
  const result = {};
  for (const row of data) {
    const norm = normalizeBtnName(row['map.brawler_dimension']);
    result[norm] = {
      winRatePct: parseFloat(row['map.winRate_measure']) * 100,
      battles: parseInt(row['map.picks_measure'], 10),
    };
  }
  return result;
}

async function getMapWinRates(token, seasons, modeId, mapName) {
  const btnMode = MODE_ID_TO_BTN_MODE[modeId];
  return cubeQuery(token, {
    measures: ['map.winRate_measure', 'map.picks_measure'],
    dimensions: ['map.brawler_dimension'],
    filters: [
      { member: 'map.mode_dimension', operator: 'equals', values: [btnMode] },
      { member: 'map.map_dimension', operator: 'equals', values: [mapName] },
      { member: 'map.powerplay_dimension', operator: 'equals', values: ['1'] },
      { member: 'map.season_dimension', operator: 'equals', values: seasons },
      { member: 'map.trophyRange_dimension', operator: 'gte', values: [MIN_TROPHY_RANGE] },
    ],
    limit: 1000,
  });
}

// brawltime.ninjaの勝率指標(map.winRate_measure)は単純な50%中心の勝敗率ではなく、
// 全キャラ試合数加重平均で56%前後になることを実データで確認した(2026年時点)。
// 仕様2.5の式は「勝率50%を中立点」とする前提だが、データ源の実態に合わせて
// 「全キャラの試合数加重平均」を中立点として使う(相対的な強弱の順序は保たれる)。
function weightedMeanWinRate(overall) {
  let totalBattles = 0;
  let totalWeighted = 0;
  for (const stat of Object.values(overall)) {
    totalBattles += stat.battles;
    totalWeighted += stat.winRatePct * stat.battles;
  }
  return totalBattles > 0 ? totalWeighted / totalBattles : 50;
}

// 仕様2.5: メタ係数 = clamp((全体勝率% - 中立点)×傾き, -3, +3) × 信頼度重み
// 手動上書き(manualValue/note)は保持し、valueのみ書き換える(仕様3.2)
function updateMetaFile(brawlers, overall, config) {
  const byNorm = {};
  for (const b of brawlers) byNorm[normalizeBtnName(b.nameEn)] = b;

  const filePath = path.join(DATA_DIR, 'meta.json');
  const existing = fs.existsSync(filePath) ? readJSON(filePath) : { coefficients: {} };
  const coefficients = { ...(existing.coefficients || {}) };
  const { slope, clampMin, clampMax, confidenceThresholdN } = config.scoring.meta;
  const baseline = weightedMeanWinRate(overall);

  let matched = 0;
  for (const [norm, stat] of Object.entries(overall)) {
    const b = byNorm[norm];
    if (!b) continue;
    matched++;
    const raw = clamp((stat.winRatePct - baseline) * slope, clampMin, clampMax);
    const confWeight = Math.min(1, stat.battles / confidenceThresholdN);
    const prev = coefficients[b.id] || {};
    coefficients[b.id] = {
      value: Math.round(raw * confWeight * 100) / 100,
      winRate: Math.round(stat.winRatePct * 100) / 100,
      battles: stat.battles,
      manualValue: prev.manualValue != null ? prev.manualValue : null,
      note: prev.note || '',
    };
  }

  writeJSON(filePath, {
    updatedAt: new Date().toISOString(),
    patchVersion: '',
    baselineWinRate: Math.round(baseline * 100) / 100,
    coefficients,
  });
  console.log(
    `[update-data] meta.json 更新完了 (${matched}体, 中立点=${baseline.toFixed(2)}%, brawltime.ninja直近${RECENT_SEASON_COUNT}シーズン集計)`
  );
}

// 仕様2.2: 自動値 = clamp(5 + (マップ別勝率% - 全体勝率%)×傾き, 0, 10)
//          試合数がM未満なら5(中立)方向に縮める
function buildMapScoreEntry(mapWinRate, globalWinRate, battles, config) {
  const { slope, min, max, neutral, confidenceThresholdM } = config.scoring.mapScore;
  const raw = clamp(neutral + (mapWinRate - globalWinRate) * slope, min, max);
  const shrunk = neutral + (raw - neutral) * Math.min(1, battles / confidenceThresholdM);
  return {
    value: Math.round(shrunk * 100) / 100,
    mapWinRate: Math.round(mapWinRate * 100) / 100,
    globalWinRate: Math.round(globalWinRate * 100) / 100,
    battles,
  };
}

async function updateMapScoresFile(brawlers, overall, token, seasons, config) {
  const byNorm = {};
  for (const b of brawlers) byNorm[normalizeBtnName(b.nameEn)] = b;

  const mapsFile = readJSON(path.join(DATA_DIR, 'maps.json'));
  const filePath = path.join(DATA_DIR, 'map_scores.json');

  const mapsOut = {};
  let mapCount = 0;
  let totalMatched = 0;
  let failCount = 0;

  for (const map of mapsFile.maps) {
    try {
      const rows = await getMapWinRates(token, seasons, map.modeId, map.name);
      const scores = {};
      for (const row of rows) {
        const norm = normalizeBtnName(row['map.brawler_dimension']);
        const b = byNorm[norm];
        const globalStat = overall[norm];
        if (!b || !globalStat) continue; // マッチしない・全体勝率が無いキャラは差分計算不能のためスキップ

        const mapWinRate = parseFloat(row['map.winRate_measure']) * 100;
        const battles = parseInt(row['map.picks_measure'], 10);
        scores[b.id] = buildMapScoreEntry(mapWinRate, globalStat.winRatePct, battles, config);
        totalMatched++;
      }
      mapsOut[map.id] = { name: map.name, mode: map.modeId, scores };
      mapCount++;
    } catch (e) {
      failCount++;
      console.warn(`[update-data] 警告: マップ「${map.name}」の勝率取得に失敗(スキップ): ${e.message}`);
    }
    await sleep(MAP_QUERY_DELAY_MS);
  }

  writeJSON(filePath, {
    updatedAt: new Date().toISOString(),
    source: 'brawltime.ninja',
    seasons,
    maps: mapsOut,
  });
  console.log(
    `[update-data] map_scores.json 更新完了 (${mapCount}/${mapsFile.maps.length}マップ, 延べ${totalMatched}件のキャラ×マップ, 失敗${failCount}件)`
  );
}

// 特定キャラ(self)を使った時の、対面/味方ごとの勝率一覧を1クエリで取得する。
// このcubeにはpowerplay(ガチバトル判定)フィルタが無いためカジュアル戦は混ざるが、
// モードフィルタは効くのでガチバトル対象6モードに限定する。
// (無指定だとバトルロイヤル等が大半を占め、3v3の相性としては別物のデータが混入する)
async function getPairWinRates(token, seasons, cube, selfBtnName) {
  const otherField = cube === 'brawlerEnemies' ? 'enemy_dimension' : 'ally_dimension';
  return cubeQuery(token, {
    measures: [`${cube}.winRate_measure`, `${cube}.picks_measure`],
    dimensions: [`${cube}.${otherField}`],
    filters: [
      { member: `${cube}.brawler_dimension`, operator: 'equals', values: [selfBtnName] },
      { member: `${cube}.trophyRange_dimension`, operator: 'gte', values: [MIN_TROPHY_RANGE] },
      { member: `${cube}.season_dimension`, operator: 'equals', values: seasons },
      { member: `${cube}.mode_dimension`, operator: 'equals', values: Object.values(MODE_ID_TO_BTN_MODE) },
    ],
    limit: 500,
  });
}

// 仕様2.3/2.4: 個別ペアの対敵相性・味方シナジー。
// マップ適性と同じ「自己参照差分」方式(このキャラの対面/味方平均勝率との差)を使うことで、
// 全体的な勝率の底上げ(50%中心でない問題)を自動的に打ち消す。
// 「AがBと対面した時の勝率」には3つの成分が混ざっている:
//   (1) A自体の強さ  (2) B自体の弱さ  (3) AとBの純粋な相性
// 素の勝率やAの平均だけを引いた値では(2)が残るため、「誰にとっても弱い相手」が
// 一律に有利判定されてしまう(実データで最大18ポイントの偏りを確認)。
// そこで行平均(A)と列平均(B)の主効果を両方除去し、(3)だけを取り出す。
//   相性 = 勝率 - Aの平均 - Bの被対面平均 + 全体平均
function buildPairEntry(winRate, expectedWinRate, battles, scoringConfig) {
  const { slope, clampMin, clampMax, confidenceThreshold } = scoringConfig;
  const raw = clamp((winRate - expectedWinRate) * slope, clampMin, clampMax);
  const shrunk = raw * Math.min(1, battles / confidenceThreshold);
  return {
    value: Math.round(shrunk * 100) / 100,
    winRate: Math.round(winRate * 100) / 100,
    expectedWinRate: Math.round(expectedWinRate * 100) / 100,
    battles,
  };
}

// 収集した生データ(matrix[selfId][otherId] = {winRate, battles})から
// 試合数で重み付けした行平均・列平均・全体平均を求め、二元正規化した値を返す
function normalizePairMatrix(matrix, scoringConfig) {
  const rowSum = {}, rowW = {}, colSum = {}, colW = {};
  let allSum = 0, allW = 0;
  for (const [selfId, row] of Object.entries(matrix)) {
    for (const [otherId, e] of Object.entries(row)) {
      const w = e.battles;
      rowSum[selfId] = (rowSum[selfId] || 0) + e.winRate * w;
      rowW[selfId] = (rowW[selfId] || 0) + w;
      colSum[otherId] = (colSum[otherId] || 0) + e.winRate * w;
      colW[otherId] = (colW[otherId] || 0) + w;
      allSum += e.winRate * w;
      allW += w;
    }
  }
  const globalAvg = allW > 0 ? allSum / allW : 50;

  const out = {};
  let pairCount = 0;
  for (const [selfId, row] of Object.entries(matrix)) {
    const rowAvg = rowW[selfId] > 0 ? rowSum[selfId] / rowW[selfId] : globalAvg;
    const bucket = (out[selfId] = {});
    for (const [otherId, e] of Object.entries(row)) {
      const colAvg = colW[otherId] > 0 ? colSum[otherId] / colW[otherId] : globalAvg;
      const expected = rowAvg + colAvg - globalAvg;
      bucket[otherId] = buildPairEntry(e.winRate, expected, e.battles, scoringConfig);
      pairCount++;
    }
  }
  return { out, pairCount, globalAvg };
}

async function updatePairMatchupsFile(brawlers, token, seasons, config) {
  const byNorm = {};
  for (const b of brawlers) byNorm[normalizeBtnName(b.nameEn)] = b;

  // 第1段階: 全ペアの生の勝率・試合数を収集する(正規化には全体の分布が必要なため)
  const rawEnemy = {};
  const rawAlly = {};
  let selfCount = 0;
  let failCount = 0;

  for (const self of brawlers) {
    for (const [cube, raw] of [
      ['brawlerEnemies', rawEnemy],
      ['brawlerAllies', rawAlly],
    ]) {
      try {
        const rows = await getPairWinRates(token, seasons, cube, self.nameEn.toUpperCase());
        const field = `${cube}.${cube === 'brawlerEnemies' ? 'enemy_dimension' : 'ally_dimension'}`;
        for (const row of rows) {
          const other = byNorm[normalizeBtnName(row[field])];
          if (!other || other.id === self.id) continue;
          const battles = parseInt(row[`${cube}.picks_measure`], 10);
          if (!battles) continue;
          (raw[self.id] = raw[self.id] || {})[other.id] = {
            winRate: parseFloat(row[`${cube}.winRate_measure`]) * 100,
            battles,
          };
        }
      } catch (e) {
        failCount++;
      }
      await sleep(MAP_QUERY_DELAY_MS);
    }
    selfCount++;
    if (selfCount % 20 === 0) console.log(`[update-data] pair_matchups進捗: ${selfCount}/${brawlers.length}体`);
  }

  // 第2段階: 二元正規化して相性値に変換
  const enemyNorm = normalizePairMatrix(rawEnemy, config.scoring.pairMatchup);
  const allyNorm = normalizePairMatrix(rawAlly, config.scoring.pairSynergy);

  writeJSON(path.join(DATA_DIR, 'pair_matchups.json'), {
    updatedAt: new Date().toISOString(),
    source: 'brawltime.ninja',
    seasons,
    note:
      'ガチバトル対象6モード・上級トロフィー帯に限定して集計。' +
      'valueは二元正規化後の純粋な相性(勝率 - 自分の平均 - 相手の被対面平均 + 全体平均)で、' +
      '「誰にとっても弱い相手」が一律有利になる偏りを除いてある。' +
      'なおこのデータ源にはガチバトル限定のフラグが無いためカジュアル戦は混在する。',
    baselines: { vsEnemy: Math.round(enemyNorm.globalAvg * 100) / 100, withAlly: Math.round(allyNorm.globalAvg * 100) / 100 },
    vsEnemy: enemyNorm.out,
    withAlly: allyNorm.out,
  });
  console.log(
    `[update-data] pair_matchups.json 更新完了 (${selfCount}体, 対面${enemyNorm.pairCount}/味方${allyNorm.pairCount}ペア, 二元正規化済み, 失敗${failCount}件)`
  );
}

// --- ゲーム内CSVからの実ステータス取得 ---

function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
    fields.push(cur);
    rows.push(fields);
  }
  return rows;
}

async function fetchGameCSV(name) {
  const res = await fetch(`${GAME_ASSETS_BASE}/${GAME_ASSETS_VERSION}/${name}`);
  if (!res.ok) throw new Error(`CSV取得失敗 ${name}: ${res.status}`);
  return parseCSV(await res.text());
}

// Supercellのcsvは1行目がカラム名、2行目が型定義。以降がデータ行。
function indexColumns(rows, cols) {
  const header = rows[0];
  const idx = {};
  for (const c of cols) {
    const i = header.indexOf(c);
    if (i >= 0) idx[c] = i;
  }
  return idx;
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function updateBrawlerStatsFile(brawlers) {
  const [charRows, skillRows, textRows] = await Promise.all([
    fetchGameCSV('csv_logic/characters.csv'),
    fetchGameCSV('csv_logic/skills.csv'),
    fetchGameCSV('localization/texts.csv'),
  ]);

  // TID(記号除去・大文字化) -> 英語表示名。characters.csvの内部名と突き合わせるため
  const tidToLabel = {};
  for (const r of textRows.slice(2)) {
    if (r.length >= 2 && r[0].startsWith('TID_')) {
      const key = normalizeBtnName(r[0].slice(4));
      if (!(key in tidToLabel)) tidToLabel[key] = r[1];
    }
  }

  const si = indexColumns(skillRows, ['Name', 'Damage', 'CastingRange', 'NumBulletsInOneAttack', 'RechargeTime']);
  const skills = {};
  for (const r of skillRows.slice(2)) {
    if (r[si.Name]) {
      skills[r[si.Name]] = {
        damage: parseInt(r[si.Damage], 10) || 0,
        range: parseInt(r[si.CastingRange], 10) || 0,
        bullets: parseInt(r[si.NumBulletsInOneAttack], 10) || 1,
        reloadMs: parseInt(r[si.RechargeTime], 10) || 0,
      };
    }
  }

  const ci = indexColumns(charRows, ['Name', 'Hitpoints', 'Speed', 'WeaponSkill']);
  const byLabel = {};
  for (const b of brawlers) byLabel[normalizeBtnName(b.nameEn)] = b;

  const stats = {};
  let matched = 0;
  for (const r of charRows.slice(2)) {
    const internal = r[ci.Name];
    if (!internal) continue;
    const key = normalizeBtnName(internal);
    // 内部名とTIDの綴りが一致しないケースがあるため(例: HookDude -> TID_HOOK)、
    // 正規化した完全一致を先に試し、駄目なら末尾のDUDEを落として再試行する
    const label = tidToLabel[key] || tidToLabel[key.replace(/DUDE$/, '')];
    if (!label) continue;
    const b = byLabel[normalizeBtnName(label)];
    if (!b) continue;
    const sk = skills[r[ci.WeaponSkill]];
    if (!sk) continue;

    const hp = parseInt(r[ci.Hitpoints], 10) || 0;
    const damagePerShot = sk.damage * sk.bullets;
    // CastingRangeは1/3タイル単位(パイパー30=10タイル、ブル16=5.33タイルで検証済み)
    const rangeTiles = Math.round((sk.range / 3) * 100) / 100;
    stats[b.id] = {
      hp,
      damagePerShot,
      damagePerBullet: sk.damage,
      bullets: sk.bullets,
      rangeTiles,
      speed: parseInt(r[ci.Speed], 10) || 0,
      reloadMs: sk.reloadMs,
    };
    matched++;
  }

  const valid = Object.values(stats).filter((s) => s.hp > 0 && s.damagePerShot > 0 && s.rangeTiles > 0);
  writeJSON(path.join(DATA_DIR, 'brawler_stats.json'), {
    updatedAt: new Date().toISOString(),
    sourceVersion: GAME_ASSETS_VERSION,
    note: 'ゲーム内CSV(characters.csv/skills.csv)由来。すべてパワーレベル1基準の値で、実戦のレベル11ではおおよそ1.4倍になる。相対比較にのみ使う想定。rangeTilesはタイル単位。',
    medians: {
      hp: median(valid.map((s) => s.hp)),
      damagePerShot: median(valid.map((s) => s.damagePerShot)),
      rangeTiles: median(valid.map((s) => s.rangeTiles)),
    },
    stats,
  });
  console.log(`[update-data] brawler_stats.json 更新完了 (${matched}/${brawlers.length}体, ゲームバージョン${GAME_ASSETS_VERSION})`);
}

async function updateWinRates(brawlers) {
  const config = readJSON(path.join(DATA_DIR, 'config.json'));
  console.log('[update-data] Brawl Time Ninjaへ接続中...');
  const token = await getAuthToken();
  const seasons = await getRecentSeasons(token);
  console.log(`[update-data] 直近${seasons.length}シーズンを対象にします: ${seasons.join(', ')}`);

  const overall = await getOverallWinRates(token, seasons);
  updateMetaFile(brawlers, overall, config);
  await updateMapScoresFile(brawlers, overall, token, seasons, config);
  // 相性は構造的でほぼ不変なので、統計的に判別できる試合数を確保するため長期間で集計する
  const pairSeasons = await getRecentSeasons(token, PAIR_SEASON_COUNT);
  console.log(`[update-data] 相性データは直近${pairSeasons.length}シーズンで集計します`);
  await updatePairMatchupsFile(brawlers, token, pairSeasons, config);
}

async function main() {
  console.log('[update-data] 開始');
  const brawlers = await updateBrawlers();
  await updateMaps();
  try {
    await updateBrawlerStatsFile(brawlers);
  } catch (e) {
    console.warn(`[update-data] 警告: ステータス(体力/攻撃力/射程)の取得に失敗しました: ${e.message}`);
  }
  try {
    await updateWinRates(brawlers);
  } catch (e) {
    console.warn(`[update-data] 警告: Brawl Time Ninjaからの勝率取得に失敗しました。マップ適性・メタ係数は中立値のままです: ${e.message}`);
  }
  console.log('[update-data] 完了');
}

main().catch((e) => {
  console.error('[update-data] 失敗:', e);
  process.exit(1);
});
