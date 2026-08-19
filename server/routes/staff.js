/* ==========================================================
   FMcriol — Rotas da API para a Comissão Técnica
   Adjuntos, fisioterapeutas e preparadores físicos. Criados no admin
   (admin/gestaoStaff.html), com ou sem clube atribuído — quem não tem
   clube fica na bolsa disponível para qualquer equipa "contratar" a
   partir do jogo (Meu Clube). Os efeitos de cada cargo vivem onde faz
   sentido para o resto do código: Adjunto em routes/morale.js (moral +
   relatórios de desempenho na caixa de entrada), Fisioterapeuta e
   Preparador Físico em routes/activities.js (recuperação física e
   ganhos de treino).
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

/* ---------- GET /api/staff?team_id=X | ?available=1 ---------- */
router.get('/', (req, res) => {
  const { team_id, available } = req.query;
  let sql = `
    SELECT s.*, t.name AS team_name, t.shield_path AS team_shield
    FROM staff s
    LEFT JOIN teams t ON t.id = s.team_id
  `;
  const params = {};

  if (available) {
    sql += ' WHERE s.team_id IS NULL';
  } else if (team_id) {
    sql += ' WHERE s.team_id = @team_id';
    params.team_id = team_id;
  }
  sql += ' ORDER BY s.role ASC, s.quality_stars DESC, s.name ASC';

  res.json(db.prepare(sql).all(params));
});

/* ---------- POST /api/staff — criar membro da comissão técnica (admin) ---------- */
router.post('/', (req, res) => {
  const {
    name, role, team_id = null, quality_stars = 2.5,
    nationality_code = '', wage_text = '', hire_fee = 0,
  } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'O nome é obrigatório' });
  if (!db.STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Cargo inválido' });

  if (team_id) {
    const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(team_id);
    if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });
  }

  const info = db.prepare(`
    INSERT INTO staff (name, role, team_id, quality_stars, nationality_code, wage_text, hire_fee)
    VALUES (@name, @role, @team_id, @quality_stars, @nationality_code, @wage_text, @hire_fee)
  `).run({
    name: name.trim(), role, team_id: team_id || null,
    quality_stars: Number(quality_stars) || 2.5,
    nationality_code, wage_text, hire_fee: Number(hire_fee) || 0,
  });

  res.status(201).json(db.prepare('SELECT * FROM staff WHERE id = ?').get(info.lastInsertRowid));
});

/* ---------- PUT /api/staff/:id — editar (admin) ---------- */
const UPDATABLE_FIELDS = ['name', 'role', 'team_id', 'quality_stars', 'nationality_code', 'wage_text', 'hire_fee'];

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Membro da comissão técnica não encontrado' });

  const updates = {};
  UPDATABLE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) updates[field] = req.body[field];
  });
  if (updates.role && !db.STAFF_ROLES.includes(updates.role)) {
    return res.status(400).json({ error: 'Cargo inválido' });
  }
  if (!Object.keys(updates).length) return res.json(existing);

  const setClause = Object.keys(updates).map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE staff SET ${setClause}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...updates, id: req.params.id });

  res.json(db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id));
});

/* ---------- PUT /api/staff/:id/hire — contratar (jogo, não admin) ----------
   Só funciona em staff disponível (sem clube); debita hire_fee do saldo do
   clube de uma vez (o jogo não tem folha de pagamento semanal — ver nota
   em db/database.js). */
router.put('/:id/hire', (req, res) => {
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id);
  if (!staff) return res.status(404).json({ error: 'Membro da comissão técnica não encontrado' });
  if (staff.team_id) return res.status(409).json({ error: 'Este membro da comissão técnica já está contratado por outro clube' });

  const { team_id } = req.body;
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  if (staff.hire_fee > 0 && team.balance < staff.hire_fee) {
    return res.status(400).json({ error: `Saldo insuficiente — precisas de ${staff.hire_fee.toLocaleString('pt-PT')} para esta contratação.` });
  }

  const hire = db.transaction(() => {
    db.prepare("UPDATE staff SET team_id = ?, updated_at = datetime('now') WHERE id = ?").run(team_id, staff.id);
    if (staff.hire_fee > 0) {
      db.prepare("UPDATE teams SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?").run(staff.hire_fee, team_id);
    }
    db.prepare(`
      INSERT INTO messages (team_id, type, title, body)
      VALUES (@team_id, 'staff_hired', @title, @body)
    `).run({
      team_id,
      title: `✍️ ${staff.name} junta-se à comissão técnica`,
      body: `Contrataste ${staff.name} como ${staff.role}.`,
    });
  });
  hire();

  res.json(db.prepare('SELECT * FROM staff WHERE id = ?').get(staff.id));
});

/* ---------- PUT /api/staff/:id/release — despedir (volta para a bolsa, sem reembolso) ---------- */
router.put('/:id/release', (req, res) => {
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id);
  if (!staff) return res.status(404).json({ error: 'Membro da comissão técnica não encontrado' });

  db.prepare("UPDATE staff SET team_id = NULL, updated_at = datetime('now') WHERE id = ?").run(staff.id);
  res.json({ ok: true });
});

/* ---------- DELETE /api/staff/:id (admin) ---------- */
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Membro da comissão técnica não encontrado' });
  res.status(204).end();
});

module.exports = router;