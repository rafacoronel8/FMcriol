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
    if (!candidate) return;
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

/* ---------- Crédito de título coletivo aos jogadores do plantel ----------
   Chamado sempre que um troféu (Campeonato ou Taça) é atribuído a uma
   equipa em runSeasonRolloverIfDue — regista em player_trophies, para
   CADA jogador atualmente no plantel dessa equipa, que ele fez parte do
   título. Alimenta a secção "Títulos Coletivos" da aba Carreira do perfil
   do jogador (ver GET /api/players/:id em routes/players.js). */
function creditPlayerTrophy(teamId, competition, seasonLabel, wonDate) {
  const team = db.prepare('SELECT name, shield_path FROM teams WHERE id = ?').get(teamId);
  const roster = db.prepare('SELECT id FROM players WHERE team_id = ?').all(teamId);
  const insertTrophy = db.prepare(`
    INSERT INTO player_trophies (player_id, team_id, team_name, team_shield, competition, season_label, won_date)
    VALUES (@player_id, @team_id, @team_name, @team_shield, @competition, @season_label, @won_date)
  `);
  roster.forEach((pl) => {
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
function runSeasonRolloverIfDue(nextDateStr) {
  const seasonStart = getCurrentSeasonStart();
  const rolloverDate = nextAugustFirst(seasonStart);
  if (nextDateStr < rolloverDate) return;

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
      db.prepare(`
        INSERT INTO trophies (team_id, competition, season_label, won_date) VALUES (?, 'league', ?, ?)
      `).run(standings[0].team_id, seasonLabel, nextDateStr);
      creditPlayerTrophy(standings[0].team_id, 'league', seasonLabel, nextDateStr);
    }

    const cupState = cup.getCupState(division);
    if (cupState.status === 'finished' && cupState.champion) {
      db.prepare(`
        INSERT INTO trophies (team_id, competition, season_label, won_date) VALUES (?, 'cup', ?, ?)
      `).run(cupState.champion.id, seasonLabel, nextDateStr);
      creditPlayerTrophy(cupState.champion.id, 'cup', seasonLabel, nextDateStr);
    }

    assignSeasonAwards(teams.map((t) => t.id), seasonLabel, nextDateStr);
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

/* ---------- Avança o Campeonato ao chegar a uma nova data ----------
   Chamado a partir de POST /api/game/advance, ANTES de runFriendliesTick
   (routes/game.js) — para que, se hoje for dia de jogo do clube do
   utilizador, o "amigável" interno criado aqui já exista a tempo de essa
   mesma função o deixar de fora (fica para ser assistido ao vivo, tal como
   qualquer amigável de hoje que envolva o utilizador). */
function runLeagueTick(nextDateStr) {
  runSeasonRolloverIfDue(nextDateStr);
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
    const homeGoals = simulateLeagueGoals(f.home_reputation + 0.15, f.away_reputation + awayDefBonus);
    const awayGoals = simulateLeagueGoals(f.away_reputation, f.home_reputation + 0.15 + homeDefBonus);

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

/* ---------- GET /api/league/:teamId — tabela + calendário do clube ---------- */
router.get('/:teamId', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  ensureSeasonFixtures();

  const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
  const currentDate = state.current_date;
  const seasonStart = getCurrentSeasonStart();

  const divisionTeams = db.prepare('SELECT id, name, shield_path FROM teams WHERE division = ?').all(team.division);
  const playedFixtures = db.prepare(`
    SELECT * FROM league_fixtures WHERE status = 'played' AND home_team_id IN (
      SELECT id FROM teams WHERE division = ?
    )
  `).all(team.division);

  const standings = buildStandings(divisionTeams, playedFixtures);
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

module.exports = router;
module.exports.regenerateSeasonFixtures = regenerateSeasonFixtures;
module.exports.ensureSeasonFixtures = ensureSeasonFixtures;
module.exports.runLeagueTick = runLeagueTick;
module.exports.getCurrentSeasonStart = getCurrentSeasonStart;
module.exports.buildStandings = buildStandings;