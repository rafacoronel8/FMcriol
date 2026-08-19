/* ==========================================================
   FMcriol — Rotas da API para Jogos Amigáveis
   Marca amigáveis com outros clubes; o adversário (gerido pelo
   jogo) aceita ou recusa o convite consoante a sua agenda e a
   diferença de reputação. Os jogos aceites são simulados
   automaticamente quando o calendário chega à data marcada
   (ver applyFriendliesForDate, chamado a partir de routes/game.js).
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

const TEAM_FIELDS = 'id, name, shield_path, reputation_stars, division';

function currentGameDate() {
  /* IMPORTANTE: "current_date" tem de vir qualificado com o nome da tabela.
     Sem isto, o SQLite interpreta "current_date" como a sua própria palavra-chave
     incorporada (a data REAL do computador), em vez da coluna da tabela — o que
     desincronizava a data mínima/aceite para amigáveis, e a lista de "próximos
     amigáveis", da data real do calendário do jogo. */
  return db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get().current_date;
}

function serialize(row) {
  return { ...row };
}

/* ---------- GET /api/friendlies/:teamId — agenda de amigáveis do clube ---------- */
router.get('/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const rows = db.prepare(`
    SELECT f.*,
           h.name AS home_name, h.shield_path AS home_shield, h.reputation_stars AS home_reputation,
           a.name AS away_name, a.shield_path AS away_shield, a.reputation_stars AS away_reputation
    FROM club_friendlies f
    JOIN teams h ON h.id = f.home_team_id
    JOIN teams a ON a.id = f.away_team_id
    WHERE f.home_team_id = ? OR f.away_team_id = ?
    ORDER BY f.match_date ASC, f.id ASC
  `).all(teamId, teamId);

  const today = currentGameDate();
  const pending = rows.filter((r) => r.status === 'pending');
  const upcoming = rows.filter((r) => r.status === 'accepted' && r.match_date >= today);
  const history = rows.filter((r) => r.status === 'played' || r.status === 'declined' || r.status === 'cancelled')
    .sort((a, b) => (a.match_date < b.match_date ? 1 : -1));

  res.json({ current_date: today, pending, upcoming, history });
});

/* ---------- POST /api/friendlies — agendar um amigável ----------
   O clube do utilizador é sempre o anfitrião ("casa"); o adversário
   decide de imediato se aceita ou recusa o convite. */
router.post('/', (req, res) => {
  const { team_id, opponent_team_id, match_date } = req.body;
  if (!team_id || !opponent_team_id || !match_date) {
    return res.status(400).json({ error: 'Faltam dados: equipa, adversário e data são obrigatórios' });
  }
  if (Number(team_id) === Number(opponent_team_id)) {
    return res.status(400).json({ error: 'Uma equipa não pode defrontar-se a si própria' });
  }

  const home = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
  const away = db.prepare('SELECT * FROM teams WHERE id = ?').get(opponent_team_id);
  if (!home || !away) return res.status(404).json({ error: 'Equipa não encontrada' });

  const today = currentGameDate();
  if (match_date <= today) {
    return res.status(400).json({ error: 'A data do amigável tem de ser depois de hoje' });
  }

  const clash = db.prepare(`
    SELECT id FROM club_friendlies
    WHERE match_date = ? AND status IN ('pending','accepted')
      AND (home_team_id = ? OR away_team_id = ? OR home_team_id = ? OR away_team_id = ?)
  `).get(match_date, home.id, home.id, away.id, away.id);
  if (clash) return res.status(409).json({ error: 'Uma das equipas já tem um amigável marcado para esse dia' });

  /* Também não pode marcar-se um amigável num dia em que uma das equipas já
     tem jornada do Campeonato marcada (ver routes/league.js) — mesmo que
     essa jornada ainda esteja só "agendada" e não tenha chegado a virar um
     amigável interno (is_league). */
  const leagueClash = db.prepare(`
    SELECT id FROM league_fixtures
    WHERE match_date = ? AND (home_team_id = ? OR away_team_id = ? OR home_team_id = ? OR away_team_id = ?)
  `).get(match_date, home.id, home.id, away.id, away.id);
  if (leagueClash) return res.status(409).json({ error: 'Uma das equipas já tem uma jornada do Campeonato marcada para esse dia' });

  /* Mesma verificação para a Taça São Vicente (ver routes/cup.js). */
  const cupClash = db.prepare(`
    SELECT id FROM cup_fixtures
    WHERE match_date = ? AND is_bye = 0
      AND (home_team_id = ? OR away_team_id = ? OR home_team_id = ? OR away_team_id = ?)
  `).get(match_date, home.id, home.id, away.id, away.id);
  if (cupClash) return res.status(409).json({ error: 'Uma das equipas já tem um jogo da Taça São Vicente marcado para esse dia' });

  /* ---------- Decisão do adversário ----------
     Clubes com reputação muito diferente da tua têm menos interesse em
     marcar um amigável "amistoso" — e uma equipa já com vários amigáveis
     aceites fica mais relutante em encher ainda mais a agenda. */
  const repGap = Math.abs(home.reputation_stars - away.reputation_stars);
  const alreadyBooked = db.prepare(`
    SELECT COUNT(*) AS n FROM club_friendlies
    WHERE status = 'accepted' AND (home_team_id = ? OR away_team_id = ?)
  `).get(away.id, away.id).n;

  let acceptChance = 0.88 - repGap * 0.12 - alreadyBooked * 0.06;
  acceptChance = Math.max(0.12, Math.min(0.95, acceptChance));
  const accepted = Math.random() < acceptChance;

  const info = db.prepare(`
    INSERT INTO club_friendlies (home_team_id, away_team_id, requested_by_team_id, match_date, status, resolved_at, decline_reason)
    VALUES (@home_team_id, @away_team_id, @requested_by_team_id, @match_date, @status, datetime('now'), @decline_reason)
  `).run({
    home_team_id: home.id,
    away_team_id: away.id,
    requested_by_team_id: team_id,
    match_date,
    status: accepted ? 'accepted' : 'declined',
    decline_reason: accepted ? null : (repGap > 1.5
      ? 'A diferença de nível entre os clubes é demasiado grande'
      : 'A equipa já tem a agenda preenchida com outros compromissos'),
  });

  const friendly = db.prepare('SELECT * FROM club_friendlies WHERE id = ?').get(info.lastInsertRowid);

  db.prepare(`
    INSERT INTO messages (team_id, type, title, body, related_team_id)
    VALUES (@team_id, @type, @title, @body, @related_team_id)
  `).run(accepted ? {
    team_id: home.id,
    type: 'friendly_accepted',
    title: `Amigável confirmado: ${away.name}`,
    body: `O ${away.name} aceitou o convite. Jogam um amigável marcado para essa data.`,
    related_team_id: away.id,
  } : {
    team_id: home.id,
    type: 'friendly_declined',
    title: `Amigável recusado: ${away.name}`,
    body: `O ${away.name} recusou o convite. ${friendly.decline_reason}.`,
    related_team_id: away.id,
  });

  res.status(201).json(serialize(friendly));
});

/* ---------- GET /api/friendlies/match/:id — detalhe de um amigável já realizado ----------
   Devolve quem marcou, quem assistiu, e a nota de cada jogador que
   participou (guardado em friendly_player_stats quando o dia do jogo é
   simulado — ver applyFriendliesForDate / simulateFriendlyMatchDetails em
   routes/game.js). Usado pelo modal de detalhe no dashboard. */
router.get('/match/:id', (req, res) => {
  const friendly = db.prepare(`
    SELECT f.*,
           h.name AS home_name, h.shield_path AS home_shield,
           a.name AS away_name, a.shield_path AS away_shield
    FROM club_friendlies f
    JOIN teams h ON h.id = f.home_team_id
    JOIN teams a ON a.id = f.away_team_id
    WHERE f.id = ?
  `).get(req.params.id);

  if (!friendly) return res.status(404).json({ error: 'Amigável não encontrado' });
  if (friendly.status !== 'played') {
    return res.status(400).json({ error: 'Este amigável ainda não tem detalhes — só é simulado quando o dia do jogo chega.' });
  }

  const stats = db.prepare('SELECT * FROM friendly_player_stats WHERE friendly_id = ? ORDER BY rating DESC').all(req.params.id);

  res.json({
    ...serialize(friendly),
    home_players: stats.filter((s) => s.team_id === friendly.home_team_id),
    away_players: stats.filter((s) => s.team_id === friendly.away_team_id),
  });
});

/* ---------- PUT /api/friendlies/:id/cancel — cancelar um amigável ainda não jogado ---------- */
router.put('/:id/cancel', (req, res) => {
  const friendly = db.prepare('SELECT * FROM club_friendlies WHERE id = ?').get(req.params.id);
  if (!friendly) return res.status(404).json({ error: 'Amigável não encontrado' });
  if (!['pending', 'accepted'].includes(friendly.status)) {
    return res.status(400).json({ error: 'Este amigável já não pode ser cancelado' });
  }

  db.prepare("UPDATE club_friendlies SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;