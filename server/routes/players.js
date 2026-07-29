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
  { competition: 'Geral (Clube)', j: 0, g: 0, a: 0, xg: 0, pen: 0, mdp: 0, am: 0, verm: 0, media: '-' },
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
           p.market_value_text, p.wage_text,
           t.name AS team_name
    FROM players p
    LEFT JOIN teams t ON t.id = p.team_id
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

  res.json({ ...deserialize(player), team, original_team: originalTeam });
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
      club_status, wage_text, technical_json, set_pieces_json, mental_json, physical_json, goalkeeping_json, season_stats_json
    ) VALUES (
      @team_id, @original_team_id, @name, @jersey_number, @position_tag, @position_code, @nationality_code, @birth_date,
      @club_status, @wage_text, @technical_json, @set_pieces_json, @mental_json, @physical_json, @goalkeeping_json, @season_stats_json
    )
  `);

  const info = stmt.run({
    team_id: team ? team.id : null,
    original_team_id: team ? team.id : null,
    name: name.trim(), jersey_number, position_tag, position_code, nationality_code, birth_date,
    club_status: team ? 'Titular Regular' : 'Jogador Livre',
    wage_text: team ? '' : '',
    technical_json: JSON.stringify(isGK ? DEFAULT_TECHNICAL_GK : DEFAULT_TECHNICAL),
    set_pieces_json: JSON.stringify(isGK ? [] : DEFAULT_SET_PIECES),
    mental_json: JSON.stringify(DEFAULT_MENTAL),
    physical_json: JSON.stringify(DEFAULT_PHYSICAL),
    goalkeeping_json: JSON.stringify(isGK ? DEFAULT_GOALKEEPING : []),
    season_stats_json: JSON.stringify(DEFAULT_SEASON_STATS),
  });

  const created = db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(deserialize(created));
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
  'career_clubs', 'career_apps', 'career_goals',
];

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Jogador não encontrado' });

  const updates = {};
  for (const field of UPDATABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      let val = req.body[field];
      if (JSON_FIELDS.includes(field) && typeof val !== 'string') val = JSON.stringify(val);
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