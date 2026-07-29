/* ==========================================================
   FMcriol — Rotas da API para a Tática (formação, onze inicial, suplentes)
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

const VALID_FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-4-3'];

function deserialize(row) {
  if (!row) return null;
  let lineup = [];
  let bench = [];
  try { lineup = JSON.parse(row.lineup_json ?? '[]'); } catch { lineup = []; }
  try { bench = JSON.parse(row.bench_json ?? '[]'); } catch { bench = []; }
  return { team_id: row.team_id, formation: row.formation, lineup, bench, updated_at: row.updated_at };
}

/* ---------- GET /api/tactics/:teamId — tática guardada (ou uma vazia por omissão) ---------- */
router.get('/:teamId', (req, res) => {
  const row = db.prepare('SELECT * FROM tactics WHERE team_id = ?').get(req.params.teamId);
  if (!row) {
    return res.json({ team_id: Number(req.params.teamId), formation: '4-3-3', lineup: [], bench: [] });
  }
  res.json(deserialize(row));
});

/* ---------- PUT /api/tactics/:teamId — guarda a formação, o onze e os suplentes ---------- */
router.put('/:teamId', (req, res) => {
  const teamId = req.params.teamId;
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const { formation, lineup, bench } = req.body;
  if (!VALID_FORMATIONS.includes(formation)) {
    return res.status(400).json({ error: 'Formação inválida' });
  }
  if (!Array.isArray(lineup) || !Array.isArray(bench)) {
    return res.status(400).json({ error: 'Onze inicial e suplentes têm de ser listas' });
  }
  if (bench.length > 8) {
    return res.status(400).json({ error: 'No máximo 8 suplentes' });
  }

  db.prepare(`
    INSERT INTO tactics (team_id, formation, lineup_json, bench_json, updated_at)
    VALUES (@team_id, @formation, @lineup_json, @bench_json, datetime('now'))
    ON CONFLICT(team_id) DO UPDATE SET
      formation = excluded.formation,
      lineup_json = excluded.lineup_json,
      bench_json = excluded.bench_json,
      updated_at = datetime('now')
  `).run({
    team_id: teamId,
    formation,
    lineup_json: JSON.stringify(lineup),
    bench_json: JSON.stringify(bench),
  });

  const saved = db.prepare('SELECT * FROM tactics WHERE team_id = ?').get(teamId);
  res.json(deserialize(saved));
});

module.exports = router;