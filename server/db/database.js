/* ==========================================================
   FMcriol — Ligação à base de dados (SQLite), uma por "dispositivo"
   ==========================================================
   Cada browser (identificado por um cookie fmcriol_device — ver
   attachDeviceContext abaixo, montado em server.js) tem o seu PRÓPRIO
   ficheiro .db, para abrir o jogo no telemóvel e no PC ao mesmo tempo
   não misturar os dois saves. Toda a lógica de schema/migrações abaixo
   é EXATAMENTE a mesma de antes — só passou a estar dentro de
   buildDatabase(dbPath), chamada uma vez por dispositivo (a primeira vez
   que esse cookie aparece), em vez de uma vez só à boleia do require(). */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const Database = require('better-sqlite3');

const DB_DIR = path.join(__dirname, '..', 'data', 'saves');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

/* ---------- Migração a partir do save único antigo ----------
   Antes desta versão, havia só UM ficheiro (data/fmcriol.db) partilhado por
   toda a gente. Para quem já tinha um jogo em curso nesse ficheiro, o
   PRIMEIRO browser a aparecer sem cookie fica automaticamente "dono" desse
   save antigo em vez de começar um save novo vazio — ver attachDeviceContext
   abaixo. LEGACY_CLAIM_MARKER garante que isto só acontece uma única vez;
   qualquer dispositivo a seguir (o teu telemóvel, por exemplo) já começa
   mesmo do zero, como deve ser. */
const LEGACY_DB_PATH = path.join(__dirname, '..', 'data', 'fmcriol.db');
const LEGACY_CLAIM_MARKER = path.join(DB_DIR, '.legacy-claimed');
function legacyAlreadyClaimed() {
  return fs.existsSync(LEGACY_CLAIM_MARKER);
}
function claimLegacy() {
  fs.writeFileSync(LEGACY_CLAIM_MARKER, new Date().toISOString());
}

/* deviceId só pode conter caracteres seguros para nome de ficheiro — um
   cookie adulterado ou em falta nunca deve conseguir escapar da pasta
   data/saves (ver sanitizeDeviceId, usado antes de montar o caminho). */
function sanitizeDeviceId(rawId) {
  const cleaned = String(rawId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned && cleaned.length <= 64 ? cleaned : null;
}

function buildDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

/* ---------- Tabela de equipas ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,
  shield_path        TEXT,
  reputation_stars  REAL NOT NULL DEFAULT 2.0,
  financial_tier    TEXT NOT NULL DEFAULT 'Medio'
                      CHECK (financial_tier IN ('Muito Rico','Rico','Medio','Pobre','Muito Pobre')),
  division          INTEGER NOT NULL DEFAULT 1,
  wage_budget       REAL NOT NULL DEFAULT 0,
  transfer_budget   REAL NOT NULL DEFAULT 0,
  balance           REAL NOT NULL DEFAULT 0,
  founded_year      INTEGER,
  location          TEXT,
  stadium_name      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* ---------- Tabela de jogadores (schema base — colunas novas entram via migração abaixo) ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  photo_path  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
`);

/* ---------- Migração segura: colunas novas na tabela de equipas ---------- */
const TEAM_COLUMNS = [
  // Identifica a equipa controlada pelo utilizador (o "meu clube" da sessão atual).
  // Só pode haver uma equipa marcada de cada vez — ver POST /api/game/claim-team.
  ['is_user_controlled', 'INTEGER DEFAULT 0'],
];
const existingTeamCols = db.prepare("PRAGMA table_info(teams)").all().map((c) => c.name);
for (const [colName, colDef] of TEAM_COLUMNS) {
  if (!existingTeamCols.includes(colName)) {
    db.exec(`ALTER TABLE teams ADD COLUMN ${colName} ${colDef}`);
  }
}

/* ---------- Migração segura: acrescenta colunas que ainda não existam ----------
   Isto permite atualizar uma base de dados já criada (ex: no teu PC) sem perder
   dados — corre sempre que o servidor arranca e só adiciona o que falta. */
const PLAYER_COLUMNS = [
  // Clube de origem do jogador (nunca muda depois de definido). Usado para repor
  // corretamente os jogadores nos seus clubes quando o jogo é reiniciado —
  // independentemente de como foram transferidos (proposta manual, IA a IA,
  // ou venda automática da lista de transferências).
  ['original_team_id', 'INTEGER'],
  // Marca jogadores criados sem clube (agentes livres) — ver POST /api/players.
  // Era esta coluna que faltava e causava "no such column: starts_as_free_agent".
  ['starts_as_free_agent', 'INTEGER DEFAULT 0'],
  // Cabeçalho
  ['jersey_number', "TEXT DEFAULT '00'"],
  ['position_tag', "TEXT DEFAULT ''"],
  ['nationality_code', "TEXT DEFAULT ''"],
  ['flag_path', 'TEXT'],
  ['birth_date', 'TEXT'],
  ['club_name_override', 'TEXT'],
  ['club_logo_path', 'TEXT'],
  ['club_status', "TEXT DEFAULT 'Titular Regular'"],
  ['market_value_text', "TEXT DEFAULT ''"],
  ['caps', 'INTEGER DEFAULT 0'],
  ['international_goals', 'INTEGER DEFAULT 0'],
  ['current_ability_stars', 'REAL DEFAULT 2.5'],
  ['potential_ability_stars', 'REAL DEFAULT 3'],
  ['wage_text', "TEXT DEFAULT ''"],
  ['contract_end', "TEXT DEFAULT ''"],
  // Posições / funções (guardadas como JSON)
  ['position_code', "TEXT DEFAULT ''"],
  ['position_caption', "TEXT DEFAULT ''"],
  ['positions_json', "TEXT DEFAULT '[]'"],
  ['roles_possession_json', "TEXT DEFAULT '[]'"],
  ['roles_nopossession_json', "TEXT DEFAULT '[]'"],
  // Atributos (guardados como JSON — arrays [nome, valor])
  ['technical_json', "TEXT DEFAULT '[]'"],
  ['set_pieces_json', "TEXT DEFAULT '[]'"],
  ['mental_json', "TEXT DEFAULT '[]'"],
  ['physical_json', "TEXT DEFAULT '[]'"],
  ['goalkeeping_json', "TEXT DEFAULT '[]'"],
  // Informação
  ['height_cm', 'INTEGER DEFAULT 180'],
  ['reputation_text', "TEXT DEFAULT 'Local'"],
  ['personality', "TEXT DEFAULT ''"],
  ['left_foot', "TEXT DEFAULT 'Razoável'"],
  ['right_foot', "TEXT DEFAULT 'Razoável'"],
  ['traits', "TEXT DEFAULT ''"],
  ['gk_rating', "TEXT DEFAULT '0 / 10'"],
  // Rodapé (estado do jogador)
  ['happiness', "TEXT DEFAULT 'Contente'"],
  ['positive_count', 'INTEGER DEFAULT 0'],
  ['negative_count', 'INTEGER DEFAULT 0'],
  ['fitness_status', "TEXT DEFAULT 'No Auge'"],
  ['fitness_note', "TEXT DEFAULT 'Em ótima condição'"],
  ['form_text', "TEXT DEFAULT 'Sem Jogos Realizados'"],
  ['discipline_text', "TEXT DEFAULT '0 cartões'"],
  ['discipline_note', "TEXT DEFAULT ''"],
  ['training_status', "TEXT DEFAULT 'Não Disponível'"],
  ['training_rating', 'REAL DEFAULT 0'],
  ['season_stats_json', "TEXT DEFAULT '[]'"],
  ['career_clubs', 'INTEGER DEFAULT 1'],
  ['career_apps', 'INTEGER DEFAULT 0'],
  ['career_goals', 'INTEGER DEFAULT 0'],
  // Marca se o jogador já mudou de clube durante a janela de mercado ATUAL
  // (1-31 julho, todos os anos — ver isMarketWindowOpen abaixo) — cada
  // jogador só pode ser transferido uma vez até essa janela fechar. Volta
  // a 0 sozinho quando a janela seguinte abre (ver routes/game.js, no
  // POST /advance, à procura da transição 30/06 -> 01/07) — antes disto só
  // era reposto num "Novo Jogo", o que deixava QUALQUER jogador já
  // transferido uma vez (incluindo os comprados pelo utilizador) fora de
  // qualquer proposta futura para sempre.
  ['transferred_in_window', 'INTEGER DEFAULT 0'],
  // Assinala que o jogador teve uma grande época (ver runPlayerDevelopmentForSeason
  // em routes/league.js) — dá-lhe mais destaque no scouting de clubes mais
  // fortes na janela de mercado seguinte (ver runAiScoutingTick em
  // routes/game.js). É reposto a 0 no início de cada avaliação de fim de
  // época, por isso só reflete sempre a época mais recente.
  ['breakout_season', 'INTEGER DEFAULT 0'],

  /* ---------- Empréstimos ----------
     loan_from_team_id -> clube "dono" do jogador enquanto ele está emprestado
                           (team_id passa a ser o clube que o está a usar).
                           NULL quando o jogador não está emprestado.
     loan_return_date  -> data do calendário do jogo em que o empréstimo acaba
                           e o jogador volta automaticamente para loan_from_team_id
                           (ver runLoanReturnsIfDue em routes/transfers.js, chamado
                           a partir de POST /api/game/advance). Sempre a 1 de julho
                           da época seguinte à do empréstimo — ver reunião de
                           transferência em routes/transfers.js. */
  ['loan_from_team_id', 'INTEGER'],
  ['loan_return_date', 'TEXT'],

  /* Vontade extra de mudar de clube, ganha numa "reunião de transferência"
     depois de o jogador ter recusado uma primeira vez (opção "não faz parte
     dos planos" — ver routes/transfers.js). Consumida assim que é usada. */
  ['consent_boost', 'REAL DEFAULT 0'],

  /* ---------- Moral / personalidade do balneário ----------
     stood_down_until  -> data (do calendário do jogo) até à qual o jogador fica de fora
                           de qualquer escolha para o onze/suplentes, depois de o
                           treinador o afastar temporariamente na sequência de um
                           incidente (ver routes/morale.js). NULL = não está afastado.
     stood_down_reason -> pequena nota do motivo, mostrada no perfil/plantel. */
  ['stood_down_until', 'TEXT'],
  ['stood_down_reason', 'TEXT'],

  /* ---------- Capitania ----------
     Reavaliada no início de cada época (routes/league.js:runSeasonRolloverIfDue)
     e sempre que um plantel fica sem capitão/sub-capitão definido (ver
     routes/players.js:assignCaptaincy) — quem tem mais Liderança (mental_json)
     do plantel é o capitão, o segundo é o sub-capitão. Só pode haver um de
     cada por equipa; ver db.getCaptainFactor acima para o efeito no relvado. */
  ['is_captain', 'INTEGER DEFAULT 0'],
  ['is_vice_captain', 'INTEGER DEFAULT 0'],
  // Marcos (jogos/golos pelo clube) já anunciados na caixa de entrada, para
  // não repetir a mesma notícia todos os dias depois de o marco ser
  // atingido — ver routes/morale.js.
  ['announced_milestones_json', "TEXT DEFAULT '[]'"],

  /* ---------- Valores iniciais ("de fábrica") de cada jogador ----------
     Tudo o que o TREINO e os AMIGÁVEIS podem alterar durante a carreira
     (atributos, condição física, forma, disciplina, estatísticas da época)
     fica aqui guardado uma segunda vez, como veio configurado antes de
     começares a jogar. "Novo Jogo" (POST /api/game/reset) repõe estes
     campos a partir daqui, para que TODOS os saves comecem sempre com os
     mesmos valores iniciais, e só subam com o treino a partir daí — em vez
     de herdarem os números já inflacionados de uma carreira anterior. */
  ['baseline_technical_json', 'TEXT'],
  ['baseline_set_pieces_json', 'TEXT'],
  ['baseline_mental_json', 'TEXT'],
  ['baseline_physical_json', 'TEXT'],
  ['baseline_goalkeeping_json', 'TEXT'],
  ['baseline_training_status', 'TEXT'],
  ['baseline_training_rating', 'REAL'],
  ['baseline_fitness_status', 'TEXT'],
  ['baseline_fitness_note', 'TEXT'],
  ['baseline_happiness', 'TEXT'],
  ['baseline_positive_count', 'INTEGER'],
  ['baseline_negative_count', 'INTEGER'],
  ['baseline_discipline_text', 'TEXT'],
  ['baseline_discipline_note', 'TEXT'],
  ['baseline_form_text', 'TEXT'],
  ['baseline_season_stats_json', 'TEXT'],
  ['baseline_caps', 'INTEGER'],
  ['baseline_international_goals', 'INTEGER'],
  // Só passa a 1 depois de o "instantâneo" acima ser tirado para este
  // jogador — ver a reparação abaixo, que faz isto uma única vez para
  // jogadores já existentes, e POST /api/players, que faz isto logo na
  // criação de qualquer jogador novo.
  ['baseline_captured', 'INTEGER DEFAULT 0'],

  ['updated_at', "TEXT DEFAULT (datetime('now'))"],
];

const existingCols = db.prepare("PRAGMA table_info(players)").all().map((c) => c.name);
for (const [colName, colDef] of PLAYER_COLUMNS) {
  if (!existingCols.includes(colName)) {
    db.exec(`ALTER TABLE players ADD COLUMN ${colName} ${colDef}`);
  }
}

/* ---------- Reparação única: tira o "instantâneo" inicial de quem já existe ----------
   Jogadores criados ANTES desta atualização nunca tiveram baseline_* gravado.
   Na primeira vez que o servidor arranca com esta coluna, usa os valores
   ATUAIS de cada jogador como o seu ponto de partida — é a melhor aproximação
   possível sem um registo separado de "como o jogador estava antes de
   qualquer treino". A partir daqui, "Novo Jogo" já repõe sempre para este
   mesmo instantâneo, de forma consistente em todos os saves seguintes. */
function captureBaseline(playerId) {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!p) return;
  db.prepare(`
    UPDATE players SET
      baseline_technical_json = @technical_json, baseline_set_pieces_json = @set_pieces_json,
      baseline_mental_json = @mental_json, baseline_physical_json = @physical_json,
      baseline_goalkeeping_json = @goalkeeping_json, baseline_training_status = @training_status,
      baseline_training_rating = @training_rating, baseline_fitness_status = @fitness_status,
      baseline_fitness_note = @fitness_note, baseline_happiness = @happiness,
      baseline_positive_count = @positive_count, baseline_negative_count = @negative_count,
      baseline_discipline_text = @discipline_text, baseline_discipline_note = @discipline_note,
      baseline_form_text = @form_text, baseline_season_stats_json = @season_stats_json,
      baseline_caps = @caps, baseline_international_goals = @international_goals,
      baseline_captured = 1
    WHERE id = @id
  `).run({
    id: p.id, technical_json: p.technical_json, set_pieces_json: p.set_pieces_json,
    mental_json: p.mental_json, physical_json: p.physical_json, goalkeeping_json: p.goalkeeping_json,
    training_status: p.training_status, training_rating: p.training_rating,
    fitness_status: p.fitness_status, fitness_note: p.fitness_note, happiness: p.happiness,
    positive_count: p.positive_count, negative_count: p.negative_count,
    discipline_text: p.discipline_text, discipline_note: p.discipline_note,
    form_text: p.form_text, season_stats_json: p.season_stats_json,
    caps: p.caps, international_goals: p.international_goals,
  });
}
db.captureBaseline = captureBaseline;

{
  const notCaptured = db.prepare('SELECT id FROM players WHERE baseline_captured IS NULL OR baseline_captured = 0').all();
  notCaptured.forEach((row) => captureBaseline(row.id));
}

/* ---------- Mercado de transferências: caixa de entrada, propostas e contratos ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'info',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  player_id   INTEGER REFERENCES players(id) ON DELETE SET NULL,
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_team ON messages(team_id);

CREATE TABLE IF NOT EXISTS transfer_offers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  buyer_team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  seller_team_id  INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  offer_amount    REAL NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfer_offers_buyer ON transfer_offers(buyer_team_id);

CREATE TABLE IF NOT EXISTS contract_offers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_offer_id  INTEGER NOT NULL REFERENCES transfer_offers(id) ON DELETE CASCADE,
  player_id          INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id            INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  wage_offer         REAL NOT NULL,
  signing_bonus      REAL NOT NULL DEFAULT 0,
  promised_role      TEXT NOT NULL DEFAULT 'Titular Regular',
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_contract_offers_team ON contract_offers(team_id);
`);

/* ---------- Migração segura: negociação de propostas ----------
   negotiation_round -> quantas vezes já houve troca de valores nesta
                         proposta (a tua contraproposta conta como uma
                         ronda); ver PUT /api/transfers/:id/counter em
                         routes/transfers.js. Começa em 0 (proposta
                         original, ainda sem nenhuma contraproposta tua). */
const transferOfferCols = db.prepare("PRAGMA table_info(transfer_offers)").all().map((c) => c.name);
if (!transferOfferCols.includes('negotiation_round')) db.exec('ALTER TABLE transfer_offers ADD COLUMN negotiation_round INTEGER NOT NULL DEFAULT 0');

/* ---------- Calendário do jogo: uma única linha com a data atual ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS game_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  current_date  TEXT NOT NULL DEFAULT '2026-07-01'
);
INSERT OR IGNORE INTO game_state (id, current_date) VALUES (1, '2026-07-01');
`);

/* ---------- Migração segura: nome do treinador + boas-vindas ----------
   manager_name  -> definido em POST /api/game/claim-team (o dashboard envia-o a
                    partir do localStorage), para o servidor poder personalizar
                    mensagens como a de boas-vindas.
   welcome_sent  -> garante que a mensagem de boas-vindas só é enviada uma vez
                    por save (voltar a "Novo Jogo" repõe isto a 0). */
const gameStateCols = db.prepare("PRAGMA table_info(game_state)").all().map((c) => c.name);
if (!gameStateCols.includes('manager_name')) db.exec('ALTER TABLE game_state ADD COLUMN manager_name TEXT');
if (!gameStateCols.includes('welcome_sent')) db.exec('ALTER TABLE game_state ADD COLUMN welcome_sent INTEGER DEFAULT 0');

/* ---------- Lista de transferências: jogador + valor a que o clube aceita vender ---------- */
const listingCols = db.prepare("PRAGMA table_info(players)").all().map((c) => c.name);
if (!listingCols.includes('is_listed')) db.exec("ALTER TABLE players ADD COLUMN is_listed INTEGER DEFAULT 0");
if (!listingCols.includes('asking_price')) db.exec("ALTER TABLE players ADD COLUMN asking_price REAL");

/* ---------- Migração segura: colunas novas na tabela de mensagens ----------
   related_team_id   -> a "outra" equipa envolvida no acontecimento (compradora/vendedora),
                        para a caixa de entrada poder mostrar o escudo dela.
   transfer_offer_id -> liga a mensagem a uma proposta pendente, para a caixa de entrada
                        poder mostrar os botões Aceitar/Recusar quando o utilizador
                        precisa de decidir sobre uma transferência de/para o seu clube. */
const messageCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
if (!messageCols.includes('related_team_id')) db.exec('ALTER TABLE messages ADD COLUMN related_team_id INTEGER');
if (!messageCols.includes('transfer_offer_id')) db.exec('ALTER TABLE messages ADD COLUMN transfer_offer_id INTEGER');

/* ---------- Migração segura: reações pós-jogo estruturadas ----------
   extra_json guarda os "medidores" da notícia de resultado (nota dos
   adeptos + reação da direção, com valor 0-10 e descrição) — ver
   routes/matchReactions.js, usado por routes/game.js e
   routes/liveMatch.js. O tipo de mensagem 'player_of_match' (Jogador do
   Jogo) reaproveita as colunas já existentes: player_id (para a foto e
   as estatísticas da época, via JOIN em routes/transfers.js) e
   title/body — não precisa de nenhuma coluna nova. */
if (!messageCols.includes('extra_json')) db.exec('ALTER TABLE messages ADD COLUMN extra_json TEXT');

/* ---------- Personalidade: normaliza para um conjunto fixo de 5 níveis ----------
   O campo já existia como texto livre (o que já estava escrito no perfil de cada
   jogador); agora passa a ser escolhido num menu fixo, para os eventos de
   balneário (ver routes/morale.js) poderem confiar no valor. Qualquer coisa que
   não seja um dos 5 níveis reconhecidos (incluindo o texto de exemplo antigo,
   como "Ambicioso", ou o campo vazio) passa a "Normal". */
const PERSONALITY_TIERS = ['Muito Fiel', 'Fiel', 'Normal', 'Problemático', 'Muito Problemático'];
db.prepare(`
  UPDATE players SET personality = 'Normal'
  WHERE personality IS NULL OR TRIM(personality) = ''
     OR personality NOT IN (${PERSONALITY_TIERS.map(() => '?').join(',')})
`).run(...PERSONALITY_TIERS);

/* ---------- Incidentes de personalidade + perguntas ao treinador ----------
   player_incidents  -> gerado quando um jogador "Problemático"/"Muito Problemático"
                         arranja uma briga ou faz uma birra (ver runMoraleTick em
                         routes/morale.js); fica "pending" até o treinador decidir
                         o que fazer (colocar na lista de transferências, afastar
                         temporariamente, ou ignorar).
   manager_questions -> perguntas ocasionais na caixa de entrada; a resposta
                         escolhida influencia a moral (happiness) do plantel. */
db.exec(`
CREATE TABLE IF NOT EXISTS player_incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('fight','tantrum','playing_time')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  resolution  TEXT,
  event_date  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS manager_questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  prompt       TEXT NOT NULL,
  options_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  chosen_key   TEXT,
  event_date   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT
);
`);

/* ---------- Migração segura: alarga o CHECK de kind em player_incidents ----------
   Mesma ideia da migração de player_awards mais abaixo — bases de dados
   criadas antes do pedido de tempo de jogo ('playing_time') têm a tabela
   já criada com o CHECK antigo. */
{
  /* Defensivo: se um arranque anterior falhou a meio desta mesma migração
     (ex: erro entre o RENAME e o DROP), ficava para trás uma tabela
     "player_incidents_old" órfã — e como db.exec corria cada instrução com
     o seu próprio commit automático, um erro a meio NÃO desfazia os passos
     já feitos. Isso deixava o jogo preso: o schema de player_incidents já
     tinha 'playing_time' (por isso a migração nunca mais voltava a correr),
     mas a tabela "_old" continuava lá — e QUALQUER coluna com uma FOREIGN
     KEY criada nesse intervalo (ex: messages.incident_id, ver mais abaixo)
     ou uma nova tentativa de migração passava a apontar/mexer numa tabela
     que já não devia existir, rebentando com "no such table:
     main.player_incidents_old". Envolver tudo numa única transação evita
     que isto volte a acontecer (ou tudo corre, ou nada fica feito), e o
     DROP TABLE IF EXISTS no arranque limpa qualquer resto que já tenha
     ficado de trás por este motivo antes de tentar outra vez. */
  const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'player_incidents'").get();
  if (schemaRow && !schemaRow.sql.includes('playing_time')) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS player_incidents_old');
      db.exec('ALTER TABLE player_incidents RENAME TO player_incidents_old');
      db.exec(`
        CREATE TABLE player_incidents (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          kind        TEXT NOT NULL CHECK (kind IN ('fight','tantrum','playing_time')),
          status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
          resolution  TEXT,
          event_date  TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
        );
      `);
      db.exec(`
        INSERT INTO player_incidents (id, team_id, player_id, kind, status, resolution, event_date, created_at, resolved_at)
          SELECT id, team_id, player_id, kind, status, resolution, event_date, created_at, resolved_at FROM player_incidents_old
      `);
      db.exec('DROP TABLE player_incidents_old');
    })();
  } else {
    /* Limpa qualquer tabela órfã de uma falha anterior mesmo quando a
       migração acima já não precisa de correr desta vez. */
    db.exec('DROP TABLE IF EXISTS player_incidents_old');
  }
}

if (!messageCols.includes('incident_id')) db.exec('ALTER TABLE messages ADD COLUMN incident_id INTEGER REFERENCES player_incidents(id)');
if (!messageCols.includes('question_id')) db.exec('ALTER TABLE messages ADD COLUMN question_id INTEGER REFERENCES manager_questions(id)');

/* ---------- Reuniões de transferência ----------
   Criada quando o clube vendedor aceita uma proposta mas o PRÓPRIO
   JOGADOR recusa mudar-se (ver decidePlayerConsent em routes/transfers.js).
   Em vez do negócio cair logo ali, o treinador vendedor fica com a
   oportunidade de reunir com o jogador antes de o negócio ser dado como
   falhado — ver PUT /api/transfers/meetings/:id/respond. */
db.exec(`
CREATE TABLE IF NOT EXISTS transfer_meetings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id            INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id          INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  buyer_team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  transfer_offer_id  INTEGER NOT NULL REFERENCES transfer_offers(id) ON DELETE CASCADE,
  offer_amount       REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  resolution         TEXT,
  event_date         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfer_meetings_team ON transfer_meetings(team_id);
`);
if (!messageCols.includes('meeting_id')) db.exec('ALTER TABLE messages ADD COLUMN meeting_id INTEGER REFERENCES transfer_meetings(id)');

/* Liga uma mensagem "Jogo de Hoje" (match_day) ao amigável/jornada/eliminatória
   em causa — permite à caixa de entrada saber se ainda precisa de resposta
   (club_friendlies.status ainda 'accepted') e abrir o jogo certo a partir dos
   botões Jogar/Simular. Ver routes/game.js e routes/liveMatch.js. */
if (!messageCols.includes('friendly_id')) db.exec('ALTER TABLE messages ADD COLUMN friendly_id INTEGER REFERENCES club_friendlies(id)');

/* ---------- Reparação: FK partida em messages.incident_id ("player_incidents_old") ----------
   Isto é o que estava mesmo a causar o crash em produção, mesmo depois da
   migração de player_incidents acima ter sido tornada atómica: numa versão
   ANTIGA do código, a linha "ALTER TABLE messages ADD COLUMN incident_id ..."
   correu num momento em que a tabela ainda se chamava "player_incidents_old"
   (a meio de uma migração anterior que falhou a meio). O SQLite guarda o
   texto do REFERENCES tal como foi escrito nesse momento — por isso a
   coluna incident_id de bases de dados já existentes ficou PARA SEMPRE a
   apontar para "player_incidents_old", mesmo depois do código ter sido
   corrigido. Com PRAGMA foreign_keys = ON, qualquer INSERT/UPDATE em
   messages (ex: mensagens da caixa de entrada durante amigáveis — ver
   routes/game.js) obriga o SQLite a verificar essa referência e falha com
   "no such table: main.player_incidents_old", porque essa tabela nunca
   voltou a existir. A única forma de corrigir isto numa base de dados que
   já tem o problema é reconstruir a tabela messages do zero, com o
   REFERENCES correto — não há "ALTER TABLE ... DROP CONSTRAINT" em SQLite. */
{
  const messagesSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
  if (messagesSchema && messagesSchema.sql.includes('player_incidents_old')) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS messages_fixed');
      db.exec(`
        CREATE TABLE messages_fixed (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id            INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          type               TEXT NOT NULL DEFAULT 'info',
          title              TEXT NOT NULL,
          body               TEXT NOT NULL,
          player_id          INTEGER REFERENCES players(id) ON DELETE SET NULL,
          is_read            INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL DEFAULT (datetime('now')),
          related_team_id    INTEGER,
          transfer_offer_id  INTEGER,
          incident_id        INTEGER REFERENCES player_incidents(id),
          question_id        INTEGER REFERENCES manager_questions(id),
          meeting_id         INTEGER REFERENCES transfer_meetings(id),
          friendly_id        INTEGER REFERENCES club_friendlies(id),
          extra_json         TEXT
        );
      `);
      const hasExtraJsonAlready = db.prepare("PRAGMA table_info(messages)").all().some((c) => c.name === 'extra_json');
      db.exec(`
        INSERT INTO messages_fixed
          (id, team_id, type, title, body, player_id, is_read, created_at, related_team_id, transfer_offer_id, incident_id, question_id, meeting_id, friendly_id${hasExtraJsonAlready ? ', extra_json' : ''})
        SELECT id, team_id, type, title, body, player_id, is_read, created_at, related_team_id, transfer_offer_id, incident_id, question_id, meeting_id, friendly_id${hasExtraJsonAlready ? ', extra_json' : ''}
        FROM messages
      `);
      db.exec('DROP TABLE messages');
      db.exec('ALTER TABLE messages_fixed RENAME TO messages');
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_team ON messages(team_id)');
    })();
  }
}

/* ---------- Backfill: jogadores já existentes que ainda não têm original_team_id
   ficam com o clube atual como "clube de origem" (melhor opção possível sem re-semear). */
db.prepare('UPDATE players SET original_team_id = team_id WHERE original_team_id IS NULL AND team_id IS NOT NULL').run();

/* ---------- Táticas: formação, onze inicial (por posição no campo) e suplentes ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS tactics (
  team_id      INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  formation    TEXT NOT NULL DEFAULT '4-3-3',
  lineup_json  TEXT NOT NULL DEFAULT '[]',
  bench_json   TEXT NOT NULL DEFAULT '[]',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* ---------- Notícias do mercado: registo global de TODAS as movimentações ----------
   Ao contrário de "messages" (que é a caixa de entrada privada de cada clube),
   esta tabela guarda um registo público de tudo o que acontece no mercado —
   incluindo negócios entre duas equipas geridas pelo jogo, que não envolvem o
   utilizador. É o que alimenta a tab "Mercado" do dashboard (estilo jornal de
   notícias). Os nomes/escudos são guardados em texto (não FKs) para que a
   notícia continue legível mesmo que o jogador ou a equipa deixem de existir. */
db.exec(`
CREATE TABLE IF NOT EXISTS market_news (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date         TEXT,
  type               TEXT NOT NULL,
  headline           TEXT NOT NULL,
  body               TEXT NOT NULL,
  player_name        TEXT,
  player_photo       TEXT,
  from_team_name     TEXT,
  from_team_shield   TEXT,
  to_team_name       TEXT,
  to_team_shield     TEXT,
  amount             REAL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_market_news_created ON market_news(id DESC);
`);

/* ---------- Atividades diárias: o que o utilizador fez com a equipa em cada dia ----------
   Uma linha por (equipa, dia de jogo) — impede fazer mais do que uma atividade
   por dia e permite ao dashboard saber qual foi feita hoje. */
db.exec(`
CREATE TABLE IF NOT EXISTS team_activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  activity_key  TEXT NOT NULL,
  event_date    TEXT NOT NULL,
  summary       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* Reparação defensiva: se já existir uma tabela "team_activity_log" de uma
   tentativa anterior sem estas colunas, a criação acima é ignorada (IF NOT
   EXISTS) e o índice abaixo falharia. Recria do zero nesse caso — é uma
   tabela nova desta funcionalidade, não há dados antigos a perder. */
{
  const cols = db.prepare("PRAGMA table_info(team_activity_log)").all().map((c) => c.name);
  const expected = ['team_id', 'activity_key', 'event_date'];
  if (expected.some((c) => !cols.includes(c))) {
    db.exec('DROP TABLE IF EXISTS team_activity_log');
    db.exec(`
      CREATE TABLE team_activity_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        activity_key  TEXT NOT NULL,
        event_date    TEXT NOT NULL,
        summary       TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_team_activity_unique ON team_activity_log(team_id, event_date)');

/* ---------- Jogos amigáveis: pedidos entre clubes, com aceitação/recusa ----------
   Chamada "club_friendlies" (em vez de só "friendlies") de propósito, para
   não colidir com nenhuma tabela de calendário/competições que já exista
   no projeto (ex: migrations/competitions.js).
   requested_by_team_id existe para que, no futuro, se possa distinguir quem
   propôs o encontro mesmo que "home_team_id" mude (ex: jogos "fora"). */
db.exec(`
CREATE TABLE IF NOT EXISTS club_friendlies (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  home_team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  requested_by_team_id  INTEGER NOT NULL,
  match_date            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','accepted','declined','played','cancelled')),
  decline_reason        TEXT,
  home_score            INTEGER,
  away_score            INTEGER,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at           TEXT
);
`);

/* Mesma reparação defensiva, para o caso de existir uma "club_friendlies"
   incompleta de uma tentativa anterior. */
{
  const cols = db.prepare("PRAGMA table_info(club_friendlies)").all().map((c) => c.name);
  const expected = ['home_team_id', 'away_team_id', 'match_date', 'status'];
  if (expected.some((c) => !cols.includes(c))) {
    db.exec('DROP TABLE IF EXISTS club_friendlies');
    db.exec(`
      CREATE TABLE club_friendlies (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        home_team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        away_team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        requested_by_team_id  INTEGER NOT NULL,
        match_date            TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','accepted','declined','played','cancelled')),
        decline_reason        TEXT,
        home_score            INTEGER,
        away_score            INTEGER,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at           TEXT
      );
    `);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_club_friendlies_home ON club_friendlies(home_team_id, match_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_club_friendlies_away ON club_friendlies(away_team_id, match_date)');

/* Marca um "amigável" interno criado automaticamente para um jogo do
   Campeonato (ver routes/league.js) — permite reaproveitar toda a máquina
   já existente de jogo do dia / jogo ao vivo sem duplicar código, e permite
   à interface (e à lista "Amigáveis") esconder estas entradas, já que não
   são amigáveis reais marcados pelo utilizador. */
{
  const cfCols = db.prepare("PRAGMA table_info(club_friendlies)").all().map((c) => c.name);
  if (!cfCols.includes('is_league')) db.exec('ALTER TABLE club_friendlies ADD COLUMN is_league INTEGER DEFAULT 0');
  /* Marca se a palestra de balneário de pré-jogo/pós-jogo já foi dada para
     este jogo — cada uma só pode ser dada uma vez (ver routes/liveMatch.js).
     pre_talk_given também serve para o botão "Jogar" da mensagem de "Jogo de
     Hoje" (routes/game.js) saber se ainda pode abrir o ecrã de pré-jogo. */
  if (!cfCols.includes('pre_talk_given')) db.exec('ALTER TABLE club_friendlies ADD COLUMN pre_talk_given INTEGER DEFAULT 0');
  if (!cfCols.includes('post_talk_given')) db.exec('ALTER TABLE club_friendlies ADD COLUMN post_talk_given INTEGER DEFAULT 0');
}

/* ---------- Campeonato: calendário oficial (round-robin a duas voltas) ----------
   Gerado de uma só vez por save (ver regenerateSeasonFixtures em
   routes/league.js), a começar sempre a 1 de agosto — depois de fechar o
   mês de mercado/pré-época. Jogos que envolvam o clube do utilizador ficam
   "linked" a uma linha em club_friendlies (friendly_id) assim que o
   calendário lhes chega, para poderem ser assistidos ao vivo tal como um
   amigável; os restantes ficam "played" diretamente, com o resultado já
   simulado. */
db.exec(`
CREATE TABLE IF NOT EXISTS league_fixtures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  round         INTEGER NOT NULL,
  home_team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  match_date    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','linked','played')),
  home_score    INTEGER,
  away_score    INTEGER,
  friendly_id   INTEGER REFERENCES club_friendlies(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_league_fixtures_date ON league_fixtures(match_date);
CREATE INDEX IF NOT EXISTS idx_league_fixtures_home ON league_fixtures(home_team_id, match_date);
CREATE INDEX IF NOT EXISTS idx_league_fixtures_away ON league_fixtures(away_team_id, match_date);
`);

/* Mesma ideia do is_league, mas para a Taça São Vicente (ver routes/cup.js). */
{
  const cfCols2 = db.prepare("PRAGMA table_info(club_friendlies)").all().map((c) => c.name);
  if (!cfCols2.includes('is_cup')) db.exec('ALTER TABLE club_friendlies ADD COLUMN is_cup INTEGER DEFAULT 0');
}

/* ---------- Taça São Vicente: mata-mata a uma mão, com sorteio por ronda ----------
   Ao contrário do Campeonato (calendário gerado de uma vez, todo à partida),
   a Taça só sorteia uma ronda de cada vez — a ronda seguinte só existe depois
   de o treinador pedir o sorteio (ver POST /api/cup/draw), tal como pedido:
   "a cada rodada existirá um sorteio". Por isso não há aqui nenhum
   "regenerateSeasonFixtures" equivalente: as linhas desta tabela vão sendo
   inseridas ronda a ronda, à medida que o torneio avança.
     round            -> 1 = primeira eliminatória, 2 = quartos, 3 = meias, 4 = final
                          (com 15 clubes, a ronda 1 tem um "bye")
     is_bye           -> esta linha não é um jogo — a equipa em home_team_id passa
                          à ronda seguinte sem jogar (away_team_id fica NULL)
     winner_team_id    -> só é preenchido quando status = 'played' (ou de imediato,
                          no caso de um bye) */
db.exec(`
CREATE TABLE IF NOT EXISTS cup_fixtures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  round          INTEGER NOT NULL,
  round_name     TEXT NOT NULL,
  home_team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id   INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  is_bye         INTEGER NOT NULL DEFAULT 0,
  match_date     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','linked','played')),
  home_score     INTEGER,
  away_score     INTEGER,
  decided_by_penalties INTEGER NOT NULL DEFAULT 0,
  winner_team_id INTEGER REFERENCES teams(id),
  friendly_id    INTEGER REFERENCES club_friendlies(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cup_fixtures_date ON cup_fixtures(match_date);
CREATE INDEX IF NOT EXISTS idx_cup_fixtures_round ON cup_fixtures(round);
`);

/* ---------- Estatísticas individuais de cada amigável ----------
   Uma linha por jogador que participou num amigável já realizado: quantos
   golos e assistências fez nesse jogo em concreto, e a nota que recebeu.
   Alimenta o modal de detalhe do amigável (routes/friendlies.js) e serve de
   base ao resumo "Amigáveis" gravado no perfil de cada jogador (season_stats_json),
   onde a Média é a média de todas estas notas. Apaga em cascata quando o
   amigável (ou o jogador) é apagado — e também quando "Novo Jogo" limpa a
   tabela club_friendlies, para que amigáveis de um save anterior nunca
   apareçam num save novo. */
db.exec(`
CREATE TABLE IF NOT EXISTS friendly_player_stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  friendly_id   INTEGER NOT NULL REFERENCES club_friendlies(id) ON DELETE CASCADE,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id     INTEGER REFERENCES players(id) ON DELETE SET NULL,
  player_name   TEXT NOT NULL,
  position_tag  TEXT,
  goals         INTEGER NOT NULL DEFAULT 0,
  assists       INTEGER NOT NULL DEFAULT 0,
  rating        REAL NOT NULL DEFAULT 6.0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_friendly_player_stats_friendly ON friendly_player_stats(friendly_id);
`);

/* Cartões amarelos/vermelhos de cada amigável — migração segura, para não
   perder os jogos já simulados de saves anteriores a esta funcionalidade. */
const FRIENDLY_STAT_COLUMNS = [
  ['yellow_cards', 'INTEGER DEFAULT 0'],
  ['red_card', 'INTEGER DEFAULT 0'],
];
const existingFriendlyStatCols = db.prepare("PRAGMA table_info(friendly_player_stats)").all().map((c) => c.name);
for (const [colName, colDef] of FRIENDLY_STAT_COLUMNS) {
  if (!existingFriendlyStatCols.includes(colName)) {
    db.exec(`ALTER TABLE friendly_player_stats ADD COLUMN ${colName} ${colDef}`);
  }
}

/* ---------- Estatísticas por competição (Campeonato / Taça) ----------
   friendly_player_stats passou a guardar TAMBÉM as estatísticas dos jogos
   do Campeonato e da Taça entre duas equipas geridas pelo jogo (sem
   nenhum amigável associado) — por isso friendly_id, que antes era sempre
   obrigatório, tem agora de poder ficar a NULL nesses casos. O SQLite não
   permite tirar um NOT NULL com ALTER TABLE, por isso esta migração
   reconstrói a tabela de raiz, preservando todas as linhas já guardadas
   (com competition = 'friendly', já que só existiam amigáveis quando
   friendly_id era obrigatório). Só corre uma vez — fica marcada pela
   presença da coluna "competition". */
{
  /* Mesma proteção aplicada a player_incidents/player_awards — ver o
     comentário grande junto a "player_incidents_old" mais acima. */
  const cols = db.prepare("PRAGMA table_info(friendly_player_stats)").all();
  const hasCompetitionCol = cols.some((c) => c.name === 'competition');
  if (!hasCompetitionCol) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS friendly_player_stats_old');
      db.exec('ALTER TABLE friendly_player_stats RENAME TO friendly_player_stats_old');
      db.exec(`
        CREATE TABLE friendly_player_stats (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          friendly_id   INTEGER REFERENCES club_friendlies(id) ON DELETE CASCADE,
          competition   TEXT NOT NULL DEFAULT 'friendly' CHECK (competition IN ('friendly','league','cup')),
          team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          player_id     INTEGER REFERENCES players(id) ON DELETE SET NULL,
          player_name   TEXT NOT NULL,
          position_tag  TEXT,
          goals         INTEGER NOT NULL DEFAULT 0,
          assists       INTEGER NOT NULL DEFAULT 0,
          rating        REAL NOT NULL DEFAULT 6.0,
          yellow_cards  INTEGER DEFAULT 0,
          red_card      INTEGER DEFAULT 0,
          tackles       INTEGER DEFAULT 0,
          pass_pct      REAL,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(`
        INSERT INTO friendly_player_stats
          (id, friendly_id, competition, team_id, player_id, player_name, position_tag, goals, assists, rating, yellow_cards, red_card, tackles, pass_pct, created_at)
        SELECT id, friendly_id, 'friendly', team_id, player_id, player_name, position_tag, goals, assists, rating, yellow_cards, red_card, 0, NULL, created_at
        FROM friendly_player_stats_old
      `);
      db.exec('DROP TABLE friendly_player_stats_old');
    })();
  } else {
    db.exec('DROP TABLE IF EXISTS friendly_player_stats_old');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_friendly_player_stats_friendly ON friendly_player_stats(friendly_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_friendly_player_stats_competition ON friendly_player_stats(competition, player_id)');
}

/* Dribles e passes por jogo — migração segura à parte, tal como
   yellow_cards/red_card acima (FRIENDLY_STAT_COLUMNS), para não obrigar a
   reconstruir a tabela outra vez. Usados no radar de Desempenho do perfil
   do jogador (dr/ps em season_stats_json — ver applySeasonStat abaixo). */
const FRIENDLY_STAT_COLUMNS_V2 = [
  ['dribbles', 'INTEGER DEFAULT 0'],
  ['passes', 'INTEGER DEFAULT 0'],
];
const existingFriendlyStatColsV2 = db.prepare("PRAGMA table_info(friendly_player_stats)").all().map((c) => c.name);
for (const [colName, colDef] of FRIENDLY_STAT_COLUMNS_V2) {
  if (!existingFriendlyStatColsV2.includes(colName)) {
    db.exec(`ALTER TABLE friendly_player_stats ADD COLUMN ${colName} ${colDef}`);
  }
}

const COMPETITION_ROW_NAMES = {
  friendly: 'Amigáveis (Não Oficial)',
  league: 'Campeonato',
  cup: 'Taça São Vicente',
};
db.COMPETITION_ROW_NAMES = COMPETITION_ROW_NAMES;

/* Acumula o resultado de UM jogo (goals/assists/cartões/cortes/% passe/
   nota) na linha certa de season_stats_json do jogador — a mesma ideia que
   já existia só para amigáveis (routes/game.js e routes/liveMatch.js),
   agora centralizada aqui para poder ser usada também pelo Campeonato e
   pela Taça (routes/league.js, routes/cup.js), incluindo jogos inteiramente
   entre equipas geridas pelo jogo, sem nenhum amigável por trás. */
function applySeasonStat(playerId, competitionRowName, stats) {
  const { goals = 0, assists = 0, yellow = 0, red = 0, tackles = 0, dribbles = 0, passes = 0, passPct = null, rating = null } = stats || {};
  const player = db.prepare('SELECT season_stats_json FROM players WHERE id = ?').get(playerId);
  if (!player) return;

  let rows;
  try { rows = JSON.parse(player.season_stats_json || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];

  let row = rows.find((r) => r.competition === competitionRowName);
  if (!row) {
    row = { competition: competitionRowName, j: 0, g: 0, a: 0, xg: 0, pen: 0, mdp: 0, am: 0, verm: 0, tk: 0, dr: 0, ps: 0, pp: '-', media: '-' };
    rows.push(row);
  }

  const prevJ = Number(row.j) || 0;
  const prevMedia = parseFloat(row.media);
  const prevMediaTotal = Number.isFinite(prevMedia) ? prevMedia * prevJ : 0;
  const prevPP = parseFloat(row.pp);
  const prevPPTotal = Number.isFinite(prevPP) ? prevPP * prevJ : 0;

  row.j = prevJ + 1;
  row.g = (Number(row.g) || 0) + goals;
  row.a = (Number(row.a) || 0) + assists;
  row.am = (Number(row.am) || 0) + yellow;
  row.verm = (Number(row.verm) || 0) + red;
  row.tk = (Number(row.tk) || 0) + tackles;
  row.dr = (Number(row.dr) || 0) + dribbles;
  row.ps = (Number(row.ps) || 0) + passes;
  if (rating != null) row.media = ((prevMediaTotal + rating) / row.j).toFixed(2);
  if (passPct != null) row.pp = ((prevPPTotal + passPct) / row.j).toFixed(1);

  db.prepare("UPDATE players SET season_stats_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(rows), playerId);
}
db.applySeasonStat = applySeasonStat;

/* ---------- Jogos ao vivo: sessão de simulação minuto a minuto ----------
   Guarda o estado de um amigável enquanto está a ser assistido ao vivo (só
   acontece com jogos de hoje que envolvam o clube do utilizador — ver
   routes/liveMatch.js): o onze/suplentes de cada equipa NESSE jogo em
   concreto, o calendário interno de golos/cartões já sorteados mas ainda
   por revelar, e os acontecimentos já revelados ao utilizador (comentário
   minuto a minuto). Uma equipa só pode ter uma sessão por amigável — por
   isso friendly_id é UNIQUE. Apaga-se sozinha (cascade) quando o amigável
   é apagado, tal como friendly_player_stats. */
db.exec(`
CREATE TABLE IF NOT EXISTS live_matches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  friendly_id       INTEGER NOT NULL UNIQUE REFERENCES club_friendlies(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','finished')),
  current_minute    INTEGER NOT NULL DEFAULT 0,
  home_score        INTEGER NOT NULL DEFAULT 0,
  away_score        INTEGER NOT NULL DEFAULT 0,
  home_state_json   TEXT NOT NULL,
  away_state_json   TEXT NOT NULL,
  schedule_json     TEXT NOT NULL,
  events_json       TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* Migração segura: se a tabela live_matches já existia de uma versão
   anterior do jogo (ex: antes de "current_minute" ou outra coluna terem
   sido acrescentadas), "CREATE TABLE IF NOT EXISTS" acima não faz nada —
   e a rota /api/live-matches falhava com "no column named current_minute"
   (ou outra coluna em falta). Isto garante que a tabela tem sempre todas
   as colunas que o código espera, tal como já acontece com
   friendly_player_stats mais acima. */
const LIVE_MATCH_COLUMNS = [
  ['status', "TEXT DEFAULT 'in_progress'"],
  ['current_minute', 'INTEGER DEFAULT 0'],
  ['home_score', 'INTEGER DEFAULT 0'],
  ['away_score', 'INTEGER DEFAULT 0'],
  ['home_state_json', "TEXT DEFAULT '{}'"],
  ['away_state_json', "TEXT DEFAULT '{}'"],
  ['schedule_json', "TEXT DEFAULT '[]'"],
  ['events_json', "TEXT DEFAULT '[]'"],
  ['created_at', "TEXT DEFAULT (datetime('now'))"],
  ['updated_at', "TEXT DEFAULT (datetime('now'))"],
];
const existingLiveMatchCols = db.prepare("PRAGMA table_info(live_matches)").all().map((c) => c.name);
for (const [colName, colDef] of LIVE_MATCH_COLUMNS) {
  if (!existingLiveMatchCols.includes(colName)) {
    db.exec(`ALTER TABLE live_matches ADD COLUMN ${colName} ${colDef}`);
  }
}

/* Regista um acontecimento no jornal do mercado. Chamado a partir das rotas de
   transferências (propostas, contratos, respostas) e do avanço do calendário
   (vendas automáticas entre equipas geridas pelo jogo). */
function logMarketNews(fields) {
  /* IMPORTANTE: "current_date" tem de vir qualificado com o nome da tabela.
     Sem isto, o SQLite interpreta "current_date" como a sua própria palavra-chave
     incorporada (a data REAL do computador) em vez da coluna — as notícias do
     mercado ficavam com a data real do sistema em vez da data do jogo. */
  const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
  db.prepare(`
    INSERT INTO market_news (
      event_date, type, headline, body, player_name, player_photo,
      from_team_name, from_team_shield, to_team_name, to_team_shield, amount
    ) VALUES (
      @event_date, @type, @headline, @body, @player_name, @player_photo,
      @from_team_name, @from_team_shield, @to_team_name, @to_team_shield, @amount
    )
  `).run({
    event_date: state?.current_date ?? null,
    type: fields.type,
    headline: fields.headline,
    body: fields.body,
    player_name: fields.player_name ?? null,
    player_photo: fields.player_photo ?? null,
    from_team_name: fields.from_team_name ?? null,
    from_team_shield: fields.from_team_shield ?? null,
    to_team_name: fields.to_team_name ?? null,
    to_team_shield: fields.to_team_shield ?? null,
    amount: fields.amount ?? null,
  });
}
db.logMarketNews = logMarketNews;

/* ---------- Mercado de transferências: reabre todos os anos, 1 jul – 31 jul ----------
   A pré-época/mercado está sempre aberta entre 1 de julho e 31 de julho,
   TODOS os anos — fecha mesmo a tempo do Campeonato começar a 1 de agosto
   (ver LEAGUE_SEASON_START / current_season_start em routes/league.js).
   Compara só o "MM-DD" da data do jogo, para não depender do ano — assim
   o mercado volta a abrir sozinho a cada nova época, sem precisar de
   nenhum reset manual. */
function isMarketWindowOpen() {
  /* IMPORTANTE: "current_date" tem de vir qualificado com o nome da tabela.
     Sem isto, o SQLite interpreta "current_date" como a sua própria palavra-chave
     incorporada (a data REAL do computador) em vez da coluna — a janela de
     mercado ficava a decidir com base no mês real do sistema em vez do mês
     do calendário do jogo. */
  const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
  const monthDay = String(state?.current_date || '').slice(5, 10); // 'MM-DD'
  return monthDay >= '07-01' && monthDay <= '07-31';
}
db.isMarketWindowOpen = isMarketWindowOpen;

/* Um jogador só pode mudar de clube UMA vez por mercado — chamado sempre que
   uma transferência se conclui (proposta do utilizador, contrato assinado, ou
   negócio automático entre equipas geridas pelo jogo). */
function markTransferredInWindow(playerId) {
  db.prepare('UPDATE players SET transferred_in_window = 1 WHERE id = ?').run(playerId);
}
db.markTransferredInWindow = markTransferredInWindow;

/* Sempre que um "amigável" (real ou gerado para uma jornada do Campeonato —
   ver is_league acima) é dado como jogado, isto propaga o resultado para a
   linha correspondente em league_fixtures, se existir alguma ligada a este
   friendly_id. Chamado a partir de routes/game.js (runFriendliesTick) e de
   routes/liveMatch.js (finalizeMatch) — os dois sítios onde um
   club_friendlies passa a status = 'played'. Não faz nada se não houver
   nenhuma linha ligada (amigável normal, sem relação com o Campeonato). */
function syncLeagueFixtureFromFriendly(friendlyId, homeScore, awayScore) {
  db.prepare(`
    UPDATE league_fixtures SET status = 'played', home_score = ?, away_score = ?
    WHERE friendly_id = ?
  `).run(homeScore, awayScore, friendlyId);
}
db.syncLeagueFixtureFromFriendly = syncLeagueFixtureFromFriendly;

/* Equivalente a syncLeagueFixtureFromFriendly, mas para a Taça São Vicente
   (ver is_cup acima e routes/cup.js). A Taça é a eliminar — não pode
   terminar empatada, por isso, se o resultado ficar empatado ao fim dos 90
   minutos (o motor de jogo/amigáveis não simula prolongamento nem
   grandes penalidades), o vencedor é decidido aqui mesmo por um
   desempate aleatório, ligeiramente influenciado pela reputação de cada
   equipa, e a marcação fica com decided_by_penalties = 1 para a interface
   poder mostrar "(gp)" junto ao resultado. */
/* ---------- Prémios em dinheiro da Taça São Vicente ----------
   Cada vitória (ou apuramento por desempate) que faça uma equipa avançar
   de ronda vale £50.000, somados sempre ao saldo da equipa — geridas pelo
   jogo ou não, para as contas do jogo se manterem coerentes. Nunca para um
   "bye" (aí não houve jogo nenhum para ganhar). Sagrar-se CAMPEÃO (vencer
   a Final) vale mais £100.000, à parte do prémio de vitória dessa própria
   ronda — o troféu vale a dobrar de uma vitória "normal". Só o clube do
   utilizador recebe mensagem na caixa de entrada; as outras 14 equipas só
   veem o saldo mudar (não têm caixa de entrada — ver routes/morale.js).

   Vive aqui (em vez de routes/cup.js) porque também é chamada de dentro de
   syncCupFixtureFromFriendly, logo abaixo — o único sítio por onde passam
   TODOS os jogos do utilizador na Taça, sejam simulados
   (routes/game.js:simulateSingleFriendly) ou assistidos ao vivo
   (routes/liveMatch.js). Se estivesse só em routes/cup.js:runCupTick (que
   só trata jogos entre equipas geridas pelo jogo), o utilizador nunca
   receberia prémio nenhum pelos SEUS próprios jogos da Taça. */
const CUP_ROUND_ADVANCE_PRIZE = 50000;
const CUP_CHAMPION_BONUS_PRIZE = 100000;

function awardCupPrizeMoney(fixture) {
  if (!fixture || !fixture.winner_team_id || fixture.is_bye) return;

  const grantPrize = (teamId, amount, type, title, body) => {
    db.prepare("UPDATE teams SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?").run(amount, teamId);
    const team = db.prepare('SELECT is_user_controlled FROM teams WHERE id = ?').get(teamId);
    if (team && team.is_user_controlled) {
      db.prepare('INSERT INTO messages (team_id, type, title, body) VALUES (?, ?, ?, ?)').run(teamId, type, title, body);
    }
  };

  const winnerTeam = db.prepare('SELECT name FROM teams WHERE id = ?').get(fixture.winner_team_id);
  const winnerName = winnerTeam ? winnerTeam.name : 'A equipa';
  const prizeFmt = `£${CUP_ROUND_ADVANCE_PRIZE.toLocaleString('pt-PT')}`;
  grantPrize(
    fixture.winner_team_id, CUP_ROUND_ADVANCE_PRIZE, 'cup_prize_money',
    `💰 Prémio da Taça: ${prizeFmt}`,
    `O ${winnerName} apurou-se para a ronda seguinte da Taça São Vicente e recebeu ${prizeFmt} em prémios.`,
  );

  if (fixture.round_name === 'Final') {
    const bonusFmt = `£${CUP_CHAMPION_BONUS_PRIZE.toLocaleString('pt-PT')}`;
    grantPrize(
      fixture.winner_team_id, CUP_CHAMPION_BONUS_PRIZE, 'cup_champion_prize',
      `🏆 Prémio de Campeão: ${bonusFmt}`,
      `O ${winnerName} conquistou a Taça São Vicente e recebeu mais ${bonusFmt} em prémios pelo título.`,
    );
  }
}
db.awardCupPrizeMoney = awardCupPrizeMoney;

/* ---------- Efeito do capitão na simulação de jogos ----------
   Um capitão com Liderança alta dá um pequeno empurrão extra à equipa
   (como se fosse mais um pouco de reputação); um capitão mal escolhido
   (liderança baixa — normalmente porque o plantel não tinha ninguém com
   jeito para isso, ver routes/players.js:assignCaptaincy) tem o efeito
   inverso. Não decide um jogo sozinho, mas garante que a escolha do
   capitão pesa mesmo no relvado, não só na caixa de entrada. Usado pelo
   Campeonato e pela Taça (jogos entre equipas geridas pelo jogo) e pelos
   jogos do próprio utilizador (ver simulateFriendlyGoals em
   routes/game.js) — o mesmo cálculo para todas as competições. */
function getCaptainFactor(teamId) {
  const captain = db.prepare("SELECT mental_json FROM players WHERE team_id = ? AND is_captain = 1").get(teamId);
  if (!captain) return 0;
  let mental = [];
  try { mental = JSON.parse(captain.mental_json || '[]'); } catch { mental = []; }
  const entry = mental.find(([name]) => name === 'Liderança');
  const leadership = entry ? Number(entry[1]) || 0 : 10;
  // Liderança vai de 1 a 20; 10 é neutro. O máximo dá +0.25 de reputação
  // efetiva, o mínimo dá -0.225 — pequeno, mas soma ao longo da época.
  return (leadership - 10) / 40;
}
db.getCaptainFactor = getCaptainFactor;

function syncCupFixtureFromFriendly(friendlyId, homeScore, awayScore) {
  const fixture = db.prepare('SELECT * FROM cup_fixtures WHERE friendly_id = ?').get(friendlyId);
  if (!fixture) return;

  let winnerId;
  let decidedByPenalties = 0;
  if (homeScore > awayScore) {
    winnerId = fixture.home_team_id;
  } else if (awayScore > homeScore) {
    winnerId = fixture.away_team_id;
  } else {
    decidedByPenalties = 1;
    const home = db.prepare('SELECT reputation_stars FROM teams WHERE id = ?').get(fixture.home_team_id);
    const away = db.prepare('SELECT reputation_stars FROM teams WHERE id = ?').get(fixture.away_team_id);
    const homeChance = 0.5 + ((home?.reputation_stars ?? 2.5) - (away?.reputation_stars ?? 2.5)) * 0.04;
    winnerId = Math.random() < Math.max(0.25, Math.min(0.75, homeChance)) ? fixture.home_team_id : fixture.away_team_id;
  }

  db.prepare(`
    UPDATE cup_fixtures SET status = 'played', home_score = ?, away_score = ?,
      winner_team_id = ?, decided_by_penalties = ?
    WHERE id = ?
  `).run(homeScore, awayScore, winnerId, decidedByPenalties, fixture.id);

  awardCupPrizeMoney({ winner_team_id: winnerId, round_name: fixture.round_name, is_bye: fixture.is_bye });
}
db.syncCupFixtureFromFriendly = syncCupFixtureFromFriendly;

db.PERSONALITY_TIERS = PERSONALITY_TIERS;

/* ---------- Comissão técnica: adjuntos, fisioterapeutas, preparadores físicos ----------
   Criados no admin (gestaoStaff.html), com ou sem clube atribuído — quem não
   tem clube fica disponível para qualquer equipa "contratar" a partir do
   jogo (Meu Clube), pagando hire_fee de uma vez (o jogo não tem folha de
   pagamento semanal — os salários de jogadores também não são debitados
   automaticamente, ver routes/game.js). Os efeitos de cada cargo estão em
   routes/morale.js (Adjunto) e routes/activities.js (Fisioterapeuta,
   Preparador Físico). */
const STAFF_ROLES = ['Adjunto', 'Fisioterapeuta', 'Preparador Físico'];
db.STAFF_ROLES = STAFF_ROLES;

/* ---------- Época: reinício automático + palmarés ----------
   current_season_start -> sempre um 1 de agosto; é a partir desta data que
   routes/league.js gera o calendário da época em curso. Quando o
   calendário do jogo chega ao 1 de agosto seguinte, a época "fecha":
   atribuem-se os troféus (Campeonato + Taça) e os 5 prémios individuais,
   e gera-se logo a seguir um Campeonato novo (ver runSeasonRolloverIfDue
   em routes/league.js). */
{
  const gsCols = db.prepare("PRAGMA table_info(game_state)").all().map((c) => c.name);
  if (!gsCols.includes('current_season_start')) {
    db.exec("ALTER TABLE game_state ADD COLUMN current_season_start TEXT DEFAULT '2026-08-01'");
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS trophies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  competition   TEXT NOT NULL CHECK (competition IN ('league','cup')),
  season_label  TEXT NOT NULL,
  won_date      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trophies_team ON trophies(team_id);

CREATE TABLE IF NOT EXISTS player_awards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  award_key     TEXT NOT NULL CHECK (award_key IN (
                  'best_player','top_scorer','best_defender','best_assist','best_goalkeeper',
                  'cup_top_scorer','cup_best_assist','cup_best_defender',
                  'best_xi_gr',
                  'best_xi_def_1','best_xi_def_2','best_xi_def_3','best_xi_def_4',
                  'best_xi_med_1','best_xi_med_2','best_xi_med_3',
                  'best_xi_ata_1','best_xi_ata_2','best_xi_ata_3'
                )),
  season_label  TEXT NOT NULL,
  won_date      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_player_awards_player ON player_awards(player_id);
`);

/* ---------- Migração segura: alarga o CHECK de award_key ----------
   Bases de dados criadas antes dos prémios da Taça (cup_top_scorer,
   cup_best_assist, cup_best_defender) têm a tabela já criada com o CHECK
   antigo — "CREATE TABLE IF NOT EXISTS" acima não o atualiza. SQLite não
   permite alterar um CHECK existente, por isso recria-se a tabela quando
   o CHECK guardado no próprio SQLite ainda não conhece as chaves novas. */
{
  /* Mesma proteção aplicada acima a player_incidents — ver o comentário
     grande junto a "player_incidents_old" para a explicação completa do
     porquê de isto ter de ser atómico. */
  const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'player_awards'").get();
  if (schemaRow && (!schemaRow.sql.includes('cup_top_scorer') || !schemaRow.sql.includes('best_xi_gr'))) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS player_awards_old');
      db.exec('ALTER TABLE player_awards RENAME TO player_awards_old');
      db.exec(`
        CREATE TABLE player_awards (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
          award_key     TEXT NOT NULL CHECK (award_key IN (
                          'best_player','top_scorer','best_defender','best_assist','best_goalkeeper',
                          'cup_top_scorer','cup_best_assist','cup_best_defender',
                          'best_xi_gr',
                          'best_xi_def_1','best_xi_def_2','best_xi_def_3','best_xi_def_4',
                          'best_xi_med_1','best_xi_med_2','best_xi_med_3',
                          'best_xi_ata_1','best_xi_ata_2','best_xi_ata_3'
                        )),
          season_label  TEXT NOT NULL,
          won_date      TEXT NOT NULL,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(`
        INSERT INTO player_awards (id, player_id, team_id, award_key, season_label, won_date, created_at)
          SELECT id, player_id, team_id, award_key, season_label, won_date, created_at FROM player_awards_old
      `);
      db.exec('DROP TABLE player_awards_old');
      db.exec('CREATE INDEX IF NOT EXISTS idx_player_awards_player ON player_awards(player_id)');
    })();
  } else {
    db.exec('DROP TABLE IF EXISTS player_awards_old');
  }
}

/* ---------- Histórico de carreira: estatísticas por época + títulos coletivos ----------
   Até aqui, o fim de uma época (runSeasonRolloverIfDue em routes/league.js)
   limpava season_stats_json e friendly_player_stats do Campeonato/Taça sem
   guardar nada — a aba "Carreira" do perfil só tinha os 3 totais manuais
   (career_clubs/career_apps/career_goals) e os prémios individuais, nunca
   um histórico ano a ano. player_season_history guarda uma "fotografia"
   das estatísticas de cada jogador por competição, no momento em que a
   época fecha. player_trophies faz o mesmo para os troféus de equipa
   (Campeonato/Taça): fica registado para cada jogador que estava no
   plantel da equipa campeã nesse preciso momento, para o perfil dele
   poder mostrar também os títulos coletivos que ajudou a conquistar. */
db.exec(`
CREATE TABLE IF NOT EXISTS player_season_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  team_name     TEXT,
  team_shield   TEXT,
  season_label  TEXT NOT NULL,
  competition   TEXT NOT NULL,
  games         INTEGER NOT NULL DEFAULT 0,
  goals         INTEGER NOT NULL DEFAULT 0,
  assists       INTEGER NOT NULL DEFAULT 0,
  yellow_cards  INTEGER NOT NULL DEFAULT 0,
  red_cards     INTEGER NOT NULL DEFAULT 0,
  tackles       INTEGER NOT NULL DEFAULT 0,
  pass_pct      REAL,
  rating        REAL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_player_season_history_player ON player_season_history(player_id);

CREATE TABLE IF NOT EXISTS player_trophies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  team_name     TEXT,
  team_shield   TEXT,
  competition   TEXT NOT NULL CHECK (competition IN ('league','cup')),
  season_label  TEXT NOT NULL,
  won_date      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_player_trophies_player ON player_trophies(player_id);
`);

db.AWARD_LABELS = {
  best_player: 'Melhor Jogador',
  top_scorer: 'Melhor Marcador',
  best_defender: 'Melhor Defesa',
  best_assist: 'Melhor Assistente',
  best_goalkeeper: 'Melhor Guarda-Redes',
  cup_top_scorer: 'Melhor Marcador da Taça',
  cup_best_assist: 'Melhor Assistente da Taça',
  cup_best_defender: 'Melhor Defesa da Taça',
};
db.AWARD_ICONS = {
  best_player: '👑',
  top_scorer: '⚽',
  best_defender: '🛡️',
  best_assist: '🎯',
  best_goalkeeper: '🧤',
  cup_top_scorer: '🏆⚽',
  cup_best_assist: '🏆🎯',
  cup_best_defender: '🏆🛡️',
};
/* Ordem "de gala" para a cerimónia de prémios (ver GET
   /api/league/awards-ceremony/:teamId) — os prémios da Taça primeiro,
   depois os do Campeonato/geral, a fechar sempre com o Melhor Jogador. */
db.AWARD_CEREMONY_ORDER = [
  'cup_top_scorer', 'cup_best_assist', 'cup_best_defender',
  'top_scorer', 'best_assist', 'best_goalkeeper', 'best_defender', 'best_player',
];

/* ---------- Especialização do jogador (escolhida no perfil) ----------
   Goleador -> pesa mais a favor deste jogador quando se escolhe quem marca
              (ver SCORE_WEIGHT em routes/game.js, routes/competitionStats.js,
              routes/liveMatch.js).
   Garçom   -> mesma ideia, mas para assistências (ASSIST_WEIGHT).
   Patrão   -> a equipa dele sofre ligeiramente menos golos (ver
              simulateLeagueGoals em routes/league.js e simulateCupGoals em
              routes/cup.js — só se aplica a jogos simulados automaticamente,
              não aos que o utilizador assiste ao vivo). */
const FOCUS_ROLES = ['Goleador', 'Garçom', 'Patrão'];
db.FOCUS_ROLES = FOCUS_ROLES;
{
  const pCols = db.prepare("PRAGMA table_info(players)").all().map((c) => c.name);
  if (!pCols.includes('focus_role')) db.exec('ALTER TABLE players ADD COLUMN focus_role TEXT');
}

db.exec(`
CREATE TABLE IF NOT EXISTS staff (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id           INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('Adjunto','Fisioterapeuta','Preparador Físico')),
  quality_stars     REAL NOT NULL DEFAULT 2.5,
  nationality_code  TEXT,
  wage_text         TEXT,
  hire_fee          REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_team ON staff(team_id);
`);

  return db;
} // ---------- fim de buildDatabase — tudo acima corre uma vez por dispositivo ----------

/* ---------- Uma ligação por dispositivo, guardada em memória ----------
   Reabrir o ficheiro .db a cada pedido seria lento e arriscado (bloqueios
   de ficheiro); guarda-se a ligação já aberta por deviceId e reutiliza-se
   em todos os pedidos seguintes desse dispositivo. */
const connectionsByDevice = new Map();

function getDeviceDatabase(deviceId) {
  const safeId = sanitizeDeviceId(deviceId) || 'default';
  let conn = connectionsByDevice.get(safeId);
  if (!conn) {
    const dbPath = safeId === 'legacy' ? LEGACY_DB_PATH : path.join(DB_DIR, `${safeId}.db`);
    conn = buildDatabase(dbPath);
    connectionsByDevice.set(safeId, conn);
  }
  return conn;
}

/* ---------- Contexto do pedido atual (qual dispositivo está a falar) ----------
   attachDeviceContext (chamado em server.js, antes de qualquer rota) lê o
   cookie fmcriol_device — criando um novo, aleatório, se ainda não existir
   — e corre o resto do pedido "dentro" desse contexto. Como todas as
   rotas desta aplicação são síncronas (better-sqlite3 é síncrono, sem
   await pelo meio), isto chega para toda a cadeia de chamadas de um
   pedido ver sempre o dispositivo certo, sem ter de passar `db` à mão por
   todas as rotas. */
const deviceContext = new AsyncLocalStorage();

function attachDeviceContext(req, res, next) {
  const cookies = String(req.headers.cookie || '').split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    return acc;
  }, {});

  const setDeviceCookie = (id) => {
    res.setHeader('Set-Cookie', `fmcriol_device=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365 * 5}; SameSite=Lax`);
  };

  let deviceId = sanitizeDeviceId(cookies.fmcriol_device);

  if (!deviceId) {
    /* Browser sem cookie — ou é mesmo a primeira visita de sempre, ou é a
       transição para este sistema de saves por dispositivo. Se ainda
       existir o save único antigo e ninguém o tiver reclamado ainda, este
       é o browser que fica com ele. */
    if (!legacyAlreadyClaimed() && fs.existsSync(LEGACY_DB_PATH)) {
      deviceId = 'legacy';
      claimLegacy();
    } else {
      deviceId = crypto.randomBytes(16).toString('hex');
    }
    setDeviceCookie(deviceId);
  } else if (deviceId !== 'legacy' && !legacyAlreadyClaimed() && fs.existsSync(LEGACY_DB_PATH)) {
    /* Cobre o caso de alguém já ter recebido um cookie novo (e vazio) nos
       primeiros minutos depois desta atualização, antes desta correção —
       se esse save novo ainda não tem NENHUMA equipa, é seguro assumir que
       foi criado por engano e trazer de volta o save antigo em vez de
       deixar o jogo "vazio" sem explicação. */
    const emptyConn = getDeviceDatabase(deviceId);
    const hasTeams = emptyConn.prepare('SELECT COUNT(*) AS n FROM teams').get().n > 0;
    if (!hasTeams) {
      deviceId = 'legacy';
      claimLegacy();
      setDeviceCookie(deviceId);
    }
  }

  deviceContext.run(deviceId, next);
}

/* ---------- Objeto exportado ----------
   Um Proxy: qualquer coisa que se peça a `db` (db.prepare(...), db.exec(...),
   db.applySeasonStat(...), etc.) é encaminhada para a ligação do
   dispositivo ATUAL (via AsyncLocalStorage). Isto significa que TODOS os
   routes/*.js continuam a fazer `const db = require('../db/database')` e a
   usá-lo exatamente como antes, sem precisar de saber nada sobre
   dispositivos — só database.js e server.js (attachDeviceContext) é que
   sabem que existe mais do que uma base de dados. */
const dbProxy = new Proxy({}, {
  get(target, prop) {
    /* attachDeviceContext é middleware puro, não faz sentido reencaminhar
       para nenhuma base de dados de dispositivo — atende-se sempre aqui,
       mesmo fora de qualquer pedido (é usado em server.js antes de as
       rotas correrem). */
    if (prop === 'attachDeviceContext') return attachDeviceContext;
    const deviceId = deviceContext.getStore();
    const conn = getDeviceDatabase(deviceId);
    const value = conn[prop];
    return typeof value === 'function' ? value.bind(conn) : value;
  },
  set(target, prop, value) {
    if (prop === 'attachDeviceContext') return true;
    const deviceId = deviceContext.getStore();
    const conn = getDeviceDatabase(deviceId);
    conn[prop] = value;
    return true;
  },
});

module.exports = dbProxy;