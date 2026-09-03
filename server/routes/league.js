/* ==========================================================
   FMcriol — Rotas da API para o Campeonato
   Gera o calendário oficial (round-robin a duas voltas, uma jornada por
   semana) a começar sempre a 1 de agosto — logo depois de fechar o mês de
   mercado/pré-época (ver MARKET_WINDOW_MONTH em db/database.js). Os jogos
   do clube do utilizador são resolvidos ao vivo, reaproveitando toda a
   máquina de "amigáveis" já existente (ver is_league em db/database.js);
   os restantes são simulados automaticamente assim que o calendário lhes
   chega, tal como já acontece com os amigáveis entre equipas geridas pelo
   jogo. A tabela classificativa é sempre calculada em tempo real a partir
   de league_fixtures — não há nenhuma tabela de classificação separada
   para manter sincronizada.
   ========================================================== */
const express = require('express');
const db = require('../db/database');
const { simulateCompetitionMatchStats, getCompetitionLeaders } = require('./competitionStats');
const players = require('./players');

const router = express.Router();

/* O campeonato começa sempre no dia seguinte ao fim do mercado de
   pré-época (ver MARKET_WINDOW_MONTH em db/database.js). Ao contrário de
   antes, isto já não é uma data fixa — cada época começa a 1 de agosto do
   ANO em que estivermos, e reinicia sozinha todos os anos (ver
   runSeasonRolloverIfDue mais abaixo). A data de início da época em curso
   fica guardada em game_state.current_season_start. */
const MATCHDAY_INTERVAL_DAYS = 7;

function getCurrentSeasonStart() {
  const row = db.prepare('SELECT current_season_start FROM game_state WHERE id = 1').get();
  return (row && row.current_season_start) || '2026-08-01';
}
function preseasonWindowFor(seasonStart) {
  const year = Number(seasonStart.slice(0, 4));
  return { start: `${year}-07-01`, end: `${year}-07-31` };
}
function seasonLabelFor(seasonStart) {
  const year = Number(seasonStart.slice(0, 4));
  return `${year}/${year + 1}`;
}
function nextAugustFirst(seasonStart) {
  const year = Number(seasonStart.slice(0, 4));
  return `${year + 1}-08-01`;
}

/* Data fixa em que os prémios monetários de fim de época do Campeonato
   (Campeão + último classificado, ver awardLeagueSeasonPrizeMoneyIfDue
   mais abaixo) são pagos — sempre 1 de Junho do ano em que a época em
   curso termina, independentemente de quando a última jornada foi mesmo
   jogada. */
function juneFirstOfSeason(seasonStart) {
  const year = Number(seasonStart.slice(0, 4));
  return `${year + 1}-06-01`;
}

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

/* ---------- Round-robin (método do círculo) ----------
   Devolve uma lista de rondas; cada ronda é uma lista de pares
   [homeTeamId, awayTeamId]. Com um número ímpar de equipas, junta uma
   equipa "fantasma" (null) — quem calha com ela descansa nessa ronda. */
function buildSingleRoundRobin(teamIds) {
  const teams = [...teamIds];
  if (teams.length % 2 !== 0) teams.push(null);
  const n = teams.length;
  const rounds = n - 1;
  const half = n / 2;
  let arr = teams.slice();
  const out = [];

  for (let r = 0; r < rounds; r += 1) {
    const pairs = [];
    for (let i = 0; i < half; i += 1) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== null && b !== null) {
        // Alterna quem joga em casa a cada ronda, para não ficar sempre o
        // mesmo lado da lista com a vantagem de jogar em casa.
        pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
      }
    }
    out.push(pairs);

    // Roda todas as posições exceto a primeira (método do círculo).
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }
  return out;
}

/* ---------- Gera o calendário completo da época (todas as divisões) ----------
   Chamado sempre que um save recomeça do zero (POST /api/game/reset) e, de
   forma preguiçosa, na primeira vez que alguma rota do Campeonato é pedida
   num save que ainda não tenha calendário (ex: bases de dados já em uso
   antes desta funcionalidade existir). Cada divisão joga o seu próprio
   campeonato à parte, mas todas partilham as mesmas datas de jornada. */
function regenerateSeasonFixtures(seasonStart) {
  const start = seasonStart || getCurrentSeasonStart();
  db.prepare('DELETE FROM league_fixtures').run();

  const teams = db.prepare('SELECT id, division FROM teams').all();
  const byDivision = new Map();
  teams.forEach((t) => {
    if (!byDivision.has(t.division)) byDivision.set(t.division, []);
    byDivision.get(t.division).push(t.id);
  });

  const insert = db.prepare(`
    INSERT INTO league_fixtures (round, home_team_id, away_team_id, match_date, status)
    VALUES (@round, @home_team_id, @away_team_id, @match_date, 'scheduled')
  `);

  const insertAll = db.transaction(() => {
    byDivision.forEach((teamIds) => {
      if (teamIds.length < 2) return;

      const shuffled = shuffle(teamIds);
      const firstLeg = buildSingleRoundRobin(shuffled);
      // Segunda volta: os mesmos confrontos, casa/fora trocados.
      const secondLeg = firstLeg.map((pairs) => pairs.map(([home, away]) => [away, home]));
      const allRounds = [...firstLeg, ...secondLeg];

      allRounds.forEach((pairs, roundIndex) => {
        const matchDate = addDaysToIsoDate(start, roundIndex * MATCHDAY_INTERVAL_DAYS);
        pairs.forEach(([homeId, awayId]) => {
          insert.run({ round: roundIndex + 1, home_team_id: homeId, away_team_id: awayId, match_date: matchDate });
        });
      });
    });
  });
  insertAll();
}

function ensureSeasonFixtures() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM league_fixtures').get().c;
  if (count === 0) regenerateSeasonFixtures();
}

/* ---------- Simulação do resultado para jogos sem o clube do utilizador ----------
   Mesmo critério usado nos amigáveis (reputação de cada equipa + vantagem
   de jogar em casa) — o Campeonato não precisa de ser mais sofisticado do
   que isso para as equipas geridas pelo computador; o que importa aqui é a
   tabela classificativa ficar coerente ao longo da época. */
function simulateLeagueGoals(attackReputation, defendReputation) {
  const lambda = Math.max(0.35, 1.15 + (attackReputation - defendReputation) * 0.3);
  let goals = 0;
  for (let i = 0; i < 8; i += 1) {
    if (Math.random() < lambda / (i + 1.7)) goals += 1;
  }
  return Math.min(goals, 7);
}

/* Um "Patrão" (especialização escolhida no perfil do jogador — ver
   focus_role em db/database.js) ajuda a equipa a sofrer menos golos.
   Só se aplica aqui, em jogos simulados automaticamente entre equipas
   geridas pelo jogo — jogos ao vivo (routes/liveMatch.js) usam o motor
   minuto a minuto, sem este ajuste. */
function teamHasPatrao(teamId) {
  return Boolean(db.prepare("SELECT 1 FROM players WHERE team_id = ? AND focus_role = 'Patrão' LIMIT 1").get(teamId));
}

/* ---------- Prémios individuais da época (Campeonato + Taça combinados) ----------
   Precisa de pelo menos 3 jogos disputados para concorrer aos prémios
   baseados em média (Melhor Jogador/Defesa/Guarda-Redes) — evita que um
   jogador com um único jogo brilhante leve o prémio. Marcador e
   Assistências são sempre pelo total acumulado, sem mínimo. */
function classifyForAwards(code) {
  const c = String(code || '').split('/')[0].trim().toUpperCase();
  if (c === 'GR') return 'GR';
  if (['DD', 'DE', 'DC', 'L'].includes(c)) return 'DEF';
  return 'OTHER';
}

function assignSeasonAwards(teamIds, seasonLabel, wonDate) {
  if (!teamIds.length) return;
  const placeholders = teamIds.map(() => '?').join(',');

  /* Proteção contra duplicados — mesma ideia de creditPlayerTrophy acima:
     se esta função for chamada mais que uma vez para a mesma época (o
     sintoma real que motivou esta correção: "Melhor Marcador da Taça"
     aparecia várias vezes com datas seguidas mas a mesma época), cada
     prémio só pode ser atribuído UMA VEZ por award_key + época. */
  const alreadyAwardedKeys = new Set(
    db.prepare(`SELECT DISTINCT award_key FROM player_awards WHERE team_id IN (${placeholders}) AND season_label = ?`)
      .all(...teamIds, seasonLabel)
      .map((r) => r.award_key)
  );

  const rows = db.prepare(`
    SELECT fps.player_id, fps.team_id, p.name AS player_name, p.position_code,
      SUM(fps.goals) AS goals, SUM(fps.assists) AS assists,
      AVG(fps.rating) AS avg_rating, COUNT(*) AS games
    FROM friendly_player_stats fps
    JOIN players p ON p.id = fps.player_id
    WHERE fps.competition IN ('league','cup') AND fps.player_id IS NOT NULL AND fps.team_id IN (${placeholders})
    GROUP BY fps.player_id
  `).all(...teamIds);
  if (!rows.length) return;

  const eligible = rows.filter((r) => r.games >= 3);
  const insertAward = db.prepare(`
    INSERT INTO player_awards (player_id, team_id, award_key, season_label, won_date)
    VALUES (@player_id, @team_id, @award_key, @season_label, @won_date)
  `);
  const award = (key, candidate) => {
    if (!candidate || alreadyAwardedKeys.has(key)) return;
    insertAward.run({ player_id: candidate.player_id, team_id: candidate.team_id, award_key: key, season_label: seasonLabel, won_date: wonDate });
  };

  const topScorer = [...rows].sort((a, b) => b.goals - a.goals)[0];
  award('top_scorer', topScorer.goals > 0 ? topScorer : null);

  const topAssist = [...rows].sort((a, b) => b.assists - a.assists)[0];
  award('best_assist', topAssist.assists > 0 ? topAssist : null);

  award('best_player', [...eligible].sort((a, b) => b.avg_rating - a.avg_rating)[0]);
  award('best_defender', [...eligible].filter((r) => classifyForAwards(r.position_code) === 'DEF').sort((a, b) => b.avg_rating - a.avg_rating)[0]);
  award('best_goalkeeper', [...eligible].filter((r) => classifyForAwards(r.position_code) === 'GR').sort((a, b) => b.avg_rating - a.avg_rating)[0]);

  /* ---------- Prémios só da Taça São Vicente ----------
     Mesma ideia dos prémios combinados acima, mas usando só estatísticas
     de jogos da Taça (competition = 'cup') — para equipas eliminadas cedo,
     ou em épocas em que a Taça nem chegou a terminar antes do 1 de agosto,
     simplesmente não há dados suficientes e o prémio não é atribuído. */
  const cupRows = db.prepare(`
    SELECT fps.player_id, fps.team_id, p.name AS player_name, p.position_code,
      SUM(fps.goals) AS goals, SUM(fps.assists) AS assists,
      AVG(fps.rating) AS avg_rating, COUNT(*) AS games
    FROM friendly_player_stats fps
    JOIN players p ON p.id = fps.player_id
    WHERE fps.competition = 'cup' AND fps.player_id IS NOT NULL AND fps.team_id IN (${placeholders})
    GROUP BY fps.player_id
  `).all(...teamIds);

  if (cupRows.length) {
    const cupTopScorer = [...cupRows].sort((a, b) => b.goals - a.goals)[0];
    award('cup_top_scorer', cupTopScorer.goals > 0 ? cupTopScorer : null);

    const cupTopAssist = [...cupRows].sort((a, b) => b.assists - a.assists)[0];
    award('cup_best_assist', cupTopAssist.assists > 0 ? cupTopAssist : null);

    const cupBestDefender = [...cupRows]
      .filter((r) => classifyForAwards(r.position_code) === 'DEF')
      .sort((a, b) => b.avg_rating - a.avg_rating)[0];
    award('cup_best_defender', cupBestDefender);
  }
}

/* ---------- "11 do Ano" — Gala de fim de época ----------
   Escolhido a partir das mesmas estatísticas combinadas de Campeonato +
   Taça já usadas acima para os prémios individuais (mínimo de 5 jogos),
   mas classificando os jogadores por posição (cópia deliberada de
   classifyPositionCode — ver routes/competitionStats.js, mesma lógica,
   mantida separada de propósito) para preencher uma formação 4-3-3 fixa:
   1 guarda-redes, 4 defesas, 3 médios, 3 atacantes (extremos + ponta de
   lança juntos) — os de melhor nota média da época em cada grupo, de
   QUALQUER equipa da divisão, não só do clube do utilizador. Fica
   guardado em player_awards como qualquer outro prémio (best_xi_gr,
   best_xi_def_1..4, best_xi_med_1..3, best_xi_ata_1..3), para a Gala (ver
   GET /season-gala/:teamId) poder ler os prémios da época tal como a
   cerimónia de prémios individuais já faz. */
function classifyForBestXI(code) {
  const c = String(code || '').split('/')[0].trim().toUpperCase();
  if (c === 'GR') return 'GR';
  if (['PL', 'AD', 'AE', 'ED', 'EE'].includes(c)) return 'ATA';
  if (['MCO', 'MOD', 'MOE'].includes(c)) return 'ATA';
  if (c.startsWith('M')) return 'MED';
  return 'DEF';
}
const BEST_XI_SLOTS = { GR: 1, DEF: 4, MED: 3, ATA: 3 };

function assignBestXI(teamIds, seasonLabel, wonDate) {
  if (!teamIds.length) return;
  const placeholders = teamIds.map(() => '?').join(',');

  /* Mesma proteção contra duplicados de assignSeasonAwards — o "Onze do
     Ano" só pode ser escolhido UMA VEZ por época. */
  const alreadyAssigned = db.prepare(`
    SELECT 1 FROM player_awards WHERE team_id IN (${placeholders}) AND season_label = ? AND award_key LIKE 'best_xi_%' LIMIT 1
  `).get(...teamIds, seasonLabel);
  if (alreadyAssigned) return;

  const rows = db.prepare(`
    SELECT fps.player_id, fps.team_id, p.position_code,
      AVG(fps.rating) AS avg_rating, COUNT(*) AS games
    FROM friendly_player_stats fps
    JOIN players p ON p.id = fps.player_id
    WHERE fps.competition IN ('league','cup') AND fps.player_id IS NOT NULL AND fps.team_id IN (${placeholders})
    GROUP BY fps.player_id
    HAVING games >= 5
  `).all(...teamIds);
  if (!rows.length) return;

  const insertAward = db.prepare(`
    INSERT INTO player_awards (player_id, team_id, award_key, season_label, won_date)
    VALUES (@player_id, @team_id, @award_key, @season_label, @won_date)
  `);

  Object.entries(BEST_XI_SLOTS).forEach(([group, slots]) => {
    const pool = rows
      .filter((r) => classifyForBestXI(r.position_code) === group)
      .sort((a, b) => b.avg_rating - a.avg_rating);
    pool.slice(0, slots).forEach((r, i) => {
      const key = slots === 1 ? `best_xi_${group.toLowerCase()}` : `best_xi_${group.toLowerCase()}_${i + 1}`;
      insertAward.run({ player_id: r.player_id, team_id: r.team_id, award_key: key, season_label: seasonLabel, won_date: wonDate });
    });
  });
}

/* ---------- Crédito de título coletivo aos jogadores do plantel ----------
   Chamado sempre que um troféu (Campeonato ou Taça) é atribuído a uma
   equipa em runSeasonRolloverIfDue — regista em player_trophies, para
   CADA jogador atualmente no plantel dessa equipa, que ele fez parte do
   título. Alimenta a secção "Títulos Coletivos" da aba Carreira do perfil
   do jogador (ver GET /api/players/:id em routes/players.js).

   Proteção contra duplicados: se por algum motivo runSeasonRolloverIfDue
   for chamada mais que uma vez para a mesma época (ex: dois avanços de dia
   muito próximos), sem isto cada jogador do plantel campeão ficava com o
   MESMO título coletivo repetido no perfil, tantas vezes quantas as
   chamadas a mais — dá para ver isto a acontecer com "Campeão da Taça São
   Vicente" repetido várias vezes com datas seguidas mas a mesma época. */
function creditPlayerTrophy(teamId, competition, seasonLabel, wonDate) {
  const team = db.prepare('SELECT name, shield_path FROM teams WHERE id = ?').get(teamId);
  const roster = db.prepare('SELECT id FROM players WHERE team_id = ?').all(teamId);
  const insertTrophy = db.prepare(`
    INSERT INTO player_trophies (player_id, team_id, team_name, team_shield, competition, season_label, won_date)
    VALUES (@player_id, @team_id, @team_name, @team_shield, @competition, @season_label, @won_date)
  `);
  const alreadyCredited = db.prepare(`
    SELECT player_id FROM player_trophies WHERE team_id = ? AND competition = ? AND season_label = ?
  `).all(teamId, competition, seasonLabel).map((r) => r.player_id);
  const alreadyCreditedSet = new Set(alreadyCredited);

  roster.forEach((pl) => {
    if (alreadyCreditedSet.has(pl.id)) return;
    insertTrophy.run({
      player_id: pl.id, team_id: teamId,
      team_name: team ? team.name : null, team_shield: team ? team.shield_path : null,
      competition, season_label: seasonLabel, won_date: wonDate,
    });
  });
}

/* ---------- Reinício automático da época ----------
   Chamado no início de todos os dias (ver runLeagueTick). Assim que o
   calendário chega ao 1 de agosto SEGUINTE ao início da época em curso:
   atribui o troféu do Campeonato (e da Taça, se já tiver terminado) a
   quem os ganhou, entrega os 5 prémios individuais com base nas
   estatísticas combinadas de Campeonato + Taça, limpa tudo (calendários e
   estatísticas da época que terminou) e gera logo a seguir o Campeonato
   novo. A Taça (routes/cup.js) não precisa de nenhum aviso especial — ao
   ver league_fixtures vazio outra vez, fica automaticamente "trancada"
   até este novo Campeonato também terminar. */
/* ---------- Evolução de jogadores no fim da época ----------
   Quem tiver uma grande época (média de classificação alta, com jogos
   suficientes para não ser sorte de um jogo só) evolui: sobe de nível
   (current_ability_stars, nunca além do potencial) e alguns atributos
   individuais sobem também — só jogadores com menos de 32 anos, que já
   não têm margem de progressão realista depois disso. Quem tem mesmo uma
   época de destaque fica com breakout_season=1, o que lhe dá bastante mais
   atenção de clubes mais fortes no scouting da próxima janela de mercado
   (ver runAiScoutingTick em routes/game.js) — reposto a 0 no início desta
   função, para só refletir sempre a época que acabou de terminar. */
const GROWTH_MIN_GAMES = 8;
const GROWTH_RATING_THRESHOLD = 6.9;
const GROWTH_STANDOUT_RATING = 7.6;
const GROWTH_MAX_AGE = 32;

function ageFromBirthDateOn(birthDateStr, todayStr) {
  if (!birthDateStr || !todayStr) return null;
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const [by, bm, bd] = String(birthDateStr).slice(0, 10).split('-').map(Number);
  if (!by) return null;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

function seasonGamesAndRating(seasonStatsJson) {
  let rows = [];
  try { rows = JSON.parse(seasonStatsJson || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) return { games: 0, avgRating: 0 };
  let games = 0;
  let weightedRating = 0;
  rows.forEach((r) => {
    const j = Number(r.j) || 0;
    games += j;
    const media = parseFloat(r.media);
    if (Number.isFinite(media) && j) weightedRating += media * j;
  });
  return { games, avgRating: games ? weightedRating / games : 0 };
}

/* Sobe `count` atributos escolhidos ao calhas dentro de uma lista
   [[nome, valor], ...] em `amount` (1-20, arredondado a 1 casa) — mesma
   ideia de bumpAttributes em routes/activities.js, mas sem alvos fixos
   (aqui o desenvolvimento é geral, não ligado a um tipo de treino). Listas
   vazias (ex: goalkeeping_json de um jogador de campo) ficam intocadas. */
function bumpRandomAttrs(jsonText, count, amount) {
  let list;
  try { list = JSON.parse(jsonText || '[]'); } catch { list = []; }
  if (!Array.isArray(list) || !list.length) return jsonText;
  const indexSet = new Set([...list.keys()].sort(() => Math.random() - 0.5).slice(0, count));
  const updated = list.map(([name, value], i) => {
    if (!indexSet.has(i)) return [name, value];
    const next = Math.max(1, Math.min(20, Number((Number(value || 0) + amount).toFixed(1))));
    return [name, next];
  });
  return JSON.stringify(updated);
}

function runPlayerDevelopmentForSeason(seasonLabel, wonDate) {
  /* Repõe o destaque da época anterior antes de recalcular — só quem teve
     uma grande época AGORA é que deve continuar a chamar a atenção. */
  db.prepare('UPDATE players SET breakout_season = 0').run();

  const players = db.prepare(`
    SELECT id, team_id, name, birth_date, season_stats_json, current_ability_stars, potential_ability_stars,
           technical_json, set_pieces_json, mental_json, physical_json, goalkeeping_json
    FROM players WHERE team_id IS NOT NULL
  `).all();

  const updatePlayer = db.prepare(`
    UPDATE players SET
      current_ability_stars = @current_ability_stars,
      technical_json = @technical_json, set_pieces_json = @set_pieces_json,
      mental_json = @mental_json, physical_json = @physical_json, goalkeeping_json = @goalkeeping_json,
      breakout_season = @breakout_season, updated_at = datetime('now')
    WHERE id = @id
  `);

  const developed = [];

  players.forEach((p) => {
    const age = ageFromBirthDateOn(p.birth_date, wonDate);
    if (age == null || age >= GROWTH_MAX_AGE) return;

    const { games, avgRating } = seasonGamesAndRating(p.season_stats_json);
    if (games < GROWTH_MIN_GAMES || avgRating < GROWTH_RATING_THRESHOLD) return;

    const potential = p.potential_ability_stars ?? p.current_ability_stars ?? 2.5;
    const current = p.current_ability_stars ?? 2.5;
    if (current >= potential) return;

    const isStandout = avgRating >= GROWTH_STANDOUT_RATING;
    const starBump = isStandout ? (0.15 + Math.random() * 0.15) : (0.05 + Math.random() * 0.1);
    const nextStars = Math.min(potential, Number((current + starBump).toFixed(2)));
    const attrAmount = isStandout ? (0.8 + Math.random() * 0.6) : (0.4 + Math.random() * 0.4);
    const attrCount = isStandout ? 3 : 2;

    updatePlayer.run({
      id: p.id,
      current_ability_stars: nextStars,
      technical_json: bumpRandomAttrs(p.technical_json, attrCount, attrAmount),
      set_pieces_json: bumpRandomAttrs(p.set_pieces_json, Math.max(1, Math.floor(attrCount / 2)), attrAmount),
      mental_json: bumpRandomAttrs(p.mental_json, attrCount, attrAmount),
      physical_json: bumpRandomAttrs(p.physical_json, Math.max(1, Math.floor(attrCount / 2)), attrAmount),
      goalkeeping_json: bumpRandomAttrs(p.goalkeeping_json, attrCount, attrAmount),
      breakout_season: isStandout ? 1 : 0,
    });

    developed.push({ id: p.id, team_id: p.team_id, name: p.name, isStandout });
  });

  return developed;
}

/* ---------- Reputação evolui com o plantel ----------
   Sem isto, a reputação de cada clube era fixa desde o início do jogo para
   sempre — o mesmo favorito ganhava sempre o Campeonato, porque as equipas
   geridas pelo jogo nunca ficavam mais fortes nem mais fracas de verdade,
   por muito que se reforçassem no mercado. No fim de cada época, a
   reputação ajusta-se GRADUALMENTE (nunca de repente, para não dar saltos
   estranhos) na direção da qualidade real do plantel (média das estrelas
   dos prováveis titulares) mais um bónus por títulos ganhos essa época —
   assim uma equipa que invista bem no mercado e desenvolva jogadores vai
   mesmo subindo ao longo de várias épocas e tornando-se concorrente a
   títulos, tal como pedido. */
function updateTeamReputations(seasonLabel) {
  const teams = db.prepare('SELECT id, reputation_stars FROM teams').all();
  const updateRep = db.prepare("UPDATE teams SET reputation_stars = ?, updated_at = datetime('now') WHERE id = ?");

  teams.forEach((team) => {
    const squad = db.prepare('SELECT current_ability_stars FROM players WHERE team_id = ?').all(team.id);
    if (!squad.length) return;

    const startingXI = squad.map((p) => p.current_ability_stars ?? 2.5).sort((a, b) => b - a).slice(0, 11);
    const squadQuality = startingXI.reduce((sum, v) => sum + v, 0) / startingXI.length;

    const wonLeague = db.prepare("SELECT 1 FROM trophies WHERE team_id = ? AND competition = 'league' AND season_label = ?").get(team.id, seasonLabel);
    const wonCup = db.prepare("SELECT 1 FROM trophies WHERE team_id = ? AND competition = 'cup' AND season_label = ?").get(team.id, seasonLabel);
    const trophyBonus = (wonLeague ? 0.25 : 0) + (wonCup ? 0.1 : 0);

    const target = Math.max(0.5, Math.min(5, squadQuality + trophyBonus));
    const current = team.reputation_stars ?? 2.5;
    const blended = current * 0.75 + target * 0.25; // ajuste gradual — nunca de repente
    const rounded = Math.round(Math.max(0.5, Math.min(5, blended)) * 2) / 2; // arredondado a 0.5 estrelas

    if (rounded !== current) updateRep.run(rounded, team.id);
  });
}

function runSeasonRolloverIfDue(nextDateStr) {
  const seasonStart = getCurrentSeasonStart();
  const rolloverDate = nextAugustFirst(seasonStart);
  if (nextDateStr < rolloverDate) return;

  /* Proteção extra contra reentrância — se por algum motivo esta função
     for chamada mais que uma vez depois de current_season_start já ter
     avançado (ex: dois avanços de dia muito próximos, ou um pedido
     repetido), regenerateSeasonFixtures(rolloverDate) mais abaixo já terá
     criado jornadas do Campeonato com match_date a partir de rolloverDate
     — encontrar alguma é sinal de que esta época já rolou e não deve
     voltar a apagar/gerar tudo outra vez (o que também duplicaria
     troféus, prémios e o arquivo de carreira). */
  const alreadyRolledOver = db.prepare('SELECT 1 FROM league_fixtures WHERE match_date >= ? LIMIT 1').get(rolloverDate);
  if (alreadyRolledOver) return;

  const seasonLabel = seasonLabelFor(seasonStart);
  const cup = require('./cup');

  const divisions = db.prepare('SELECT DISTINCT division FROM teams').all().map((r) => r.division);
  divisions.forEach((division) => {
    const teams = db.prepare('SELECT id, name, shield_path FROM teams WHERE division = ?').all(division);
    const played = db.prepare(`
      SELECT * FROM league_fixtures WHERE status = 'played' AND home_team_id IN (SELECT id FROM teams WHERE division = ?)
    `).all(division);
    if (!played.length) return;

    const standings = buildStandings(teams, played);
    if (standings[0]) {
      /* Proteção contra duplicados — ver comentário em creditPlayerTrophy:
         sem isto, se esta função corresse mais que uma vez para a mesma
         época, o campeão ganhava o troféu do Campeonato repetido. */
      const alreadyLeagueChamp = db.prepare(`
        SELECT 1 FROM trophies WHERE team_id = ? AND competition = 'league' AND season_label = ?
      `).get(standings[0].team_id, seasonLabel);
      if (!alreadyLeagueChamp) {
        db.prepare(`
          INSERT INTO trophies (team_id, competition, season_label, won_date) VALUES (?, 'league', ?, ?)
        `).run(standings[0].team_id, seasonLabel, nextDateStr);
        creditPlayerTrophy(standings[0].team_id, 'league', seasonLabel, nextDateStr);
      }
    }

    const cupState = cup.getCupState(division);
    if (cupState.status === 'finished' && cupState.champion) {
      const alreadyCupChamp = db.prepare(`
        SELECT 1 FROM trophies WHERE team_id = ? AND competition = 'cup' AND season_label = ?
      `).get(cupState.champion.id, seasonLabel);
      if (!alreadyCupChamp) {
        db.prepare(`
          INSERT INTO trophies (team_id, competition, season_label, won_date) VALUES (?, 'cup', ?, ?)
        `).run(cupState.champion.id, seasonLabel, nextDateStr);
        creditPlayerTrophy(cupState.champion.id, 'cup', seasonLabel, nextDateStr);
      }
    }

    assignSeasonAwards(teams.map((t) => t.id), seasonLabel, nextDateStr);
    assignBestXI(teams.map((t) => t.id), seasonLabel, nextDateStr);
  });

  /* ---------- Arquiva o histórico de carreira ANTES de limpar a época ----------
     Uma cópia dos totais de Campeonato/Taça desta época (já acumulados em
     season_stats_json por routes/competitionStats.js) fica guardada em
     player_season_history antes de serem apagados logo a seguir — é isto
     que alimenta a aba "Carreira" do perfil do jogador com um histórico
     ano a ano, em vez de só o resumo da época em curso (que se perdia
     por completo em cada "Novo Jogo"/mudança de época). */
  {
    const insertHistory = db.prepare(`
      INSERT INTO player_season_history
        (player_id, team_id, team_name, team_shield, season_label, competition, games, goals, assists, yellow_cards, red_cards, tackles, pass_pct, rating)
      VALUES (@player_id, @team_id, @team_name, @team_shield, @season_label, @competition, @games, @goals, @assists, @yellow_cards, @red_cards, @tackles, @pass_pct, @rating)
    `);
    const historyRowNames = [db.COMPETITION_ROW_NAMES.league, db.COMPETITION_ROW_NAMES.cup];
    db.prepare('SELECT id, team_id, season_stats_json FROM players').all().forEach((p) => {
      let rows;
      try { rows = JSON.parse(p.season_stats_json || '[]'); } catch { rows = []; }
      if (!Array.isArray(rows)) return;
      const team = p.team_id ? db.prepare('SELECT name, shield_path FROM teams WHERE id = ?').get(p.team_id) : null;
      rows
        .filter((r) => historyRowNames.includes(r.competition) && (Number(r.j) || 0) > 0)
        .forEach((r) => {
          insertHistory.run({
            player_id: p.id,
            team_id: p.team_id || null,
            team_name: team ? team.name : null,
            team_shield: team ? team.shield_path : null,
            season_label: seasonLabel,
            competition: r.competition,
            games: Number(r.j) || 0,
            goals: Number(r.g) || 0,
            assists: Number(r.a) || 0,
            yellow_cards: Number(r.am) || 0,
            red_cards: Number(r.verm) || 0,
            tackles: Number(r.tk) || 0,
            pass_pct: Number.isFinite(parseFloat(r.pp)) ? parseFloat(r.pp) : null,
            rating: Number.isFinite(parseFloat(r.media)) ? parseFloat(r.media) : null,
          });
        });
    });
  }

  db.prepare("DELETE FROM friendly_player_stats WHERE competition IN ('league','cup')").run();
  const resettableRowNames = [db.COMPETITION_ROW_NAMES.league, db.COMPETITION_ROW_NAMES.cup];
  const strip = db.prepare('UPDATE players SET season_stats_json = ? WHERE id = ?');

  /* IMPORTANTE: a evolução dos jogadores (ver runPlayerDevelopmentForSeason)
     tem de correr ANTES desta limpeza — precisa do season_stats_json ainda
     com os dados de Campeonato/Taça desta época para calcular a média de
     classificação de cada jogador. A atualização da reputação das equipas
     pode correr a seguir, já só precisa dos troféus (já gravados acima). */
  const developedPlayers = runPlayerDevelopmentForSeason(seasonLabel, nextDateStr);
  updateTeamReputations(seasonLabel);

  db.prepare('SELECT id, season_stats_json FROM players').all().forEach((p) => {
    let rows;
    try { rows = JSON.parse(p.season_stats_json || '[]'); } catch { rows = []; }
    if (!Array.isArray(rows)) return;
    const filtered = rows.filter((r) => !resettableRowNames.includes(r.competition));
    if (filtered.length !== rows.length) strip.run(JSON.stringify(filtered), p.id);
  });

  db.prepare('DELETE FROM league_fixtures').run();
  db.prepare('DELETE FROM cup_fixtures').run();
  db.prepare('UPDATE game_state SET current_season_start = ? WHERE id = 1').run(rolloverDate);
  regenerateSeasonFixtures(rolloverDate);

  /* ---------- Capitão e sub-capitão da nova época ----------
     As equipas geridas pelo jogo continuam a ter capitão atribuído
     automaticamente (mesmo critério de sempre — mais Liderança do
     plantel), para o efeito em db.getCaptainFactor não faltar a
     ninguém. O clube do utilizador passa a ESCOLHER: fica sem capitão
     definido até responder à mensagem "Escolhe o capitão da equipa" na
     caixa de entrada (ver PUT /api/players/captain/:teamId). */
  const allTeamsForCaptaincy = db.prepare('SELECT id, is_user_controlled FROM teams').all();
  allTeamsForCaptaincy.forEach((t) => {
    if (t.is_user_controlled) {
      db.prepare('UPDATE players SET is_captain = 0, is_vice_captain = 0 WHERE team_id = ?').run(t.id);
      const candidates = players.getCaptaincyCandidates(t.id);
      if (candidates.length) {
        db.prepare(`
          INSERT INTO messages (team_id, type, title, body, extra_json)
          VALUES (@team_id, 'choose_captain', @title, @body, @extra_json)
        `).run({
          team_id: t.id,
          title: '🎖️ Escolhe o capitão da equipa',
          body: `Uma nova época começa — escolhe quem veste a braçadeira de capitão para a época ${seasonLabelFor(rolloverDate)}. O sub-capitão fica automaticamente com o segundo melhor em Liderança.`,
          extra_json: JSON.stringify({
            captain_candidates: candidates.map((c) => ({
              player_id: c.id, name: c.name, position_tag: c.position_tag, leadership: c.leadership,
            })),
          }),
        });
      }
      return;
    }
    players.assignCaptaincy(t.id, { force: true });
  });

  /* Notifica o treinador — uma mensagem por cada troféu/prémio que o SEU
     clube (ou um jogador dele) tenha ganho, além do aviso geral de que a
     época nova já começou. Assim fica claro na caixa de entrada o que foi
     mesmo conquistado, em vez de um resumo vago. */
  const myTeam = db.prepare('SELECT * FROM teams WHERE is_user_controlled = 1').get();
  if (myTeam) {
    const myTrophies = db.prepare(`
      SELECT * FROM trophies WHERE team_id = ? AND season_label = ? AND won_date = ?
    `).all(myTeam.id, seasonLabel, nextDateStr);

    myTrophies.forEach((t) => {
      const isLeague = t.competition === 'league';
      db.prepare(`
        INSERT INTO messages (team_id, type, title, body) VALUES (@team_id, 'trophy_won', @title, @body)
      `).run({
        team_id: myTeam.id,
        title: `🏆 ${isLeague ? 'Campeões do Campeonato' : 'Campeões da Taça São Vicente'}!`,
        body: `O ${myTeam.name} venceu ${isLeague ? 'o Campeonato' : 'a Taça São Vicente'} da época ${seasonLabel}! O troféu já está na vitrine do clube.`,
      });
    });

    const myPlayerIds = new Set(db.prepare('SELECT id FROM players WHERE team_id = ?').all(myTeam.id).map((r) => r.id));

    /* ---------- Evolução dos jogadores do MEU clube ----------
       Uma mensagem por cada jogador que teve mesmo uma época de destaque
       (breakout) — os que só subiram um pouco não geram mensagem própria,
       para não encher a caixa de entrada com coisas pequenas. */
    developedPlayers
      .filter((d) => d.team_id === myTeam.id && d.isStandout)
      .forEach((d) => {
        db.prepare(`
          INSERT INTO messages (team_id, type, title, body, player_id) VALUES (@team_id, 'player_developed', @title, @body, @player_id)
        `).run({
          team_id: myTeam.id,
          player_id: d.id,
          title: `📈 ${d.name} evoluiu muito esta época!`,
          body: `${d.name} teve uma época de destaque e melhorou como jogador. Clubes mais fortes já começam a reparar nele — não te surpreendas se aparecerem propostas inesperadas na próxima janela de mercado.`,
        });
      });

    const myAwards = db.prepare(`
      SELECT * FROM player_awards WHERE team_id = ? AND season_label = ? AND won_date = ?
    `).all(myTeam.id, seasonLabel, nextDateStr);

    myAwards.forEach((a) => {
      if (!myPlayerIds.has(a.player_id)) return;
      const player = db.prepare('SELECT name, photo_path FROM players WHERE id = ?').get(a.player_id);
      if (!player) return;
      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id) VALUES (@team_id, 'award_won', @title, @body, @player_id)
      `).run({
        team_id: myTeam.id,
        player_id: a.player_id,
        title: `${db.AWARD_ICONS[a.award_key] || '🏅'} ${player.name} venceu ${db.AWARD_LABELS[a.award_key] || a.award_key}!`,
        body: `${player.name} foi eleito ${db.AWARD_LABELS[a.award_key] || a.award_key} da época ${seasonLabel}, juntando-se ao seu próprio palmarés. Podes ver o prémio no perfil dele.`,
      });
    });

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body) VALUES (@team_id, 'season_rollover', @title, @body)
    `).run({
      team_id: myTeam.id,
      title: `📅 Começa a época ${seasonLabelFor(rolloverDate)}`,
      body: `A época ${seasonLabel} chegou ao fim. O Campeonato ${seasonLabelFor(rolloverDate)} arranca já hoje.`,
    });
  }
}

/* ---------- Prémios em dinheiro de fim de época do Campeonato + Taça ----------
   Pagos sempre no dia 1 de Junho — NUNCA ligados ao fim real da última
   jornada (que pode calhar mais cedo ou mais tarde) nem ao "rollover" da
   época (sempre 1 de Agosto seguinte, ver runSeasonRolloverIfDue) — para o
   dinheiro estar disponível bem antes da janela de mercado de pré-época (1
   a 31 de Julho). Só paga quando a divisão tiver mesmo o Campeonato todo
   disputado (senão a classificação final ainda nem faz sentido); se 1 de
   Junho passar sem isso acontecer, os prémios saem assim que a última
   jornada em atraso for resolvida.

   TODAS as equipas da divisão recebem, conforme a posição final (1º lugar
   450.000£, último lugar 25.000£, com as posições a meio distribuídas de
   forma linear entre os dois — ver db.awardLeagueSeasonPrizeMoney em
   db/database.js) — mais o prémio da Taça São Vicente (50.000£ por ronda
   avançada, +100.000£ para o campeão), tudo somado numa única entrada no
   orçamento de transferências. db.awardLeagueSeasonPrizeMoney já trata da
   proteção contra pagamentos em duplicado. */
function awardLeagueSeasonPrizeMoneyIfDue(nextDateStr) {
  const seasonStart = getCurrentSeasonStart();
  const prizeDate = juneFirstOfSeason(seasonStart);
  if (nextDateStr < prizeDate) return;

  const seasonLabel = seasonLabelFor(seasonStart);
  const divisions = db.prepare('SELECT DISTINCT division FROM teams').all().map((r) => r.division);

  divisions.forEach((division) => {
    const teams = db.prepare('SELECT id, name, shield_path FROM teams WHERE division = ?').all(division);
    const fixtures = db.prepare(`
      SELECT * FROM league_fixtures WHERE home_team_id IN (SELECT id FROM teams WHERE division = ?)
    `).all(division);
    if (!fixtures.length || fixtures.some((f) => f.status !== 'played')) return;

    const standings = buildStandings(teams, fixtures);
    if (!standings.length) return;

    db.awardLeagueSeasonPrizeMoney({ standings, season_label: seasonLabel });
  });
}

/* ---------- Avança o Campeonato ao chegar a uma nova data ----------
   Chamado a partir de POST /api/game/advance, ANTES de runFriendliesTick
   (routes/game.js) — para que, se hoje for dia de jogo do clube do
   utilizador, o "amigável" interno criado aqui já exista a tempo de essa
   mesma função o deixar de fora (fica para ser assistido ao vivo, tal como
   qualquer amigável de hoje que envolva o utilizador). */
function runLeagueTick(nextDateStr) {
  runSeasonRolloverIfDue(nextDateStr);
  awardLeagueSeasonPrizeMoneyIfDue(nextDateStr);
  ensureSeasonFixtures();

  const due = db.prepare(`
    SELECT lf.*,
           h.name AS home_name, h.reputation_stars AS home_reputation, h.is_user_controlled AS home_user,
           a.name AS away_name, a.reputation_stars AS away_reputation, a.is_user_controlled AS away_user
    FROM league_fixtures lf
    JOIN teams h ON h.id = lf.home_team_id
    JOIN teams a ON a.id = lf.away_team_id
    WHERE lf.status = 'scheduled' AND lf.match_date <= ?
  `).all(nextDateStr);

  const results = [];

  due.forEach((f) => {
    if (f.home_user || f.away_user) {
      /* Jogo do utilizador: cria um "amigável" interno ligado a esta
         jornada, para reaproveitar toda a máquina já existente (banner
         "Jogo de Hoje", jogo ao vivo, resolução automática se o jogo for
         ignorado). Fica marcado is_league = 1 para a interface o poder
         distinguir de um amigável real. */
      const info = db.prepare(`
        INSERT INTO club_friendlies (home_team_id, away_team_id, requested_by_team_id, match_date, status, is_league)
        VALUES (@home_team_id, @away_team_id, @requested_by_team_id, @match_date, 'accepted', 1)
      `).run({
        home_team_id: f.home_team_id,
        away_team_id: f.away_team_id,
        requested_by_team_id: f.home_team_id,
        match_date: f.match_date,
      });
      db.prepare("UPDATE league_fixtures SET status = 'linked', friendly_id = ? WHERE id = ?")
        .run(info.lastInsertRowid, f.id);
      return;
    }

    const homeDefBonus = teamHasPatrao(f.home_team_id) ? 0.3 : 0;
    const awayDefBonus = teamHasPatrao(f.away_team_id) ? 0.3 : 0;
    const homeCapFactor = db.getCaptainFactor(f.home_team_id);
    const awayCapFactor = db.getCaptainFactor(f.away_team_id);
    const homeRep = f.home_reputation + homeCapFactor;
    const awayRep = f.away_reputation + awayCapFactor;
    const homeGoals = simulateLeagueGoals(homeRep + 0.15, awayRep + awayDefBonus);
    const awayGoals = simulateLeagueGoals(awayRep, homeRep + 0.15 + homeDefBonus);

    db.prepare("UPDATE league_fixtures SET status = 'played', home_score = ?, away_score = ? WHERE id = ?")
      .run(homeGoals, awayGoals, f.id);

    /* Gera golos/assistências/cartões/cortes/% de passe para os jogadores
       das duas equipas (geridas pelo jogo) — é o que alimenta os
       "Melhores Marcadores" etc. do Campeonato e as linhas "Campeonato"
       no perfil de cada jogador. Ver routes/competitionStats.js. */
    simulateCompetitionMatchStats('league', f.home_team_id, f.away_team_id, homeGoals, awayGoals);

    results.push({
      round: f.round, home_team: f.home_name, away_team: f.away_name,
      home_score: homeGoals, away_score: awayGoals,
    });
  });

  return results;
}

/* ---------- Tabela classificativa, calculada a partir dos jogos já jogados ---------- */
function buildStandings(divisionTeams, playedFixtures) {
  const table = new Map();
  divisionTeams.forEach((t) => table.set(t.id, {
    team_id: t.id, name: t.name, shield_path: t.shield_path,
    pj: 0, v: 0, e: 0, d: 0, gp: 0, gc: 0, sg: 0, pts: 0,
  }));

  playedFixtures.forEach((f) => {
    const home = table.get(f.home_team_id);
    const away = table.get(f.away_team_id);
    if (!home || !away || f.home_score == null || f.away_score == null) return;

    home.pj += 1; away.pj += 1;
    home.gp += f.home_score; home.gc += f.away_score;
    away.gp += f.away_score; away.gc += f.home_score;

    if (f.home_score > f.away_score) { home.v += 1; home.pts += 3; away.d += 1; }
    else if (f.home_score < f.away_score) { away.v += 1; away.pts += 3; home.d += 1; }
    else { home.e += 1; away.e += 1; home.pts += 1; away.pts += 1; }
  });

  return [...table.values()]
    .map((t) => ({ ...t, sg: t.gp - t.gc }))
    .sort((a, b) => b.pts - a.pts || b.sg - a.sg || b.gp - a.gp || a.name.localeCompare(b.name))
    .map((t, i) => ({ ...t, position: i + 1 }));
}

/* ---------- Probabilidade de título (Monte Carlo) ----------
   Simula o resto da época MUITAS vezes, usando o MESMO modelo de golos do
   motor de jogo real (simulateLeagueGoals, Patrão, capitão — ver
   runLeagueTick acima), e conta em quantas simulações cada equipa acaba
   em 1º lugar. Como os pontos já conquistados entram como ponto de
   partida em TODAS as simulações, isto responde sozinho à evolução da
   época — uma equipa em grande momento já parte com vantagem.

   A reputação (reputation_stars) só muda no fim da época (ver
   updateTeamReputations mais acima) — para que o mercado/transferências
   também pesem já DURANTE a época, como foi pedido, soma-se um pequeno
   ajuste baseado na qualidade atual do plantel (média das estrelas dos
   prováveis titulares) face à reputação "oficial" da equipa, mais um
   ajuste pela forma dos últimos jogos ("momento da equipa"). Isto é só
   para ESTA estimativa — nunca afeta os resultados reais simulados pelo
   motor do jogo. */
const TITLE_ODDS_ITERATIONS = 50;
/* As diferenças de reputação entre equipas (0.5 a 5 estrelas) são grandes
   demais para uma época inteira (~28 jornadas) — aplicadas sem ajuste, a
   equipa mais forte acaba campeã em mais de 80% das simulações, o que não
   parece um Campeonato a sério. Esta compressão aproxima cada equipa da
   média da divisão antes de simular, mantendo a ORDEM (quem é mais forte
   continua favorito) mas suavizando o quanto isso pesa ao longo de uma
   época toda — dá uma distribuição parecida com a de uma liga real, onde
   o favorito ronda os 25-30% e não os 80-90%. */
const STRENGTH_COMPRESSION_FACTOR = 0.15;
const SQUAD_MARKET_WEIGHT = 0.15; // quanto o plantel atual pesa vs a reputação "oficial"
const MAX_SQUAD_MARKET_BONUS = 0.35;
const RECENT_FORM_GAMES = 5;
const MAX_FORM_BONUS = 0.3;

function computeSquadMarketBonus(teamId, reputationStars) {
  const squad = db.prepare('SELECT current_ability_stars FROM players WHERE team_id = ?').all(teamId);
  if (squad.length < 11) return 0; // plantel curto demais para um número fiável
  const startingXI = squad.map((p) => p.current_ability_stars ?? 2.5).sort((a, b) => b - a).slice(0, 11);
  const squadQuality = startingXI.reduce((sum, v) => sum + v, 0) / startingXI.length;
  const raw = (squadQuality - reputationStars) * SQUAD_MARKET_WEIGHT;
  return Math.max(-MAX_SQUAD_MARKET_BONUS, Math.min(MAX_SQUAD_MARKET_BONUS, raw));
}

function computeRecentFormBonus(teamId, playedFixtures, seasonAvgPtsPerGame) {
  const teamGames = playedFixtures
    .filter((f) => f.home_team_id === teamId || f.away_team_id === teamId)
    .slice(-RECENT_FORM_GAMES);
  if (teamGames.length < 2) return 0; // época mal começada, ainda sem "momento" fiável para medir

  let pts = 0;
  teamGames.forEach((f) => {
    const isHome = f.home_team_id === teamId;
    const gf = isHome ? f.home_score : f.away_score;
    const ga = isHome ? f.away_score : f.home_score;
    if (gf > ga) pts += 3;
    else if (gf === ga) pts += 1;
  });
  const recentAvg = pts / teamGames.length;
  const raw = (recentAvg - seasonAvgPtsPerGame) * 0.12;
  return Math.max(-MAX_FORM_BONUS, Math.min(MAX_FORM_BONUS, raw));
}

function computeTitleOdds(divisionTeams, playedFixtures, remainingFixtures) {
  const baseStandings = buildStandings(divisionTeams, playedFixtures);

  const totalTeamGamesPlayed = playedFixtures.length * 2; // cada jogo conta para as 2 equipas
  const totalPts = baseStandings.reduce((sum, s) => sum + s.pts, 0);
  const seasonAvgPtsPerGame = totalTeamGamesPlayed > 0 ? totalPts / totalTeamGamesPlayed : 1.3;

  const strength = new Map();
  const meanReputation = divisionTeams.reduce((sum, t) => sum + (t.reputation_stars ?? 2.5), 0) / divisionTeams.length;
  divisionTeams.forEach((t) => {
    const rep = t.reputation_stars ?? 2.5;
    const compressedRep = meanReputation + (rep - meanReputation) * STRENGTH_COMPRESSION_FACTOR;
    const capFactor = db.getCaptainFactor(t.id);
    const marketBonus = computeSquadMarketBonus(t.id, rep);
    const formBonus = computeRecentFormBonus(t.id, playedFixtures, seasonAvgPtsPerGame);
    strength.set(t.id, compressedRep + capFactor + marketBonus + formBonus);
  });

  const titleCount = new Map(divisionTeams.map((t) => [t.id, 0]));

  for (let iter = 0; iter < TITLE_ODDS_ITERATIONS; iter += 1) {
    const sim = new Map(baseStandings.map((s) => [s.team_id, { ...s }]));

    remainingFixtures.forEach((f) => {
      const home = sim.get(f.home_team_id);
      const away = sim.get(f.away_team_id);
      if (!home || !away) return;

      const homeDefBonus = teamHasPatrao(f.home_team_id) ? 0.3 : 0;
      const awayDefBonus = teamHasPatrao(f.away_team_id) ? 0.3 : 0;
      const homeStr = strength.get(f.home_team_id) ?? 2.5;
      const awayStr = strength.get(f.away_team_id) ?? 2.5;
      const homeGoals = simulateLeagueGoals(homeStr + 0.15, awayStr + awayDefBonus);
      const awayGoals = simulateLeagueGoals(awayStr, homeStr + 0.15 + homeDefBonus);

      home.pj += 1; away.pj += 1;
      home.gp += homeGoals; home.gc += awayGoals;
      away.gp += awayGoals; away.gc += homeGoals;
      if (homeGoals > awayGoals) home.pts += 3;
      else if (awayGoals > homeGoals) away.pts += 3;
      else { home.pts += 1; away.pts += 1; }
    });

    const finalOrder = [...sim.values()]
      .map((t) => ({ ...t, sg: t.gp - t.gc }))
      .sort((a, b) => b.pts - a.pts || b.sg - a.sg || b.gp - a.gp || a.name.localeCompare(b.name));

    const champion = finalOrder[0];
    if (champion) titleCount.set(champion.team_id, (titleCount.get(champion.team_id) || 0) + 1);
  }

  return divisionTeams
    .map((t) => ({
      team_id: t.id,
      name: t.name,
      shield_path: t.shield_path,
      title_probability: Math.round((titleCount.get(t.id) / TITLE_ODDS_ITERATIONS) * 1000) / 10, // 1 casa decimal
    }))
    .sort((a, b) => b.title_probability - a.title_probability);
}

/* ---------- GET /api/league/:teamId — tabela + calendário do clube ---------- */
router.get('/:teamId', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  ensureSeasonFixtures();

  const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
  const currentDate = state.current_date;
  const seasonStart = getCurrentSeasonStart();

  const divisionTeams = db.prepare('SELECT id, name, shield_path, reputation_stars FROM teams WHERE division = ?').all(team.division);
  const playedFixtures = db.prepare(`
    SELECT * FROM league_fixtures WHERE status = 'played' AND home_team_id IN (
      SELECT id FROM teams WHERE division = ?
    )
    ORDER BY match_date ASC, id ASC
  `).all(team.division);
  const remainingFixtures = db.prepare(`
    SELECT * FROM league_fixtures WHERE status IN ('scheduled', 'linked') AND home_team_id IN (
      SELECT id FROM teams WHERE division = ?
    )
  `).all(team.division);

  const standings = buildStandings(divisionTeams, playedFixtures);
  const titleOdds = computeTitleOdds(divisionTeams, playedFixtures, remainingFixtures);
  const leaders = getCompetitionLeaders('league', divisionTeams.map((t) => t.id));

  const teamFixtures = db.prepare(`
    SELECT lf.*,
           h.name AS home_name, h.shield_path AS home_shield,
           a.name AS away_name, a.shield_path AS away_shield
    FROM league_fixtures lf
    JOIN teams h ON h.id = lf.home_team_id
    JOIN teams a ON a.id = lf.away_team_id
    WHERE lf.home_team_id = ? OR lf.away_team_id = ?
    ORDER BY lf.match_date ASC, lf.id ASC
  `).all(team.id, team.id);

  const upcoming = teamFixtures.filter((f) => f.status !== 'played');
  const history = teamFixtures.filter((f) => f.status === 'played').slice().reverse();

  res.json({
    current_date: currentDate,
    season_started: currentDate >= seasonStart,
    season_start: seasonStart,
    season_label: seasonLabelFor(seasonStart),
    preseason_window: preseasonWindowFor(seasonStart),
    my_team_id: team.id,
    standings,
    title_odds: titleOdds,
    leaders,
    upcoming,
    history,
  });
});

/* ---------- GET /api/league/awards-ceremony/:teamId — cerimónia de prémios ----------
   Devolve os prémios da época mais recente já atribuída à divisão do clube
   (Campeonato + Taça, incluindo os prémios só da Taça), na ordem "de gala"
   definida em db.AWARD_CEREMONY_ORDER — para a interface mostrar uma
   bolinha por prémio, clicável, que revela o vencedor ao ser clicada.
   Devolve status 'none' se a divisão ainda não teve nenhuma época
   terminada (ex: primeiro ano de um save novo). */
router.get('/awards-ceremony/:teamId', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const divisionTeamIds = db.prepare('SELECT id FROM teams WHERE division = ?').all(team.division).map((t) => t.id);
  if (!divisionTeamIds.length) return res.json({ status: 'none' });
  const placeholders = divisionTeamIds.map(() => '?').join(',');

  const latest = db.prepare(`
    SELECT season_label, won_date FROM player_awards
    WHERE team_id IN (${placeholders})
    ORDER BY won_date DESC, id DESC LIMIT 1
  `).get(...divisionTeamIds);
  if (!latest) return res.json({ status: 'none' });

  const rows = db.prepare(`
    SELECT pa.award_key, pa.player_id, p.name AS player_name, p.photo_path AS player_photo,
           t.id AS team_id, t.name AS team_name, t.shield_path AS team_shield
    FROM player_awards pa
    JOIN players p ON p.id = pa.player_id
    LEFT JOIN teams t ON t.id = pa.team_id
    WHERE pa.season_label = ? AND pa.won_date = ? AND pa.team_id IN (${placeholders})
  `).all(latest.season_label, latest.won_date, ...divisionTeamIds);

  const byKey = new Map(rows.map((r) => [r.award_key, r]));
  const awards = db.AWARD_CEREMONY_ORDER
    .filter((key) => byKey.has(key))
    .map((key) => ({
      award_key: key,
      label: db.AWARD_LABELS[key] || key,
      icon: db.AWARD_ICONS[key] || '🏅',
      ...byKey.get(key),
    }));

  res.json({
    status: awards.length ? 'ready' : 'none',
    season_label: latest.season_label,
    won_date: latest.won_date,
    awards,
  });
});

/* ---------- GET /api/league/season-gala/:teamId — "11 do Ano" para a Gala ----------
   Mesmo espírito da cerimónia de prémios (award-ceremony, acima): lê a
   época mais recente com prémios atribuídos para a divisão deste clube, e
   devolve os 11 jogadores (best_xi_*) já pela ORDEM em que devem "entrar
   em campo" na animação do frontend — guarda-redes primeiro, depois
   defesas, médios e por fim os atacantes — com o formation slot (x/y) que
   lhes corresponde na formação 4-3-3 fixa usada pela Gala (ver
   dashboard.js, reaproveita as mesmas coordenadas da tática). Devolve
   status 'none' se a divisão ainda não teve nenhuma época terminada. */
const BEST_XI_ORDER = [
  'best_xi_gr',
  'best_xi_def_1', 'best_xi_def_2', 'best_xi_def_3', 'best_xi_def_4',
  'best_xi_med_1', 'best_xi_med_2', 'best_xi_med_3',
  'best_xi_ata_1', 'best_xi_ata_2', 'best_xi_ata_3',
];

router.get('/season-gala/:teamId', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const divisionTeamIds = db.prepare('SELECT id FROM teams WHERE division = ?').all(team.division).map((t) => t.id);
  if (!divisionTeamIds.length) return res.json({ status: 'none' });
  const placeholders = divisionTeamIds.map(() => '?').join(',');

  const latest = db.prepare(`
    SELECT season_label, won_date FROM player_awards
    WHERE team_id IN (${placeholders}) AND award_key LIKE 'best_xi_%'
    ORDER BY won_date DESC, id DESC LIMIT 1
  `).get(...divisionTeamIds);
  if (!latest) return res.json({ status: 'none' });

  const rows = db.prepare(`
    SELECT pa.award_key, pa.player_id, p.name AS player_name, p.photo_path AS player_photo,
           t.id AS team_id, t.name AS team_name, t.shield_path AS team_shield
    FROM player_awards pa
    JOIN players p ON p.id = pa.player_id
    LEFT JOIN teams t ON t.id = pa.team_id
    WHERE pa.season_label = ? AND pa.won_date = ? AND pa.award_key LIKE 'best_xi_%'
  `).all(latest.season_label, latest.won_date);

  const byKey = new Map(rows.map((r) => [r.award_key, r]));
  const lineup = BEST_XI_ORDER.filter((key) => byKey.has(key)).map((key) => byKey.get(key));

  res.json({
    status: lineup.length ? 'ready' : 'none',
    season_label: latest.season_label,
    won_date: latest.won_date,
    formation: '4-3-3',
    lineup,
  });
});

module.exports = router;
module.exports.regenerateSeasonFixtures = regenerateSeasonFixtures;
module.exports.ensureSeasonFixtures = ensureSeasonFixtures;
module.exports.runLeagueTick = runLeagueTick;
module.exports.getCurrentSeasonStart = getCurrentSeasonStart;
module.exports.buildStandings = buildStandings;
module.exports.computeTitleOdds = computeTitleOdds;