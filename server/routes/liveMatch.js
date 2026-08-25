/* ==========================================================
   FMcriol — Rotas da API para Jogos ao Vivo
   Simulação minuto a minuto de um amigável de hoje que envolva o
   clube do utilizador: golos, cartões, substituições e mudanças
   de tática em tempo real, com o resultado final a ser gravado
   exatamente como um amigável normal (club_friendlies + stats).
   ========================================================== */
const express = require('express');
const db = require('../db/database');
const { buildPostMatchReactions } = require('./matchReactions');

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

/* Dribles e passes por jogo — mesma lógica e comentário em
   routes/competitionStats.js e routes/game.js, repetida aqui porque esta
   rota também não partilha módulo com as outras duas (só as reações
   pós-jogo passaram a ser partilhadas, ver routes/matchReactions.js). */
const DRIBBLE_BASE = { GR: 0.1, DEF: 0.6, MED: 1.6, MO: 3.2, PL: 2.6 };
const PASS_BASE = { GR: 16, DEF: 42, MED: 52, MO: 32, PL: 24 };

function extractAttr(jsonText, name) {
  let list;
  try { list = JSON.parse(jsonText || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) return null;
  const found = list.find(([n]) => n === name);
  return found ? Number(found[1]) : null;
}
function playerDribbleFactor(player) {
  const technique = extractAttr(player.technical_json, 'Técnica') ?? 10;
  const pace = extractAttr(player.physical_json, 'Velocidade') ?? 10;
  const accel = extractAttr(player.physical_json, 'Aceleração') ?? 10;
  return Math.max(0.4, Math.min(2.5, (technique + pace + accel) / 3 / 10));
}
function playerPassFactor(player) {
  const passing = extractAttr(player.technical_json, 'Passe') ?? extractAttr(player.goalkeeping_json, 'Passe') ?? 10;
  return Math.max(0.4, Math.min(2.2, passing / 10));
}

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

/* ---------- Postura tática (mentalidade) ----------
   Cada equipa escolhe uma postura no início do jogo (por omissão
   'equilibrado') e pode mudá-la a qualquer momento (ver POST
   /:friendlyId/mentality) — tal como já acontecia com a formação.
   ATTACK_MULT pesa o ataque da própria equipa; DEFEND_MULT pesa a
   solidez defensiva contra o ataque adversário. 'contra_ataque' tem
   ainda um bónus extra (ver simulateMentalityLambda) que só dispara
   contra um adversário em postura 'atacante', e que é tanto maior
   quanto mais rápido for o plantel em campo — exatamente como pedido:
   sair rápido em contra-ataque funciona melhor com jogadores velozes. */
const MENTALITIES = ['equilibrado', 'atacante', 'contra_ataque', 'defensiva'];
const MENTALITY_LABELS = {
  equilibrado: 'Equilibrado',
  atacante: 'Atacante',
  contra_ataque: 'Contra-Ataque',
  defensiva: 'Defensiva',
};
const MENTALITY_DESCRIPTIONS = {
  equilibrado: 'Abordagem normal, sem exagerar no ataque nem na defesa.',
  atacante: 'Mais jogadores lançados no ataque — mais golos, mas a defesa fica mais aberta a contra-ataques.',
  contra_ataque: 'Espera pelo erro do adversário e sai rápido — funciona muito melhor com jogadores velozes em campo, principalmente contra equipas em postura atacante.',
  defensiva: 'Fecha-se atrás da bola — muito difícil de sofrer golos, mas cria pouco perigo lá à frente.',
};
const MENTALITY_ATTACK_MULT = { equilibrado: 1, atacante: 1.4, contra_ataque: 0.85, defensiva: 0.6 };
const MENTALITY_DEFEND_MULT = { equilibrado: 1, atacante: 0.65, contra_ataque: 1.05, defensiva: 1.5 };

/* Fator de ritmo do jogador (0.5-2.2, mesma escala de playerQualityFactor),
   com base em Velocidade + Aceleração (physical_json) — usado para o bónus
   de contra-ataque e não para a qualidade geral, que já existe à parte. */
function playerPaceFactor(player) {
  let list;
  try { list = JSON.parse(player.physical_json || '[]'); } catch { list = []; }
  const wanted = new Set(['Velocidade', 'Aceleração']);
  let sum = 0;
  let count = 0;
  if (Array.isArray(list)) {
    list.forEach(([name, value]) => {
      if (wanted.has(name)) {
        const v = Number(value);
        if (Number.isFinite(v)) { sum += v; count += 1; }
      }
    });
  }
  const avg = count ? sum / count : 10;
  return Math.max(0.5, Math.min(2.2, avg / 10));
}

/* Ritmo médio da equipa em campo AGORA (exclui o guarda-redes) — recalculado
   sempre que é preciso, para refletir substituições feitas a meio do jogo. */
function teamPaceFactor(state) {
  const outfield = state.on_pitch.filter((p) => p.category !== 'GR' && Number.isFinite(p.pace));
  if (!outfield.length) return 1;
  return outfield.reduce((sum, p) => sum + p.pace, 0) / outfield.length;
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
   Mesma curva base usada em routes/game.js para os amigáveis simulados
   automaticamente (Poisson simplificado com base na reputação), agora
   ajustada pela postura tática de cada lado (ver MENTALITY_ATTACK_MULT /
   MENTALITY_DEFEND_MULT acima) e, no caso do contra-ataque, pelo ritmo do
   plantel em campo. */
function mentalityLambda(attackRep, defendRep, attackMentality, defendMentality, attackPace) {
  const attackMult = MENTALITY_ATTACK_MULT[attackMentality] ?? 1;
  const defendMult = MENTALITY_DEFEND_MULT[defendMentality] ?? 1;
  let lambda = Math.max(0.35, 1.15 + (attackRep * attackMult - defendRep * defendMult) * 0.3);

  if (attackMentality === 'contra_ataque' && defendMentality === 'atacante') {
    lambda += 0.4 * attackPace;
  }
  return lambda;
}

function rollGoalsFromLambda(lambda) {
  let goals = 0;
  for (let i = 0; i < 8; i += 1) {
    if (Math.random() < lambda / (i + 1.7)) goals += 1;
  }
  return Math.min(goals, 7);
}

/* ---------- Palestras de balneário (pré-jogo / pós-jogo) ----------
   Cópia deliberada da mesma ideia (ladder de 3 níveis + efeito up/down por
   jogador) já usada em routes/morale.js para as perguntas ao treinador —
   mantém-se separada porque routes/morale.js só corre no avanço diário do
   calendário, e isto tem de correr no momento em que o treinador escolhe a
   palestra, no meio de um jogo ao vivo. */
const TALK_HAPPINESS_LADDER = ['Insatisfeito', 'Descontente', 'Contente'];
function talkHappinessIndex(text) {
  const i = TALK_HAPPINESS_LADDER.indexOf(text);
  return i === -1 ? TALK_HAPPINESS_LADDER.indexOf('Contente') : i;
}
function shiftTalkHappiness(text, delta) {
  const next = Math.max(0, Math.min(TALK_HAPPINESS_LADDER.length - 1, talkHappinessIndex(text) + delta));
  return TALK_HAPPINESS_LADDER[next];
}

/* Palestra de PRÉ-JOGO — o mesmo leque de opções serve para qualquer jogo,
   porque ainda não há resultado. */
const TEAM_TALK_PRE = [
  { key: 'calma', icon: '🧘', label: 'Calma e Confiança', description: 'Discurso tranquilo, focado em manter todos confiantes.', effect: { up: 0.5, down: 0.05 } },
  { key: 'motivadora', icon: '🔥', label: 'Discurso Motivador', description: 'Palavras fortes para levantar o grupo — mais impacto, mas mais risco.', effect: { up: 0.65, down: 0.15 } },
  { key: 'exigente', icon: '📢', label: 'Exigir Mais', description: 'Pedes mais nível a todos — pode incomodar os mais sensíveis.', effect: { up: 0.35, down: 0.35 } },
  { key: 'tatica', icon: '📋', label: 'Foco Tático', description: 'Sem grandes emoções, só instruções — efeito reduzido dos dois lados.', effect: { up: 0.15, down: 0.05 } },
];

/* Palestra de PÓS-JOGO — as opções mudam consoante o resultado. */
const TEAM_TALK_POST = {
  win: [
    { key: 'elogiar', icon: '🎉', label: 'Elogiar a Equipa', description: 'Reconheces o esforço de todos.', effect: { up: 0.6, down: 0.05 } },
    { key: 'moderado', icon: '🙂', label: 'Parabéns Comedidos', description: 'Contente, mas sem exageros.', effect: { up: 0.35, down: 0.05 } },
    { key: 'exigir_mais', icon: '⚠️', label: 'Avisar Para Não Baixar o Nível', description: 'Festejas pouco e já pedes mais para o próximo jogo — alguns podem sentir-se pouco reconhecidos.', effect: { up: 0.25, down: 0.25 } },
  ],
  draw: [
    { key: 'compreensivo', icon: '🤝', label: 'Compreensão e Confiança', description: 'Mostras que confias no grupo apesar do empate.', effect: { up: 0.5, down: 0.1 } },
    { key: 'motivar', icon: '🔄', label: 'Motivar Para o Próximo Jogo', description: 'Vira a página rapidamente.', effect: { up: 0.4, down: 0.1 } },
    { key: 'criticar', icon: '😠', label: 'Criticar a Falta de Ambição', description: 'Mostras descontentamento com o resultado.', effect: { up: 0.15, down: 0.4 } },
  ],
  loss: [
    { key: 'apoiar', icon: '🤗', label: 'Apoiar o Grupo', description: 'Não culpas ninguém, foca-te em recuperar juntos.', effect: { up: 0.45, down: 0.1 } },
    { key: 'motivar', icon: '🔄', label: 'Focar na Recuperação', description: 'Discurso equilibrado, olhando já para o próximo jogo.', effect: { up: 0.3, down: 0.2 } },
    { key: 'criticar', icon: '💢', label: 'Criticar Duramente', description: 'Não escondes o descontentamento com a exibição — arriscado.', effect: { up: 0.1, down: 0.55 } },
  ],
};

function matchResultFor(homeScore, awayScore, isHome) {
  const us = isHome ? homeScore : awayScore;
  const them = isHome ? awayScore : homeScore;
  if (us > them) return 'win';
  if (us < them) return 'loss';
  return 'draw';
}

/* Aplica o efeito escolhido a todo o plantel do clube do utilizador — cada
   jogador tem uma hipótese independente de subir, descer, ou não mudar de
   nível de moral (happiness), tal como em applyQuestionEffect
   (routes/morale.js). Devolve também até 3 nomes de cada lado, só para dar
   um exemplo concreto no resultado da palestra em vez de só um número. */
function applyTeamTalkEffect(teamId, effect) {
  const players = db.prepare('SELECT id, name, happiness FROM players WHERE team_id = ?').all(teamId);
  const update = db.prepare("UPDATE players SET happiness = ?, updated_at = datetime('now') WHERE id = ?");
  let up = 0; let down = 0;
  const upNames = []; const downNames = [];

  players.forEach((p) => {
    const roll = Math.random();
    if (roll < effect.up) {
      update.run(shiftTalkHappiness(p.happiness, 1), p.id);
      up += 1;
      if (upNames.length < 3) upNames.push(p.name);
    } else if (roll < effect.up + effect.down) {
      update.run(shiftTalkHappiness(p.happiness, -1), p.id);
      down += 1;
      if (downNames.length < 3) downNames.push(p.name);
    }
  });

  return { up, down, total: players.length, upNames, downNames };
}

/* ---------- Estado atual do balneário (para a palestra saber o ponto de partida) ----------
   Contagem simples pelos 3 níveis de moral existentes — dá ao treinador
   contexto sobre se o grupo já anda contente ou se precisa mesmo de um
   empurrão antes de escolher o tom da palestra. */
function squadMoodBreakdown(teamId) {
  const rows = db.prepare('SELECT happiness FROM players WHERE team_id = ?').all(teamId);
  const counts = { Contente: 0, Descontente: 0, Insatisfeito: 0 };
  rows.forEach((r) => {
    const key = TALK_HAPPINESS_LADDER.includes(r.happiness) ? r.happiness : 'Contente';
    counts[key] += 1;
  });
  return { total: rows.length, counts };
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
    quality: playerQualityFactor(p), pace: playerPaceFactor(p), yellow: false, goals: 0, assists: 0,
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
      jersey_number: p.jersey_number || '', quality: playerQualityFactor(p), pace: playerPaceFactor(p),
    }));

  if (!bench.length) {
    bench = squad
      .filter((p) => !onPitchIds.has(p.id))
      .slice(0, 7)
      .map((p) => ({
        id: p.id, name: p.name, category: p.category, position_code: p.position_code,
        jersey_number: p.jersey_number || '', quality: playerQualityFactor(p), pace: playerPaceFactor(p),
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
    mentality: 'equilibrado',
    on_pitch: onPitch,
    bench,
    subs_remaining: MAX_SUBS,
    appeared: onPitch.map((p) => p.id),
  };
}

/* Quantas "chances" (lances de perigo sem golo) uma equipa cria, consoante
   a sua postura — o ataque cria mais oportunidades, a defensiva cria menos
   (mas também sofre menos, ver MENTALITY_DEFEND_MULT). */
const CHANCE_BASE_COUNT = 4;
const CHANCE_MENTALITY_BONUS = { equilibrado: 0, atacante: 3, contra_ataque: 1, defensiva: -2 };

/* ---------- Calendário de acontecimentos sorteado no início do jogo (ou a
   partir do minuto em que a postura tática muda a meio do jogo) ----------
   Golos, cartões e lances de perigo são sorteados de antemão (quantos e a
   que minuto), mas só são revelados ao utilizador à medida que o relógio
   avança — como o jogo é "ao vivo", o resultado final não existe antes do
   apito final. `fromMinute` permite gerar só a parte do calendário que
   ainda falta (usado quando uma equipa muda de postura a meio do jogo —
   ver POST /:friendlyId/mentality — para não recomeçar o jogo do zero, só
   ajustar o que ainda está por vir). */
function buildSchedule(homeState, awayState, fromMinute = 0) {
  const remainingFraction = Math.max(0, (MATCH_LENGTH - fromMinute) / MATCH_LENGTH);
  const homePace = teamPaceFactor(homeState);
  const awayPace = teamPaceFactor(awayState);

  const homeLambda = mentalityLambda(homeState.reputation + 0.25, awayState.reputation, homeState.mentality, awayState.mentality, homePace) * remainingFraction;
  const awayLambda = mentalityLambda(awayState.reputation, homeState.reputation + 0.25, awayState.mentality, homeState.mentality, awayPace) * remainingFraction;
  const homeGoals = rollGoalsFromLambda(homeLambda);
  const awayGoals = rollGoalsFromLambda(awayLambda);

  const minuteInRange = () => fromMinute + 1 + Math.floor(Math.random() * Math.max(1, MATCH_LENGTH - fromMinute));

  const events = [];
  for (let i = 0; i < homeGoals; i += 1) events.push({ minute: minuteInRange(), type: 'goal', side: 'home' });
  for (let i = 0; i < awayGoals; i += 1) events.push({ minute: minuteInRange(), type: 'goal', side: 'away' });

  ['home', 'away'].forEach((side) => {
    let yellows = 0;
    for (let i = 0; i < 5; i += 1) { if (Math.random() < 0.32 * remainingFraction) yellows += 1; }
    for (let i = 0; i < yellows; i += 1) events.push({ minute: minuteInRange(), type: 'yellow', side });
    if (Math.random() < 0.08 * remainingFraction) events.push({ minute: minuteInRange(), type: 'red', side });

    /* ---------- Lances de perigo (sem golo) ---------- */
    const attackMentality = (side === 'home' ? homeState : awayState).mentality || 'equilibrado';
    const defendMentality = (side === 'home' ? awayState : homeState).mentality || 'equilibrado';
    const base = CHANCE_BASE_COUNT + (CHANCE_MENTALITY_BONUS[attackMentality] ?? 0) - (defendMentality === 'defensiva' ? 2 : 0);
    const count = Math.max(0, Math.round(base * remainingFraction)) + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i += 1) events.push({ minute: minuteInRange(), type: 'chance', side, mentality: attackMentality });
  });

  events.sort((a, b) => a.minute - b.minute);
  return events;
}

/* ---------- Descrições dos lances (golos e chances) ----------
   Um pequeno leque de frases por situação, com um prefixo opcional que
   identifica o estilo do lance (contra-ataque veloz, pressão constante da
   postura atacante, jogada paciente da postura defensiva) — é isto que dá
   "textura" ao comentário em vez de repetir sempre a mesma frase. */
const MENTALITY_PREFIXES = {
  contra_ataque: ['Contra-ataque relâmpago! ', 'Transição rapidíssima: ', 'Saem em contra-ataque a alta velocidade: '],
  atacante: ['Mais uma pressão insistente lá à frente: ', 'Depois de tanto insistir no ataque, ', ''],
  defensiva: ['Jogada paciente, construída com calma: ', 'Raro lance de perigo, mas eficaz: ', ''],
  equilibrado: [''],
};
function mentalityPrefix(mentality) {
  const pool = MENTALITY_PREFIXES[mentality] || MENTALITY_PREFIXES.equilibrado;
  return pool[Math.floor(Math.random() * pool.length)];
}

const GOAL_TEMPLATES_ASSISTED = [
  (a) => `⚽ Golo do ${a.team}! ${a.scorer} marca, assistido por ${a.assister}.`,
  (a) => `⚽ ${a.scorer} não perdoa e festeja pelo ${a.team}, após o passe de ${a.assister}.`,
  (a) => `⚽ Belíssima jogada do ${a.team}: ${a.assister} serve ${a.scorer}, que só teve de encostar.`,
];
const GOAL_TEMPLATES_SOLO = [
  (a) => `⚽ Golo do ${a.team}! ${a.scorer} marca.`,
  (a) => `⚽ ${a.scorer} resolve sozinho e coloca o ${a.team} a festejar!`,
  (a) => `⚽ Belo remate de ${a.scorer} — o ${a.team} chega ao golo!`,
];

const CHANCE_OUTCOME_TEMPLATES = {
  saved: [
    (a) => `🧤 Grande defesa de ${a.keeper} a negar o golo a ${a.attacker} (${a.team}).`,
    (a) => `🧤 ${a.keeper} evita o pior e defende o remate perigoso de ${a.attacker} (${a.team}).`,
  ],
  off_target: [
    (a) => `🎯 ${a.attacker} (${a.team}) desperdiça boa oportunidade, atira para fora.`,
    (a) => `🎯 Remate de ${a.attacker} (${a.team}) sai muito por cima da baliza.`,
  ],
  blocked: [
    (a) => `🛡️ A defesa do ${a.defTeam} corta em cima da linha e evita o golo de ${a.attacker}.`,
    (a) => `🛡️ Bloqueio decisivo da defesa do ${a.defTeam} ao remate de ${a.attacker}.`,
  ],
  woodwork: [
    (a) => `🥅 Na trave! ${a.attacker} (${a.team}) acerta na madeira, a bola não entra por centímetros.`,
    (a) => `🥅 O poste nega o golo a ${a.attacker} (${a.team})!`,
  ],
};

/* ---------- Resolve um único acontecimento agendado, mutando o estado ---------- */
function resolveEvent(ev, homeState, awayState, scoreRef) {
  const state = ev.side === 'home' ? homeState : awayState;
  const teamLabel = state.team_name;

  if (ev.type === 'goal') {
    const outfield = state.on_pitch.filter((p) => p.category !== 'GR');
    const prefix = mentalityPrefix(state.mentality);

    /* Plantel muito curto (menos de 6 em campo) — nem todo golo tem de
       ficar atribuído a alguém; conta na mesma para o marcador, mas sem
       nome (ver mesma ideia em routes/game.js e routes/competitionStats.js). */
    if (outfield.length < 6 && Math.random() < 0.35) {
      scoreRef[ev.side] += 1;
      return { minute: ev.minute, kind: 'goal', side: ev.side, text: `${prefix}⚽ Golo do ${teamLabel}! A confusão na área não deixou ver quem marcou.` };
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

    const templates = assister ? GOAL_TEMPLATES_ASSISTED : GOAL_TEMPLATES_SOLO;
    const template = templates[Math.floor(Math.random() * templates.length)];
    const text = prefix + template({ team: teamLabel, scorer: scorer.name, assister: assister ? assister.name : null });
    /* player_id / assister_id / side vão no evento (além do texto) para o
       frontend poder animar o lance no campo — ver playLiveBallAnimation
       em public/dashboard.js — associando o golo ao boneco certo. */
    return {
      minute: ev.minute, kind: 'goal', side: ev.side, text,
      player_id: scorer.id, assister_id: assister ? assister.id : null,
    };
  }

  if (ev.type === 'chance') {
    const defendState = ev.side === 'home' ? awayState : homeState;
    const outfield = state.on_pitch.filter((p) => p.category !== 'GR');
    if (!outfield.length) return null;

    const attacker = pickWeightedWithFocus(outfield, SCORE_WEIGHT, 'Goleador') || outfield[Math.floor(Math.random() * outfield.length)];
    const keeper = defendState.on_pitch.find((p) => p.category === 'GR');

    const roll = Math.random();
    let outcomeKey;
    if (keeper && roll < 0.45) outcomeKey = 'saved';
    else if (roll < 0.7) outcomeKey = 'off_target';
    else if (roll < 0.9) outcomeKey = 'blocked';
    else outcomeKey = 'woodwork';

    const templates = CHANCE_OUTCOME_TEMPLATES[outcomeKey];
    const template = templates[Math.floor(Math.random() * templates.length)];
    const prefix = mentalityPrefix(ev.mentality || state.mentality);
    const text = prefix + template({
      attacker: attacker.name, team: teamLabel, defTeam: defendState.team_name,
      keeper: keeper ? keeper.name : 'o guarda-redes',
    });
    /* Mesma ideia do golo: player_id (quem remata) + keeper_id (quem
       defende, quando aplicável) + outcome, para a animação do lance no
       campo saber que bonecos mexer e onde a bola deve parar. */
    return {
      minute: ev.minute, kind: 'chance', side: ev.side, text,
      player_id: attacker.id, keeper_id: keeper ? keeper.id : null, outcome: outcomeKey,
    };
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
      (friendly_id, competition, team_id, player_id, player_name, position_tag, goals, assists, rating, yellow_cards, red_card, tackles, pass_pct, dribbles, passes)
    VALUES
      (@friendly_id, @competition, @team_id, @player_id, @player_name, @position_tag, @goals, @assists, @rating, @yellow_cards, @red_card, @tackles, @pass_pct, @dribbles, @passes)
  `);

  [
    { state: homeState, goalsFor: finalScore.home, goalsAgainst: finalScore.away },
    { state: awayState, goalsFor: finalScore.away, goalsAgainst: finalScore.home },
  ].forEach(({ state, goalsFor, goalsAgainst }) => {
    const resultBonus = goalsFor > goalsAgainst ? 0.3 : goalsFor < goalsAgainst ? -0.2 : 0.1;
    const roster = db.prepare('SELECT id, name, position_tag, technical_json, physical_json, goalkeeping_json FROM players WHERE team_id = ?').all(state.team_id);
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
      const dribbles = Math.max(0, Math.round((DRIBBLE_BASE[p.category] || 1) * playerDribbleFactor(info) + (Math.random() * 2 - 1)));
      const passes = Math.max(0, Math.round((PASS_BASE[p.category] || 20) * playerPassFactor(info) + (Math.random() * 10 - 5)));

      insertStat.run({
        friendly_id: friendly.id, competition, team_id: state.team_id, player_id: p.id,
        player_name: info.name, position_tag: info.position_tag || '',
        goals: p.goals, assists: p.assists, rating: Number(rating.toFixed(2)),
        yellow_cards: yellowCount, red_card: redCard, tackles, pass_pct: passPct, dribbles, passes,
      });

      /* Reflete o jogo no perfil do jogador — linha certa consoante a
         competição (Amigáveis / Campeonato / Taça), ver db/database.js. */
      db.applySeasonStat(p.id, rowName, {
        goals: p.goals, assists: p.assists, yellow: yellowCount, red: redCard,
        tackles, dribbles, passes, passPct, rating: Number(rating.toFixed(2)),
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

    const goalsFor = isHome ? finalScore.home : finalScore.away;
    const goalsAgainst = isHome ? finalScore.away : finalScore.home;
    const opponentState = isHome ? awayState : homeState;
    const competitionPhrase = friendly.is_cup ? 'na Taça São Vicente' : (friendly.is_league ? 'no Campeonato' : 'nos amigáveis');

    /* Mesma lógica dos jogos simulados automaticamente (ver
       routes/game.js:simulateSingleFriendly) — nota dos adeptos, reação
       da direção e Jogador do Jogo, agora com base nas estatísticas reais
       do jogo que acabou de ser assistido ao vivo. */
    const { extraJson, potm } = buildPostMatchReactions({
      friendlyId: friendly.id, teamId: state.team_id, teamName: state.team_name, opponentName,
      goalsFor, goalsAgainst, isHome, teamReputation: state.reputation, opponentReputation: opponentState.reputation,
      competitionPhrase,
    });

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, extra_json)
      VALUES (@team_id, @type, @title, @body, @extra_json)
    `).run({
      team_id: state.team_id,
      type: friendly.is_cup ? 'cup_played' : (friendly.is_league ? 'league_played' : 'friendly_played'),
      title: `${result === 'Vitória' ? '🏆' : '📉'} ${label}: ${result.toLowerCase()} contra o ${opponentName}${penaltiesNote}`,
      body: `Resultado final: ${scoreText}${penaltiesNote}.${cupTail}`,
      extra_json: extraJson,
    });

    if (potm) {
      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id)
        VALUES (@team_id, 'player_of_match', @title, @body, @player_id)
      `).run({ team_id: state.team_id, title: potm.title, body: potm.body, player_id: potm.player_id });
    }
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
    mentality: state.mentality || 'equilibrado',
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
  const friendly = db.prepare('SELECT is_cup, is_league, pre_talk_given, post_talk_given FROM club_friendlies WHERE id = ?').get(row.friendly_id);
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
    pre_talk_given: !!friendly?.pre_talk_given,
    post_talk_given: !!friendly?.post_talk_given,
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
    quality: playerIn.quality, pace: playerIn.pace, yellow: false, goals: 0, assists: 0, slot_index: playerOut.slot_index,
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

/* ---------- GET /api/live-matches/meta/mentalities — catálogo de posturas ----------
   Lista fixa (label + descrição) para o frontend construir o seletor sem
   duplicar os textos aqui. */
router.get('/meta/mentalities', (req, res) => {
  res.json(MENTALITIES.map((key) => ({ key, label: MENTALITY_LABELS[key], description: MENTALITY_DESCRIPTIONS[key] })));
});

/* ---------- POST /api/live-matches/:friendlyId/mentality — muda a postura tática a meio do jogo ----------
   Atacante / Contra-Ataque / Defensiva / Equilibrado (ver MENTALITIES acima).
   Só o que ainda falta do jogo é reconstruído (golos, cartões e lances de
   perigo a partir do minuto atual) — o que já aconteceu fica exatamente
   como estava, tal como acontece com a mudança de formação. */
router.post('/:friendlyId/mentality', (req, res) => {
  const row = loadLiveRow(req.params.friendlyId);
  if (!row) return res.status(404).json({ error: 'Este jogo ainda não começou a ser assistido.' });
  if (row.status === 'finished') return res.status(400).json({ error: 'O jogo já terminou.' });

  const { team_id, mentality } = req.body;
  if (!MENTALITIES.includes(mentality)) return res.status(400).json({ error: 'Postura tática inválida.' });

  const homeState = JSON.parse(row.home_state_json);
  const awayState = JSON.parse(row.away_state_json);
  const side = Number(homeState.team_id) === Number(team_id) ? 'home' : (Number(awayState.team_id) === Number(team_id) ? 'away' : null);
  if (!side) return res.status(400).json({ error: 'Equipa inválida para este jogo.' });

  const state = side === 'home' ? homeState : awayState;
  if (state.mentality === mentality) return res.json(rowToPayload(row));
  state.mentality = mentality;

  const schedule = JSON.parse(row.schedule_json || '[]');
  const pastSchedule = schedule.filter((ev) => ev.minute <= row.current_minute);
  const futureSchedule = buildSchedule(homeState, awayState, row.current_minute);
  const newSchedule = [...pastSchedule, ...futureSchedule];

  const event = { minute: row.current_minute, kind: 'mentality_change', text: `🧠 ${state.team_name} muda para postura ${MENTALITY_LABELS[mentality]}.` };
  const events = [...JSON.parse(row.events_json || '[]'), event];

  persistRow(row.friendly_id, {
    minute: row.current_minute, homeScore: row.home_score, awayScore: row.away_score,
    homeState, awayState, schedule: newSchedule, events, status: row.status,
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

/* ---------- GET /api/live-matches/:friendlyId/team-talk-options ----------
   Devolve as opções de palestra disponíveis: pré-jogo (sempre as mesmas) e
   pós-jogo (só depois de terminado, já filtradas pelo resultado real do
   clube do utilizador) — assim o frontend nunca precisa de duplicar estes
   textos nem de adivinhar o resultado por conta própria. */
router.get('/:friendlyId/team-talk-options', (req, res) => {
  const friendly = db.prepare(`
    SELECT cf.*,
           h.name AS home_name, h.shield_path AS home_shield, h.reputation_stars AS home_reputation,
           a.name AS away_name, a.shield_path AS away_shield, a.reputation_stars AS away_reputation
    FROM club_friendlies cf
    JOIN teams h ON h.id = cf.home_team_id
    JOIN teams a ON a.id = cf.away_team_id
    WHERE cf.id = ?
  `).get(req.params.friendlyId);
  if (!friendly) return res.status(404).json({ error: 'Jogo não encontrado' });

  const userTeam = db.prepare('SELECT id FROM teams WHERE is_user_controlled = 1').get();
  const isHomeUser = userTeam && friendly.home_team_id === userTeam.id;

  const strip = (list) => list.map(({ key, icon, label, description }) => ({ key, icon, label, description }));
  const post = friendly.status === 'played'
    ? strip(TEAM_TALK_POST[matchResultFor(friendly.home_score, friendly.away_score, isHomeUser)] || [])
    : [];

  const myTeam = { name: isHomeUser ? friendly.home_name : friendly.away_name, shield: isHomeUser ? friendly.home_shield : friendly.away_shield, reputation: isHomeUser ? friendly.home_reputation : friendly.away_reputation };
  const opponent = { name: isHomeUser ? friendly.away_name : friendly.home_name, shield: isHomeUser ? friendly.away_shield : friendly.home_shield, reputation: isHomeUser ? friendly.away_reputation : friendly.home_reputation };
  const competitionLabel = friendly.is_cup ? 'Taça São Vicente' : (friendly.is_league ? 'Campeonato' : 'Amigável');

  res.json({
    pre: strip(TEAM_TALK_PRE),
    pre_talk_given: !!friendly.pre_talk_given,
    post,
    post_talk_given: !!friendly.post_talk_given,
    match_date: friendly.match_date,
    competition_label: competitionLabel,
    is_home: isHomeUser,
    my_team: myTeam,
    opponent,
    mood: userTeam ? squadMoodBreakdown(userTeam.id) : null,
  });
});

/* ---------- POST /api/live-matches/:friendlyId/team-talk — palestra de balneário ----------
   phase: 'pre' (antes do jogo começar) ou 'post' (depois do apito final).
   Cada uma só pode ser dada uma vez por jogo (ver pre_talk_given /
   post_talk_given em club_friendlies) — nem o pré-jogo nem o pós-jogo se
   repetem, mesmo que a janela seja reaberta. */
router.post('/:friendlyId/team-talk', (req, res) => {
  const friendly = db.prepare('SELECT * FROM club_friendlies WHERE id = ?').get(req.params.friendlyId);
  if (!friendly) return res.status(404).json({ error: 'Jogo não encontrado' });

  const userTeam = db.prepare('SELECT id FROM teams WHERE is_user_controlled = 1').get();
  const isHomeUser = userTeam && friendly.home_team_id === userTeam.id;
  const isAwayUser = userTeam && friendly.away_team_id === userTeam.id;
  if (!isHomeUser && !isAwayUser) return res.status(400).json({ error: 'Este jogo não envolve o teu clube.' });

  const { phase, talk_key } = req.body;
  let option;

  if (phase === 'pre') {
    if (friendly.pre_talk_given) return res.status(400).json({ error: 'Já deste a palestra de pré-jogo.' });
    option = TEAM_TALK_PRE.find((o) => o.key === talk_key);
    if (!option) return res.status(400).json({ error: 'Palestra inválida.' });
    db.prepare('UPDATE club_friendlies SET pre_talk_given = 1 WHERE id = ?').run(friendly.id);
  } else if (phase === 'post') {
    if (friendly.status !== 'played') return res.status(400).json({ error: 'O jogo ainda não terminou.' });
    if (friendly.post_talk_given) return res.status(400).json({ error: 'Já deste a palestra de pós-jogo.' });
    const result = matchResultFor(friendly.home_score, friendly.away_score, isHomeUser);
    option = (TEAM_TALK_POST[result] || []).find((o) => o.key === talk_key);
    if (!option) return res.status(400).json({ error: 'Palestra inválida.' });
    db.prepare('UPDATE club_friendlies SET post_talk_given = 1 WHERE id = ?').run(friendly.id);
  } else {
    return res.status(400).json({ error: 'Fase de palestra inválida.' });
  }

  const summary = applyTeamTalkEffect(userTeam.id, option.effect);
  res.json({ ok: true, ...summary });
});

module.exports = router;
module.exports.finishStaleLiveMatches = finishStaleLiveMatches;