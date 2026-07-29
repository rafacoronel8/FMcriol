/* ==========================================================
   FMcriol — Rota de Pesquisa Global (equipas + jogadores)
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

/* ---------- GET /api/search?q=... ---------- */
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();

  if (!q) {
    return res.json({ query: q, teams: [], players: [] });
  }

  const like = `%${q}%`;

  const teams = db.prepare(`
    SELECT id, name, shield_path, reputation_stars, financial_tier, division
    FROM teams
    WHERE name LIKE ?
    ORDER BY reputation_stars DESC
    LIMIT 10
  `).all(like);

  const players = db.prepare(`
    SELECT p.id, p.name, p.photo_path, p.team_id, t.name AS team_name
    FROM players p
    LEFT JOIN teams t ON t.id = p.team_id
    WHERE p.name LIKE ?
    ORDER BY p.name ASC
    LIMIT 10
  `).all(like);

  res.json({
    query: q,
    teams: teams.map((t) => ({ ...t, type: 'equipa' })),
    players: players.map((p) => ({ ...p, type: 'jogador' })),
  });
});

module.exports = router;
