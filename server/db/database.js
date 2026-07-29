/* ==========================================================
   FMcriol — Ligação à base de dados (SQLite)
   ========================================================== */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'fmcriol.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
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
  // Marca se o jogador já mudou de clube durante a janela de mercado atual —
  // só existe UM mercado por jogo, por isso cada jogador só pode ser
  // transferido uma vez até o mercado fechar (ver isMarketWindowOpen abaixo).
  ['transferred_in_window', 'INTEGER DEFAULT 0'],
  ['updated_at', "TEXT DEFAULT (datetime('now'))"],
];

const existingCols = db.prepare("PRAGMA table_info(players)").all().map((c) => c.name);
for (const [colName, colDef] of PLAYER_COLUMNS) {
  if (!existingCols.includes(colName)) {
    db.exec(`ALTER TABLE players ADD COLUMN ${colName} ${colDef}`);
  }
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

/* ---------- Calendário do jogo: uma única linha com a data atual ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS game_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  current_date  TEXT NOT NULL DEFAULT '2026-07-01'
);
INSERT OR IGNORE INTO game_state (id, current_date) VALUES (1, '2026-07-01');
`);

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

/* Regista um acontecimento no jornal do mercado. Chamado a partir das rotas de
   transferências (propostas, contratos, respostas) e do avanço do calendário
   (vendas automáticas entre equipas geridas pelo jogo). */
function logMarketNews(fields) {
  const state = db.prepare('SELECT current_date FROM game_state WHERE id = 1').get();
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

/* ---------- Mercado de transferências: existe apenas UM mês de mercado por jogo ----------
   A janela fica aberta só durante o mês em que a carreira começa (2026-07, ver
   INSERT OR IGNORE INTO game_state acima e /api/game/reset). Fora desse mês —
   ou seja, depois de avançar o calendário para agosto — não é possível abrir
   nem receber novas propostas. Isto é o que garante "existe apenas um mês de
   mercado" pedido no bug report. */
const MARKET_WINDOW_MONTH = '2026-07';
function isMarketWindowOpen() {
  const state = db.prepare('SELECT current_date FROM game_state WHERE id = 1').get();
  return String(state?.current_date || '').slice(0, 7) === MARKET_WINDOW_MONTH;
}
db.isMarketWindowOpen = isMarketWindowOpen;

/* Um jogador só pode mudar de clube UMA vez por mercado — chamado sempre que
   uma transferência se conclui (proposta do utilizador, contrato assinado, ou
   negócio automático entre equipas geridas pelo jogo). */
function markTransferredInWindow(playerId) {
  db.prepare('UPDATE players SET transferred_in_window = 1 WHERE id = ?').run(playerId);
}
db.markTransferredInWindow = markTransferredInWindow;

module.exports = db;