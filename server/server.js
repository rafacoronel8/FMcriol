/* ==========================================================
   FMcriol — Servidor principal
   ========================================================== */
const express = require('express');
const cors = require('cors');
const path = require('path');

const db = require('./db/database');

const teamsRouter = require('./routes/teams');
const searchRouter = require('./routes/search');
const playersRouter = require('./routes/players');
const transfersRouter = require('./routes/transfers');
const gameRouter = require('./routes/game');
const tacticsRouter = require('./routes/tactics');
const activitiesRouter = require('./routes/activities');
const friendliesRouter = require('./routes/friendlies');
const liveMatchRouter = require('./routes/liveMatch');
const leagueRouter = require('./routes/league');
const cupRouter = require('./routes/cup');
const moraleRouter = require('./routes/morale');
const staffRouter = require('./routes/staff');
const scoutRouter = require('./routes/scout');


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ---------- Um save por dispositivo ----------
   Tem de vir ANTES de qualquer rota que toque na base de dados: lê (ou
   cria, se for a primeira visita deste browser) o cookie fmcriol_device e
   liga o resto do pedido à base de dados desse dispositivo — ver
   db/database.js. Sem isto, abrir o jogo no telemóvel e no PC ao mesmo
   tempo estava a partilhar o MESMO save global, causando incoerências
   entre os dois. Agora cada browser fica com o seu próprio ficheiro .db,
   criado automaticamente na primeira visita. */
app.use(db.attachDeviceContext);

/* Serve as imagens carregadas (escudos, fotos, etc.) */
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* Serve as páginas do frontend (public/ vive ao lado de server/).
   public/index.html responde automaticamente a GET / */
app.use(express.static(path.join(__dirname, '..', 'public')));

/* Rotas da API */
app.use('/api/teams', teamsRouter);
app.use('/api/search', searchRouter);
app.use('/api/players', playersRouter);
app.use('/api/transfers', transfersRouter);
app.use('/api/game', gameRouter);
app.use('/api/tactics', tacticsRouter);
app.use('/api/activities', activitiesRouter);
app.use('/api/friendlies', friendliesRouter);
app.use('/api/live-matches', liveMatchRouter);
app.use('/api/league', leagueRouter);
app.use('/api/cup', cupRouter);
app.use('/api/morale', moraleRouter);
app.use('/api/staff', staffRouter);
app.use('/api/scout', scoutRouter);

/* Verificação rápida de que o servidor + base de dados estão a funcionar */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Servidor FMcriol ligado à base de dados.' });
});

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

app.listen(PORT, () => {
  console.log(`⚽ FMcriol server a correr em http://localhost:${PORT}`);
});