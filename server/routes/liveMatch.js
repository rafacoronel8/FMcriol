/* ==========================================================
   FMcriol — Rotas da API para Jogos ao Vivo
   Simulação minuto a minuto de um amigável de hoje que envolva o
   clube do utilizador: golos, cartões, substituições e mudanças
   de tática em tempo real, com o resultado final a ser gravado
   exatamente como um amigável normal (club_friendlies + stats).
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

const VALID_FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-4-3'];
const MAX_SUBS = 5;
const MATCH_LENGTH = 90;

/* ---------- Ordem dos códigos de posição por formação ----------
   TEM de ficar exatamente pela mesma ordem que o array FORMATIONS em
   public/dashboard.js (índice a índice) — é este índice que o frontend usa
   para saber em que coordenada (x%, y%) do campo colocar cada jogador do
   jogo ao vivo. Isto evita termos de duplicar as coordenadas aqui: o
   servidor só precisa de dizer "este jogador ocupa o slot 4", o cliente é
   que sabe que o slot 4 da 4-3-3 fica em x:18%% y:74%%. */
const FORMATION_SLOTS = {
  '4-3-3': ['GR', 'DD', 'DC', 'DC', 'DE', 'MCD', 'MC', 'MC', 'ED', 'PL', 'EE'],
  '4-4-2': ['GR', 'DD', 'DC', 'DC', 'DE', 'MD', 'MC', 'MC', 'ME', 'PL', 'PL'],
  '4-2-3-1': ['GR', 'DD', 'DC', 'DC', 'DE', 'MCD', 'MCD', 'MOD', 'MCO', 'MOE', 'PL'],
  '3-4-3': ['GR', 'DC', 'DC', 'DC', 'MD', 'MC', 'MC', 'ME', 'ED', 'PL', 'EE'],
};

function currentGameDate() {
  /* IMPORTANTE: "current_date" tem de vir qualificado com o nome da tabela.
     Sem isto, o SQLite interpreta "current_date" como a sua própria palavra-chave
     incorporada (a data REAL do computador), em vez da coluna da tabela. */
  return db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get().current_date;
}

/* ---------- Classificação de posição + peso de qualidade -----------
   Mesma lógica usada na simulação offline dos amigáveis (routes/game.js),
   repetida aqui porque as duas rotas não partilham módulo. */
function classifyPositionCode(code) {
  const c = String(code || '').toUpperCase();
  if (c.startsWith('GR')) return 'GR';
  if (c === 'PL') return 'PL';
  if (c.startsWith('MO') || c === 'MCO' || c.startsWith('ED') || c.startsWith('EE')) return 'MO';
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

/* Mesma ideia, mas aplicando o bónus de especialização (Goleador/Garçom —
   ver focus_role, escolhido no perfil do jogador) por cima do peso normal. */
function pickWeightedWithFocus(candidates, weightMap, focusRole) {
  const weightFn = (p) => weightMap[p.category] * (p.focus_role === focusRole ? 2.2 : 1);
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

/* ---------- Golos esperados por um resultado plausível ----------
   Mesma curva usada em routes/game.js para os amigáveis simulados
   automaticamente (Poisson simplificado com base na reputação). */
function simulateGoalsCount(attackStrength, defendStrength) {
  const lambda = Math.max(0.35, 1.15 + (attackStrength - defendStrength) * 0.3);
  let goals = 0;
  for (let i = 0; i < 8; i += 1) {
    if (Math.random() < lambda / (i + 1.7)) goals += 1;
  }
  return Math.min(goals, 7);
}

function randomMinute() {
  return 1 + Math.floor(Math.random() * MATCH_LENGTH);
}

/* ---------- Monta o plantel de uma equipa para este jogo ao vivo ----------
   Usa a Tática guardada (onze + suplentes); completa com o resto do
   plantel, tal como na simulação offline, para o jogo nunca ficar sem
   11 jogadores em campo. */
function buildTeamRoster(teamId) {
  const squadRows = db.prepare(`
    SELECT id, name, position_tag, position_code, jersey_number, focus_role,
           technical_json, mental_json, physical_json, goalkeeping_json
    FROM players WHERE team_id = ?
  `).all(teamId);
  const squad = squadRows.map((p) => ({ ...p, category: classifyPositionCode(p.position_code) }));

  const tactic = db.prepare('SELECT * FROM tactics WHERE team_id = ?').get(teamId);
  const chosen = [];
  const usedIds = new Set();

  if (tactic) {
    let lineupEntries = [];
    try { lineupEntries = JSON.parse(tactic.lineup_json || '[]'); } catch { lineupEntries = []; }
    lineupEntries.forEach((entry) => {
      const player = squad.find((p) => p.id === entry.player_id);
      if (player && !usedIds.has(player.id)) {
        /* slot_id vem no formato "CODIGO_indice" (ver dashboard.js renderPitch) —
           o índice é a posição exata dentro do array de formação, é isso que
           usamos para saber onde colocar este jogador no campo do jogo ao vivo. */
        const slotIndex = Number(String(entry.slot_id || '').split('_').pop());
        chosen.push({
          ...player,
          category: classifyPositionCode(entry.code || player.position_code),
          slot_index: Number.isInteger(slotIndex) ? slotIndex : null,
        });
        usedIds.add(player.id);
      }
    });
  }
  if (chosen.length < 11) {
    squad.filter((p) => !usedIds.has(p.id)).forEach((p) => {
      if (chosen.length < 11) { chosen.push({ ...p, slot_index: null }); usedIds.add(p.id); }
    });
  }

  const formation = (tactic && VALID_FORMATIONS.includes(tactic.formation)) ? tactic.formation : '4-3-3';

  /* Garante que todo o onze tem um slot_index válido (0-10) e sem repetidos —
     quem já tinha um índice da tática guardada mantém-no; quem não tinha
     (jogadores acrescentados para completar o onze) recebe o próximo slot
     livre, para nunca sobrepor dois jogadores no mesmo ponto do campo. */
  const slotCount = FORMATION_SLOTS[formation].length;
  const takenSlots = new Set(chosen.map((p) => p.slot_index).filter((i) => i !== null && i >= 0 && i < slotCount));
  let nextFree = 0;
  const nextFreeSlot = () => {
    while (takenSlots.has(nextFree) && nextFree < slotCount) nextFree += 1;
    takenSlots.add(nextFree);
    return nextFree;
  };
  chosen.slice(0, 11).forEach((p) => {
    if (p.slot_index === null || p.slot_index < 0 || p.slot_index >= slotCount) {
      p.slot_index = nextFreeSlot();
    }
  });

  const onPitch = chosen.slice(0, 11).map((p) => ({
    id: p.id, name: p.name, category: p.category, position_code: p.position_code,
    jersey_number: p.jersey_number || '', slot_index: p.slot_index,
    quality: playerQualityFactor(p), yellow: false, goals: 0, assists: 0,
  }));

  let benchIds = [];
  if (tactic) {
    try { benchIds = JSON.parse(tactic.bench_json || '[]'); } catch { benchIds = []; }
  }
  const onPitchIds = new Set(onPitch.map((p) => p.id));
  let bench = benchIds
    .map((id) => squad.find((p) => p.id === id))
    .filter((p) => p && !onPitchIds.has(p.id))
    .map((p) => ({
      id: p.id, name: p.name, category: p.category, position_code: p.position_code,
      jersey_number: p.jersey_number || '', quality: playerQualityFactor(p),
    }));

  if (!bench.length) {
    bench = squad
      .filter((p) => !onPitchIds.has(p.id))
      .slice(0, 7)
      .map((p) => ({
        id: p.id, name: p.name, category: p.category, position_code: p.position_code,
        jersey_number: p.jersey_number || '', quality: playerQualityFactor(p),
      }));
  }

  const team = db.prepare('SELECT name, shield_path, reputation_stars, is_user_controlled FROM teams WHERE id = ?').get(teamId);

  return {
    team_id: teamId,
    team_name: team.name,
    team_shield: team.shield_path || null,
    reputation: team.reputation_stars,
    is_user: !!team.is_user_controlled,
    formation,
    on_pitch: onPitch,
    bench,
    subs_remaining: MAX_SUBS,
    appeared: onPitch.map((p) => p.id),
  };
}

/* ---------- Calendário de acontecimentos sorteado no início do jogo ----------
   Golos e cartões são sorteados de antemão (quantos e a que minuto), mas só
   são revelados ao utilizador à medida que o relógio avança — como o jogo é
   "ao vivo", o resultado final não existe antes do apito final. */
function buildSchedule(homeState, awayState) {
  const homeGoals = simulateGoalsCount(homeState.reputation + 0.25, awayState.reputation);
  const awayGoals = simulateGoalsCount(awayState.reputation, homeState.reputation + 0.25);

  const events = [];
  for (let i = 0; i < homeGoals; i += 1) events.push({ minute: randomMinute(), type: 'goal', side: 'home' });
  for (let i = 0; i < awayGoals; i += 1) events.push({ minute: randomMinute(), type: 'goal', side: 'away' });

  ['home', 'away'].forEach((side) => {
    let yellows = 0;
    for (let i = 0; i < 5; i += 1) { if (Math.random() < 0.32) yellows += 1; }
    for (let i = 0; i < yellows; i += 1) events.push({ minute: randomMinute(), type: 'yellow', side });
    if (Math.random() < 0.08) events.push({ minute: randomMinute(), type: 'red', side });
  });

  events.sort((a, b) => a.minute - b.minute);
  return events;
}

/* ---------- Resolve um único acontecimento agendado, mutando o estado ---------- */
function resolveEvent(ev, homeState, awayState, scoreRef) {
  const state = ev.side === 'home' ? homeState : awayState;
  const teamLabel = state.team_name;

  if (ev.type === 'goal') {
    const outfield = state.on_pitch.filter((p) => p.category !== 'GR');

    /* Plantel muito curto (menos de 6 em campo) — nem todo golo tem de
       ficar atribuído a alguém; conta na mesma para o marcador, mas sem
       nome (ver mesma ideia em routes/game.js e routes/competitionStats.js). */
    if (outfield.length < 6 && Math.random() < 0.35) {
      scoreRef[ev.side] += 1;
      return { minute: ev.minute, kind: 'goal', text: `⚽ Golo do ${teamLabel}! A confusão na área não deixou ver quem marcou.` };
    }

    const scorer = pickWeightedWithFocus(outfield, SCORE_WEIGHT, 'Goleador');
    if (!scorer) return null;
    scorer.goals += 1;
    scoreRef[ev.side] += 1;

    let assister = null;
    if (Math.random() < 0.8) {
      const assistCandidates = outfield.filter((p) => p.id !== scorer.id);
      assister = pickWeightedWithFocus(assistCandidates, ASSIST_WEIGHT, 'Garçom');
      if (assister) assister.assists += 1;
    }

    const text = assister
      ? `⚽ Golo do ${teamLabel}! ${scorer.name} marca, assistido por ${assister.name}.`
      : `⚽ Golo do ${teamLabel}! ${scorer.name} marca.`;
    return { minute: ev.minute, kind: 'goal', text };
  }

  if (ev.type === 'yellow') {
    const pool = state.on_pitch.filter((p) => !p.sentOff);
    const player = pickWeighted(pool, CARD_WEIGHT) || pool[Math.floor(Math.random() * pool.length)];
    if (!player) return null;
    if (player.yellow) {
      player.sentOff = true;
      state.on_pitch = state.on_pitch.filter((p) => p.id !== player.id);
      state.dismissed = state.dismissed || [];
      state.dismissed.push(player);
      return { minute: ev.minute, kind: 'red', text: `🟥 Segunda amarela para ${player.name} (${teamLabel}) — expulso!` };
    }
    player.yellow = true;
    return { minute: ev.minute, kind: 'yellow', text: `🟨 Cartão amarelo para ${player.name} (${teamLabel}).` };
  }

  if (ev.type === 'red') {
    const pool = state.on_pitch.filter((p) => !p.sentOff);
    const player = pool[Math.floor(Math.random() * pool.length)];
    if (!player) return null;
    player.sentOff = true;
    player.red = true;
    state.on_pitch = state.on_pitch.filter((p) => p.id !== player.id);
    state.dismissed = state.dismissed || [];
    state.dismissed.push(player);
    return { minute: ev.minute, kind: 'red', text: `🟥 Cartão vermelho direto para ${player.name} (${teamLabel})!` };
  }

  return null;
}

/* ---------- Grava o resultado final tal como um amigável normal ---------- */
function finalizeMatch(friendly, homeState, awayState, finalScore) {
  db.prepare(`
    UPDATE club_friendlies SET status = 'played', home_score = ?, away_score = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(finalScore.home, finalScore.away, friendly.id);

  /* Se este jogo ao vivo era na verdade uma jornada do Campeonato (ver
     is_league em db/database.js e routes/league.js), propaga o resultado
     para league_fixtures — é o que mantém a tabela classificativa e o
     histórico do Campeonato atualizados assim que o jogo termina. */
  db.syncLeagueFixtureFromFriendly(friendly.id, finalScore.home, finalScore.away);

  /* Mesma ideia, mas para a Taça São Vicente (ver is_cup em db/database.js
     e routes/cup.js) — decide o vencedor já aqui se o jogo ficou empatado,
     porque num mata-mata não pode continuar empatado. */
  db.syncCupFixtureFromFriendly(friendly.id, finalScore.home, finalScore.away);

  const competition = friendly.is_cup ? 'cup' : (friendly.is_league ? 'league' : 'friendly');
  const rowName = db.COMPETITION_ROW_NAMES[competition] || db.COMPETITION_ROW_NAMES.friendly;

  const insertStat = db.prepare(`
    INSERT INTO friendly_player_stats
      (friendly_id, competition, team_id, player_id, player_name, position_tag, goals, assists, rating, yellow_cards, red_card, tackles, pass_pct)
    VALUES
      (@friendly_id, @competition, @team_id, @player_id, @player_name, @position_tag, @goals, @assists, @rating, @yellow_cards, @red_card, @tackles, @pass_pct)
  `);

  [
    { state: homeState, goalsFor: finalScore.home, goalsAgainst: finalScore.away },
    { state: awayState, goalsFor: finalScore.away, goalsAgainst: finalScore.home },
  ].forEach(({ state, goalsFor, goalsAgainst }) => {
    const resultBonus = goalsFor > goalsAgainst ? 0.3 : goalsFor < goalsAgainst ? -0.2 : 0.1;
    const roster = db.prepare('SELECT id, name, position_tag FROM players WHERE team_id = ?').all(state.team_id);
    const rosterById = new Map(roster.map((p) => [p.id, p]));

    const everyone = new Map();
    state.on_pitch.forEach((p) => everyone.set(p.id, p));
    (state.subbedOut || []).forEach((p) => { if (!everyone.has(p.id)) everyone.set(p.id, p); });
    (state.dismissed || []).forEach((p) => { if (!everyone.has(p.id)) everyone.set(p.id, p); });

    everyone.forEach((p) => {
      const info = rosterById.get(p.id);
      if (!info) return;
      const yellowCount = p.yellow ? (p.sentOff && p.red !== true ? 2 : 1) : 0;
      const redCard = p.sentOff ? 1 : 0;

      let rating = 6.0 + resultBonus + (Math.random() * 0.6 - 0.3) + p.goals * 0.8 + p.assists * 0.4;
      if (p.category === 'GR') rating += goalsAgainst === 0 ? 0.5 : (goalsAgainst >= 3 ? -0.4 : 0);
      rating -= yellowCount * 0.1;
      if (redCard) rating -= 1.0;
      rating = Math.max(4.0, Math.min(10.0, rating));

      const quality = p.quality || 1;
      const tackles = Math.max(0, Math.round((TACKLE_BASE[p.category] || 0) * quality + (Math.random() * 2 - 1)));
      const passPct = Math.max(40, Math.min(98, Math.round(62 + quality * 10 + (Math.random() * 16 - 8))));

      insertStat.run({
        friendly_id: friendly.id, competition, team_id: state.team_id, player_id: p.id,
        player_name: info.name, position_tag: info.position_tag || '',
        goals: p.goals, assists: p.assists, rating: Number(rating.toFixed(2)),
        yellow_cards: yellowCount, red_card: redCard, tackles, pass_pct: passPct,
      });

      /* Reflete o jogo no perfil do jogador — linha certa consoante a
         competição (Amigáveis / Campeonato / Taça), ver db/database.js. */
      db.applySeasonStat(p.id, rowName, {
        goals: p.goals, assists: p.assists, yellow: yellowCount, red: redCard,
        tackles, passPct, rating: Number(rating.toFixed(2)),
      });
    });
  });

  const scoreText = `${homeState.team_name} ${finalScore.home}-${finalScore.away} ${awayState.team_name}`;
  const outcomeFor = (isHome) => {
    const us = isHome ? finalScore.home : finalScore.away;
    const them = isHome ? finalScore.away : finalScore.home;
    if (us > them) return 'Vitória';
    if (us < them) return 'Derrota';
    return 'Empate';
  };

  /* Na Taça não há empates — se ficou empatado, syncCupFixtureFromFriendly
     (chamado acima) já decidiu o vencedor por desempate; usa-se isso em
     vez do resultado literal do marcador para a mensagem. */
  const cupFixture = friendly.is_cup ? db.prepare('SELECT winner_team_id, decided_by_penalties FROM cup_fixtures WHERE friendly_id = ?').get(friendly.id) : null;
  const cupOutcomeFor = (teamId) => (cupFixture.winner_team_id === teamId ? 'Vitória' : 'Derrota');

  [
    { state: homeState, opponentName: awayState.team_name, isHome: true },
    { state: awayState, opponentName: homeState.team_name, isHome: false },
  ].forEach(({ state, opponentName, isHome }) => {
    if (!state.is_user) return;
    const result = cupFixture ? cupOutcomeFor(state.team_id) : outcomeFor(isHome);
    const label = friendly.is_cup ? 'Taça São Vicente' : (friendly.is_league ? 'Campeonato' : 'Amigável');
    const penaltiesNote = cupFixture?.decided_by_penalties ? ' (nos penáltis)' : '';
    const cupTail = friendly.is_cup
      ? (result === 'Vitória' ? ' Seguem em frente na competição.' : ' Estão eliminados da Taça São Vicente.')
      : '';
    db.prepare(`
      INSERT INTO messages (team_id, type, title, body)
      VALUES (@team_id, @type, @title, @body)
    `).run({
      team_id: state.team_id,
      type: friendly.is_cup ? 'cup_played' : (friendly.is_league ? 'league_played' : 'friendly_played'),
      title: `${result === 'Vitória' ? '🏆' : '📉'} ${label}: ${result.toLowerCase()} contra o ${opponentName}${penaltiesNote}`,
      body: `Resultado final: ${scoreText}${penaltiesNote}.${cupTail}`,
    });
  });
}

/* ---------- Serialização do estado (o que o frontend recebe) ---------- */
function teamStateForClient(state) {
  const everyone = [...state.on_pitch, ...(state.subbedOut || []), ...(state.dismissed || [])];
  const notable = everyone
    .filter((p) => p.goals || p.assists || p.yellow || p.sentOff)
    .map((p) => ({ id: p.id, name: p.name, goals: p.goals || 0, assists: p.assists || 0, yellow: !!p.yellow, sent_off: !!p.sentOff }));

  return {
    team_id: state.team_id,
    team_name: state.team_name,
    team_shield: state.team_shield || null,
    is_user: state.is_user,
    formation: state.formation,
    subs_remaining: state.subs_remaining,
    on_pitch: state.on_pitch.map((p) => ({
      id: p.id, name: p.name, yellow: !!p.yellow, category: p.category,
      jersey_number: p.jersey_number || '', slot_index: p.slot_index,
      goals: p.goals || 0, assists: p.assists || 0,
    })),
    bench: state.bench.map((p) => ({ id: p.id, name: p.name, category: p.category, jersey_number: p.jersey_number || '' })),
    notable_players: notable,
  };
}

function loadLiveRow(friendlyId) {
  return db.prepare('SELECT * FROM live_matches WHERE friendly_id = ?').get(friendlyId);
}

function rowToPayload(row, newEvents) {
  const home = JSON.parse(row.home_state_json);
  const away = JSON.parse(row.away_state_json);
  const events = JSON.parse(row.events_json || '[]');
  return {
    friendly_id: row.friendly_id,
    status: row.status,
    minute: row.current_minute,
    home_score: row.home_score,
    away_score: row.away_score,
    home: teamStateForClient(home),
    away: teamStateForClient(away),
    events,
    new_events: newEvents || [],
  };
}

function persistRow(friendlyId, { minute, homeScore, awayScore, homeState, awayState, schedule, events, status }) {
  db.prepare(`
    UPDATE live_matches SET
      status = @status, current_minute = @minute, home_score = @home_score, away_score = @away_score,
      home_state_json = @home_state_json, away_state_json = @away_state_json,
      schedule_json = @schedule_json, events_json = @events_json, updated_at = datetime('now')
    WHERE friendly_id = @friendly_id
  `).run({
    friendly_id: friendlyId, status, minute, home_score: homeScore, away_score: awayScore,
    home_state_json: JSON.stringify(homeState), away_state_json: JSON.stringify(awayState),
    schedule_json: JSON.stringify(schedule), events_json: JSON.stringify(events),
  });
}

/* Faz o jogo avançar de `fromMinute` (exclusivo) até `toMinute` (inclusivo),
   resolvendo os acontecimentos agendados nesse intervalo. Devolve os novos
   acontecimentos gerados (incluindo intervalo/apito final, se aplicável). */
function advanceTo(row, toMinuteRaw) {
  const homeState = JSON.parse(row.home_state_json);
  const awayState = JSON.parse(row.away_state_json);
  const schedule = JSON.parse(row.schedule_json || '[]');
  const events = JSON.parse(row.events_json || '[]');
  const score = { home: row.home_score, away: row.away_score };

  const toMinute = Math.max(row.current_minute, Math.min(MATCH_LENGTH, toMinuteRaw));
  const newEvents = [];

  const halfTimeAlready = events.some((e) => e.kind === 'half_time');
  const pending = schedule.filter((ev) => ev.minute > row.current_minute && ev.minute <= toMinute);
  pending.sort((a, b) => a.minute - b.minute);

  pending.forEach((ev) => {
    if (!halfTimeAlready && ev.minute >= 45 && !newEvents.some((e) => e.kind === 'half_time') && !events.some((e) => e.kind === 'half_time')) {
      newEvents.push({ minute: 45, kind: 'half_time', text: '⏸ Intervalo.' });
    }
    const feedItem = resolveEvent(ev, homeState, awayState, score);
    if (feedItem) newEvents.push(feedItem);
  });

  if (!halfTimeAlready && toMinute >= 45 && !newEvents.some((e) => e.kind === 'half_time')) {
    newEvents.push({ minute: 45, kind: 'half_time', text: '⏸ Intervalo.' });
  }

  let status = row.status;
  if (toMinute >= MATCH_LENGTH) {
    status = 'finished';
    newEvents.push({ minute: MATCH_LENGTH, kind: 'full_time', text: `🏁 Fim do jogo: ${homeState.team_name} ${score.home}-${score.away} ${awayState.team_name}.` });
    const friendly = db.prepare('SELECT * FROM club_friendlies WHERE id = ?').get(row.friendly_id);
    finalizeMatch(friendly, homeState, awayState, score);
  }

  const allEvents = [...events, ...newEvents];
  persistRow(row.friendly_id, {
    minute: toMinute, homeScore: score.home, awayScore: score.away,
    homeState, awayState, schedule, events: allEvents, status,
  });

  return { newEvents, updatedRow: db.prepare('SELECT * FROM live_matches WHERE friendly_id = ?').get(row.friendly_id) };
}

/* ---------- GET /api/live-matches/:friendlyId — estado atual (ou 404) ---------- */
router.get('/:friendlyId', (req, res) => {
  const row = loadLiveRow(req.params.friendlyId);
  if (!row) return res.status(404).json({ error: 'Este jogo ainda não começou a ser assistido.' });
  res.json(rowToPayload(row));
});

/* ---------- POST /api/live-matches/:friendlyId/start — inicia a sessão ao vivo ---------- */
router.post('/:friendlyId/start', (req, res) => {
  const friendly = db.prepare('SELECT * FROM club_friendlies WHERE id = ?').get(req.params.friendlyId);
  if (!friendly) return res.status(404).json({ error: 'Amigável não encontrado' });

  const existing = loadLiveRow(friendly.id);
  if (existing) return res.json(rowToPayload(existing));

  if (friendly.status !== 'accepted') {
    return res.status(400).json({ error: 'Este amigável já não pode ser assistido ao vivo.' });
  }

  const homeState = buildTeamRoster(friendly.home_team_id);
  const awayState = buildTeamRoster(friendly.away_team_id);
  if (!homeState.on_pitch.length || !awayState.on_pitch.length) {
    return res.status(400).json({ error: 'Uma das equipas não tem jogadores suficientes para este jogo.' });
  }

  const schedule = buildSchedule(homeState, awayState);
  const events = [{ minute: 0, kind: 'kickoff', text: `⚽ Começou o jogo: ${homeState.team_name} vs ${awayState.team_name}!` }];

  db.prepare(`
    INSERT INTO live_matches (friendly_id, status, current_minute, home_score, away_score, home_state_json, away_state_json, schedule_json, events_json)
    VALUES (@friendly_id, 'in_progress', 0, 0, 0, @home_state_json, @away_state_json, @schedule_json, @events_json)
  `).run({
    friendly_id: friendly.id,
    home_state_json: JSON.stringify(homeState),
    away_state_json: JSON.stringify(awayState),
    schedule_json: JSON.stringify(schedule),
    events_json: JSON.stringify(events),
  });

  const row = loadLiveRow(friendly.id);
  res.status(201).json(rowToPayload(row));
});

/* ---------- POST /api/live-matches/:friendlyId/tick — avança N minutos ---------- */
router.post('/:friendlyId/tick', (req, res) => {
  const row = loadLiveRow(req.params.friendlyId);
  if (!row) return res.status(404).json({ error: 'Este jogo ainda não começou a ser assistido.' });
  if (row.status === 'finished') return res.json(rowToPayload(row));

  const minutes = Math.max(1, Math.min(45, Number(req.body.minutes) || 5));
  const { newEvents, updatedRow } = advanceTo(row, row.current_minute + minutes);
  res.json(rowToPayload(updatedRow, newEvents));
});

/* ---------- POST /api/live-matches/:friendlyId/substitution ---------- */
router.post('/:friendlyId/substitution', (req, res) => {
  const row = loadLiveRow(req.params.friendlyId);
  if (!row) return res.status(404).json({ error: 'Este jogo ainda não começou a ser assistido.' });
  if (row.status === 'finished') return res.status(400).json({ error: 'O jogo já terminou.' });

  const { team_id, player_out_id, player_in_id } = req.body;
  const homeState = JSON.parse(row.home_state_json);
  const awayState = JSON.parse(row.away_state_json);
  const side = Number(homeState.team_id) === Number(team_id) ? 'home' : (Number(awayState.team_id) === Number(team_id) ? 'away' : null);
  if (!side) return res.status(400).json({ error: 'Equipa inválida para este jogo.' });

  const state = side === 'home' ? homeState : awayState;
  if (state.subs_remaining <= 0) return res.status(400).json({ error: 'Já não tens substituições disponíveis.' });

  const outIdx = state.on_pitch.findIndex((p) => Number(p.id) === Number(player_out_id));
  const inIdx = state.bench.findIndex((p) => Number(p.id) === Number(player_in_id));
  if (outIdx === -1) return res.status(400).json({ error: 'Esse jogador não está em campo.' });
  if (inIdx === -1) return res.status(400).json({ error: 'Esse jogador não está no banco.' });

  const [playerOut] = state.on_pitch.splice(outIdx, 1);
  const [playerIn] = state.bench.splice(inIdx, 1);
  state.on_pitch.push({
    id: playerIn.id, name: playerIn.name, category: playerIn.category, jersey_number: playerIn.jersey_number || '',
    quality: playerIn.quality, yellow: false, goals: 0, assists: 0, slot_index: playerOut.slot_index,
  });
  state.subs_remaining -= 1;
  state.subbedOut = state.subbedOut || [];
  state.subbedOut.push(playerOut);
  if (!state.appeared.includes(playerIn.id)) state.appeared.push(playerIn.id);

  const event = { minute: row.current_minute, kind: 'substitution', text: `🔄 Substituição no ${state.team_name}: ${playerIn.name} entra, ${playerOut.name} sai.` };
  const events = [...JSON.parse(row.events_json || '[]'), event];

  persistRow(row.friendly_id, {
    minute: row.current_minute, homeScore: row.home_score, awayScore: row.away_score,
    homeState, awayState, schedule: JSON.parse(row.schedule_json || '[]'), events, status: row.status,
  });

  const updatedRow = loadLiveRow(row.friendly_id);
  res.json(rowToPayload(updatedRow, [event]));
});

/* ---------- POST /api/live-matches/:friendlyId/tactic — muda a formação a meio do jogo ---------- */
router.post('/:friendlyId/tactic', (req, res) => {
  const row = loadLiveRow(req.params.friendlyId);
  if (!row) return res.status(404).json({ error: 'Este jogo ainda não começou a ser assistido.' });
  if (row.status === 'finished') return res.status(400).json({ error: 'O jogo já terminou.' });

  const { team_id, formation } = req.body;
  if (!VALID_FORMATIONS.includes(formation)) return res.status(400).json({ error: 'Formação inválida.' });

  const homeState = JSON.parse(row.home_state_json);
  const awayState = JSON.parse(row.away_state_json);
  const side = Number(homeState.team_id) === Number(team_id) ? 'home' : (Number(awayState.team_id) === Number(team_id) ? 'away' : null);
  if (!side) return res.status(400).json({ error: 'Equipa inválida para este jogo.' });

  const state = side === 'home' ? homeState : awayState;
  if (state.formation === formation) return res.json(rowToPayload(row));
  state.formation = formation;
  /* Reatribui os slots do campo pela ordem em que os jogadores já estavam
     em campo — a nova formação tem sempre 11 posições, só a forma muda. */
  state.on_pitch.forEach((p, i) => { p.slot_index = i; });

  const event = { minute: row.current_minute, kind: 'tactic_change', text: `📋 ${state.team_name} muda para ${formation}.` };
  const events = [...JSON.parse(row.events_json || '[]'), event];

  persistRow(row.friendly_id, {
    minute: row.current_minute, homeScore: row.home_score, awayScore: row.away_score,
    homeState, awayState, schedule: JSON.parse(row.schedule_json || '[]'), events, status: row.status,
  });

  const updatedRow = loadLiveRow(row.friendly_id);
  res.json(rowToPayload(updatedRow, [event]));
});

/* ---------- Força o fim de qualquer jogo ao vivo ainda por terminar ----------
   Chamado a partir de POST /api/game/advance (routes/game.js) antes de o
   calendário mudar de dia — se o utilizador saltou o jogo de hoje ou saiu a
   meio, isto termina a simulação de imediato (avança direto ao minuto 90)
   para o amigável nunca ficar preso em "accepted" para sempre. */
function finishStaleLiveMatches(todayDateStr) {
  const stale = db.prepare(`
    SELECT lm.* FROM live_matches lm
    JOIN club_friendlies f ON f.id = lm.friendly_id
    WHERE lm.status = 'in_progress' AND f.match_date <= ?
  `).all(todayDateStr);

  const finished = [];
  stale.forEach((row) => {
    const { updatedRow } = advanceTo(row, MATCH_LENGTH);
    finished.push({
      friendly_id: updatedRow.friendly_id,
      home_score: updatedRow.home_score,
      away_score: updatedRow.away_score,
    });
  });
  return finished;
}

module.exports = router;
module.exports.finishStaleLiveMatches = finishStaleLiveMatches;