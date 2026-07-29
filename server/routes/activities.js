/* ==========================================================
   FMcriol — Rotas da API para as Atividades Diárias do Clube
   Uma atividade por dia de jogo: treinos, recuperação, folga…
   Cada uma tem um pequeno efeito real no plantel (rating de
   treino e condição física), para não serem só decorativas.
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

/* ---------- Catálogo de atividades ----------
   trainingBump       -> soma ao training_rating geral de cada jogador (0-10, arredondado a 1 casa)
   attrBump           -> quanto sobe CADA atributo visado (Força, Ritmo de Jogo, etc.), 0-20, 1 casa
   attrTargets        -> { technical_json / mental_json / physical_json / goalkeeping_json: [nomes] }
                          só os atributos destas listas sobem — os restantes ficam iguais
   recoverChance      -> prob. de um jogador "Cansado"/"Em Recuperação" passar a "No Auge"
   fatigueChance      -> prob. de um jogador "No Auge" ficar "Cansado" — treinos intensos têm de
                          ter isto bem alto, para a perda de condição física ser uma consequência
                          previsível do treino, não um acaso raro
   happinessBoost     -> se true, jogadores "Descontente"/"Insatisfeito" melhoram um nível */
const ACTIVITIES = [
  {
    key: 'treino_fisico',
    name: 'Treino Físico',
    icon: '💪',
    description: 'Sessão de condição física no ginásio e no campo. Sobe força e ritmo de jogo, mas cansa bastante o plantel.',
    trainingBump: 0.5,
    attrBump: 0.1,
    attrTargets: {
      physical_json: ['Força', 'Velocidade', 'Aceleração', 'Resistência'],
      mental_json: ['Ritmo de Jogo'],
    },
    recoverChance: 0.15,
    fatigueChance: 0.85,
  },
  {
    key: 'treino_tatico',
    name: 'Treino Tático',
    icon: '📋',
    description: 'Trabalho de posicionamento e organização coletiva em campo, a pensar na próxima tática.',
    trainingBump: 0.35,
    attrBump: 0.1,
    attrTargets: {
      mental_json: ['Posicionamento', 'Decisões', 'Trabalho de Equipa', 'Visão'],
      goalkeeping_json: ['Comando de Área', 'Comunicação'],
    },
    recoverChance: 0.2,
    fatigueChance: 0.35,
  },
  {
    key: 'treino_finalizacao',
    name: 'Treino de Finalização',
    icon: '🎯',
    description: 'Sessão focada em remate e último passe, para afinar a pontaria da equipa.',
    trainingBump: 0.35,
    attrBump: 0.1,
    attrTargets: {
      technical_json: ['Finalização', 'Remates de Longe', 'Primeiro Toque', 'Técnica'],
      goalkeeping_json: ['Reflexos', 'Um Contra Um'],
    },
    recoverChance: 0.2,
    fatigueChance: 0.4,
  },
  {
    key: 'sessao_video',
    name: 'Análise de Vídeo',
    icon: '🎥',
    description: 'Revisão de jogos anteriores em sala, a apontar erros e pontos fortes do adversário.',
    trainingBump: 0.2,
    attrBump: 0.05,
    attrTargets: {
      mental_json: ['Antecipação', 'Decisões', 'Concentração', 'Visão'],
    },
    recoverChance: 0.35,
    fatigueChance: 0.05,
  },
  {
    key: 'recuperacao',
    name: 'Sessão de Recuperação',
    icon: '🧊',
    description: 'Fisioterapia, piscina e trabalho ligeiro — o foco é recuperar o plantel cansado ou lesionado.',
    trainingBump: 0.1,
    attrBump: 0,
    attrTargets: {},
    recoverChance: 0.55,
    fatigueChance: 0,
  },
  {
    key: 'folga',
    name: 'Dia de Folga',
    icon: '😌',
    description: 'Um dia de descanso total. O plantel agradece, mas o treino não avança.',
    trainingBump: 0,
    attrBump: 0,
    attrTargets: {},
    recoverChance: 0.7,
    fatigueChance: 0,
    happinessBoost: true,
  },
];

const ACTIVITIES_BY_KEY = Object.fromEntries(ACTIVITIES.map((a) => [a.key, a]));
const ATTR_JSON_FIELDS = ['technical_json', 'mental_json', 'physical_json', 'goalkeeping_json'];

/* Sobe os atributos visados por esta atividade dentro de um dos campos JSON
   do jogador (ex: physical_json = [["Força", 10], ["Velocidade", 11], ...]).
   Só mexe nos atributos cujo nome está em `names` — os restantes ficam
   exatamente como estavam. Valores ficam sempre entre 1 e 20 (escala usada
   no perfil do jogador) e arredondados a 1 casa decimal. */
function bumpAttributes(jsonText, names, bump) {
  if (!names || !names.length || !bump) return jsonText;
  let list;
  try { list = JSON.parse(jsonText || '[]'); } catch { list = []; }
  if (!Array.isArray(list) || !list.length) return jsonText;

  const targetSet = new Set(names);
  const updated = list.map(([name, value]) => {
    if (!targetSet.has(name)) return [name, value];
    const next = Math.max(1, Math.min(20, Number((Number(value || 0) + bump).toFixed(1))));
    return [name, next];
  });
  return JSON.stringify(updated);
}

function currentGameDate() {
  return db.prepare('SELECT current_date FROM game_state WHERE id = 1').get().current_date;
}

function publicCatalog() {
  return ACTIVITIES.map(({ key, name, icon, description }) => ({ key, name, icon, description }));
}

/* ---------- GET /api/activities/:teamId — catálogo + atividade feita hoje ---------- */
router.get('/:teamId', (req, res) => {
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const today = currentGameDate();
  const done = db.prepare('SELECT * FROM team_activity_log WHERE team_id = ? AND event_date = ?').get(req.params.teamId, today);

  res.json({
    current_date: today,
    activities: publicCatalog(),
    done_today: done ? { activity_key: done.activity_key, summary: done.summary } : null,
  });
});

/* ---------- POST /api/activities/:teamId — realizar a atividade escolhida ---------- */
router.post('/:teamId', (req, res) => {
  const teamId = req.params.teamId;
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const activity = ACTIVITIES_BY_KEY[req.body.activity_key];
  if (!activity) return res.status(400).json({ error: 'Atividade inválida' });

  const today = currentGameDate();
  const already = db.prepare('SELECT id FROM team_activity_log WHERE team_id = ? AND event_date = ?').get(teamId, today);
  if (already) return res.status(409).json({ error: 'Já realizaste uma atividade com a equipa hoje. Avança o dia para escolheres outra.' });

  const players = db.prepare('SELECT * FROM players WHERE team_id = ?').all(teamId);

  let recovered = 0;
  let tired = 0;
  let cheered = 0;
  let attributesUpped = 0;

  const updatePlayer = db.prepare(`
    UPDATE players SET training_status = @training_status, training_rating = @training_rating,
      fitness_status = @fitness_status, fitness_note = @fitness_note,
      happiness = @happiness,
      technical_json = @technical_json, mental_json = @mental_json,
      physical_json = @physical_json, goalkeeping_json = @goalkeeping_json,
      updated_at = datetime('now')
    WHERE id = @id
  `);

  const apply = db.transaction(() => {
    players.forEach((p) => {
      const nextRating = Math.max(0, Math.min(10, Number((Number(p.training_rating || 0) + activity.trainingBump).toFixed(1))));

      /* ---------- Sobe os atributos reais visados por este treino ---------- */
      const nextJson = {};
      let playerImproved = false;
      ATTR_JSON_FIELDS.forEach((field) => {
        const names = activity.attrTargets[field];
        const before = p[field];
        const after = bumpAttributes(before, names, activity.attrBump);
        nextJson[field] = after;
        if (after !== before) playerImproved = true;
      });
      if (playerImproved) attributesUpped += 1;

      /* ---------- Condição física: o treino tem sempre um preço ----------
         Treinos intensos (fatigueChance alto) descem quase sempre a condição
         de um jogador "No Auge" — a subida de atributos tem sempre este
         contrapeso. Só recuperação/folga trazem o plantel de volta ao auge. */
      let fitnessStatus = p.fitness_status;
      let fitnessNote = p.fitness_note;
      if ((fitnessStatus === 'Cansado' || fitnessStatus === 'Em Recuperação') && Math.random() < activity.recoverChance) {
        fitnessStatus = 'No Auge';
        fitnessNote = 'Em ótima condição';
        recovered += 1;
      } else if (fitnessStatus === 'No Auge' && Math.random() < activity.fatigueChance) {
        fitnessStatus = 'Cansado';
        fitnessNote = 'Precisa de descansar em breve';
        tired += 1;
      }

      let happiness = p.happiness;
      if (activity.happinessBoost && (happiness === 'Descontente' || happiness === 'Insatisfeito')) {
        happiness = 'Contente';
        cheered += 1;
      }

      updatePlayer.run({
        id: p.id,
        training_status: activity.name,
        training_rating: nextRating,
        fitness_status: fitnessStatus,
        fitness_note: fitnessNote,
        happiness,
        technical_json: nextJson.technical_json,
        mental_json: nextJson.mental_json,
        physical_json: nextJson.physical_json,
        goalkeeping_json: nextJson.goalkeeping_json,
      });
    });

    const bits = [`${players.length} jogador${players.length === 1 ? '' : 'es'} participaram`];
    if (attributesUpped) bits.push(`${attributesUpped} melhoraram atributos ligados a este treino`);
    if (recovered) bits.push(`${recovered} recuperaram a condição física`);
    if (tired) bits.push(`${tired} ficaram cansados`);
    if (cheered) bits.push(`${cheered} ficaram mais contentes`);
    const summary = bits.join(', ') + '.';

    db.prepare(`
      INSERT INTO team_activity_log (team_id, activity_key, event_date, summary)
      VALUES (@team_id, @activity_key, @event_date, @summary)
    `).run({ team_id: teamId, activity_key: activity.key, event_date: today, summary });

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body)
      VALUES (@team_id, 'activity_done', @title, @body)
    `).run({
      team_id: teamId,
      title: `${activity.icon} ${activity.name} concluído`,
      body: `A equipa realizou ${activity.name.toLowerCase()}. ${summary}`,
    });

    return summary;
  });

  const summary = apply();
  res.json({ ok: true, activity_key: activity.key, summary });
});

module.exports = router;