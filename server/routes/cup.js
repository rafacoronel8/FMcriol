/* ==========================================================
   FMcriol — Rotas da API para a Taça São Vicente
   Mata-mata a uma mão entre os 15 clubes da 1ª Divisão, que só arranca
   depois do último jogo do Campeonato. Ao contrário do Campeonato, o
   calendário da Taça NÃO é gerado de uma vez — cada ronda só existe depois
   de o treinador pedir o sorteio (POST /api/cup/draw), tal como pedido:
   "a cada rodada existirá um sorteio". Os jogos do clube do utilizador são
   resolvidos ao vivo, reaproveitando a máquina de "amigáveis" (ver is_cup
   em db/database.js), tal como já acontece com o Campeonato.

   Com 15 equipas, a Ronda 1 tem sempre um "bye" (a equipa sorteada para o
   bye passa à ronda seguinte sem jogar), reduzindo o número de equipas a
   uma potência de 2 (8) já a partir dos Quartos de Final.
   ========================================================== */
const express = require('express');
const db = require('../db/database');
const { simulateCompetitionMatchStats, getCompetitionLeaders } = require('./competitionStats');

const router = express.Router();

const ROUND_NAMES = {
  1: 'Primeira Eliminatória',
  2: 'Quartos de Final',
  3: 'Meias-Finais',
  4: 'Final',
};
const DRAW_TO_MATCH_GAP_DAYS = 7;

function addDaysToIsoDate(isoDateStr, days) {
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function currentGameDate() {
  return db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get().current_date;
}

/* A Taça só existe depois de o Campeonato estar todo disputado — a divisão
   usada é sempre a do clube do utilizador (na prática só existe a 1ª). */
function isLeagueFinished(division) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN status != 'played' THEN 1 ELSE 0 END) AS pending
    FROM league_fixtures
    WHERE home_team_id IN (SELECT id FROM teams WHERE division = ?)
  `).get(division);
  return Boolean(row.total) && !row.pending;
}

/* ---------- Estado atual da Taça ----------
   Devolve sempre um destes formatos:
   - { status: 'locked' }                                              — Campeonato por acabar
   - { status: 'ready_to_draw', round, round_name, pool: [teams] }      — pronta para sortear
   - { status: 'round_in_progress', round, round_name }                 — ronda a decorrer
   - { status: 'finished', champion: team }                             — Taça vencida */
function getCupState(division) {
  if (!isLeagueFinished(division)) return { status: 'locked' };

  const divisionTeams = db.prepare('SELECT id, name, shield_path, reputation_stars FROM teams WHERE division = ?').all(division);
  const maxRoundRow = db.prepare('SELECT MAX(round) AS r FROM cup_fixtures').get();
  const maxRound = maxRoundRow.r;

  if (!maxRound) {
    return { status: 'ready_to_draw', round: 1, round_name: ROUND_NAMES[1], pool: divisionTeams };
  }

  const roundFixtures = db.prepare('SELECT * FROM cup_fixtures WHERE round = ?').all(maxRound);
  const unresolved = roundFixtures.some((f) => f.status !== 'played');
  if (unresolved) {
    return { status: 'round_in_progress', round: maxRound, round_name: ROUND_NAMES[maxRound] };
  }

  const winnerIds = roundFixtures.map((f) => f.winner_team_id).filter(Boolean);
  if (winnerIds.length <= 1) {
    const champion = divisionTeams.find((t) => t.id === winnerIds[0]);
    return { status: 'finished', champion, round: maxRound, round_name: ROUND_NAMES[maxRound] };
  }

  const nextRound = maxRound + 1;
  const pool = winnerIds.map((id) => divisionTeams.find((t) => t.id === id)).filter(Boolean);
  return { status: 'ready_to_draw', round: nextRound, round_name: ROUND_NAMES[nextRound] || `Ronda ${nextRound}`, pool };
}

/* ---------- POST /api/cup/draw — sorteia a próxima ronda ----------
   Devolve os confrontos pela ORDEM em que devem ser "puxados" na animação
   das bolinhas no frontend (o bye, se existir, sai primeiro). */
router.post('/draw', (req, res) => {
  const userTeam = db.prepare('SELECT * FROM teams WHERE is_user_controlled = 1').get();
  if (!userTeam) return res.status(400).json({ error: 'Nenhum clube selecionado' });

  const state = getCupState(userTeam.division);
  if (state.status !== 'ready_to_draw') {
    return res.status(409).json({ error: 'A Taça não está pronta para sortear agora.' });
  }

  const today = currentGameDate();
  const matchDate = addDaysToIsoDate(today, DRAW_TO_MATCH_GAP_DAYS);
  const pool = shuffle(state.pool);
  const reveal = [];

  const insertMatch = db.prepare(`
    INSERT INTO cup_fixtures (round, round_name, home_team_id, away_team_id, match_date, status)
    VALUES (@round, @round_name, @home_team_id, @away_team_id, @match_date, 'scheduled')
  `);
  const insertBye = db.prepare(`
    INSERT INTO cup_fixtures (round, round_name, home_team_id, away_team_id, is_bye, match_date, status, winner_team_id)
    VALUES (@round, @round_name, @home_team_id, NULL, 1, @match_date, 'played', @home_team_id)
  `);

  const runDraw = db.transaction(() => {
    let working = pool;
    if (working.length % 2 !== 0) {
      const byeIndex = Math.floor(Math.random() * working.length);
      const byeTeam = working[byeIndex];
      working = working.filter((_, i) => i !== byeIndex);
      insertBye.run({ round: state.round, round_name: state.round_name, home_team_id: byeTeam.id, match_date: today });
      reveal.push({ type: 'bye', team: byeTeam });
    }

    for (let i = 0; i < working.length; i += 2) {
      const home = working[i];
      const away = working[i + 1];
      insertMatch.run({
        round: state.round, round_name: state.round_name,
        home_team_id: home.id, away_team_id: away.id, match_date: matchDate,
      });
      reveal.push({ type: 'match', home, away });
    }
  });
  runDraw();

  res.json({ round: state.round, round_name: state.round_name, match_date: matchDate, reveal });
});

/* ---------- GET /api/cup/:teamId — estado da Taça + histórico de rondas ---------- */
router.get('/:teamId', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const state = getCupState(team.division);

  const fixtures = db.prepare(`
    SELECT cf.*,
           h.name AS home_name, h.shield_path AS home_shield,
           a.name AS away_name, a.shield_path AS away_shield,
           w.name AS winner_name
    FROM cup_fixtures cf
    JOIN teams h ON h.id = cf.home_team_id
    LEFT JOIN teams a ON a.id = cf.away_team_id
    LEFT JOIN teams w ON w.id = cf.winner_team_id
    WHERE h.division = ?
    ORDER BY cf.round ASC, cf.id ASC
  `).all(team.division);

  const rounds = {};
  fixtures.forEach((f) => {
    if (!rounds[f.round]) rounds[f.round] = { round: f.round, round_name: f.round_name, fixtures: [] };
    rounds[f.round].fixtures.push(f);
  });

  const divisionTeamIds = db.prepare('SELECT id FROM teams WHERE division = ?').all(team.division).map((t) => t.id);
  const leaders = getCompetitionLeaders('cup', divisionTeamIds);

  res.json({
    ...state,
    my_team_id: team.id,
    rounds: Object.values(rounds),
    leaders,
  });
});

module.exports = router;
module.exports.getCupState = getCupState;
module.exports.currentGameDate = currentGameDate;

/* ---------- Avança a Taça ao chegar a uma nova data ----------
   Chamado a partir de POST /api/game/advance (routes/game.js), no mesmo
   sítio que o Campeonato — antes de runFriendliesTick, para que um jogo de
   hoje que envolva o utilizador já exista como "amigável" a tempo de essa
   função o deixar de fora (fica para ser assistido ao vivo). Ao contrário
   do Campeonato, a Taça NÃO pode terminar empatada: quando nenhuma das
   equipas é o utilizador, um empate ao fim do "jogo" é logo aqui decidido
   por desempate (ver também syncCupFixtureFromFriendly, usado quando é o
   utilizador a jogar). */
function simulateCupGoals(attackReputation, defendReputation) {
  const lambda = Math.max(0.35, 1.15 + (attackReputation - defendReputation) * 0.3);
  let goals = 0;
  for (let i = 0; i < 8; i += 1) {
    if (Math.random() < lambda / (i + 1.7)) goals += 1;
  }
  return Math.min(goals, 7);
}

/* Ver equivalente em routes/league.js — "Patrão" reduz golos sofridos,
   só nos jogos simulados automaticamente. */
function teamHasPatrao(teamId) {
  return Boolean(db.prepare("SELECT 1 FROM players WHERE team_id = ? AND focus_role = 'Patrão' LIMIT 1").get(teamId));
}

function runCupTick(nextDateStr) {
  const due = db.prepare(`
    SELECT cf.*,
           h.name AS home_name, h.reputation_stars AS home_reputation, h.is_user_controlled AS home_user,
           a.name AS away_name, a.reputation_stars AS away_reputation, a.is_user_controlled AS away_user
    FROM cup_fixtures cf
    JOIN teams h ON h.id = cf.home_team_id
    JOIN teams a ON a.id = cf.away_team_id
    WHERE cf.status = 'scheduled' AND cf.is_bye = 0 AND cf.match_date <= ?
  `).all(nextDateStr);

  const results = [];

  due.forEach((f) => {
    if (f.home_user || f.away_user) {
      const info = db.prepare(`
        INSERT INTO club_friendlies (home_team_id, away_team_id, requested_by_team_id, match_date, status, is_cup)
        VALUES (@home_team_id, @away_team_id, @requested_by_team_id, @match_date, 'accepted', 1)
      `).run({
        home_team_id: f.home_team_id,
        away_team_id: f.away_team_id,
        requested_by_team_id: f.home_team_id,
        match_date: f.match_date,
      });
      db.prepare("UPDATE cup_fixtures SET status = 'linked', friendly_id = ? WHERE id = ?")
        .run(info.lastInsertRowid, f.id);
      return;
    }

    const homeDefBonus = teamHasPatrao(f.home_team_id) ? 0.3 : 0;
    const awayDefBonus = teamHasPatrao(f.away_team_id) ? 0.3 : 0;
    const homeGoals = simulateCupGoals(f.home_reputation + 0.15, f.away_reputation + awayDefBonus);
    const awayGoals = simulateCupGoals(f.away_reputation, f.home_reputation + 0.15 + homeDefBonus);

    let winnerId;
    let decidedByPenalties = 0;
    if (homeGoals > awayGoals) winnerId = f.home_team_id;
    else if (awayGoals > homeGoals) winnerId = f.away_team_id;
    else {
      decidedByPenalties = 1;
      const homeChance = 0.5 + (f.home_reputation - f.away_reputation) * 0.04;
      winnerId = Math.random() < Math.max(0.25, Math.min(0.75, homeChance)) ? f.home_team_id : f.away_team_id;
    }

    db.prepare(`
      UPDATE cup_fixtures SET status = 'played', home_score = ?, away_score = ?,
        winner_team_id = ?, decided_by_penalties = ?
      WHERE id = ?
    `).run(homeGoals, awayGoals, winnerId, decidedByPenalties, f.id);

    /* Mesma ideia do Campeonato — ver routes/competitionStats.js. */
    simulateCompetitionMatchStats('cup', f.home_team_id, f.away_team_id, homeGoals, awayGoals);

    results.push({
      round: f.round, home_team: f.home_name, away_team: f.away_name,
      home_score: homeGoals, away_score: awayGoals, decided_by_penalties: decidedByPenalties,
    });
  });

  return results;
}

module.exports.runCupTick = runCupTick;