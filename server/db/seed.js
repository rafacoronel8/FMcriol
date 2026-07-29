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
  { name: 'Castilho',     reputation_stars: 3.0, financial_tier: 'Pobre' },
  { name: "Ponta d'Pom",  reputation_stars: 3.0, financial_tier: 'Pobre' },
  { name: 'São Pedro',    reputation_stars: 2.5, financial_tier: 'Muito Pobre' },
  { name: 'Salamansa',    reputation_stars: 3.5, financial_tier: 'Medio' },
  { name: 'Calhau',       reputation_stars: 2.5, financial_tier: 'Muito Pobre' },
  { name: 'Uni-Mindelo',  reputation_stars: 2.0, financial_tier: 'Medio' },
  { name: 'Estoril',      reputation_stars: 1.8, financial_tier: 'Muito Pobre' },
  { name: 'Corinthians',  reputation_stars: 1.9, financial_tier: 'Muito Pobre' },
];

const insert = db.prepare(`
  INSERT INTO teams (name, reputation_stars, financial_tier, division, wage_budget, transfer_budget, balance)
  VALUES (@name, @reputation_stars, @financial_tier, 1, @wage_budget, @transfer_budget, @balance)
  ON CONFLICT(name) DO UPDATE SET
    reputation_stars = excluded.reputation_stars,
    financial_tier   = excluded.financial_tier,
    wage_budget      = excluded.wage_budget,
    transfer_budget  = excluded.transfer_budget,
    balance          = excluded.balance,
    updated_at       = datetime('now')
`);

const seedAll = db.transaction((list) => {
  for (const t of list) {
    const budgets = computeBudgets(t.reputation_stars, t.financial_tier);
    insert.run({ ...t, ...budgets });
  }
});

seedAll(teams);

console.log(`✅ ${teams.length} equipas inseridas/atualizadas na base de dados.`);
console.table(
  db.prepare('SELECT id, name, reputation_stars, financial_tier, wage_budget, transfer_budget, balance FROM teams ORDER BY reputation_stars DESC').all()
);
