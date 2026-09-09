/* ==========================================================
   FMcriol — Lista Preferencial (alvos de mercado guardados à mão)
   ==========================================================
   GET    /api/shortlist/:teamId              -> lista completa, com dados
                                                  do jogador e do clube atual
   POST   /api/shortlist                       -> adiciona (ou atualiza a
                                                  nota de) um jogador
   PUT    /api/shortlist/:id                   -> só edita a nota
   DELETE /api/shortlist/:teamId/:playerId     -> remove um jogador
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

/* Mesma linha de pensamento do estado do jogador na aba "Negociar" do
   perfil (script_perfilJogador.js:setupNegotiateTab) — devolvido já
   calculado para o frontend não ter de repetir esta lógica. */
function shortlistStatusFor(player) {
  if (!player.team_id) return 'Agente Livre';
  return 'No plantel de outro clube';
}

router.get('/:teamId', (req, res) => {
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const rows = db.prepare(`
    SELECT
      s.id AS shortlist_id, s.note, s.created_at,
      p.id AS player_id, p.name, p.photo_path, p.position_tag, p.position_code,
      p.current_ability_stars, p.potential_ability_stars, p.market_value_text, p.wage_text,
      p.birth_date, p.nationality_code, p.personality, p.is_listed, p.asking_price,
      p.team_id, t.name AS team_name, t.shield_path AS team_shield
    FROM shortlist s
    JOIN players p ON p.id = s.player_id
    LEFT JOIN teams t ON t.id = p.team_id
    WHERE s.team_id = ?
    ORDER BY s.created_at DESC
  `).all(team.id);

  const entries = rows.map((r) => ({
    shortlist_id: r.shortlist_id,
    note: r.note,
    created_at: r.created_at,
    status: r.team_id === Number(team.id) ? 'No teu plantel' : shortlistStatusFor(r),
    player: {
      id: r.player_id, name: r.name, photo_path: r.photo_path,
      position_tag: r.position_tag, position_code: r.position_code,
      current_ability_stars: r.current_ability_stars, potential_ability_stars: r.potential_ability_stars,
      market_value_text: r.market_value_text, wage_text: r.wage_text,
      birth_date: r.birth_date, nationality_code: r.nationality_code, personality: r.personality,
      is_listed: r.is_listed, asking_price: r.asking_price,
      team_id: r.team_id, team_name: r.team_name, team_shield: r.team_shield,
    },
  }));

  res.json({ entries });
});

/* Também devolve o estado (se já está ou não na lista) para UM jogador —
   usado pelo botão no perfil para saber que rótulo mostrar ao abrir a
   página, sem ter de pedir a lista toda. */
router.get('/:teamId/status/:playerId', (req, res) => {
  const row = db.prepare('SELECT id, note FROM shortlist WHERE team_id = ? AND player_id = ?')
    .get(req.params.teamId, req.params.playerId);
  res.json({ on_shortlist: !!row, shortlist_id: row ? row.id : null, note: row ? row.note : '' });
});

router.post('/', (req, res) => {
  const { team_id, player_id, note = '' } = req.body;
  if (!team_id || !player_id) return res.status(400).json({ error: 'team_id e player_id são obrigatórios' });

  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(team_id);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });
  const player = db.prepare('SELECT id FROM players WHERE id = ?').get(player_id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });

  db.prepare(`
    INSERT INTO shortlist (team_id, player_id, note) VALUES (@team_id, @player_id, @note)
    ON CONFLICT(team_id, player_id) DO UPDATE SET note = @note
  `).run({ team_id, player_id, note });

  const row = db.prepare('SELECT id FROM shortlist WHERE team_id = ? AND player_id = ?').get(team_id, player_id);
  res.status(201).json({ shortlist_id: row.id, on_shortlist: true });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM shortlist WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Entrada não encontrada' });

  db.prepare('UPDATE shortlist SET note = ? WHERE id = ?').run(req.body.note || '', req.params.id);
  res.json({ ok: true });
});

router.delete('/:teamId/:playerId', (req, res) => {
  db.prepare('DELETE FROM shortlist WHERE team_id = ? AND player_id = ?')
    .run(req.params.teamId, req.params.playerId);
  res.json({ ok: true, on_shortlist: false });
});

module.exports = router;