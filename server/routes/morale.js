/* ==========================================================
   FMcriol — Rotas da API para a Moral do Balneário
   Personalidade dos jogadores (Muito Fiel … Muito Problemático) gera, de
   vez em quando, acontecimentos no balneário: jogadores fiéis ajudam a unir
   o grupo, jogadores problemáticos arranjam brigas ou fazem birras — sobre
   os quais o treinador pode agir (lista de transferências, afastar
   temporariamente, ou ignorar). De vez em quando também chega à caixa de
   entrada uma pergunta ao treinador, cuja resposta mexe com a moral do
   plantel. Tudo isto é propositadamente raro — poucas vezes por época — e
   só é gerado para o clube do utilizador (os outros 14 clubes não têm
   caixa de entrada para ninguém ver).
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

/* Ladder de moral usado em todo o jogo (ver também db/database.js e
   activities.js) — do pior para o melhor. */
const HAPPINESS_LADDER = ['Insatisfeito', 'Descontente', 'Contente'];

function happinessIndex(text) {
  const i = HAPPINESS_LADDER.indexOf(text);
  return i === -1 ? HAPPINESS_LADDER.indexOf('Contente') : i;
}
function shiftHappiness(text, delta) {
  const next = Math.max(0, Math.min(HAPPINESS_LADDER.length - 1, happinessIndex(text) + delta));
  return HAPPINESS_LADDER[next];
}

const LOYAL_TIERS = ['Fiel', 'Muito Fiel'];
const PROBLEM_TIERS = ['Problemático', 'Muito Problemático'];

/* ---------- Textos de apoio ---------- */
const LOYALTY_FLAVOUR = [
  'organizou um jantar de equipa e o balneário nunca esteve tão unido',
  'falou a sós com os mais novos do plantel e deu-lhes confiança para a época',
  'puxou pelo grupo numa sessão de treino mais dura, e todos seguiram o exemplo',
  'resolveu um mal-entendido entre colegas antes de este se tornar um problema',
];
const FIGHT_FLAVOUR = [
  'uma discussão acesa com um colega de equipa no final do treino',
  'uma troca de palavras feia com outro jogador no balneário',
  'um desentendimento com um companheiro de equipa que quase chegou às mãos',
];
const TANTRUM_FLAVOUR = [
  'exigiu explicações por não estar a jogar mais minutos',
  'recusou-se a participar no treino, queixando-se da falta de oportunidades',
  'fez queixa junto da equipa técnica por continuar afastado da titularidade',
];

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

/* ---------- Perguntas ao treinador ----------
   Cada pergunta tem 2 opções; cada opção diz que efeito tem na moral do
   plantel (aplicado a todos os jogadores, com alguma variação aleatória —
   ver applyQuestionEffect). */
const QUESTION_BANK = [
  {
    prompt: 'O balneário anda dividido sobre a intensidade dos treinos desta semana. Como decides?',
    options: [
      { key: 'a', label: 'Aumentar a exigência', effect: { up: 0.35, down: 0.25 } },
      { key: 'b', label: 'Manter um ritmo tranquilo', effect: { up: 0.55, down: 0.02 } },
    ],
  },
  {
    prompt: 'Um jogador mais experiente pede-te 5 minutos para desabafar sobre o ambiente no grupo. O que fazes?',
    options: [
      { key: 'a', label: 'Ouvir e agir sobre o que ele disser', effect: { up: 0.6, down: 0.03 } },
      { key: 'b', label: 'Agradecer, mas focar só no próximo jogo', effect: { up: 0.05, down: 0.3 } },
    ],
  },
  {
    prompt: 'A imprensa pergunta-te sobre as ambições do clube esta época. O que respondes?',
    options: [
      { key: 'a', label: 'Prometer lutar pelo título', effect: { up: 0.45, down: 0.2 } },
      { key: 'b', label: 'Pedir calma e paciência ao clube', effect: { up: 0.3, down: 0.05 } },
    ],
  },
];

function applyQuestionEffect(teamId, effect) {
  const players = db.prepare('SELECT id, happiness FROM players WHERE team_id = ?').all(teamId);
  const update = db.prepare('UPDATE players SET happiness = ?, updated_at = datetime(\'now\') WHERE id = ?');
  let up = 0; let down = 0;

  players.forEach((p) => {
    const roll = Math.random();
    if (roll < effect.up) {
      update.run(shiftHappiness(p.happiness, 1), p.id);
      up += 1;
    } else if (roll < effect.up + effect.down) {
      update.run(shiftHappiness(p.happiness, -1), p.id);
      down += 1;
    }
  });

  return { up, down, total: players.length };
}

/* ---------- Avança a moral do balneário ao chegar a uma nova data ----------
   Chamado a partir de POST /api/game/advance (routes/game.js). Só corre
   para o clube do utilizador — é o único com caixa de entrada e gestão de
   plantel manual. */
const REPORT_GOOD = [
  'tem estado em grande destaque nos treinos',
  'está a impressionar toda a equipa técnica com o seu nível',
  'parece cada vez mais confiante e afinado',
];
const REPORT_BAD = [
  'tem estado abaixo do que se esperava ultimamente',
  'anda com dificuldade em manter o nível de sempre',
  'precisa de trabalhar mais para recuperar a forma',
];
const REPORT_NEUTRAL = [
  'tem estado regular, sem grandes oscilações',
  'continua a cumprir o que se pede dele, nada de especial a assinalar',
];

/* ---------- Adjunto: relatórios de desempenho + pequeno impulso de moral ----------
   Se o clube tiver um Adjunto contratado (ver routes/staff.js), de vez em
   quando manda um relatório sobre um jogador à caixa de entrada — a
   opinião dele sobre a forma de cada um, baseada no rating de treino,
   condição física e felicidade — e tem uma pequena chance extra,
   independente dos jogadores fiéis, de levantar a moral de alguém. Quanto
   melhor o adjunto (quality_stars), mais frequente é isto. */
function runAssistantCoachTick(myTeam, players) {
  const assistant = db.prepare("SELECT * FROM staff WHERE team_id = ? AND role = 'Adjunto'").get(myTeam.id);
  if (!assistant || !players.length) return;
  const q = assistant.quality_stars / 5; // 0..1

  if (Math.random() < 0.01 + q * 0.02) {
    const unhappy = players.filter((p) => happinessIndex(p.happiness) < HAPPINESS_LADDER.length - 1);
    if (unhappy.length) {
      const target = unhappy[Math.floor(Math.random() * unhappy.length)];
      db.prepare("UPDATE players SET happiness = ?, updated_at = datetime('now') WHERE id = ?")
        .run(shiftHappiness(target.happiness, 1), target.id);
    }
  }

  if (Math.random() < 0.015 + q * 0.02) {
    const target = players[Math.floor(Math.random() * players.length)];
    const rating = Number(target.training_rating) || 0;
    const bucket = rating >= 7 ? 'good' : (rating <= 3.5 ? 'bad' : 'neutral');
    const flavour = bucket === 'good' ? pick(REPORT_GOOD) : (bucket === 'bad' ? pick(REPORT_BAD) : pick(REPORT_NEUTRAL));
    const icon = bucket === 'good' ? '📈' : (bucket === 'bad' ? '📉' : '📋');

    const bits = [`${target.name} ${flavour}.`];
    if (target.fitness_status === 'Lesionado') bits.push('Continua entregue ao departamento médico.');
    else if (target.fitness_status === 'Cansado') bits.push('Convém gerir bem os minutos dele nos próximos jogos.');
    if (target.happiness === 'Insatisfeito') bits.push('O adjunto nota que anda descontente com a situação no plantel.');

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, player_id)
      VALUES (@team_id, 'assistant_report', @title, @body, @player_id)
    `).run({
      team_id: myTeam.id,
      player_id: target.id,
      title: `${icon} Relatório do Adjunto: ${target.name}`,
      body: `${assistant.name} enviou-te uma nota sobre ${target.name}: ${bits.join(' ')}`,
    });
  }
}

function runMoraleTick(nextDateStr) {
  const myTeam = db.prepare('SELECT * FROM teams WHERE is_user_controlled = 1').get();
  if (!myTeam) return;

  /* Reintegra automaticamente quem já cumpriu o afastamento temporário. */
  db.prepare(`
    UPDATE players SET stood_down_until = NULL, stood_down_reason = NULL, updated_at = datetime('now')
    WHERE team_id = ? AND stood_down_until IS NOT NULL AND stood_down_until <= ?
  `).run(myTeam.id, nextDateStr);

  const players = db.prepare('SELECT * FROM players WHERE team_id = ?').all(myTeam.id);

  runAssistantCoachTick(myTeam, players);

  /* ---------- Jogadores fiéis: boost de moral, sem precisar de decisão ---------- */
  players.filter((p) => LOYAL_TIERS.includes(p.personality)).forEach((p) => {
    const chance = p.personality === 'Muito Fiel' ? 0.012 : 0.006;
    if (Math.random() >= chance) return;

    const teammates = players.filter((t) => t.id !== p.id);
    let boosted = 0;
    const bump = db.prepare('UPDATE players SET happiness = ?, updated_at = datetime(\'now\') WHERE id = ?');
    teammates.forEach((t) => {
      if (happinessIndex(t.happiness) < HAPPINESS_LADDER.length - 1 && Math.random() < 0.5) {
        bump.run(shiftHappiness(t.happiness, 1), t.id);
        boosted += 1;
      }
    });

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, player_id)
      VALUES (@team_id, 'loyalty_boost', @title, @body, @player_id)
    `).run({
      team_id: myTeam.id,
      player_id: p.id,
      title: `🤝 ${p.name} deu uma lição de liderança ao grupo`,
      body: boosted
        ? `${p.name} ${pick(LOYALTY_FLAVOUR)}. O ambiente no balneário melhorou visivelmente.`
        : `${p.name} ${pick(LOYALTY_FLAVOUR)}. O grupo já estava em boa forma, mas isto não faz mal a ninguém.`,
    });
  });

  /* ---------- Jogadores problemáticos: pode gerar um incidente ----------
     Ignora quem já tem um incidente pendente por resolver, ou já está
     afastado temporariamente — não faz sentido acumular. */
  const hasPendingIncident = new Set(
    db.prepare("SELECT player_id FROM player_incidents WHERE team_id = ? AND status = 'pending'").all(myTeam.id).map((r) => r.player_id),
  );

  players
    .filter((p) => PROBLEM_TIERS.includes(p.personality) && !hasPendingIncident.has(p.id) && !p.stood_down_until)
    .forEach((p) => {
      const unhappy = p.happiness === 'Descontente' || p.happiness === 'Insatisfeito';
      const base = p.personality === 'Muito Problemático' ? 0.02 : 0.01;
      const chance = unhappy ? base * 2 : base;
      if (Math.random() >= chance) return;

      const kind = unhappy && Math.random() < 0.7 ? 'tantrum' : 'fight';
      const info = db.prepare(`
        INSERT INTO player_incidents (team_id, player_id, kind, event_date)
        VALUES (@team_id, @player_id, @kind, @event_date)
      `).run({ team_id: myTeam.id, player_id: p.id, kind, event_date: nextDateStr });

      const flavour = kind === 'fight' ? pick(FIGHT_FLAVOUR) : pick(TANTRUM_FLAVOUR);
      const title = kind === 'fight'
        ? `🥊 ${p.name} envolveu-se numa briga no balneário`
        : `😠 ${p.name} fez uma birra no treino`;
      const body = `${p.name} ${flavour}. É preciso decidir o que fazer.`;

      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id, incident_id)
        VALUES (@team_id, 'player_incident', @title, @body, @player_id, @incident_id)
      `).run({
        team_id: myTeam.id, player_id: p.id, incident_id: info.lastInsertRowid, title, body,
      });
    });

  /* ---------- Pergunta ocasional ao treinador ---------- */
  const hasPendingQuestion = db.prepare("SELECT id FROM manager_questions WHERE team_id = ? AND status = 'pending'").get(myTeam.id);
  if (!hasPendingQuestion && Math.random() < 0.01) {
    const q = pick(QUESTION_BANK);
    const info = db.prepare(`
      INSERT INTO manager_questions (team_id, prompt, options_json, event_date)
      VALUES (@team_id, @prompt, @options_json, @event_date)
    `).run({ team_id: myTeam.id, prompt: q.prompt, options_json: JSON.stringify(q.options), event_date: nextDateStr });

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, question_id)
      VALUES (@team_id, 'manager_question', @title, @body, @question_id)
    `).run({
      team_id: myTeam.id,
      question_id: info.lastInsertRowid,
      title: '💬 Precisas de decidir',
      body: q.prompt,
    });
  }
}

/* ---------- PUT /api/morale/incidents/:id/respond — decisão sobre um incidente ----------
   action: 'transfer_list' | 'stand_down' | 'ignore' */
router.put('/incidents/:id/respond', (req, res) => {
  const incident = db.prepare('SELECT * FROM player_incidents WHERE id = ?').get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incidente não encontrado' });
  if (incident.status !== 'pending') return res.status(409).json({ error: 'Este incidente já foi resolvido' });

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(incident.player_id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });

  const { action } = req.body;
  let resolution = '';

  if (action === 'transfer_list') {
    let askingPrice = Number(req.body.asking_price);
    if (!askingPrice || askingPrice <= 0) {
      const parsed = parseFloat(String(player.market_value_text || '').replace(/[^\d.,]/g, '').replace(',', '.'));
      askingPrice = parsed > 0 ? parsed : 50000;
    }
    db.prepare("UPDATE players SET is_listed = 1, asking_price = ?, updated_at = datetime('now') WHERE id = ?")
      .run(askingPrice, player.id);
    resolution = `${player.name} foi colocado na lista de transferências.`;
  } else if (action === 'stand_down') {
    const days = Math.max(1, Math.min(60, Number(req.body.duration_days) || 7));
    const state = db.prepare('SELECT current_date FROM game_state WHERE id = 1').get();
    const [y, m, d] = state.current_date.split('-').map(Number);
    const until = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
    const untilStr = `${until.getUTCFullYear()}-${String(until.getUTCMonth() + 1).padStart(2, '0')}-${String(until.getUTCDate()).padStart(2, '0')}`;

    db.prepare(`
      UPDATE players SET stood_down_until = ?, stood_down_reason = ?, updated_at = datetime('now') WHERE id = ?
    `).run(untilStr, incident.kind === 'fight' ? 'Afastado por conflito com um colega' : 'Afastado por birra no treino', player.id);
    resolution = `${player.name} foi afastado do plantel durante ${days} dia${days === 1 ? '' : 's'} (até ${untilStr.split('-').reverse().join('/')}).`;
  } else if (action === 'ignore') {
    resolution = `Decidiste não tomar nenhuma medida sobre ${player.name}.`;
  } else {
    return res.status(400).json({ error: 'Ação inválida' });
  }

  db.prepare("UPDATE player_incidents SET status = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?")
    .run(resolution, incident.id);

  res.json({ ok: true, resolution });
});

/* ---------- PUT /api/morale/questions/:id/respond — responder a uma pergunta ---------- */
router.put('/questions/:id/respond', (req, res) => {
  const question = db.prepare('SELECT * FROM manager_questions WHERE id = ?').get(req.params.id);
  if (!question) return res.status(404).json({ error: 'Pergunta não encontrada' });
  if (question.status !== 'pending') return res.status(409).json({ error: 'Esta pergunta já foi respondida' });

  let options = [];
  try { options = JSON.parse(question.options_json); } catch { options = []; }
  const chosen = options.find((o) => o.key === req.body.option_key);
  if (!chosen) return res.status(400).json({ error: 'Opção inválida' });

  const { up, down, total } = applyQuestionEffect(question.team_id, chosen.effect || { up: 0, down: 0 });

  let resolution = `Escolheste: "${chosen.label}".`;
  if (up || down) {
    const bits = [];
    if (up) bits.push(`${up} jogador${up === 1 ? '' : 'es'} ficaram mais motivados`);
    if (down) bits.push(`${down} jogador${down === 1 ? '' : 'es'} ficaram desmotivados`);
    resolution += ` ${bits.join(', ')}.`;
  } else if (total) {
    resolution += ' O plantel manteve-se na mesma.';
  }

  db.prepare("UPDATE manager_questions SET status = 'resolved', chosen_key = ?, resolved_at = datetime('now') WHERE id = ?")
    .run(chosen.key, question.id);

  res.json({ ok: true, resolution });
});

module.exports = router;
module.exports.runMoraleTick = runMoraleTick;
module.exports.PERSONALITY_TIERS = db.PERSONALITY_TIERS;