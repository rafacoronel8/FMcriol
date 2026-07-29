/* ==========================================================
   FMcriol — Rotas da API para Equipas
   ========================================================== */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/database');

const router = express.Router();

/* ---------- Upload de escudo ---------- */
const SHIELDS_DIR = path.join(__dirname, '..', 'uploads', 'shields');
if (!fs.existsSync(SHIELDS_DIR)) fs.mkdirSync(SHIELDS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SHIELDS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `team_${req.params.id}_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Ficheiro tem de ser uma imagem'));
    cb(null, true);
  },
});

/* ---------- GET /api/teams — listar todas as equipas ---------- */
router.get('/', (req, res) => {
  const { division, q } = req.query;
  let sql = 'SELECT * FROM teams';
  const conditions = [];
  const params = {};

  if (division) {
    conditions.push('division = @division');
    params.division = division;
  }
  if (q) {
    conditions.push('name LIKE @q');
    params.q = `%${q}%`;
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY reputation_stars DESC, name ASC';

  const teams = db.prepare(sql).all(params);
  res.json(teams);
});

/* ---------- GET /api/teams/:id — detalhe de uma equipa (com contagem de jogadores) ---------- */
router.get('/:id', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const players = db.prepare('SELECT id, name, photo_path, jersey_number, position_tag FROM players WHERE team_id = ? ORDER BY name ASC').all(req.params.id);
  res.json({ ...team, players, player_count: players.length });
});

/* ---------- POST /api/teams — criar nova equipa ---------- */
router.post('/', (req, res) => {
  const {
    name, reputation_stars = 2.0, financial_tier = 'Medio',
    division = 1, wage_budget = 0, transfer_budget = 0, balance = 0,
    founded_year, location, stadium_name,
  } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'O nome da equipa é obrigatório' });

  try {
    const stmt = db.prepare(`
      INSERT INTO teams (name, reputation_stars, financial_tier, division, wage_budget, transfer_budget, balance, founded_year, location, stadium_name)
      VALUES (@name, @reputation_stars, @financial_tier, @division, @wage_budget, @transfer_budget, @balance, @founded_year, @location, @stadium_name)
    `);
    const info = stmt.run({
      name: name.trim(), reputation_stars, financial_tier, division,
      wage_budget, transfer_budget, balance,
      founded_year: founded_year ?? null, location: location ?? null, stadium_name: stadium_name ?? null,
    });
    const created = db.prepare('SELECT * FROM teams WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(created);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Já existe uma equipa com esse nome' });
    res.status(500).json({ error: err.message });
  }
});

/* ---------- PUT /api/teams/:id — atualizar equipa ---------- */
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Equipa não encontrada' });

  const merged = { ...existing, ...req.body, id: existing.id };
  db.prepare(`
    UPDATE teams SET
      name = @name, reputation_stars = @reputation_stars, financial_tier = @financial_tier,
      division = @division, wage_budget = @wage_budget, transfer_budget = @transfer_budget,
      balance = @balance, founded_year = @founded_year, location = @location,
      stadium_name = @stadium_name, updated_at = datetime('now')
    WHERE id = @id
  `).run(merged);

  res.json(db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id));
});

/* ---------- POST /api/teams/:id/shield — upload do escudo ---------- */
router.post('/:id/shield', upload.single('shield'), (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });
  if (!req.file) return res.status(400).json({ error: 'Nenhum ficheiro enviado' });

  const relPath = `/uploads/shields/${req.file.filename}`;
  db.prepare("UPDATE teams SET shield_path = ?, updated_at = datetime('now') WHERE id = ?")
    .run(relPath, req.params.id);

  res.json({ ...team, shield_path: relPath });
});

/* ---------- DELETE /api/teams/:id — remover equipa ---------- */
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Equipa não encontrada' });
  res.status(204).end();
});

module.exports = router;
