/* ==========================================================
   FMcriol — Rotas da API para Jogadores
   ========================================================== */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/database');

const router = express.Router();

/* ---------- Valores por omissão para um jogador novo (estilo FM) ---------- */
const DEFAULT_TECHNICAL = [
  ['Cruzamento', 10], ['Drible', 10], ['Finalização', 10], ['Primeiro Toque', 10],
  ['Cabeceamento', 10], ['Remates de Longe', 10], ['Marcação', 10], ['Passe', 10],
  ['Desarme', 10], ['Técnica', 10],
];
const DEFAULT_SET_PIECES = [
  ['Cantos', 10], ['Livres', 10], ['Lançamentos Longos', 10], ['Grandes Penalidades', 10],
];
const DEFAULT_MENTAL = [
  ['Agressividade', 10], ['Antecipação', 10], ['Coragem', 10], ['Compostura', 10],
  ['Concentração', 10], ['Decisões', 10], ['Determinação', 10], ['Classe', 10],
  ['Liderança', 10], ['Fora de Bola', 10], ['Posicionamento', 10], ['Trabalho de Equipa', 10],
  ['Visão', 10], ['Ritmo de Jogo', 10],
];
const DEFAULT_PHYSICAL = [
  ['Aceleração', 10], ['Agilidade', 10], ['Equilíbrio', 10], ['Alcance de Cabeceamento', 10],
  ['Condição Natural', 10], ['Velocidade', 10], ['Resistência', 10], ['Força', 10],
];
const DEFAULT_SEASON_STATS = [
  { competition: 'Geral (Clube)', j: 0, g: 0, a: 0, xg: 0, pen: 0, mdp: 0, am: 0, verm: 0, tk: 0, pp: '-', media: '-' },
];

/* ---------- Guarda-Redes: conjunto de atributos diferente do jogador de campo ---------- */
const DEFAULT_GOALKEEPING = [
  ['Alcance Aéreo', 10], ['Comando de Área', 10], ['Comunicação', 10], ['Excentricidade', 10],
  ['Primeiro Toque', 10], ['Manejo', 10], ['Pontapé', 10], ['Um Contra Um', 10],
  ['Passe', 10], ['Soco (Tendência)', 10], ['Reflexos', 10], ['Saída da Baliza (Tendência)', 10],
  ['Lançamento', 10],
];
/* Guarda-redes têm uma "Técnica" muito reduzida — só isto costuma ser relevante */
const DEFAULT_TECHNICAL_GK = [
  ['Cobrança de Livres', 10], ['Cobrança de Grandes Penalidades', 10], ['Técnica', 10],
];

function isGoalkeeperPosition(positionCode){
  return String(positionCode || '').split('/')[0].trim().toUpperCase() === 'GR';
}

/* ---------- Geração automática de atributos a partir de um "Nível Geral" (0-100) ----------
   Cópia deliberada da mesma ideia de classifyPositionCode usada em
   routes/competitionstats.js (ver comentário no topo desse ficheiro) —
   mantém-se separada em vez de partilhada para não arriscar mexer no
   código de simulação de jogos ao alterar isto. */
function classifyPositionForGeneration(code) {
  const c = String(code || '').split('/')[0].trim().toUpperCase();
  if (c === 'GR') return 'GR';
  if (['PL', 'AD', 'AE', 'ED', 'EE'].includes(c)) return 'PL';
  if (['MCO', 'MOD', 'MOE'].includes(c)) return 'MO';
  if (c.startsWith('M')) return 'MED';
  return 'DEF';
}

/* Peso de cada atributo por categoria de posição — quanto maior, mais esse
   atributo sobe acima da média para um jogador daquele nível; negativo
   empurra para baixo da média. 0 = fica perto da média do "Nível Geral".
   Tendências de guarda-redes (Excentricidade, Soco/Saída da Baliza) ficam
   a 0 de propósito: são um estilo de jogo, não uma questão de qualidade. */
const ATTR_WEIGHTS = {
  technical: {
    DEF: { Cruzamento: -0.3, Drible: -0.3, Finalização: -0.7, 'Primeiro Toque': 0.1, Cabeceamento: 0.9, 'Remates de Longe': -0.5, Marcação: 1.1, Passe: 0.3, Desarme: 1.1, Técnica: 0.1 },
    MED: { Cruzamento: 0.2, Drible: 0.3, Finalização: -0.2, 'Primeiro Toque': 0.5, Cabeceamento: 0.1, 'Remates de Longe': 0.2, Marcação: 0.6, Passe: 1.0, Desarme: 0.7, Técnica: 0.6 },
    MO: { Cruzamento: 0.5, Drible: 0.9, Finalização: 0.4, 'Primeiro Toque': 0.9, Cabeceamento: -0.2, 'Remates de Longe': 0.5, Marcação: -0.5, Passe: 0.9, Desarme: -0.3, Técnica: 1.0 },
    PL: { Cruzamento: 0.1, Drible: 0.6, Finalização: 1.2, 'Primeiro Toque': 0.8, Cabeceamento: 0.5, 'Remates de Longe': 0.6, Marcação: -0.8, Passe: 0.1, Desarme: -0.8, Técnica: 0.6 },
  },
  technical_gk: {
    GR: { 'Cobrança de Livres': 0.2, 'Cobrança de Grandes Penalidades': 0.1, Técnica: 0.4 },
  },
  set_pieces: {
    DEF: { Cantos: -0.2, Livres: -0.3, 'Lançamentos Longos': 0.3, 'Grandes Penalidades': -0.3 },
    MED: { Cantos: 0.3, Livres: 0.4, 'Lançamentos Longos': 0.2, 'Grandes Penalidades': 0.0 },
    MO: { Cantos: 0.5, Livres: 0.7, 'Lançamentos Longos': -0.2, 'Grandes Penalidades': 0.3 },
    PL: { Cantos: 0.0, Livres: 0.2, 'Lançamentos Longos': -0.3, 'Grandes Penalidades': 0.7 },
  },
  mental: {
    DEF: { Agressividade: 0.6, Antecipação: 0.8, Coragem: 0.6, Compostura: 0.3, Concentração: 0.9, Decisões: 0.5, Determinação: 0.6, Classe: 0.2, Liderança: 0.4, 'Fora de Bola': -0.3, Posicionamento: 1.0, 'Trabalho de Equipa': 0.5, Visão: -0.1, 'Ritmo de Jogo': 0.0 },
    MED: { Agressividade: 0.2, Antecipação: 0.5, Coragem: 0.3, Compostura: 0.5, Concentração: 0.5, Decisões: 0.8, Determinação: 0.5, Classe: 0.4, Liderança: 0.3, 'Fora de Bola': 0.0, Posicionamento: 0.6, 'Trabalho de Equipa': 0.8, Visão: 0.8, 'Ritmo de Jogo': 0.2 },
    MO: { Agressividade: -0.1, Antecipação: 0.4, Coragem: 0.2, Compostura: 0.6, Concentração: 0.3, Decisões: 0.7, Determinação: 0.4, Classe: 0.9, Liderança: 0.2, 'Fora de Bola': 0.5, Posicionamento: 0.2, 'Trabalho de Equipa': 0.4, Visão: 1.0, 'Ritmo de Jogo': 0.5 },
    PL: { Agressividade: 0.0, Antecipação: 0.5, Coragem: 0.3, Compostura: 0.8, Concentração: 0.3, Decisões: 0.5, Determinação: 0.4, Classe: 0.6, Liderança: 0.0, 'Fora de Bola': 1.1, Posicionamento: 0.5, 'Trabalho de Equipa': 0.2, Visão: 0.2, 'Ritmo de Jogo': 0.4 },
    GR: { Agressividade: -0.2, Antecipação: 0.7, Coragem: 0.8, Compostura: 0.9, Concentração: 1.0, Decisões: 0.7, Determinação: 0.5, Classe: 0.3, Liderança: 0.5, 'Fora de Bola': -0.5, Posicionamento: 0.9, 'Trabalho de Equipa': 0.3, Visão: 0.2, 'Ritmo de Jogo': -0.3 },
  },
  physical: {
    DEF: { Aceleração: 0.3, Agilidade: 0.2, Equilíbrio: 0.3, 'Alcance de Cabeceamento': 0.7, 'Condição Natural': 0.3, Velocidade: 0.4, Resistência: 0.5, Força: 0.9 },
    MED: { Aceleração: 0.4, Agilidade: 0.4, Equilíbrio: 0.4, 'Alcance de Cabeceamento': 0.0, 'Condição Natural': 0.3, Velocidade: 0.4, Resistência: 0.9, Força: 0.3 },
    MO: { Aceleração: 0.6, Agilidade: 0.7, Equilíbrio: 0.5, 'Alcance de Cabeceamento': -0.3, 'Condição Natural': 0.2, Velocidade: 0.6, Resistência: 0.4, Força: -0.1 },
    PL: { Aceleração: 0.7, Agilidade: 0.5, Equilíbrio: 0.4, 'Alcance de Cabeceamento': 0.4, 'Condição Natural': 0.2, Velocidade: 0.8, Resistência: 0.2, Força: 0.4 },
    GR: { Aceleração: 0.1, Agilidade: 0.8, Equilíbrio: 0.5, 'Alcance de Cabeceamento': 0.6, 'Condição Natural': 0.2, Velocidade: 0.0, Resistência: 0.2, Força: 0.5 },
  },
  goalkeeping: {
    GR: { 'Alcance Aéreo': 0.7, 'Comando de Área': 0.8, Comunicação: 0.5, Excentricidade: 0, 'Primeiro Toque': 0.3, Manejo: 1.0, Pontapé: 0.2, 'Um Contra Um': 0.9, Passe: 0.3, 'Soco (Tendência)': 0, Reflexos: 1.1, 'Saída da Baliza (Tendência)': 0, Lançamento: 0.2 },
  },
};

/* ---------- Fórmula de geração: cada atributo tem um "teto" próprio ----------
   Em vez de todos os atributos subirem quase ao mesmo ritmo com o Nível
   Geral (o que dava, por exemplo, um Defesa Central com Finalização quase
   tão boa como a Marcação), cada atributo tem um teto máximo (`cap`)
   definido pelo seu peso de importância na posição:
     peso  1.2  -> teto 20 (atributo-chave, quase sempre no máximo)
     peso  0.0  -> teto 10 (neutro, nunca sai de "razoável")
     peso -1.0  -> teto  4 (irrelevant­e para a posição, fica sempre fraco)
   O valor sobe dos ~3 (jogador muito fraco) até ao teto do próprio
   atributo, na proporção do Nível Geral — nunca ultrapassando esse teto,
   por muito alto que seja o Nível Geral. Assim um Defesa Central com 90
   tem Desarme/Marcação lá em cima mas Finalização/Drible continuam baixos,
   tal como um Avançado com 90 tem Finalização no topo mas Marcação fraca. */
function attrCap(weight) {
  return Math.max(4, Math.min(20, Math.round(10 + weight * 10)));
}

function scaledAttrValue(overall, weight) {
  const cap = attrCap(weight);
  const floor = 3; // valor mínimo de qualquer atributo, mesmo com Nível Geral 0
  const noise = (Math.random() * 1.4) - 0.7;
  const value = floor + (cap - floor) * (overall / 100) + noise;
  return Math.max(1, Math.min(20, Math.round(value)));
}

function generateAttrList(names, weights, overall) {
  return names.map((name) => [name, scaledAttrValue(overall, weights[name] ?? 0)]);
}

/* ---------- PUT /api/players/:id/generate-attributes ----------
   Recebe um "Nível Geral" de 0 a 100 e gera automaticamente TODOS os
   atributos individuais do jogador (Técnica/Guarda-Redes, Bolas Paradas,
   Mental, Físico), com base nesse número e na posição principal já
   guardada (position_code) — cada atributo tem um teto próprio consoante
   a sua importância para a posição (ver scaledAttrValue acima), mais uma
   pequena variação aleatória para não sair sempre um perfil demasiado
   "redondo". */
router.put('/:id/generate-attributes', (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });

  const overall = Number(req.body.overall);
  if (!Number.isFinite(overall) || overall < 0 || overall > 100) {
    return res.status(400).json({ error: 'O Nível Geral tem de ser um número entre 0 e 100' });
  }

  const category = classifyPositionForGeneration(player.position_code);
  const isGK = category === 'GR';

  const technical_json = isGK
    ? generateAttrList(DEFAULT_TECHNICAL_GK.map(([n]) => n), ATTR_WEIGHTS.technical_gk.GR, overall)
    : generateAttrList(DEFAULT_TECHNICAL.map(([n]) => n), ATTR_WEIGHTS.technical[category], overall);
  const set_pieces_json = isGK
    ? []
    : generateAttrList(DEFAULT_SET_PIECES.map(([n]) => n), ATTR_WEIGHTS.set_pieces[category], overall);
  const mental_json = generateAttrList(DEFAULT_MENTAL.map(([n]) => n), ATTR_WEIGHTS.mental[category], overall);
  const physical_json = generateAttrList(DEFAULT_PHYSICAL.map(([n]) => n), ATTR_WEIGHTS.physical[category], overall);
  const goalkeeping_json = isGK
    ? generateAttrList(DEFAULT_GOALKEEPING.map(([n]) => n), ATTR_WEIGHTS.goalkeeping.GR, overall)
    : [];

  db.prepare(`
    UPDATE players SET
      technical_json = @technical_json, set_pieces_json = @set_pieces_json,
      mental_json = @mental_json, physical_json = @physical_json, goalkeeping_json = @goalkeeping_json,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id: player.id,
    technical_json: JSON.stringify(technical_json),
    set_pieces_json: JSON.stringify(set_pieces_json),
    mental_json: JSON.stringify(mental_json),
    physical_json: JSON.stringify(physical_json),
    goalkeeping_json: JSON.stringify(goalkeeping_json),
  });

  const updated = db.prepare('SELECT * FROM players WHERE id = ?').get(player.id);
  res.json(deserialize(updated));
});

/* ---------- Upload de imagens (foto, bandeira, logo do clube) ---------- */
const UPLOAD_DIRS = {
  photo: path.join(__dirname, '..', 'uploads', 'players'),
  flag: path.join(__dirname, '..', 'uploads', 'flags'),
  club: path.join(__dirname, '..', 'uploads', 'club-overrides'),
};
Object.values(UPLOAD_DIRS).forEach((dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

function makeUploader(kind) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIRS[kind]),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `player_${req.params.id}_${kind}_${Date.now()}${ext}`);
    },
  });
  return multer({
    storage,
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) return cb(new Error('Ficheiro tem de ser uma imagem'));
      cb(null, true);
    },
  });
}

/* ---------- Helpers de serialização (JSON <-> colunas de texto) ---------- */
const JSON_FIELDS = [
  'positions_json', 'roles_possession_json', 'roles_nopossession_json',
  'technical_json', 'set_pieces_json', 'mental_json', 'physical_json', 'goalkeeping_json', 'season_stats_json',
];

function deserialize(row) {
  if (!row) return row;
  const out = { ...row };
  JSON_FIELDS.forEach((f) => {
    try { out[f] = JSON.parse(row[f] ?? '[]'); } catch { out[f] = []; }
  });
  return out;
}

/* ---------- GET /api/players?team_id=X — listar jogadores (resumo) ---------- */
router.get('/', (req, res) => {
  const { team_id, q, free_agents } = req.query;
  let sql = `
    SELECT p.id, p.name, p.photo_path, p.jersey_number, p.position_tag, p.position_code, p.team_id,
           p.club_status, p.fitness_status, p.fitness_note, p.current_ability_stars, p.form_text,
           p.market_value_text, p.wage_text, p.personality, p.stood_down_until, p.stood_down_reason,
           p.focus_role, p.loan_from_team_id, p.loan_return_date,
           t.name AS team_name,
           loanFrom.name AS loan_from_team_name
    FROM players p
    LEFT JOIN teams t ON t.id = p.team_id
    LEFT JOIN teams loanFrom ON loanFrom.id = p.loan_from_team_id
  `;
  const conditions = [];
  const params = {};

  /* free_agents=1 -> só jogadores sem clube (livres, disponíveis a custo zero) */
  if (free_agents) {
    conditions.push('p.team_id IS NULL');
  } else if (team_id) {
    conditions.push('p.team_id = @team_id'); params.team_id = team_id;
  }
  if (q) { conditions.push('p.name LIKE @q'); params.q = `%${q}%`; }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY p.name ASC';

  res.json(db.prepare(sql).all(params));
});

/* ---------- GET /api/players/:id — perfil completo ---------- */
router.get('/:id', (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });

  const team = player.team_id
    ? db.prepare('SELECT id, name, shield_path FROM teams WHERE id = ?').get(player.team_id)
    : null;
  const originalTeam = player.original_team_id
    ? db.prepare('SELECT id, name, shield_path FROM teams WHERE id = ?').get(player.original_team_id)
    : null;
  const loanFromTeam = player.loan_from_team_id
    ? db.prepare('SELECT id, name, shield_path FROM teams WHERE id = ?').get(player.loan_from_team_id)
    : null;
  const awards = db.prepare('SELECT * FROM player_awards WHERE player_id = ? ORDER BY won_date DESC').all(req.params.id);

  res.json({ ...deserialize(player), team, original_team: originalTeam, loan_from_team: loanFromTeam, awards });
});

/* ---------- POST /api/players — criar jogador novo (com defaults) ---------- */
router.post('/', (req, res) => {
  const { name, team_id = null, position_tag = '', position_code = '', nationality_code = '', jersey_number = '00', birth_date = null } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'O nome do jogador é obrigatório' });

  /* team_id é opcional: sem clube, o jogador entra como "Jogador Livre" —
     sem salário, sem clube de origem, disponível para qualquer equipa assinar
     sem pagar transferência (ver POST /api/transfers/free-agent-offer). */
  let team = null;
  if (team_id) {
    team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
    if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });
  }

  const isGK = isGoalkeeperPosition(position_code);

  const stmt = db.prepare(`
    INSERT INTO players (
      team_id, original_team_id, name, jersey_number, position_tag, position_code, nationality_code, birth_date,
      club_status, wage_text, personality, technical_json, set_pieces_json, mental_json, physical_json, goalkeeping_json, season_stats_json
    ) VALUES (
      @team_id, @original_team_id, @name, @jersey_number, @position_tag, @position_code, @nationality_code, @birth_date,
      @club_status, @wage_text, @personality, @technical_json, @set_pieces_json, @mental_json, @physical_json, @goalkeeping_json, @season_stats_json
    )
  `);

  const info = stmt.run({
    team_id: team ? team.id : null,
    original_team_id: team ? team.id : null,
    name: name.trim(), jersey_number, position_tag, position_code, nationality_code, birth_date,
    club_status: team ? 'Titular Regular' : 'Jogador Livre',
    wage_text: team ? '' : '',
    personality: 'Normal',
    technical_json: JSON.stringify(isGK ? DEFAULT_TECHNICAL_GK : DEFAULT_TECHNICAL),
    set_pieces_json: JSON.stringify(isGK ? [] : DEFAULT_SET_PIECES),
    mental_json: JSON.stringify(DEFAULT_MENTAL),
    physical_json: JSON.stringify(DEFAULT_PHYSICAL),
    goalkeeping_json: JSON.stringify(isGK ? DEFAULT_GOALKEEPING : []),
    season_stats_json: JSON.stringify(DEFAULT_SEASON_STATS),
  });

  const created = db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid);
  db.captureBaseline(created.id);
  res.status(201).json(deserialize(db.prepare('SELECT * FROM players WHERE id = ?').get(created.id)));
});

/* ---------- PUT /api/players/:id — guardar qualquer campo do perfil (autosave) ---------- */
const UPDATABLE_FIELDS = [
  'team_id', 'original_team_id', 'name', 'jersey_number', 'position_tag', 'nationality_code', 'birth_date',
  'club_name_override', 'club_status', 'market_value_text', 'caps', 'international_goals',
  'current_ability_stars', 'potential_ability_stars', 'wage_text', 'contract_end',
  'position_code', 'position_caption', 'positions_json', 'roles_possession_json', 'roles_nopossession_json',
  'technical_json', 'set_pieces_json', 'mental_json', 'physical_json', 'goalkeeping_json',
  'height_cm', 'reputation_text', 'personality', 'left_foot', 'right_foot', 'traits', 'gk_rating',
  'happiness', 'positive_count', 'negative_count', 'fitness_status', 'fitness_note', 'form_text',
  'discipline_text', 'discipline_note', 'training_status', 'training_rating', 'season_stats_json',
  'career_clubs', 'career_apps', 'career_goals', 'focus_role',
];

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Jogador não encontrado' });

  const updates = {};
  for (const field of UPDATABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      let val = req.body[field];
      if (JSON_FIELDS.includes(field) && typeof val !== 'string') val = JSON.stringify(val);
      // A personalidade só pode ser um dos 5 níveis reconhecidos (ver
      // routes/morale.js) — qualquer outra coisa cai para "Normal", em vez
      // de deixar entrar texto livre que os eventos de balneário não saibam interpretar.
      if (field === 'personality' && !db.PERSONALITY_TIERS.includes(val)) val = 'Normal';
      if (field === 'focus_role' && val && !db.FOCUS_ROLES.includes(val)) val = null;
      updates[field] = val;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.json(deserialize(existing));
  }

  const setClause = Object.keys(updates).map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE players SET ${setClause}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...updates, id: req.params.id });

  const updated = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  res.json(deserialize(updated));
});

/* ---------- POST /api/players/:id/photo | /flag | /club-logo ---------- */
function wireImageUpload(kind, column) {
  router.post(`/:id/${kind}`, makeUploader(kind === 'club-logo' ? 'club' : kind).single('image'), (req, res) => {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
    if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });
    if (!req.file) return res.status(400).json({ error: 'Nenhum ficheiro enviado' });

    const folder = kind === 'photo' ? 'players' : kind === 'flag' ? 'flags' : 'club-overrides';
    const relPath = `/uploads/${folder}/${req.file.filename}`;
    db.prepare(`UPDATE players SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(relPath, req.params.id);

    res.json({ [column]: relPath });
  });
}
wireImageUpload('photo', 'photo_path');
wireImageUpload('flag', 'flag_path');
wireImageUpload('club-logo', 'club_logo_path');

/* ---------- PUT /api/players/:id/transfer-list — colocar/tirar da lista de transferências ---------- */
router.put('/:id/transfer-list', (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });

  const isListed = req.body.is_listed ? 1 : 0;
  let askingPrice = null;
  if (isListed) {
    askingPrice = Number(req.body.asking_price);
    if (!askingPrice || askingPrice <= 0) return res.status(400).json({ error: 'Indica um valor de venda válido' });
  }

  db.prepare("UPDATE players SET is_listed = ?, asking_price = ?, updated_at = datetime('now') WHERE id = ?")
    .run(isListed, askingPrice, req.params.id);

  res.json({ id: player.id, is_listed: isListed, asking_price: askingPrice });
});

/* ---------- DELETE /api/players/:id ---------- */
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Jogador não encontrado' });
  res.status(204).end();
});

module.exports = router;