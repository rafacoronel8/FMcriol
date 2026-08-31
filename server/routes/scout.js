/* ==========================================================
   FMcriol — Recomendações do Olheiro
   Só dá recomendações se o clube tiver um Olheiro contratado (ver
   routes/staff.js — cargo 'Olheiro', migração em db/database.js) E o
   mercado de transferências estiver aberto. Fica num ficheiro próprio em
   vez de mexer em routes/staff.js, que já trata de contratar/despedir
   comissão técnica de forma genérica por cargo.
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

/* Cópia deliberada da mesma classificação de posição já usada em
   routes/liveMatch.js / routes/competitionStats.js. */
function classifyPositionCode(code) {
  const c = String(code || '').split('/')[0].trim().toUpperCase();
  if (c === 'GR') return 'GR';
  if (['PL', 'AD', 'AE', 'ED', 'EE'].includes(c)) return 'PL';
  if (['MCO', 'MOD', 'MOE'].includes(c)) return 'MO';
  if (c.startsWith('M')) return 'MED';
  return 'DEF';
}

/* Mesma lógica de parsing (e o mesmo cuidado com separadores de milhar) já
   corrigida em routes/transfers.js:parseMoneyRange — duplicada aqui de
   propósito, como o resto da geração de estatísticas neste projeto. */
function parseMoneyRange(text) {
  const raw = String(text || '');
  const tokenRegex = /([\d][\d.,\s]*)\s*(M|K)?/gi;
  const results = [];
  for (const m of raw.matchAll(tokenRegex)) {
    const numText = m[1].trim();
    if (!numText) continue;
    const suffix = (m[2] || '').toUpperCase();
    let value;
    if (suffix) {
      value = parseFloat(numText.replace(/\s/g, '').replace(',', '.'));
    } else {
      const digitsOnly = numText.replace(/[^\d]/g, '');
      value = digitsOnly ? parseInt(digitsOnly, 10) : NaN;
    }
    if (Number.isFinite(value) && value > 0) {
      results.push(suffix === 'K' ? value * 1_000 : suffix === 'M' ? value * 1_000_000 : value);
    }
  }
  return results;
}
const MARKET_VALUE_CEILING = 2_500_000;

function currentGameDateStr() {
  const row = db.prepare('SELECT current_date FROM game_state WHERE id = 1').get();
  return row ? row.current_date : null;
}
function ageFromBirthDate(birthDateStr) {
  const today = currentGameDateStr();
  if (!birthDateStr || !today) return 25;
  const [ty, tm, td] = today.split('-').map(Number);
  const [by, bm, bd] = String(birthDateStr).slice(0, 10).split('-').map(Number);
  if (!by) return 25;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}
function estimateMarketValue(player) {
  const parsed = parseMoneyRange(player.market_value_text);
  if (parsed.length) {
    const avg = parsed.reduce((a, b) => a + b, 0) / parsed.length;
    if (avg > 0) return Math.round(Math.min(avg, MARKET_VALUE_CEILING));
  }
  const ability = player.current_ability_stars ?? 2.5;
  const potential = player.potential_ability_stars ?? ability;
  const age = ageFromBirthDate(player.birth_date);
  const ageFactor = age <= 21 ? 1.25 : age <= 25 ? 1.1 : age <= 29 ? 1.0 : age <= 33 ? 0.7 : 0.45;
  const growthFactor = 1 + Math.max(0, potential - ability) * 0.12;
  return Math.round(ability * 60_000 * ageFactor * growthFactor);
}

/* Posições com menos jogadores do que o "ideal" no plantel do clube pesam
   mais nas recomendações — um plantel curto numa posição é prioridade. */
const IDEAL_COUNT = { GR: 2, DEF: 6, MED: 5, MO: 3, PL: 3 };
function computeSquadNeeds(teamId) {
  const squad = db.prepare('SELECT position_code FROM players WHERE team_id = ?').all(teamId);
  const counts = { GR: 0, DEF: 0, MED: 0, MO: 0, PL: 0 };
  squad.forEach((p) => { counts[classifyPositionCode(p.position_code)] += 1; });
  const needs = {};
  Object.keys(IDEAL_COUNT).forEach((code) => {
    needs[code] = Math.max(0, IDEAL_COUNT[code] - (counts[code] || 0)) / IDEAL_COUNT[code];
  });
  return needs;
}

/* ---------- Relatório de scouting (texto) ----------
   Combina qualidade + especialização (focus_role, quando existe, senão a
   posição) + personalidade num pequeno parágrafo, para cada indicação vir
   com uma descrição a sério do jogador, não só um nome e um preço. */
const QUALITY_TIER_PHRASES = [
  { min: 4.3, text: 'É um jogador de topo para o nível deste campeonato.' },
  { min: 3.4, text: 'É um jogador claramente acima da média.' },
  { min: 2.4, text: 'É um jogador sólido e equilibrado.' },
  { min: 1.4, text: 'Ainda está em desenvolvimento, mas tem margem de progressão.' },
  { min: 0, text: 'É um jogador limitado, mais para preencher o plantel.' },
];
function qualityPhrase(stars) {
  return (QUALITY_TIER_PHRASES.find((t) => stars >= t.min) || QUALITY_TIER_PHRASES[QUALITY_TIER_PHRASES.length - 1]).text;
}

const FOCUS_ROLE_LABELS = { 'Goleador': 'Finalizador', 'Garçom': 'Criador de Jogo', 'Patrão': 'Líder Defensivo' };
const FOCUS_ROLE_PHRASES = {
  'Goleador': 'É um finalizador nato, sempre pronto para aparecer na área.',
  'Garçom': 'Tem excelente visão de jogo e gosta de servir os companheiros.',
  'Patrão': 'Lidera pela postura e impõe respeito em campo.',
};
const POSITION_GROUP_LABELS = { GR: 'Guarda-Redes', DEF: 'Defesa', MED: 'Médio', MO: 'Médio Ofensivo', PL: 'Avançado' };
const POSITION_GROUP_PHRASES = {
  GR: 'Guarda-redes seguro, com boa leitura do jogo aéreo.',
  DEF: 'Defensor consistente, forte no jogo de posicionamento.',
  MED: 'Médio equilibrado, tão útil a defender como a construir.',
  MO: 'Criativo entre linhas, procura sempre o passe decisivo.',
  PL: 'Avançado com faro de golo, ameaça constante perto da baliza.',
};
function specializationLabel(player, code) {
  return FOCUS_ROLE_LABELS[player.focus_role] || POSITION_GROUP_LABELS[code] || 'Jogador de Campo';
}
function specializationPhrase(player, code) {
  return FOCUS_ROLE_PHRASES[player.focus_role] || POSITION_GROUP_PHRASES[code] || '';
}

/* PERSONALITY_TIERS (db.PERSONALITY_TIERS): Muito Fiel / Fiel / Normal /
   Problemático / Muito Problemático — ver db/database.js. */
const PERSONALITY_PHRASES = {
  'Muito Fiel': 'É conhecido por ser extremamente leal e dedicado dentro do balneário.',
  'Fiel': 'Parece ser um profissional dedicado, sem problemas de atitude.',
  'Normal': 'Nada de especial a apontar fora de campo.',
  'Problemático': 'O olheiro alerta: já teve alguns episódios de atitude questionável.',
  'Muito Problemático': 'Aviso do olheiro: tem histórico de ser fonte de problemas no balneário.',
};

function buildScoutDescription(player, code) {
  const bits = [
    qualityPhrase(player.current_ability_stars ?? 2.5),
    specializationPhrase(player, code),
    PERSONALITY_PHRASES[player.personality] || PERSONALITY_PHRASES.Normal,
  ].filter(Boolean);
  return bits.join(' ');
}

function daysBetweenIsoDates(fromStr, toStr) {
  const [fy, fm, fd] = String(fromStr).split('-').map(Number);
  const [ty, tm, td] = String(toStr).split('-').map(Number);
  if (!fy || !ty) return 0;
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/* Encontra o melhor conjunto de candidatos para um clube, com o mesmo
   critério de preço/qualidade/necessidade usado em GET /recommendations —
   usado tanto ali como no runScoutTick abaixo, para as duas vias nunca
   discordarem sobre o que é "uma boa indicação". */
/* Aplica a tarefa definida pelo utilizador (idade mín/máx, posição,
   preço máximo — ver PUT /api/staff/:id/task) a um candidato. Qualquer
   campo em branco/null significa "sem restrição nessa dimensão". */
function matchesScoutTask(scout, player, code, value) {
  if (scout.task_position && scout.task_position !== code) return false;
  if (scout.task_max_price != null && value > scout.task_max_price) return false;
  if (scout.task_min_age != null || scout.task_max_age != null) {
    const age = ageFromBirthDate(player.birth_date);
    if (scout.task_min_age != null && age < scout.task_min_age) return false;
    if (scout.task_max_age != null && age > scout.task_max_age) return false;
  }
  return true;
}

function findScoutCandidates(team, scout, excludeIds) {
  const needs = computeSquadNeeds(team.id);
  const budget = team.transfer_budget || 0;
  const teamLevel = team.reputation_stars ?? 2.5;
  const scoutSharpness = 1 + ((scout.quality_stars ?? 2.5) - 2.5) * 0.08;

  const candidates = db.prepare(`
    SELECT p.*, t.name AS team_name, t.shield_path AS team_shield
    FROM players p
    JOIN teams t ON t.id = p.team_id
    WHERE p.team_id IS NOT NULL AND p.team_id != ? AND t.is_user_controlled = 0
      AND (p.transferred_in_window IS NULL OR p.transferred_in_window = 0)
  `).all(team.id);

  return candidates
    .filter((p) => !excludeIds.has(p.id))
    .map((p) => {
      const code = classifyPositionCode(p.position_code);
      const quality = p.current_ability_stars ?? 2.5;
      const value = Math.round(estimateMarketValue(p) * scoutSharpness);
      if (!matchesScoutTask(scout, p, code, value)) return null;
      /* Sem tarefa de preço definida, continua a respeitar o orçamento do
         clube como antes; com tarefa de preço definida, essa passa a ser
         o único teto (o utilizador pediu explicitamente esse limite). */
      if (scout.task_max_price == null && value > budget * 1.15) return null;
      if (quality < teamLevel - 1.4) return null;
      if (quality > teamLevel + 1.6) return null;

      const needScore = needs[code] ?? 0;
      const affordability = Math.max(0, 1 - value / (budget || 1));
      const fitScore = Number((quality * 0.5 + needScore * 3 + affordability * 1.5).toFixed(2));
      return { player: p, code, quality, value, fitScore, needScore };
    })
    .filter(Boolean)
    .sort((a, b) => b.fitScore - a.fitScore);
}

/* ---------- GET /api/scout/:teamId/recommendations ----------
   Devolve até 8 jogadores de outros clubes (geridos pelo jogo) que:
   - custam dentro (ou perto) do orçamento de transferências do clube;
   - têm um nível plausível para o clube (nem demasiado fracos para
     valerem a pena, nem claramente fora de alcance);
   - dão prioridade a posições onde o plantel está mais curto.
   Ordenados por um "fit_score" que combina qualidade, necessidade de
   posição e quão vantajoso é o preço face ao orçamento disponível. */
router.get('/:teamId/recommendations', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const scout = db.prepare("SELECT * FROM staff WHERE team_id = ? AND role = 'Olheiro'").get(team.id);
  if (!scout) {
    return res.json({ has_scout: false, market_open: db.isMarketWindowOpen(), scout_name: null, recommendations: [] });
  }

  const marketOpen = db.isMarketWindowOpen();
  if (!marketOpen) {
    return res.json({
      has_scout: true, market_open: false, scout_name: scout.name, scout_id: scout.id,
      task: {
        min_age: scout.task_min_age, max_age: scout.task_max_age,
        position: scout.task_position, max_price: scout.task_max_price,
      },
      recommendations: [],
    });
  }

  const scored = findScoutCandidates(team, scout, new Set()).map(({ player: p, code, quality, value, fitScore, needScore }) => ({
    player_id: p.id, name: p.name, photo_path: p.photo_path,
    position_tag: p.position_tag, position_code: p.position_code,
    team_id: p.team_id, team_name: p.team_name, team_shield: p.team_shield,
    current_ability_stars: quality, estimated_value: value, fit_score: fitScore,
    need_reason: needScore > 0.4 ? 'Posição em falta no plantel' : (needScore > 0 ? 'Reforça essa posição' : 'Boa oportunidade de qualidade'),
  }));

  res.json({
    has_scout: true, market_open: true, scout_name: scout.name, scout_id: scout.id,
    task: {
      min_age: scout.task_min_age, max_age: scout.task_max_age,
      position: scout.task_position, max_price: scout.task_max_price,
    },
    recommendations: scored.slice(0, 8),
  });
});

/* ---------- Indicações do olheiro na caixa de entrada ----------
   Chamado a partir do avanço diário (POST /api/game/advance — ver
   routes/game.js, ao lado de morale.runMoraleTick). Por cada clube com um
   Olheiro contratado, enquanto o mercado estiver aberto:
   1) Limpa indicações que já não fazem sentido (o jogador foi comprado
      por outro clube, passou demasiado tempo, ou já não está disponível).
   2) Com alguma probabilidade por dia, e só se ainda houver espaço (no
      máximo MAX_ACTIVE_TIPS_PER_TEAM ativas ao mesmo tempo), acrescenta
      uma indicação nova — nunca repete um jogador já indicado. */
const ACTIVE_TIP_TTL_DAYS = 14;
const MAX_ACTIVE_TIPS_PER_TEAM = 5;
const NEW_TIP_CHANCE = 0.22;

function runScoutTick(nextDateStr) {
  if (!db.isMarketWindowOpen()) return;

  const scouts = db.prepare("SELECT * FROM staff WHERE role = 'Olheiro' AND team_id IS NOT NULL").all();
  if (!scouts.length) return;

  scouts.forEach((scout) => {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(scout.team_id);
    if (!team) return;

    const activeTips = db.prepare(`
      SELECT id, player_id, created_at, extra_json FROM messages
      WHERE team_id = ? AND type = 'scout_tip'
    `).all(team.id);

    activeTips.forEach((tip) => {
      let report = {};
      try { report = (JSON.parse(tip.extra_json || '{}').scout_report) || {}; } catch { report = {}; }
      const player = tip.player_id ? db.prepare('SELECT team_id, transferred_in_window FROM players WHERE id = ?').get(tip.player_id) : null;
      const ageDays = daysBetweenIsoDates((tip.created_at || '').slice(0, 10), nextDateStr);

      const stillValid = player
        && player.team_id === report.origin_team_id
        && !player.transferred_in_window
        && ageDays < ACTIVE_TIP_TTL_DAYS;

      if (!stillValid) db.prepare('DELETE FROM messages WHERE id = ?').run(tip.id);
    });

    const remaining = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE team_id = ? AND type = 'scout_tip'").get(team.id).n;
    if (remaining >= MAX_ACTIVE_TIPS_PER_TEAM) return;
    if (Math.random() > NEW_TIP_CHANCE) return;

    const alreadyRecommendedIds = new Set(
      db.prepare("SELECT player_id FROM messages WHERE team_id = ? AND type = 'scout_tip' AND player_id IS NOT NULL")
        .all(team.id).map((r) => r.player_id)
    );

    const scored = findScoutCandidates(team, scout, alreadyRecommendedIds);
    if (!scored.length) return;

    // Não escolhe sempre o nº1 — dá alguma variedade escolhendo entre os melhores.
    const pick = scored[Math.floor(Math.random() * Math.min(3, scored.length))];
    const { player, code, quality, value } = pick;

    const report = {
      player_id: player.id, photo_path: player.photo_path, name: player.name,
      position_tag: player.position_tag, team_name: player.team_name, team_shield: player.team_shield,
      origin_team_id: player.team_id,
      quality_stars: quality, specialization: specializationLabel(player, code),
      personality: player.personality || 'Normal',
      estimated_value: value, description: buildScoutDescription(player, code),
    };

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, player_id, extra_json)
      VALUES (@team_id, 'scout_tip', @title, @body, @player_id, @extra_json)
    `).run({
      team_id: team.id,
      player_id: player.id,
      title: `🔎 O olheiro recomenda: ${player.name}`,
      body: report.description,
      extra_json: JSON.stringify({ scout_report: report }),
    });
  });
}

module.exports = router;
module.exports.runScoutTick = runScoutTick;