// スコアリングエンジン (仕様書 2章)
// 最終スコア = マップ適性スコア + 対敵相性補正 + 味方シナジー補正 + メタ係数

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// data/pair_overrides.json (nameEnベース) を id ベースへ解決する
function resolvePairOverrides(raw, brawlersByNormName) {
  const resolveOne = (nameEn) => {
    const norm = window.BSApi.normalizeName(nameEn);
    const b = brawlersByNormName[norm];
    if (!b) {
      console.warn(`pair_overrides: 未知のキャラ名 "${nameEn}" (現在のBrawlAPIマスタに存在しません)`);
      return null;
    }
    return b.id;
  };

  const vsEnemy = (raw.vsEnemy || [])
    .map((o) => ({ selfId: resolveOne(o.self), enemyId: resolveOne(o.enemy), value: o.value, note: o.note }))
    .filter((o) => o.selfId != null && o.enemyId != null);

  const withAlly = (raw.withAlly || [])
    .map((o) => ({ selfId: resolveOne(o.self), allyId: resolveOne(o.ally), value: o.value, note: o.note }))
    .filter((o) => o.selfId != null && o.allyId != null);

  return { vsEnemy, withAlly };
}

// --- 自分で作る相性表 ---
// 「シェリー vs ブル」と「ブル vs シェリー」が食い違わないよう、
// ペアにつき1つの値だけを保存し、逆側は導出する(構造的に矛盾し得ない)。
//   対面(vsEnemy): A有利ならB不利なので符号を反転させる
//   味方(withAlly): 相性の良し悪しは双方に等しく効くので同符号
function myMatchupKey(idA, idB) {
  const a = Number(idA);
  const b = Number(idB);
  return a <= b ? `${a}_${b}` : `${b}_${a}`;
}

function lookupMyMatchup(store, kind, selfId, otherId) {
  if (!store || !store[kind]) return null;
  const raw = store[kind][myMatchupKey(selfId, otherId)];
  if (raw == null) return null;
  if (Number(selfId) <= Number(otherId)) return raw;
  return kind === 'vsEnemy' ? -raw : raw;
}

// selfId視点の値をvalueに設定する(nullで解除)。保存形式は常に小さいid視点に正規化する
function setMyMatchup(store, kind, selfId, otherId, value) {
  if (!store[kind]) store[kind] = {};
  const key = myMatchupKey(selfId, otherId);
  if (value == null) {
    delete store[kind][key];
    return store;
  }
  const flip = Number(selfId) > Number(otherId) && kind === 'vsEnemy';
  store[kind][key] = flip ? -value : value;
  return store;
}

// 試合数が足りないペアの実データは統計的な裏付けが無く、ノイズをそのまま
// 相性値として扱うことになるため使わない(呼び出し側でロール相性表にフォールバックする)。
function pickReliablePair(table, selfId, otherId, scoringConfig) {
  const entry = table && table[selfId] && table[selfId][otherId];
  if (!entry) return null;
  const min = scoringConfig && scoringConfig.minBattles;
  if (min && entry.battles < min) return null;
  return entry;
}

// 構成バランスルール評価 (仕様 2.4(b) / 3.2)
// team = 入力済み味方 + 評価中の候補キャラ自身
function evaluateCompRules(candidate, allies, mode, compRules) {
  let bonus = 0;
  const reasons = [];

  for (const rule of compRules.rules || []) {
    const when = rule.when || {};
    if (when.modes && !when.modes.includes(mode)) continue;

    let matched = true;

    if (when.teamLacksRoles) {
      const alliesHaveAny = allies.some((a) => when.teamLacksRoles.includes(a.role));
      if (alliesHaveAny) matched = false;
    }

    if (matched && when.teamHasRoleCount) {
      for (const [role, n] of Object.entries(when.teamHasRoleCount)) {
        const count = allies.filter((a) => a.role === role).length;
        if (count < n) {
          matched = false;
          break;
        }
      }
    }

    if (!matched) continue;

    const then = rule.then || {};
    if (then.bonusToRoles && then.bonusToRoles.includes(candidate.role)) {
      bonus += then.value;
      reasons.push({ label: rule.note || rule.id, value: then.value });
    }
  }

  return { bonus, reasons };
}

function computeMapScorePart(candidate, ctx) {
  const neutral = ctx.config.scoring.mapScore.neutral;
  const override = ctx.mapOverrides.find(
    (o) => String(o.mapId) === String(ctx.mapId) && String(o.brawlerId) === String(candidate.id)
  );
  if (override) {
    return {
      value: override.value,
      reason: { label: `手動評価: ${override.note}`, value: override.value - neutral },
      hasData: true,
      source: 'override',
    };
  }

  const mapEntry = ctx.mapScores.maps ? ctx.mapScores.maps[ctx.mapId] : null;
  const scoreEntry = mapEntry && mapEntry.scores ? mapEntry.scores[candidate.id] : null;
  if (scoreEntry) {
    const diff = scoreEntry.mapWinRate - scoreEntry.globalWinRate;
    const diffStr = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`;
    return {
      value: scoreEntry.value,
      reason: {
        label: `このマップで平均${diffStr}%勝率(適性${scoreEntry.value.toFixed(1)}/10)`,
        value: scoreEntry.value - neutral,
      },
      hasData: true,
      source: 'auto',
      mapWinRate: scoreEntry.mapWinRate,
      globalWinRate: scoreEntry.globalWinRate,
      battles: scoreEntry.battles,
    };
  }

  return { value: neutral, reason: null, hasData: false, source: 'neutral' };
}

function computeMetaPart(candidate, ctx) {
  const entry = ctx.meta.coefficients ? ctx.meta.coefficients[candidate.id] : null;
  if (!entry) return { value: 0, reason: null, hasData: false };
  const value = entry.manualValue != null ? entry.manualValue : entry.value;
  return {
    value,
    reason: {
      label: `今環境で${value > 0 ? '好調' : value < 0 ? '不調' : '標準'}(メタ${value >= 0 ? '+' : ''}${value.toFixed(1)})`,
      value,
    },
    hasData: true,
    winRate: entry.winRate,
    battles: entry.battles,
  };
}

// 個人バイアス: ユーザーが自分の評価(外部Tier表・体感等)を任意で加点/減点できる項目。
// 仕様書の4項目加算とは独立の追加レイヤーで、localStorage由来のctx.personalBiasを参照する。
function computePersonalBiasPart(candidate, ctx) {
  const entry = ctx.personalBias ? ctx.personalBias[candidate.id] : null;
  if (!entry || !entry.value) return { value: 0, reason: null };
  const value = entry.value;
  return {
    value,
    reason: {
      label: `自分の評価${entry.note ? `: ${entry.note}` : ''}(${value > 0 ? '+' : ''}${value})`,
      value,
    },
  };
}

// 相手チームの実ステータス(体力/火力/射程)の平均を集計する。
// 判明している相手が少ないうちは偏りが大きいので、呼び出し側で人数条件を見る。
function summarizeTeamStats(members, statsTable) {
  const vals = { hp: [], damagePerShot: [], rangeTiles: [] };
  for (const m of members) {
    const s = statsTable ? statsTable[m.id] : null;
    if (!s) continue;
    if (s.hp > 0) vals.hp.push(s.hp);
    if (s.damagePerShot > 0) vals.damagePerShot.push(s.damagePerShot);
    if (s.rangeTiles > 0) vals.rangeTiles.push(s.rangeTiles);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    count: members.length,
    hp: avg(vals.hp),
    damagePerShot: avg(vals.damagePerShot),
    rangeTiles: avg(vals.rangeTiles),
  };
}

// 「相手が軽装甲ならアサシンで詰める」「相手の火力が低いならタンクで圧をかける」といった
// 実ステータス基準の型補正。数値はconfig.scoring.enemyCompで調整できる。
function computeEnemyCompPart(candidate, ctx) {
  const cfg = ctx.config.scoring.enemyComp;
  const stats = ctx.brawlerStats;
  if (!cfg || !stats || !ctx.enemies || ctx.enemies.length < cfg.minEnemies) {
    return { value: 0, reasons: [] };
  }
  const summary = summarizeTeamStats(ctx.enemies, stats.stats);
  const med = stats.medians;
  const role = candidate.role;
  let value = 0;
  const reasons = [];

  const add = (roles, label) => {
    if (!roles.includes(role)) return;
    value += cfg.bonus;
    reasons.push({ label, value: cfg.bonus });
  };

  if (summary.hp != null && med.hp && summary.hp < med.hp * cfg.squishyHpRatio) {
    add(['assassin', 'dive_tank'], '相手が軽い編成 — 突撃が刺さる');
  }
  if (summary.damagePerShot != null && med.damagePerShot && summary.damagePerShot < med.damagePerShot * cfg.lowDamageRatio) {
    add(['anchor_tank', 'dive_tank'], '相手の火力が低め — タンクで圧をかけられる');
  }
  if (summary.rangeTiles != null) {
    if (summary.rangeTiles >= cfg.longRangeTiles) {
      add(['assassin', 'dive_tank'], '相手が遠距離寄り — 距離を詰める型が有効');
    } else if (summary.rangeTiles < cfg.closeRangeTiles) {
      add(['sniper', 'thrower'], '相手が近距離寄り — 射程で優位に立てる');
    }
  }
  return { value, reasons };
}

function computeCandidateScore(candidate, ctx) {
  const mapPart = computeMapScorePart(candidate, ctx);

  let enemySum = 0;
  const enemyReasons = [];
  for (const enemy of ctx.enemies) {
    const po = ctx.pairOverrides.vsEnemy.find(
      (o) => String(o.selfId) === String(candidate.id) && String(o.enemyId) === String(enemy.id)
    );
    const mine = lookupMyMatchup(ctx.myMatchups, 'vsEnemy', candidate.id, enemy.id);
    let v;
    let source = '';
    if (mine != null) {
      v = mine;
      source = '自分の評価で';
    } else if (po) {
      v = po.value;
    } else {
      const auto = pickReliablePair(ctx.pairMatchups && ctx.pairMatchups.vsEnemy, candidate.id, enemy.id, ctx.config.scoring.pairMatchup);
      if (auto) {
        v = auto.value;
        source = '実績';
      } else {
        v = (ctx.roleMatchups.matchups[candidate.role] || {})[enemy.role] || 0;
      }
    }
    enemySum += v;
    if (v !== 0) {
      enemyReasons.push({
        label: `相手の${enemy.displayName || enemy.name}に${source}${v > 0 ? '有利' : '不利'}(${v > 0 ? '+' : ''}${v})`,
        value: v,
      });
    }
  }

  let allySum = 0;
  const allyReasons = [];
  for (const ally of ctx.allies) {
    const po = ctx.pairOverrides.withAlly.find(
      (o) => String(o.selfId) === String(candidate.id) && String(o.allyId) === String(ally.id)
    );
    const mine = lookupMyMatchup(ctx.myMatchups, 'withAlly', candidate.id, ally.id);
    let v;
    let isRealData = false;
    if (mine != null) {
      v = mine;
    } else if (po) {
      v = po.value;
    } else {
      const auto = pickReliablePair(ctx.pairMatchups && ctx.pairMatchups.withAlly, candidate.id, ally.id, ctx.config.scoring.pairSynergy);
      if (auto) {
        v = auto.value;
        isRealData = true;
      } else {
        v = (ctx.roleSynergy.synergy[candidate.role] || {})[ally.role] || 0;
      }
    }
    allySum += v;
    if (v !== 0) {
      const suffix = isRealData ? '実績' : '';
      allyReasons.push({
        label: `味方の${ally.displayName || ally.name}と${suffix}${v > 0 ? '好相性' : '相性が悪い'}(${v > 0 ? '+' : ''}${v})`,
        value: v,
      });
    }
  }

  const compResult = evaluateCompRules(candidate, ctx.allies, ctx.mode, ctx.compRules);
  allySum += compResult.bonus;
  for (const r of compResult.reasons) {
    allyReasons.push({ label: r.label, value: r.value });
  }

  const metaPart = computeMetaPart(candidate, ctx);
  const biasPart = computePersonalBiasPart(candidate, ctx);
  const enemyCompPart = computeEnemyCompPart(candidate, ctx);

  const total = mapPart.value + enemySum + allySum + metaPart.value + biasPart.value + enemyCompPart.value;

  const allReasons = [];
  if (mapPart.reason) allReasons.push(mapPart.reason);
  allReasons.push(...enemyReasons, ...allyReasons, ...enemyCompPart.reasons);
  if (metaPart.reason) allReasons.push(metaPart.reason);
  if (biasPart.reason) allReasons.push(biasPart.reason);
  allReasons.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  return {
    brawler: candidate,
    total,
    breakdown: {
      mapValue: mapPart.value,
      enemySum,
      allySum,
      metaValue: metaPart.value,
      biasValue: biasPart.value,
      enemyCompValue: enemyCompPart.value,
    },
    stats: {
      mapWinRate: mapPart.mapWinRate,
      mapGlobalWinRate: mapPart.globalWinRate,
      mapBattles: mapPart.battles,
      metaWinRate: metaPart.winRate,
      metaBattles: metaPart.battles,
    },
    reasons: allReasons.slice(0, 2).map((r) => r.label),
    allReasons,
  };
}

function computeScores(candidates, ctx) {
  return candidates.map((c) => computeCandidateScore(c, ctx)).sort((a, b) => b.total - a.total);
}

window.BSScore = {
  clamp,
  resolvePairOverrides,
  evaluateCompRules,
  summarizeTeamStats,
  myMatchupKey,
  lookupMyMatchup,
  setMyMatchup,
  computeCandidateScore,
  computeScores,
};
