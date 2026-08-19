/* ==========================================================
   FMcriol — Geração de estatísticas de jogador para jogos do Campeonato e
   da Taça inteiramente entre equipas geridas pelo jogo (sem nenhum
   amigável por trás — ver routes/league.js e routes/cup.js).

   Isto é uma cópia deliberada da mesma lógica já usada em routes/game.js
   (simulateFriendlyMatchDetails) para amigáveis — mantém-se separada em vez
   de partilhada para não arriscar mexer no código de amigáveis/jogo ao
   vivo, que já está em produção. Sempre que um dos dois lados muda, vale a
   pena verificar se o outro também deveria mudar.
   ========================================================== */
const db = require('../db/database');

function classifyPositionCode(code) {
  const c = String(code || '').split('/')[0].trim().toUpperCase();
  if (c === 'GR') return 'GR';
  if (['PL', 'AD', 'AE', 'ED', 'EE'].includes(c)) return 'PL';
  if (['MCO', 'MOD', 'MOE'].includes(c)) return 'MO';
  if (c.startsWith('M')) return 'MED';
  return 'DEF';
}

const SCORE_WEIGHT = { DEF: 15, MED: 20, MO: 30, PL: 35, GR: 0 };
const ASSIST_WEIGHT = { DEF: 10, MED: 30, MO: 35, PL: 20, GR: 0 };
const CARD_WEIGHT = { DEF: 30, MED: 30, MO: 20, PL: 15, GR: 5 };
const TACKLE_BASE = { GR: 0, DEF: 3.2, MED: 2.4, MO: 1.1, PL: 0.6 };

function playerQualityFactor(player) {
  const fields = player.category === 'GR'
    ? ['goalkeeping_json', 'mental_json', 'physical_json']
    : ['technical_json', 'mental_json', 'physical_json'];
  let sum = 0;
  let count = 0;
  fields.forEach((field) => {
    let list;
    try { list = JSON.parse(player[field] || '[]'); } catch { list = []; }
    if (Array.isArray(list)) {
      list.forEach(([, value]) => {
        const v = Number(value);
        if (Number.isFinite(v)) { sum += v; count += 1; }
      });
    }
  });
  const avg = count ? sum / count : 10;
  return Math.max(0.5, Math.min(2.2, avg / 10));
}

function pickWeighted(candidates, weightMap) {
  const pool = candidates.filter((p) => (weightMap[p.category] || 0) > 0);
  if (!pool.length) return null;
  const total = pool.reduce((sum, p) => sum + weightMap[p.category] * p.quality, 0);
  let roll = Math.random() * total;
  for (const p of pool) {
    roll -= weightMap[p.category] * p.quality;
    if (roll <= 0) return p;
  }
  return pool[pool.length - 1];
}

function pickWeightedCustom(candidates, weightFn) {
  const pool = candidates.filter((p) => weightFn(p) > 0);
  if (!pool.length) return null;
  const total = pool.reduce((sum, p) => sum + weightFn(p) * p.quality, 0);
  let roll = Math.random() * total;
  for (const p of pool) {
    roll -= weightFn(p) * p.quality;
    if (roll <= 0) return p;
  }
  return pool[pool.length - 1];
}

/* Onze inicial guardado na Tática do clube; se a equipa nunca guardou uma
   (o normal para as 14 equipas geridas pelo jogo), completa com o resto do
   plantel por ordem, tal como em routes/game.js. */
function resolveMatchLineup(teamId) {
  const squad = db.prepare(`
    SELECT id, name, position_tag, position_code, focus_role,
           technical_json, mental_json, physical_json, goalkeeping_json
    FROM players WHERE team_id = ?
  `).all(teamId).map((p) => ({ ...p, category: classifyPositionCode(p.position_code) }));
  if (!squad.length) return [];

  const tactic = db.prepare('SELECT lineup_json FROM tactics WHERE team_id = ?').get(teamId);
  const chosen = [];
  const usedIds = new Set();

  if (tactic) {
    let lineupEntries = [];
    try { lineupEntries = JSON.parse(tactic.lineup_json || '[]'); } catch { lineupEntries = []; }
    lineupEntries.forEach((entry) => {
      const player = squad.find((p) => p.id === entry.player_id);
      if (player && !usedIds.has(player.id)) {
        chosen.push({ ...player, category: classifyPositionCode(entry.code || player.position_code) });
        usedIds.add(player.id);
      }
    });
  }

  if (chosen.length < 11) {
    squad.filter((p) => !usedIds.has(p.id)).forEach((p) => {
      if (chosen.length < 11) { chosen.push(p); usedIds.add(p.id); }
    });
  }

  return chosen.slice(0, 11).map((p) => ({ ...p, quality: playerQualityFactor(p) }));
}

/* ---------- Gera golos/assistências/cartões/cortes/% de passe para os
   dois lados de um jogo do Campeonato ou da Taça sem nenhum amigável por
   trás (as duas equipas são geridas pelo jogo). Guarda tudo em
   friendly_player_stats (com friendly_id a NULL) e atualiza a linha certa
   de season_stats_json de cada jogador. ---------- */
function simulateCompetitionMatchStats(competition, homeTeamId, awayTeamId, homeGoals, awayGoals) {
  const rowName = db.COMPETITION_ROW_NAMES[competition] || db.COMPETITION_ROW_NAMES.friendly;
  const sides = [
    { teamId: homeTeamId, goalsFor: homeGoals, goalsAgainst: awayGoals },
    { teamId: awayTeamId, goalsFor: awayGoals, goalsAgainst: homeGoals },
  ];

  const insertStat = db.prepare(`
    INSERT INTO friendly_player_stats
      (friendly_id, competition, team_id, player_id, player_name, position_tag, goals, assists, rating, yellow_cards, red_card, tackles, pass_pct)
    VALUES
      (NULL, @competition, @team_id, @player_id, @player_name, @position_tag, @goals, @assists, @rating, @yellow_cards, @red_card, @tackles, @pass_pct)
  `);

  sides.forEach(({ teamId, goalsFor, goalsAgainst }) => {
    const lineup = resolveMatchLineup(teamId);
    if (!lineup.length) return;

    const outfield = lineup.filter((p) => p.category !== 'GR');
    const tally = new Map(lineup.map((p) => [p.id, { goals: 0, assists: 0, yellow: 0, red: 0 }]));

    /* Mesma salvaguarda de routes/game.js: um plantel curto não deve
       concentrar todos os golos da equipa num único jogador, e um
       plantel muito curto (menos de 6 jogadores) nem sequer deve ter
       todos os golos atribuídos — alguns ficam por "desconhecido". */
    const scoreWeightFor = (p) => SCORE_WEIGHT[p.category] * (p.focus_role === 'Goleador' ? 2.2 : 1);
    const assistWeightFor = (p) => ASSIST_WEIGHT[p.category] * (p.focus_role === 'Garçom' ? 2.2 : 1);
    const anonymousGoalChance = lineup.length < 6 ? 0.35 : 0;
    const pickScorer = () => {
      const underCap = outfield.filter((p) => tally.get(p.id).goals < 3);
      const pool = underCap.length ? underCap : outfield;
      return pickWeightedCustom(pool, scoreWeightFor);
    };

    for (let g = 0; g < goalsFor; g += 1) {
      if (anonymousGoalChance && Math.random() < anonymousGoalChance) continue;

      const scorer = pickScorer();
      if (scorer) tally.get(scorer.id).goals += 1;
      if (scorer && Math.random() < 0.8) {
        const assistCandidates = outfield.filter((p) => p.id !== scorer.id);
        const assister = pickWeightedCustom(assistCandidates, assistWeightFor);
        if (assister) tally.get(assister.id).assists += 1;
      }
    }

    let yellows = 0;
    for (let i = 0; i < 5; i += 1) { if (Math.random() < 0.32) yellows += 1; }
    for (let i = 0; i < yellows; i += 1) {
      const pool = lineup.filter((p) => tally.get(p.id).red === 0);
      const player = pickWeighted(pool, CARD_WEIGHT) || pool[Math.floor(Math.random() * pool.length)];
      if (!player) continue;
      const t = tally.get(player.id);
      if (t.yellow) { t.yellow += 1; t.red = 1; } else { t.yellow = 1; }
    }
    if (Math.random() < 0.08) {
      const pool = lineup.filter((p) => tally.get(p.id).red === 0);
      const player = pool[Math.floor(Math.random() * pool.length)];
      if (player) tally.get(player.id).red = 1;
    }

    const resultBonus = goalsFor > goalsAgainst ? 0.3 : goalsFor < goalsAgainst ? -0.2 : 0.1;

    lineup.forEach((player) => {
      const { goals, assists, yellow, red } = tally.get(player.id);
      let rating = 6.0 + resultBonus + (Math.random() * 0.6 - 0.3) + goals * 0.8 + assists * 0.4;
      if (player.category === 'GR') rating += goalsAgainst === 0 ? 0.5 : (goalsAgainst >= 3 ? -0.4 : 0);
      rating -= yellow * 0.1;
      if (red) rating -= 1.0;
      rating = Math.max(4.0, Math.min(10.0, rating));

      const tackles = Math.max(0, Math.round((TACKLE_BASE[player.category] || 0) * player.quality + (Math.random() * 2 - 1)));
      const passPct = Math.max(40, Math.min(98, Math.round(62 + player.quality * 10 + (Math.random() * 16 - 8))));

      insertStat.run({
        competition, team_id: teamId, player_id: player.id,
        player_name: player.name, position_tag: player.position_tag || '',
        goals, assists, rating: Number(rating.toFixed(2)),
        yellow_cards: yellow, red_card: red, tackles, pass_pct: passPct,
      });

      db.applySeasonStat(player.id, rowName, {
        goals, assists, yellow, red, tackles, passPct, rating: Number(rating.toFixed(2)),
      });
    });
  });
}

/* ---------- Líderes estatísticos de uma competição (melhores marcadores,
   assistências, cartões, cortes por jogo, % de passe) ----------
   Usado pelas rotas GET de routes/league.js e routes/cup.js, ao lado da
   tabela classificativa / do bracket. Só considera equipas da divisão do
   clube do utilizador (teamIds), tal como a própria tabela. */
function getCompetitionLeaders(competition, teamIds) {
  if (!teamIds.length) return {};
  const placeholders = teamIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      fps.player_id, fps.player_name, fps.team_id,
      t.name AS team_name, t.shield_path AS team_shield,
      p.photo_path AS player_photo,
      SUM(fps.goals) AS goals, SUM(fps.assists) AS assists,
      SUM(fps.yellow_cards) AS yellow, SUM(fps.red_card) AS red,
      SUM(fps.tackles) AS tackles, COUNT(*) AS games,
      AVG(fps.pass_pct) AS pass_pct
    FROM friendly_player_stats fps
    JOIN teams t ON t.id = fps.team_id
    LEFT JOIN players p ON p.id = fps.player_id
    WHERE fps.competition = ? AND fps.player_id IS NOT NULL AND fps.team_id IN (${placeholders})
    GROUP BY fps.player_id
  `).all(competition, ...teamIds);

  const withDerived = rows.map((r) => ({
    ...r,
    tackles_per_game: r.games ? r.tackles / r.games : 0,
    pass_pct: r.pass_pct != null ? Math.round(r.pass_pct * 10) / 10 : null,
  }));

  const top = (key, min = 1) => withDerived
    .filter((r) => r[key] >= min)
    .sort((a, b) => b[key] - a[key])
    .slice(0, 5);

  return {
    top_scorers: top('goals'),
    top_assists: top('assists'),
    top_yellow: top('yellow'),
    top_red: top('red'),
    top_tackles: withDerived.filter((r) => r.games > 0).sort((a, b) => b.tackles_per_game - a.tackles_per_game).slice(0, 5),
    top_passing: withDerived.filter((r) => r.pass_pct != null).sort((a, b) => b.pass_pct - a.pass_pct).slice(0, 5),
  };
}

module.exports = { simulateCompetitionMatchStats, getCompetitionLeaders };