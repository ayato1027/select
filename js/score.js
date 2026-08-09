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
  };
}

function computeCandidateScore(candidate, ctx) {
  const mapPart = computeMapScorePart(candidate, ctx);

  let enemySum = 0;
  const enemyReasons = [];
  for (const enemy of ctx.enemies) {
    const po = ctx.pairOverrides.vsEnemy.find(
      (o) => String(o.selfId) === String(candidate.id) && String(o.enemyId) === String(enemy.id)
    );
    const v = po ? po.value : ((ctx.roleMatchups.matchups[candidate.role] || {})[enemy.role] || 0);
    enemySum += v;
    if (v !== 0) {
      enemyReasons.push({ label: `相手の${enemy.displayName || enemy.name}に${v > 0 ? '有利' : '不利'}(${v > 0 ? '+' : ''}${v})`, value: v });
    }
  }

  let allySum = 0;
  const allyReasons = [];
  for (const ally of ctx.allies) {
    const po = ctx.pairOverrides.withAlly.find(
      (o) => String(o.selfId) === String(candidate.id) && String(o.allyId) === String(ally.id)
    );
    const v = po ? po.value : ((ctx.roleSynergy.synergy[candidate.role] || {})[ally.role] || 0);
    allySum += v;
    if (v !== 0) {
      allyReasons.push({ label: `味方の${ally.displayName || ally.name}と${v > 0 ? '好相性' : '相性が悪い'}(${v > 0 ? '+' : ''}${v})`, value: v });
    }
  }

  const compResult = evaluateCompRules(candidate, ctx.allies, ctx.mode, ctx.compRules);
  allySum += compResult.bonus;
  for (const r of compResult.reasons) {
    allyReasons.push({ label: r.label, value: r.value });
  }

  const metaPart = computeMetaPart(candidate, ctx);

  const total = mapPart.value + enemySum + allySum + metaPart.value;

  const allReasons = [];
  if (mapPart.reason) allReasons.push(mapPart.reason);
  allReasons.push(...enemyReasons, ...allyReasons);
  if (metaPart.reason) allReasons.push(metaPart.reason);
  allReasons.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  return {
    brawler: candidate,
    total,
    breakdown: {
      mapValue: mapPart.value,
      enemySum,
      allySum,
      metaValue: metaPart.value,
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
  computeCandidateScore,
  computeScores,
};
