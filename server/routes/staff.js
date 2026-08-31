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

/* ---------- PUT /api/staff/:id/task — definir o que o Olheiro deve procurar ----------
   Só faz sentido para role='Olheiro'. Qualquer campo pode ficar em
   branco/null (sem restrição nessa dimensão) — ver routes/scout.js, que
   aplica estes filtros às recomendações e às indicações da caixa de
   entrada. `position` usa as mesmas siglas do resto do jogo: GR, DEF,
   MED, MO, PL. */
const TASK_POSITIONS = ['GR', 'DEF', 'MED', 'MO', 'PL'];

router.put('/:id/task', (req, res) => {
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id);
  if (!staff) return res.status(404).json({ error: 'Membro da comissão técnica não encontrado' });
  if (staff.role !== 'Olheiro') return res.status(400).json({ error: 'Só se pode dar esta tarefa a um Olheiro' });
  if (!staff.team_id) return res.status(400).json({ error: 'Este Olheiro ainda não está contratado por nenhum clube' });

  const { min_age, max_age, position, max_price } = req.body;

  if (position != null && position !== '' && !TASK_POSITIONS.includes(position)) {
    return res.status(400).json({ error: 'Posição inválida' });
  }
  const minAge = min_age === '' || min_age == null ? null : Number(min_age);
  const maxAge = max_age === '' || max_age == null ? null : Number(max_age);
  if (minAge != null && maxAge != null && minAge > maxAge) {
    return res.status(400).json({ error: 'A idade mínima não pode ser maior do que a máxima' });
  }
  const maxPrice = max_price === '' || max_price == null ? null : Number(max_price);

  db.prepare(`
    UPDATE staff SET task_min_age = ?, task_max_age = ?, task_position = ?, task_max_price = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(minAge, maxAge, position || null, maxPrice, staff.id);

  res.json(db.prepare('SELECT * FROM staff WHERE id = ?').get(staff.id));
});

/* ---------- DELETE /api/staff/:id (admin) ---------- */
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Membro da comissão técnica não encontrado' });
  res.status(204).end();
});

module.exports = router;