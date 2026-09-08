/* ==========================================================
   FMcriol — Guardar / Carregar Jogo
   ==========================================================
   GET  /api/save/export  -> devolve o .db do dispositivo atual para
                              download ("Guardar Jogo" no dashboard).
   POST /api/save/import  -> substitui o save do dispositivo atual pelo
                              ficheiro .db enviado no corpo do pedido
                              ("Continuar jogo guardado" na seleção de
                              clube). Devolve a equipa/treinador do save
                              carregado, para o frontend atualizar o
                              localStorage antes de abrir o dashboard. */
const express = require('express');
const router = express.Router();
const db = require('../db/database');

router.get('/export', (req, res) => {
  try {
    const buffer = db.exportDeviceBuffer(req.deviceId);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="fmcriol-save-${stamp}.db"`);
    res.send(buffer);
  } catch (err) {
    console.error('Erro ao exportar o save:', err);
    res.status(500).json({ error: 'Não foi possível preparar o ficheiro de save.' });
  }
});

/* express.raw só se aplica a esta rota — o resto do servidor continua a
   usar express.json() normalmente. O limite de 50mb é bastante folgado
   para uma base SQLite de um único save. */
router.post('/import', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  try {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Não recebi nenhum ficheiro.' });
    }

    // Um ficheiro SQLite válido começa sempre com esta assinatura de 16 bytes.
    const signature = buffer.slice(0, 16).toString('utf8');
    if (!signature.startsWith('SQLite format 3')) {
      return res.status(400).json({ error: 'Esse ficheiro não parece ser um save válido do FMcriol.' });
    }

    db.importDeviceBuffer(req.deviceId, buffer);

    const team = db.prepare('SELECT id, name FROM teams WHERE is_user_controlled = 1').get();
    const state = db.prepare('SELECT manager_name FROM game_state WHERE id = 1').get();

    res.json({
      ok: true,
      team_id: team ? team.id : null,
      team_name: team ? team.name : null,
      manager_name: state ? state.manager_name || '' : '',
    });
  } catch (err) {
    console.error('Erro ao importar o save:', err);
    res.status(500).json({ error: 'Não foi possível carregar este ficheiro. Confirma que é um save do FMcriol.' });
  }
});

module.exports = router;