/* ==========================================================
   FMcriol — Seed inicial das equipas da Primeira Divisão
   Executa com: npm run seed
   ========================================================== */
const db = require('./database');

/* Multiplicador financeiro usado para calcular orçamentos automaticamente.
   Ajusta estes valores quando quiseres afinar o equilíbrio económico do jogo. */
const FINANCIAL_MULTIPLIER = {
  'Muito Rico': 5.0,
  'Rico': 3.0,
  'Medio': 1.5,
  'Pobre': 0.8,
  'Muito Pobre': 0.4,
};

const BASE_WAGE_BUDGET = 5000;       // £ por semana, na referência (3 estrelas, tier Medio)
const BASE_TRANSFER_BUDGET = 250000; // £, na referência (3 estrelas, tier Medio)
const BASE_BALANCE = 200000;         // £, saldo inicial de referência

/* ----------------------------------------------------------------
   Cores dos equipamentos de cada equipa (ver parseTeamKits/
   resolveMatchKits em db/database.js). `pattern` é só para desenhar
   o boneco (solid/stripes/checkered/bordered); `base` é a cor usada
   para detetar confusão de cores entre as duas equipas em jogo, por
   isso é sempre a cor mais dominante/reconhecível do equipamento. */
const C = {
  preto: '#1a1a1a',
  branco: '#f5f5f0',
  amarelo: '#f2c14e',
  azul: '#1d3557',
  azulCiano: '#00bcd4',
  vermelho: '#d6402f',
  verde: '#2e8b57',
  laranja: '#e8a33d',
};
const BOB_MARLEY_BORDER = [C.vermelho, C.amarelo, C.verde];

function kit(pattern, base, accent, label, borders) {
  return { pattern, base, accent, label, borders: borders || null };
}

const TEAM_KITS = {
  'Academica': {
    home: kit('solid', C.preto, C.branco, 'Principal'),
    away: kit('solid', C.branco, C.preto, 'Secundário'),
  },
  'Amarante': {
    home: kit('solid', C.amarelo, C.azul, 'Principal'),
    away: kit('solid', C.azul, C.amarelo, 'Secundário'),
  },
  'Batuque': {
    home: kit('checkered', C.preto, C.branco, 'Principal'),
    away: kit('solid', C.laranja, C.preto, 'Secundário'),
  },
  'Derby': {
    home: kit('solid', C.azul, C.branco, 'Principal'),
    away: kit('solid', C.branco, C.azul, 'Secundário'),
  },
  'Falcões do Norte': {
    home: kit('checkered', C.verde, C.branco, 'Principal'),
    away: kit('solid', C.branco, C.verde, 'Secundário'),
  },
  'Farense': {
    home: kit('solid', C.branco, C.preto, 'Principal'),
    away: kit('stripes', C.preto, C.amarelo, 'Secundário'),
  },
  'Mindelense': {
    home: kit('solid', C.vermelho, C.branco, 'Principal'),
    away: kit('solid', C.branco, C.vermelho, 'Secundário'),
  },
  'Ribeira Bote': {
    home: kit('checkered', C.preto, C.branco, 'Principal'),
    away: kit('checkered', C.amarelo, C.preto, 'Secundário'),
    third: kit('bordered', C.preto, C.vermelho, 'Terceiro', BOB_MARLEY_BORDER),
  },
  'Salamansa': {
    home: kit('solid', C.amarelo, C.azul, 'Principal'),
    away: kit('solid', C.azul, C.amarelo, 'Secundário'),
  },
  'Castilho': {
    home: kit('solid', C.azul, C.branco, 'Principal'),
    away: kit('solid', C.branco, C.azul, 'Secundário'),
  },
  "Ponta d'Pom": {
    home: kit('solid', C.azul, C.branco, 'Principal'),
    away: kit('solid', C.branco, C.azul, 'Secundário'),
  },
  'Calhau': {
    home: kit('solid', C.verde, C.branco, 'Principal'),
    away: kit('stripes', C.branco, C.verde, 'Secundário'),
  },
  'São Pedro': {
    home: kit('stripes', C.branco, C.azul, 'Principal'),
    away: kit('solid', C.azulCiano, C.branco, 'Secundário'),
  },
  'Corinthians': {
    home: kit('solid', C.preto, C.branco, 'Principal'),
    away: kit('solid', C.branco, C.preto, 'Secundário'),
  },
  'Estoril': {
    home: kit('solid', C.amarelo, C.azul, 'Principal'),
    away: kit('solid', C.azul, C.amarelo, 'Secundário'),
  },
  'Uni-Mindelo': {
    home: kit('solid', C.preto, C.azul, 'Principal'),
    away: kit('solid', C.azul, C.preto, 'Secundário'),
  },
};

function computeBudgets(reputation, tier) {
  const mult = FINANCIAL_MULTIPLIER[tier] ?? 1;
  const repFactor = reputation / 3;
  return {
    wage_budget: Math.round(BASE_WAGE_BUDGET * mult * repFactor),
    transfer_budget: Math.round(BASE_TRANSFER_BUDGET * mult * repFactor),
    balance: Math.round(BASE_BALANCE * mult * repFactor),
  };
}

/* Equipas da Primeira Divisão, conforme o documento do projeto */
const teams = [
  { name: 'Mindelense',   reputation_stars: 5.0, financial_tier: 'Muito Rico' },
  { name: 'Academica',    reputation_stars: 4.5, financial_tier: 'Rico' },
  { name: 'Derby',        reputation_stars: 4.5, financial_tier: 'Rico' },
  { name: 'Amarante',     reputation_stars: 3.8, financial_tier: 'Medio' },
  { name: 'Batuque',      reputation_stars: 3.7, financial_tier: 'Medio' },
  { name: 'Ribeira Bote', reputation_stars: 3.7, financial_tier: 'Pobre' },
  { name: 'Farense',      reputation_stars: 3.5, financial_tier: 'Medio' },
  { name: 'Falcões do Norte', reputation_stars: 4.0, financial_tier: 'Medio' },
  { name: 'Castilho',     reputation_stars: 3.0, financial_tier: 'Pobre' },
  { name: "Ponta d'Pom",  reputation_stars: 3.0, financial_tier: 'Pobre' },
  { name: 'São Pedro',    reputation_stars: 2.5, financial_tier: 'Muito Pobre' },
  { name: 'Salamansa',    reputation_stars: 3.5, financial_tier: 'Medio' },
  { name: 'Calhau',       reputation_stars: 2.5, financial_tier: 'Muito Pobre' },
  { name: 'Uni-Mindelo',  reputation_stars: 2.0, financial_tier: 'Medio' },
  { name: 'Estoril',      reputation_stars: 1.8, financial_tier: 'Muito Pobre' },
  { name: 'Corinthians',  reputation_stars: 1.9, financial_tier: 'Muito Pobre' },
];

/* IMPORTANTE: desde que a base de dados passou a ser "uma por dispositivo"
   (ver db/database.js — o `db` exportado é um Proxy que só funciona depois
   de attachDeviceContext correr num pedido HTTP), já não existe uma única
   ligação global para usar aqui com `db.prepare(...)` diretamente — isso
   fazia este script rebentar sempre com "db acedido antes de
   attachDeviceContext correr", mesmo antes de chegar a inserir uma equipa.

   A solução é a mesma já usada pelas rotas de admin: `db.withEveryDatabase`
   aplica a função a TODOS os saves por dispositivo que já existem no disco
   e também ao ficheiro-molde (fmcriol.db), para que os saves novos também
   já nasçam com as cores dos equipamentos atualizadas. */
function seedTeamsOnConnection(conn, list) {
  const insert = conn.prepare(`
    INSERT INTO teams (name, reputation_stars, financial_tier, division, wage_budget, transfer_budget, balance, kit_colors_json)
    VALUES (@name, @reputation_stars, @financial_tier, 1, @wage_budget, @transfer_budget, @balance, @kit_colors_json)
    ON CONFLICT(name) DO UPDATE SET
      reputation_stars = excluded.reputation_stars,
      financial_tier   = excluded.financial_tier,
      wage_budget      = excluded.wage_budget,
      transfer_budget  = excluded.transfer_budget,
      balance          = excluded.balance,
      kit_colors_json  = excluded.kit_colors_json,
      updated_at       = datetime('now')
  `);

  const seedAll = conn.transaction((teamsToSeed) => {
    for (const t of teamsToSeed) {
      const budgets = computeBudgets(t.reputation_stars, t.financial_tier);
      const kits = TEAM_KITS[t.name] || null;
      insert.run({ ...t, ...budgets, kit_colors_json: kits ? JSON.stringify(kits) : null });
    }
  });

  seedAll(list);

  return conn.prepare('SELECT id, name, reputation_stars, financial_tier, wage_budget, transfer_budget, balance FROM teams ORDER BY reputation_stars DESC').all();
}

const preview = db.withEveryDatabase((conn) => seedTeamsOnConnection(conn, teams));

console.log(`✅ ${teams.length} equipas inseridas/atualizadas em todos os saves (dispositivos existentes + molde).`);
if (preview) console.table(preview);