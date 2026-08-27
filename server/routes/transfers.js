/* ==========================================================
   FMcriol — Rotas da API para o Mercado de Transferências
   (propostas financeiras, contratos e caixa de entrada)
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

/* ---------- Peso do papel/protagonismo de um jogador no plantel ---------- */
const ROLE_WEIGHTS = {
  'Jogador Chave': 5,
  'Titular Regular': 4,
  'Titular': 4,
  'Rotação': 3,
  'Suplente': 2,
  'Reserva': 2,
  'Emprestado': 1,
};
function roleWeight(status) {
  return ROLE_WEIGHTS[String(status || '').trim()] ?? 3;
}

/* ---------- Perfil "Flexível": clubes mais pequenos/pobres vendem por menos sem problema ---------- */
const TIER_ACCEPT_RATIO = {
  'Muito Rico': 0.95,
  'Rico': 0.85,
  'Medio': 0.70,
  'Pobre': 0.55,
  'Muito Pobre': 0.40,
};

/* Até quanto acima do valor de mercado do jogador (estimateMarketValue) um
   comprador está disposto a ir consoante o seu tier financeiro — clubes
   ricos pagam prémios acima do valor de referência, clubes pobres ficam
   abaixo dele. Usado em buyerCeiling(), sempre limitado depois pelo
   orçamento de transferências real do clube. */
const BUYER_CEILING_RATIO = {
  'Muito Rico': 1.35,
  'Rico': 1.15,
  'Medio': 1.00,
  'Pobre': 0.80,
  'Muito Pobre': 0.60,
};

/* Extrai números de texto tipo "£95M - £113M", "£1.2M" ou "£120.000"/"£120 000"
   (número inteiro já formatado por toLocaleString('pt-PT'), sem sufixo) ->
   valores em libras (ex: [95000000, 113000000] / [1200000] / [120000]).

   IMPORTANTE: só se trata como CASA DECIMAL o que vem antes de um sufixo
   M/K (ex: "1.2M" = 1,2 milhões). Um número SEM sufixo é sempre um valor
   inteiro já por extenso, e o "." ou espaço que apareça nele é separador de
   milhar, não vírgula decimal — nunca se deve fazer parseFloat direto a
   isso. Antes disto, "£120.000" (cento e vinte mil) e "£120 000" (mesma
   coisa, formatação com espaço) eram lidos como ~120 (tratando o separador
   de milhar como ponto decimal ou partindo o número a meio no espaço),
   fazendo o valor de referência de um jogador cair para uma fração do que
   devia ser — ou, no sentido inverso, um valor de mercado escrito à mão em
   milhões (ex: "£95M", jeito comum de pensar em futebol) ficava fora de
   alcance de QUALQUER orçamento do jogo (que anda na casa dos milhares —
   ver BASE_TRANSFER_BUDGET em routes/game.js), fazendo qualquer proposta
   ser sempre recusada, seja qual for o valor oferecido. */
function parseMoneyRange(text) {
  const raw = String(text || '');
  const tokenRegex = /([\d][\d.,\s]*)\s*(M|K)?/gi;
  const results = [];

  for (const m of raw.matchAll(tokenRegex)) {
    const numText = m[1].trim();
    if (!numText) continue;
    const suffix = (m[2] || '').toUpperCase();

    let value;
    if (suffix) {
      // Com sufixo M/K: o que vier antes pode ter uma casa decimal (ex: "1,2M").
      const cleaned = numText.replace(/\s/g, '').replace(',', '.');
      value = parseFloat(cleaned);
    } else {
      // Sem sufixo: número inteiro já por extenso — remove tudo o que não for dígito.
      const digitsOnly = numText.replace(/[^\d]/g, '');
      value = digitsOnly ? parseInt(digitsOnly, 10) : NaN;
    }

    if (Number.isFinite(value) && value > 0) {
      results.push(suffix === 'K' ? value * 1_000 : suffix === 'M' ? value * 1_000_000 : value);
    }
  }
  return results;
}

/* Data de fim de contrato tem de se basear no calendário do JOGO, nunca na
   data real do computador — senão o calendário do jogo deixa de bater certo
   com os contratos assinados (ver bug do calendário). */
function computeContractEndText(years = 3) {
  /* IMPORTANTE: "current_date" tem de vir qualificado com o nome da tabela.
     Sem isto, o SQLite interpreta "current_date" como a sua própria palavra-chave
     incorporada (a data REAL do computador) em vez da coluna — anulando a
     proteção acima. */
  const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
  const end = new Date(`${state.current_date}T00:00:00`);
  end.setFullYear(end.getFullYear() + years);
  return `${end.getDate()}/${end.getMonth() + 1}/${end.getFullYear()}`;
}

/* Antes de qualquer proposta avançar, a equipa vendedora (se for a do
   utilizador) recebe primeiro um aviso de interesse — só depois é que a
   proposta em si aparece na caixa de entrada. */
function logInterestMessage(buyerTeam, sellerTeam, player) {
  if (sellerTeam?.is_user_controlled) {
    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
      VALUES (@team_id, 'transfer_interest', @title, @body, @player_id, @related_team_id)
    `).run({
      team_id: sellerTeam.id,
      title: `Interesse: ${player.name}`,
      body: `O ${buyerTeam.name} está interessado em contratar ${player.name}. Uma proposta pode chegar em breve.`,
      player_id: player.id,
      related_team_id: buyerTeam.id,
    });
  }
  db.logMarketNews({
    type: 'transfer_interest',
    headline: `${buyerTeam.name} de olho em ${player.name}`,
    body: sellerTeam
      ? `O ${buyerTeam.name} está interessado em contratar ${player.name}, do ${sellerTeam.name}.`
      : `O ${buyerTeam.name} está interessado em contratar ${player.name}.`,
    player_name: player.name,
    player_photo: player.photo_path,
    from_team_name: sellerTeam?.name,
    from_team_shield: sellerTeam?.shield_path,
    to_team_name: buyerTeam.name,
    to_team_shield: buyerTeam.shield_path,
  });
}

function ageFromBirthDate(birthDate) {
  if (!birthDate) return 25;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return 25;
  return Math.floor((Date.now() - b.getTime()) / (365.25 * 24 * 3600 * 1000));
}

/* Estima o valor de mercado em número — usa o texto já preenchido no perfil quando existe,
   ou uma fórmula com base na qualidade/potencial/idade do jogador quando não existe.

   IMPORTANTE — escala: tem de ficar no mesmo universo dos orçamentos de
   transferência das equipas (~£33.000 a ~£2.100.000, ver computeBudgets em
   routes/game.js). A fórmula anterior (ability * 14.000.000) dava valores de
   dezenas de milhões — muito acima do orçamento de qualquer clube do jogo,
   incluindo o mais rico. Como o valor de referência entra na razão que
   decide se uma proposta é aceite (offerRatio = offerAmount / referenceValue)
   e o offerAmount nunca pode passar do teu orçamento, praticamente nenhuma
   proposta conseguia alguma vez atingir o acceptRatio necessário.

   SEGURANÇA ADICIONAL: mesmo com o parseMoneyRange corrigido, o campo
   market_value_text é texto editável à mão no perfil (ver contenteditable
   em perfilJogador.html), por isso continua a ser possível escrever ali um
   valor num registo completamente diferente do resto do jogo (ex: "£95M",
   ao jeito do futebol real). Sem limite, isso tornava a proposta impossível
   de aceitar para sempre, seja qual for o valor oferecido — dá-se por isso
   um teto (MARKET_VALUE_CEILING) alinhado com o orçamento mais alto
   possível no jogo, para nenhum jogador ficar "impossível" de comprar. */
const MARKET_VALUE_CEILING = 2_500_000;

/* Quanto acima do teto do comprador (buyerCeiling) uma contraproposta pode
   pedir antes de ser considerada um insulto — acima disto o comprador
   desiste logo, em vez de tentar subir a oferta. */
const INSULT_MULTIPLIER = 1.6;

/* Número máximo de rondas de contraproposta permitidas numa negociação —
   ao chegar aqui, a oferta em cima da mesa passa a ser a "palavra final"
   do comprador (só resta Aceitar ou Recusar). */
const MAX_NEGOTIATION_ROUNDS = 3;

function estimateMarketValue(player) {
  const parsed = parseMoneyRange(player.market_value_text);
  if (parsed.length) {
    const avg = parsed.reduce((a, b) => a + b, 0) / parsed.length;
    if (avg > 0) return Math.min(avg, MARKET_VALUE_CEILING);
  }

  const ability = player.current_ability_stars ?? 2.5;
  const potential = player.potential_ability_stars ?? ability;
  const age = ageFromBirthDate(player.birth_date);
  const ageFactor = age <= 21 ? 1.25 : age <= 25 ? 1.1 : age <= 29 ? 1.0 : age <= 33 ? 0.7 : 0.45;
  const growthFactor = 1 + Math.max(0, potential - ability) * 0.12;
  return Math.round(ability * 60_000 * ageFactor * growthFactor);
}

function parseWage(text) {
  const parsed = parseMoneyRange(text);
  return parsed.length ? parsed[0] : 3000;
}

/* Quanto o comprador está disposto a pagar no máximo por este jogador
   numa negociação — nunca acima do orçamento de transferências que
   realmente tem disponível agora. */
function buyerCeiling(player, buyerTeam) {
  const referenceValue = estimateMarketValue(player);
  const tierRatio = BUYER_CEILING_RATIO[buyerTeam.financial_tier] ?? 1.05;
  const reputationPremium = ((buyerTeam.reputation_stars ?? 3) - 3) * 0.05;
  const ceilingRatio = Math.max(0.5, tierRatio + reputationPremium);
  return Math.min(buyerTeam.transfer_budget, referenceValue * ceilingRatio);
}

/* ---------- Decisão do próprio jogador ----------
   O clube vendedor aceitar o valor da transferência não significa que o jogador
   aceite mudar-se: ele compara a reputação do clube comprador com a do vendedor
   e quer, no mínimo, manter o salário que já tem — normalmente pede um pouco
   mais. Devolve também o salário que o jogador ficaria a receber, para já
   deixar o contrato pronto quando aceita. */
function decidePlayerConsent(player, buyerTeam, sellerTeam) {
  const currentWage = parseWage(player.wage_text);
  const expectedWage = Math.round(currentWage * (1.0 + Math.random() * 0.15)); // igual a até +15%
  const repDelta = (buyerTeam.reputation_stars - (sellerTeam?.reputation_stars ?? buyerTeam.reputation_stars)) / 5;
  const luck = (Math.random() * 0.2) - 0.1;
  /* consent_boost -> ganho numa reunião de transferência anterior, depois de
     o treinador dizer ao jogador que não faz parte dos seus planos (ver
     PUT /api/transfers/meetings/:id/respond). Consumido logo a seguir. */
  const boost = Number(player.consent_boost) || 0;
  const score = (repDelta * 0.6) + luck + 0.05 + boost; // ligeiro viés a favor, já que o clube vendedor aceitou vender
  return { accepted: score > 0, wageOffer: Math.max(expectedWage, currentWage) };
}

/* Próximo 1 de julho a partir da data atual do calendário do jogo — usado
   como data de regresso de um empréstimo proposto na reunião de
   transferência (ver abaixo), quando não é dada nenhuma duração concreta.
   O mercado só está aberto entre 1 e 31 de julho (ver isMarketWindowOpen em
   db/database.js), por isso uma reunião só pode acontecer dentro dessa
   janela — "a época seguinte" começa sempre no 1 de julho do ANO SEGUINTE
   ao da data atual. */
function nextJulyFirst(currentDateStr) {
  const year = Number(String(currentDateStr).slice(0, 4));
  return `${year + 1}-07-01`;
}

/* Durações de empréstimo aceites numa proposta (POST /api/transfers/offer,
   is_loan=true) — em meses, a contar da data atual do jogo. */
const VALID_LOAN_MONTHS = [3, 6, 12, 18, 24];

/* Decide, ao acaso, se um negócio entre clubes geridos pelo jogo (ou uma
   proposta que um clube gerido pelo jogo faça a um jogador do utilizador)
   vem com alguma cláusula — mantém a maior parte dos negócios simples
   (só dinheiro), mas dá alguma variedade à aba "Cláusulas". Nunca gera
   mais do que uma cláusula de cada vez. */
function maybeGenerateAiClauses({ player, buyerTeam, sellerTeam, amount }) {
  if (!sellerTeam || !(amount > 0)) return [];
  if (Math.random() > 0.22) return [];

  const age = ageFromBirthDate(player.birth_date);
  const poorBuyer = ['Pobre', 'Muito Pobre'].includes(buyerTeam.financial_tier);
  const roll = Math.random();

  if (poorBuyer && roll < 0.55) {
    const months = [6, 12, 18][Math.floor(Math.random() * 3)];
    return [{ type: 'installments', total_amount: Math.round(amount), months }];
  }
  if (age <= 22 && roll < 0.85) {
    const percentage = [10, 15, 20, 25][Math.floor(Math.random() * 4)];
    return [{ type: 'sell_on_percentage', percentage }];
  }
  const threshold = 5 + Math.floor(Math.random() * 10);
  const bonus = Math.round(amount * (0.08 + Math.random() * 0.12));
  return [{ type: 'goal_bonus', goals_threshold: threshold, bonus_amount: bonus }];
}


/* ---------- Dinheiro de uma venda definitiva, já com o negócio fechado ----------
   Faz sempre as duas coisas juntas: reparte o valor entre orçamento de
   transferências (transfer_budget, ajustado já de uma vez, tal como numa
   venda normal) e saldo (balance) — mas, se houver uma cláusula de
   prestações, o SALDO só é ajustado aos poucos, mês a mês (ver
   runInstallmentClausesTick em db/database.js), embora a CAPACIDADE de
   orçamento dos dois clubes mude já toda de uma vez, exatamente como
   aconteceria numa venda a pronto — e materializa as cláusulas acordadas
   (db.materializeClauses) e cobra logo qualquer percentagem de revenda que
   o clube vendedor deva a um dono anterior do jogador (db.triggerSellOnClauses).
   Partilhado entre finalizePlayerMove (abaixo) e as vendas automáticas
   entre clubes geridos pelo jogo em routes/game.js, para as duas vias
   seguirem sempre exatamente as mesmas regras de dinheiro e cláusulas. */
function settleTransferMoney({ playerId, buyerTeam, sellerTeam, amount, clauses = [], transferOfferId = null }) {
  const hasInstallments = clauses.some((c) => c.type === 'installments');

  if (sellerTeam) {
    if (hasInstallments) {
      db.prepare("UPDATE teams SET transfer_budget = transfer_budget + @amount, updated_at = datetime('now') WHERE id = @id")
        .run({ amount, id: sellerTeam.id });
      sellerTeam.transfer_budget += amount;
    } else {
      db.prepare("UPDATE teams SET balance = balance + @amount, transfer_budget = transfer_budget + @amount, updated_at = datetime('now') WHERE id = @id")
        .run({ amount, id: sellerTeam.id });
      sellerTeam.balance += amount;
      sellerTeam.transfer_budget += amount;
    }
  }

  if (hasInstallments) {
    db.prepare("UPDATE teams SET transfer_budget = transfer_budget - @amount, updated_at = datetime('now') WHERE id = @id")
      .run({ amount, id: buyerTeam.id });
    buyerTeam.transfer_budget -= amount;
  } else {
    db.prepare("UPDATE teams SET balance = balance - @amount, transfer_budget = transfer_budget - @amount, updated_at = datetime('now') WHERE id = @id")
      .run({ amount, id: buyerTeam.id });
    buyerTeam.balance -= amount;
    buyerTeam.transfer_budget -= amount;
  }

  if (sellerTeam && amount > 0) {
    db.triggerSellOnClauses({ playerId, sellingTeamId: sellerTeam.id, saleAmount: amount });
  }
  if (sellerTeam && clauses.length) {
    db.materializeClauses({ transferOfferId, playerId, buyerTeamId: buyerTeam.id, sellerTeamId: sellerTeam.id, clauses });
  }
}

/* Decide, com um pequeno viés a favor (é temporário, não uma venda
   definitiva), se o próprio jogador aceita ser emprestado — mesma ideia de
   decidePlayerConsent, reaproveitada tanto por POST /api/transfers/offer
   (proposta de empréstimo em primeira mão) como pela reunião de
   transferência (PUT /meetings/:id/respond, ação 'loan'). */
function decideLoanConsent(player, buyerTeam, sellerTeam) {
  const repDelta = (buyerTeam.reputation_stars - (sellerTeam?.reputation_stars ?? buyerTeam.reputation_stars)) / 5;
  const luck = (Math.random() * 0.2) - 0.1;
  const boost = Number(player.consent_boost) || 0;
  return ((repDelta * 0.6) + luck + 0.2 + boost) > 0;
}

/* Concretiza a mudança de clube de um jogador, com ou sem empréstimo —
   partilhado entre a aceitação normal de uma proposta (PUT
   /:id/respond), a proposta de empréstimo (POST /offer) e a reunião de
   transferência (PUT /meetings/:id/respond), para todas seguirem sempre
   exatamente as mesmas regras. `clauses` só se aplica a vendas definitivas
   — nunca a empréstimos. */
function finalizePlayerMove({ player, buyerTeam, sellerTeam, wageOffer, amount, isLoan, loanReturnDate, clauses = [], transferOfferId = null }) {
  const contractEndText = computeContractEndText();

  if (isLoan) {
    db.prepare(`
      UPDATE players SET team_id = @team_id, loan_from_team_id = @loan_from_team_id,
        loan_return_date = @loan_return_date, is_listed = 0, asking_price = NULL,
        club_status = 'Emprestado', transferred_in_window = 1, consent_boost = 0,
        updated_at = datetime('now')
      WHERE id = @player_id
    `).run({
      team_id: buyerTeam.id, loan_from_team_id: sellerTeam ? sellerTeam.id : player.team_id,
      loan_return_date: loanReturnDate, player_id: player.id,
    });
    if (amount > 0) {
      /* A taxa de empréstimo (se houver) é sempre paga a pronto — não faz
         sentido parcelar uma taxa de empréstimo, que já é temporária. */
      settleTransferMoney({ playerId: player.id, buyerTeam, sellerTeam, amount, clauses: [], transferOfferId });
    }
    return;
  }

  db.prepare(`
    UPDATE players SET team_id = @team_id, is_listed = 0, asking_price = NULL,
      club_status = 'Titular Regular', wage_text = @wage_text, contract_end = @contract_end,
      transferred_in_window = 1, consent_boost = 0, updated_at = datetime('now')
    WHERE id = @player_id
  `).run({ team_id: buyerTeam.id, player_id: player.id, wage_text: `£${Number(wageOffer).toLocaleString('pt-PT')} p/s`, contract_end: contractEndText });

  settleTransferMoney({ playerId: player.id, buyerTeam, sellerTeam, amount, clauses, transferOfferId });
}

/* ---------- Empréstimos: regresso automático ao clube de origem ----------
   Chamado a partir de POST /api/game/advance (routes/game.js), tal como o
   Campeonato e a Taça — assim que o calendário do jogo chega à
   loan_return_date de um jogador, ele volta automaticamente para
   loan_from_team_id e deixa de estar emprestado. */
function runLoanReturnsIfDue(nextDateStr) {
  const due = db.prepare(`
    SELECT p.*, home.name AS home_name, home.shield_path AS home_shield,
           away.name AS away_name
    FROM players p
    JOIN teams home ON home.id = p.loan_from_team_id
    LEFT JOIN teams away ON away.id = p.team_id
    WHERE p.loan_return_date IS NOT NULL AND p.loan_return_date <= ?
  `).all(nextDateStr);

  due.forEach((p) => {
    db.prepare(`
      UPDATE players SET team_id = @home_team_id, loan_from_team_id = NULL, loan_return_date = NULL,
        club_status = 'Titular Regular', updated_at = datetime('now')
      WHERE id = @id
    `).run({ home_team_id: p.loan_from_team_id, id: p.id });

    if (db.prepare('SELECT is_user_controlled FROM teams WHERE id = ?').get(p.loan_from_team_id)?.is_user_controlled) {
      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
        VALUES (@team_id, 'loan_returned', @title, @body, @player_id, @related_team_id)
      `).run({
        team_id: p.loan_from_team_id, player_id: p.id, related_team_id: p.team_id,
        title: `↩️ Empréstimo terminado: ${p.name}`,
        body: `${p.name} terminou o empréstimo no ${p.away_name || 'outro clube'} e volta a estar disponível no plantel.`,
      });
    }
  });

  return due.length;
}

/* ---------- POST /api/transfers/offer — enviar proposta financeira por um jogador ----------
   Aceita tanto uma proposta de COMPRA definitiva como uma proposta de
   EMPRÉSTIMO (is_loan=true, loan_duration_months em {3,6,12,18,24}), e
   pode vir acompanhada de até 3 cláusulas (clauses: pagamento em
   prestações / prémio por golos / percentagem de próxima venda — ver
   db.normalizeClauseSpecs). As cláusulas nunca se aplicam a empréstimos. */
router.post('/offer', (req, res) => {
  const { player_id, buyer_team_id, offer_amount, is_loan, loan_duration_months } = req.body;
  const offerAmount = Number(offer_amount) || 0;
  const isLoan = !!is_loan;

  if (!player_id || !buyer_team_id || (!isLoan && !(offerAmount > 0))) {
    return res.status(400).json({ error: 'Dados da proposta incompletos' });
  }
  if (isLoan && !VALID_LOAN_MONTHS.includes(Number(loan_duration_months))) {
    return res.status(400).json({ error: 'Indica uma duração de empréstimo válida (3, 6, 12, 18 ou 24 meses)' });
  }

  const clauses = isLoan ? [] : db.normalizeClauseSpecs(req.body.clauses);
  if (clauses === null) return res.status(400).json({ error: 'Cláusulas inválidas na proposta' });

  if (!db.isMarketWindowOpen()) {
    return res.status(400).json({ error: 'O mercado de transferências está fechado. Só há uma janela de mercado por jogo.' });
  }

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(player_id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });
  if (!player.team_id) return res.status(400).json({ error: 'Este jogador não pertence a nenhum clube' });
  if (String(player.team_id) === String(buyer_team_id)) {
    return res.status(400).json({ error: 'Este jogador já está na tua equipa' });
  }
  if (player.transferred_in_window) {
    return res.status(400).json({ error: 'Este jogador já foi transferido neste mercado e não pode mudar de clube outra vez.' });
  }

  const buyerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(buyer_team_id);
  if (!buyerTeam) return res.status(404).json({ error: 'Equipa não encontrada' });
  if (offerAmount > buyerTeam.transfer_budget) {
    return res.status(400).json({ error: 'A proposta excede o teu orçamento de transferências disponível' });
  }

  const sellerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(player.team_id);
  logInterestMessage(buyerTeam, sellerTeam, player);

  const referenceValue = estimateMarketValue(player);
  const offerFmt = `£${Math.round(offerAmount).toLocaleString('pt-PT')}`;
  const clauseLines = clauses.map((c) => `• ${db.describeClause(c)}`).join('\n');

  /* ---------- Proposta de empréstimo — decisão bem mais leniente do que
     uma venda definitiva, e sem cláusulas: quanto mais importante o
     jogador for para o plantel atual (roleWeight), mais relutante fica o
     clube vendedor em emprestá-lo. */
  if (isLoan) {
    const importance = roleWeight(player.club_status);
    const willingness = 0.75 - importance * 0.11 + Math.min(0.15, offerAmount / 50_000);
    const luck = (Math.random() * 0.2) - 0.1;
    const clubAccepts = (willingness + luck) > 0.28;

    if (!clubAccepts) {
      const info = db.prepare(`
        INSERT INTO transfer_offers (player_id, buyer_team_id, seller_team_id, offer_amount, status, resolved_at, is_loan, loan_duration_months)
        VALUES (@player_id, @buyer_team_id, @seller_team_id, @offer_amount, 'rejected', datetime('now'), 1, @loan_duration_months)
      `).run({ player_id, buyer_team_id, seller_team_id: player.team_id, offer_amount: offerAmount, loan_duration_months: Number(loan_duration_months) });

      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
        VALUES (@team_id, 'transfer_rejected', @title, @body, @player_id, @related_team_id)
      `).run({
        team_id: buyer_team_id, player_id, related_team_id: player.team_id,
        title: `Empréstimo recusado: ${player.name}`,
        body: `O ${sellerTeam?.name || 'clube'} não quer emprestar ${player.name} de momento. Tenta de novo mais tarde ou propõe uma taxa de empréstimo mais alta.`,
      });
      return res.status(201).json(db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(info.lastInsertRowid));
    }

    const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
    const loanReturnDate = db.addMonthsToIsoDate(state.current_date, Number(loan_duration_months));
    const playerAccepts = decideLoanConsent(player, buyerTeam, sellerTeam);

    const info = db.prepare(`
      INSERT INTO transfer_offers (player_id, buyer_team_id, seller_team_id, offer_amount, status, resolved_at, is_loan, loan_duration_months)
      VALUES (@player_id, @buyer_team_id, @seller_team_id, @offer_amount, @status, datetime('now'), 1, @loan_duration_months)
    `).run({
      player_id, buyer_team_id, seller_team_id: player.team_id, offer_amount: offerAmount,
      loan_duration_months: Number(loan_duration_months), status: playerAccepts ? 'accepted' : 'rejected',
    });

    if (playerAccepts) {
      finalizePlayerMove({ player, buyerTeam, sellerTeam, amount: offerAmount, isLoan: true, loanReturnDate, transferOfferId: info.lastInsertRowid });

      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
        VALUES (@team_id, 'transfer_accepted', @title, @body, @player_id, @related_team_id)
      `).run({
        team_id: buyer_team_id, player_id, related_team_id: player.team_id,
        title: `Empréstimo acordado: ${player.name}`,
        body: `O ${sellerTeam?.name || 'clube'} e ${player.name} aceitaram o empréstimo${offerAmount ? ` (taxa de ${offerFmt})` : ''} — o jogador está no teu plantel até ${Number(loanReturnDate.slice(0, 4))}.`,
      });
      db.logMarketNews({
        type: 'loan_agreed',
        headline: `${player.name} sai por empréstimo para o ${buyerTeam.name}`,
        body: `${player.name} muda-se por empréstimo do ${sellerTeam?.name || '—'} para o ${buyerTeam.name} até ${loanReturnDate}.`,
        player_name: player.name, player_photo: player.photo_path,
        from_team_name: sellerTeam?.name, from_team_shield: sellerTeam?.shield_path,
        to_team_name: buyerTeam.name, to_team_shield: buyerTeam.shield_path,
        amount: offerAmount || null,
      });
    } else {
      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
        VALUES (@team_id, 'transfer_rejected', @title, @body, @player_id, @related_team_id)
      `).run({
        team_id: buyer_team_id, player_id, related_team_id: player.team_id,
        title: `Empréstimo caiu: ${player.name}`,
        body: `O ${sellerTeam?.name || 'clube'} aceitou emprestar ${player.name}, mas o próprio jogador recusou a mudança temporária.`,
      });
    }

    return res.status(201).json(db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(info.lastInsertRowid));
  }

  /* ---------- Proposta de compra definitiva (com ou sem cláusulas) ---------- */
  const tierRatio = TIER_ACCEPT_RATIO[sellerTeam?.financial_tier] ?? 0.70;
  const reputationPremium = ((sellerTeam?.reputation_stars ?? 3) - 3) * 0.03;
  const abilityPremium = Math.max(0, (player.current_ability_stars ?? 2.5) - 3.5) * 0.05;
  const acceptRatio = tierRatio + reputationPremium + abilityPremium;

  const clausesValue = db.estimateClausesValue(clauses, { player, referenceValue });
  const effectiveAmount = (offerAmount * db.installmentDiscountFactor(clauses)) + clausesValue;
  const offerRatio = effectiveAmount / referenceValue;
  const luck = (Math.random() * 0.16) - 0.08;
  const accepted = (offerRatio + luck) >= acceptRatio;

  const info = db.prepare(`
    INSERT INTO transfer_offers (player_id, buyer_team_id, seller_team_id, offer_amount, status, resolved_at, clauses_json)
    VALUES (@player_id, @buyer_team_id, @seller_team_id, @offer_amount, @status, datetime('now'), @clauses_json)
  `).run({
    player_id, buyer_team_id, seller_team_id: player.team_id, offer_amount: offerAmount,
    status: accepted ? 'accepted' : 'rejected', clauses_json: JSON.stringify(clauses),
  });

  const title = accepted ? `Proposta aceite: ${player.name}` : `Proposta recusada: ${player.name}`;
  const body = accepted
    ? `O ${sellerTeam?.name || 'clube'} aceitou a tua proposta de ${offerFmt} por ${player.name}${clauseLines ? ` com as seguintes cláusulas:\n${clauseLines}` : ''}. Já podes negociar o contrato com o jogador no perfil dele.`
    : `O ${sellerTeam?.name || 'clube'} recusou a tua proposta de ${offerFmt}${clauseLines ? ` (com cláusulas)` : ''} por ${player.name}. Tenta um valor mais alto, ajusta as cláusulas, ou volta a tentar mais tarde.`;

  db.prepare(`
    INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
    VALUES (@team_id, @type, @title, @body, @player_id, @related_team_id)
  `).run({ team_id: buyer_team_id, type: accepted ? 'transfer_accepted' : 'transfer_rejected', title, body, player_id, related_team_id: player.team_id });

  db.logMarketNews({
    type: accepted ? 'offer_accepted' : 'offer_rejected',
    headline: accepted ? `${sellerTeam?.name || 'Clube'} aceita proposta por ${player.name}` : `${sellerTeam?.name || 'Clube'} recusa proposta por ${player.name}`,
    body: accepted
      ? `O ${buyerTeam.name} propôs ${offerFmt} pelo passe de ${player.name}${clauseLines ? ` (com cláusulas)` : ''} e o ${sellerTeam?.name || 'clube vendedor'} aceitou o negócio. Falta agora fechar os termos do contrato com o jogador.`
      : `O ${buyerTeam.name} propôs ${offerFmt} pelo passe de ${player.name}, mas o ${sellerTeam?.name || 'clube vendedor'} recusou a oferta.`,
    player_name: player.name,
    player_photo: player.photo_path,
    from_team_name: sellerTeam?.name,
    from_team_shield: sellerTeam?.shield_path,
    to_team_name: buyerTeam.name,
    to_team_shield: buyerTeam.shield_path,
    amount: offerAmount,
  });

  res.status(201).json(db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(info.lastInsertRowid));
});

/* ---------- POST /api/transfers/:id/contract — propor contrato ao jogador ---------- */
router.post('/:id/contract', (req, res) => {
  if (!db.isMarketWindowOpen()) {
    return res.status(400).json({ error: 'O mercado de transferências está fechado. Só há uma janela de mercado por jogo.' });
  }

  const transferOffer = db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(req.params.id);
  if (!transferOffer) return res.status(404).json({ error: 'Proposta de transferência não encontrada' });
  if (transferOffer.status !== 'accepted') {
    return res.status(400).json({ error: 'O clube ainda não aceitou a proposta de transferência' });
  }

  const alreadySigned = db.prepare(`
    SELECT * FROM contract_offers WHERE transfer_offer_id = ? AND status = 'accepted'
  `).get(req.params.id);
  if (alreadySigned) return res.status(400).json({ error: 'Este jogador já assinou contrato por esta transferência' });

  const wageOffer = Number(req.body.wage_offer);
  const signingBonus = Number(req.body.signing_bonus) || 0;
  const promisedRole = req.body.promised_role || 'Titular Regular';
  if (!wageOffer || wageOffer <= 0) return res.status(400).json({ error: 'Indica um salário válido' });

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(transferOffer.player_id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });
  if (player.transferred_in_window) {
    return res.status(400).json({ error: 'Este jogador já foi transferido neste mercado e não pode mudar de clube outra vez.' });
  }

  const buyerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(transferOffer.buyer_team_id);
  const sellerTeam = transferOffer.seller_team_id
    ? db.prepare('SELECT * FROM teams WHERE id = ?').get(transferOffer.seller_team_id)
    : null;

  const totalCost = transferOffer.offer_amount + signingBonus;
  if (totalCost > buyerTeam.transfer_budget) {
    return res.status(400).json({ error: 'O prémio de assinatura excede o orçamento de transferências disponível' });
  }
  if (wageOffer > buyerTeam.wage_budget) {
    return res.status(400).json({ error: 'O salário proposto excede o teu orçamento salarial disponível' });
  }

  /* ---------- Decisão do jogador: equilíbrio entre reputação do clube e papel prometido ---------- */
  const currentRole = roleWeight(player.club_status);
  const offeredRole = roleWeight(promisedRole);
  const repDelta = (buyerTeam.reputation_stars - (sellerTeam?.reputation_stars ?? buyerTeam.reputation_stars)) / 5;
  const roleDelta = (offeredRole - currentRole) / 4;

  const currentWage = parseWage(player.wage_text);
  const wageFactor = Math.max(-0.3, Math.min(0.5, ((wageOffer / currentWage) - 1) * 0.4));
  const bonusFactor = Math.min(0.1, (signingBonus / 2_000_000) * 0.1);
  const luck = (Math.random() * 0.2) - 0.1;

  const score = (repDelta * 0.5) + (roleDelta * 0.5) + wageFactor + bonusFactor + luck;
  const accepted = score > 0;

  const info = db.prepare(`
    INSERT INTO contract_offers (transfer_offer_id, player_id, team_id, wage_offer, signing_bonus, promised_role, status, resolved_at)
    VALUES (@transfer_offer_id, @player_id, @team_id, @wage_offer, @signing_bonus, @promised_role, @status, datetime('now'))
  `).run({
    transfer_offer_id: transferOffer.id, player_id: player.id, team_id: buyerTeam.id,
    wage_offer: wageOffer, signing_bonus: signingBonus, promised_role: promisedRole,
    status: accepted ? 'accepted' : 'rejected',
  });

  if (accepted) {
    const contractEndText = computeContractEndText();

    db.prepare(`
      UPDATE players SET
        team_id = @team_id, club_status = @club_status,
        wage_text = @wage_text, contract_end = @contract_end,
        transferred_in_window = 1,
        updated_at = datetime('now')
      WHERE id = @id
    `).run({
      team_id: buyerTeam.id, club_status: promisedRole,
      wage_text: `£${Number(wageOffer).toLocaleString('pt-PT')} p/s`, contract_end: contractEndText,
      id: player.id,
    });

    const clauses = (() => { try { return JSON.parse(transferOffer.clauses_json || '[]'); } catch { return []; } })();
    const hasInstallments = clauses.some((c) => c.type === 'installments');

    /* O comprador perde sempre a capacidade de orçamento (transfer_budget)
       de uma vez, tal como em qualquer venda — só o SALDO (balance) fica
       condicionado ao método de pagamento escolhido. */
    db.prepare(`
      UPDATE teams SET
        balance = balance - @cashNow, transfer_budget = transfer_budget - @totalCost,
        wage_budget = wage_budget - @wage_offer, updated_at = datetime('now')
      WHERE id = @id
    `).run({
      cashNow: hasInstallments ? signingBonus : totalCost, totalCost, wage_offer: wageOffer, id: buyerTeam.id,
    });

    if (sellerTeam) {
      db.prepare(`
        UPDATE teams SET
          balance = balance + @cashNow, transfer_budget = transfer_budget + @amount, updated_at = datetime('now')
        WHERE id = @id
      `).run({ cashNow: hasInstallments ? 0 : transferOffer.offer_amount, amount: transferOffer.offer_amount, id: sellerTeam.id });

      if (transferOffer.offer_amount > 0) {
        db.triggerSellOnClauses({ playerId: player.id, sellingTeamId: sellerTeam.id, saleAmount: transferOffer.offer_amount });
      }
      if (clauses.length) {
        db.materializeClauses({
          transferOfferId: transferOffer.id, playerId: player.id,
          buyerTeamId: buyerTeam.id, sellerTeamId: sellerTeam.id, clauses,
        });
      }
    }
  }

  const title = accepted ? `Contrato assinado: ${player.name}` : `Jogador recusou o contrato: ${player.name}`;
  const body = accepted
    ? `${player.name} aceitou o teu contrato (£${Number(wageOffer).toLocaleString('pt-PT')}/semana, papel: ${promisedRole}) e é agora jogador do ${buyerTeam.name}.`
    : `${player.name} recusou a tua proposta de contrato. Tenta melhorar o salário, o prémio de assinatura, ou o papel oferecido no plantel.`;

  db.prepare(`
    INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
    VALUES (@team_id, @type, @title, @body, @player_id, @related_team_id)
  `).run({
    team_id: buyerTeam.id, type: accepted ? 'contract_accepted' : 'contract_rejected', title, body,
    player_id: player.id, related_team_id: sellerTeam?.id ?? null,
  });

  db.logMarketNews({
    type: accepted ? 'transfer_completed' : 'contract_rejected',
    headline: accepted ? `${player.name} é reforço do ${buyerTeam.name}` : `${player.name} recusa proposta de contrato do ${buyerTeam.name}`,
    body: accepted
      ? `${player.name} mudou-se do ${sellerTeam?.name || '—'} para o ${buyerTeam.name} por ${`£${Math.round(transferOffer.offer_amount).toLocaleString('pt-PT')}`}, com um salário de £${Number(wageOffer).toLocaleString('pt-PT')}/semana e o papel de ${promisedRole}.`
      : `O ${buyerTeam.name} tinha acordo fechado com o ${sellerTeam?.name || 'clube vendedor'} por ${player.name}, mas o jogador recusou os termos do contrato oferecido.`,
    player_name: player.name,
    player_photo: player.photo_path,
    from_team_name: sellerTeam?.name,
    from_team_shield: sellerTeam?.shield_path,
    to_team_name: buyerTeam.name,
    to_team_shield: buyerTeam.shield_path,
    amount: accepted ? transferOffer.offer_amount : null,
  });

  res.status(201).json(db.prepare('SELECT * FROM contract_offers WHERE id = ?').get(info.lastInsertRowid));
});

/* ---------- POST /api/transfers/free-agent-offer — assinar um jogador livre (custo zero) ----------
   Jogadores sem clube (team_id NULL) não têm dono a negociar o valor da
   transferência — o "negócio" fica automaticamente fechado a custo zero, e
   segue-se logo para a negociação do contrato (mesmo fluxo de sempre em
   POST /api/transfers/:id/contract, usando o id devolvido aqui). */
router.post('/free-agent-offer', (req, res) => {
  if (!db.isMarketWindowOpen()) {
    return res.status(400).json({ error: 'O mercado de transferências está fechado. Só há uma janela de mercado por jogo.' });
  }

  const { player_id, buyer_team_id } = req.body;
  if (!player_id || !buyer_team_id) return res.status(400).json({ error: 'Dados incompletos' });

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(player_id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });
  if (player.team_id) return res.status(400).json({ error: 'Este jogador já pertence a um clube — usa a proposta de transferência normal' });
  if (player.transferred_in_window) {
    return res.status(400).json({ error: 'Este jogador já foi transferido neste mercado e não pode mudar de clube outra vez.' });
  }

  const buyerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(buyer_team_id);
  if (!buyerTeam) return res.status(404).json({ error: 'Equipa não encontrada' });

  logInterestMessage(buyerTeam, null, player);

  const info = db.prepare(`
    INSERT INTO transfer_offers (player_id, buyer_team_id, seller_team_id, offer_amount, status, resolved_at)
    VALUES (@player_id, @buyer_team_id, NULL, 0, 'accepted', datetime('now'))
  `).run({ player_id, buyer_team_id });

  res.status(201).json(db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(info.lastInsertRowid));
});

/* ---------- Aceita uma proposta pendente pelo valor indicado ----------
   Partilhada por PUT /:id/respond (aceitas logo a proposta original) e
   PUT /:id/counter (o comprador acaba por aceitar a tua contraproposta) —
   assim as duas vias seguem sempre exatamente as mesmas regras. O jogador
   ainda tem de querer mudar-se: se recusar, cria-se a mesma reunião de
   sempre (ver decidePlayerConsent) em vez de o negócio cair já. */
function acceptOfferAtAmount(offer, player, buyerTeam, sellerTeam, amount) {
  return db.transaction(() => {
    const consent = decidePlayerConsent(player, buyerTeam, sellerTeam);
    const amountFmt = `£${Math.round(amount).toLocaleString('pt-PT')}`;

    if (!consent.accepted) {
      /* O estado da proposta fica 'accepted' (o acordo entre clubes
         mantém-se pelo valor final negociado); falta só o próprio jogador
         — ver PUT /api/transfers/meetings/:id/respond. */
      db.prepare("UPDATE transfer_offers SET status = 'accepted', offer_amount = ?, resolved_at = datetime('now') WHERE id = ?")
        .run(amount, offer.id);

      const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
      const meetingInfo = db.prepare(`
        INSERT INTO transfer_meetings (team_id, player_id, buyer_team_id, transfer_offer_id, offer_amount, event_date)
        VALUES (@team_id, @player_id, @buyer_team_id, @transfer_offer_id, @offer_amount, @event_date)
      `).run({
        team_id: offer.seller_team_id, player_id: player.id, buyer_team_id: buyerTeam.id,
        transfer_offer_id: offer.id, offer_amount: amount, event_date: state.current_date,
      });

      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id, related_team_id, meeting_id)
        VALUES (@team_id, 'transfer_meeting', @title, @body, @player_id, @related_team_id, @meeting_id)
      `).run({
        team_id: offer.seller_team_id, player_id: player.id, related_team_id: buyerTeam.id,
        meeting_id: meetingInfo.lastInsertRowid,
        title: `Reunião necessária: ${player.name}`,
        body: `Aceitaste a proposta do ${buyerTeam.name} de ${amountFmt} por ${player.name}, mas ele não quer mudar-se. Podes reunir com ele antes de o negócio cair — propõe um empréstimo (volta a 1 de julho da época seguinte) ou diz-lhe que não faz parte dos teus planos, para o deixar mais recetivo a sair.`,
      });

      return { ok: true, status: 'player_hesitant', meeting_id: meetingInfo.lastInsertRowid };
    }

    db.prepare("UPDATE transfer_offers SET status = 'accepted', offer_amount = ?, resolved_at = datetime('now') WHERE id = ?")
      .run(amount, offer.id);
    const clauses = (() => { try { return JSON.parse(offer.clauses_json || '[]'); } catch { return []; } })();
    finalizePlayerMove({ player, buyerTeam, sellerTeam, wageOffer: consent.wageOffer, amount, isLoan: false, clauses, transferOfferId: offer.id });

    const title = `Transferência aceite: ${player.name}`;
    const body = `Aceitaste a proposta do ${buyerTeam.name} de ${amountFmt} por ${player.name}. A transferência foi concluída.`;

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
      VALUES (@team_id, 'player_sold', @title, @body, @player_id, @related_team_id)
    `).run({ team_id: offer.seller_team_id, title, body, player_id: player.id, related_team_id: buyerTeam.id });

    db.logMarketNews({
      type: 'player_sold',
      headline: `${player.name} muda-se para o ${buyerTeam.name}`,
      body,
      player_name: player.name,
      player_photo: player.photo_path,
      from_team_name: sellerTeam?.name,
      from_team_shield: sellerTeam?.shield_path,
      to_team_name: buyerTeam.name,
      to_team_shield: buyerTeam.shield_path,
      amount,
    });

    return { ok: true, status: 'accepted' };
  })();
}

/* ---------- Recusa definitiva de uma proposta pendente ----------
   byBuyer=false -> foste tu que recusaste (Recusar, ou contraproposta
                    absurda que o comprador nem tenta melhorar).
   byBuyer=true  -> o COMPRADOR é que desiste da negociação (a tua
                    contraproposta ficou fora do que está disposto a
                    pagar, e já não há mais rondas ou ele fica insultado). */
function rejectOfferMessage(offer, player, buyerTeam, sellerTeam, { byBuyer = false } = {}) {
  db.prepare("UPDATE transfer_offers SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?").run(offer.id);

  /* Proposta recusada: o estado de "listado" do jogador não muda por causa
     disto. Se já estava na lista de transferências, continua lá (outros
     clubes podem voltar a propor); se não estava, continua sem estar. */
  const amountFmt = `£${Math.round(offer.offer_amount).toLocaleString('pt-PT')}`;
  const title = byBuyer ? `Negociação terminada: ${player.name}` : `Transferência recusada: ${player.name}`;
  const body = byBuyer
    ? `O ${buyerTeam.name} não aceitou a tua contraproposta por ${player.name} e desistiu do negócio. O jogador continua na lista de transferências.`
    : `Recusaste a proposta do ${buyerTeam.name} de ${amountFmt} por ${player.name}. O jogador continua na lista de transferências.`;
  const msgType = byBuyer ? 'transfer_player_refused' : 'offer_declined_by_user';

  db.prepare(`
    INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
    VALUES (@team_id, @type, @title, @body, @player_id, @related_team_id)
  `).run({ team_id: offer.seller_team_id, type: msgType, title, body, player_id: player.id, related_team_id: buyerTeam.id });

  db.logMarketNews({
    type: msgType,
    headline: `${sellerTeam?.name || 'Clube'} recusa proposta por ${player.name}`,
    body,
    player_name: player.name,
    player_photo: player.photo_path,
    from_team_name: sellerTeam?.name,
    from_team_shield: sellerTeam?.shield_path,
    to_team_name: buyerTeam.name,
    to_team_shield: buyerTeam.shield_path,
    amount: null,
  });
}

/* ---------- PUT /api/transfers/:id/respond — aceitar ou recusar uma proposta pendente ----------
   Usado quando uma equipa (IA ou humana) faz uma proposta por um jogador da equipa
   vendedora e é preciso a confirmação dessa equipa antes da transferência se concluir
   (ex: propostas automáticas da lista de transferências para jogadores do utilizador). */
router.put('/:id/respond', (req, res) => {
  const offer = db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Proposta não encontrada' });
  if (offer.status !== 'pending') return res.status(400).json({ error: 'Esta proposta já foi respondida' });

  const accept = !!req.body.accept;
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(offer.player_id);
  const buyerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(offer.buyer_team_id);
  const sellerTeam = offer.seller_team_id ? db.prepare('SELECT * FROM teams WHERE id = ?').get(offer.seller_team_id) : null;
  if (!player || !buyerTeam) return res.status(404).json({ error: 'Jogador ou equipa não encontrados' });

  if (accept) {
    return res.json(acceptOfferAtAmount(offer, player, buyerTeam, sellerTeam, offer.offer_amount));
  }

  rejectOfferMessage(offer, player, buyerTeam, sellerTeam, { byBuyer: false });
  res.json({ ok: true, status: 'rejected' });
});

/* ---------- PUT /api/transfers/:id/counter — contraproposta a uma oferta pendente ----------
   Em vez de aceitares ou recusares já, pedes mais dinheiro pelo teu
   jogador. O comprador reage de uma de três formas:
   - dentro do que está disposto a pagar (buyerCeiling)   -> aceita já, ao
     valor que pediste;
   - bem acima disso (INSULT_MULTIPLIER)                  -> sente-se
     insultado e desiste logo, sem sequer tentar subir a oferta;
   - no meio-termo                                        -> sobe a oferta
     dele a meio caminho entre o que já tinha em cima da mesa e o que
     pediste (sem nunca ultrapassar o teto), fica com uma nova proposta
     pendente e podes voltar a responder — até esgotares
     MAX_NEGOTIATION_ROUNDS, altura em que a oferta em cima da mesa passa
     a ser a "palavra final" do comprador (só podes Aceitar/Recusar). */
router.put('/:id/counter', (req, res) => {
  const offer = db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Proposta não encontrada' });
  if (offer.status !== 'pending') return res.status(400).json({ error: 'Esta proposta já foi respondida' });

  const counterAmount = Number(req.body.counter_amount);
  if (!counterAmount || counterAmount <= offer.offer_amount) {
    return res.status(400).json({ error: 'A contraproposta tem de ser um valor acima da oferta atual' });
  }
  if (offer.negotiation_round >= MAX_NEGOTIATION_ROUNDS) {
    return res.status(400).json({ error: 'Já não há mais rondas de negociação disponíveis para esta proposta — aceita ou recusa a oferta atual.' });
  }

  /* O vendedor também pode pedir cláusulas na contraproposta (ex: "aceito
     por menos dinheiro, mas quero 20% da próxima venda") — se não vier
     nada no corpo do pedido, mantêm-se as cláusulas já em cima da mesa. */
  const clauses = req.body.clauses !== undefined
    ? db.normalizeClauseSpecs(req.body.clauses)
    : (() => { try { return JSON.parse(offer.clauses_json || '[]'); } catch { return []; } })();
  if (clauses === null) return res.status(400).json({ error: 'Cláusulas inválidas na contraproposta' });

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(offer.player_id);
  const buyerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(offer.buyer_team_id);
  const sellerTeam = offer.seller_team_id ? db.prepare('SELECT * FROM teams WHERE id = ?').get(offer.seller_team_id) : null;
  if (!player || !buyerTeam) return res.status(404).json({ error: 'Jogador ou equipa não encontrados' });

  const ceiling = buyerCeiling(player, buyerTeam);
  const nextRound = offer.negotiation_round + 1;

  const referenceValue = estimateMarketValue(player);
  const clausesValue = db.estimateClausesValue(clauses, { player, referenceValue });
  const installmentDiscount = db.installmentDiscountFactor(clauses);
  /* Quanto o comprador "sente" que está a pagar, já a contar com as
     cláusulas — uma percentagem de revenda ou um prémio por golos tornam
     um pedido mais alto mais aceitável; prestações tornam-no ligeiramente
     menos apetecível (o dinheiro demora a chegar). */
  const effectiveCounter = Math.max(0, (counterAmount * installmentDiscount) - clausesValue);

  db.prepare('UPDATE transfer_offers SET clauses_json = ? WHERE id = ?').run(JSON.stringify(clauses), offer.id);
  offer.clauses_json = JSON.stringify(clauses); // mantém o objeto em memória sincronizado para acceptOfferAtAmount, já mais abaixo

  if (effectiveCounter > ceiling * INSULT_MULTIPLIER) {
    rejectOfferMessage(offer, player, buyerTeam, sellerTeam, { byBuyer: true });
    return res.json({ ok: true, status: 'rejected', reason: 'insulted' });
  }

  if (effectiveCounter <= ceiling) {
    return res.json(acceptOfferAtAmount(offer, player, buyerTeam, sellerTeam, counterAmount));
  }

  const raisedAmount = Math.min(ceiling, Math.round((offer.offer_amount + Math.min(effectiveCounter, ceiling)) / 2));
  const isFinalRound = nextRound >= MAX_NEGOTIATION_ROUNDS;

  db.prepare('UPDATE transfer_offers SET offer_amount = ?, negotiation_round = ? WHERE id = ?')
    .run(raisedAmount, nextRound, offer.id);

  const raisedFmt = `£${Math.round(raisedAmount).toLocaleString('pt-PT')}`;
  const counterFmt = `£${Math.round(counterAmount).toLocaleString('pt-PT')}`;
  const clauseLines = clauses.map((c) => `• ${db.describeClause(c)}`).join('\n');
  const title = `Nova oferta: ${player.name}`;
  const body = isFinalRound
    ? `Pediste ${counterFmt} por ${player.name}${clauseLines ? ` com cláusulas:\n${clauseLines}` : ''}. O ${buyerTeam.name} não chega lá, mas sobe a proposta para ${raisedFmt} — é a oferta final, sem mais margem para negociar. Aceita ou recusa.`
    : `Pediste ${counterFmt} por ${player.name}${clauseLines ? ` com cláusulas:\n${clauseLines}` : ''}. O ${buyerTeam.name} sobe a proposta para ${raisedFmt}. Podes aceitar, recusar, ou voltar a contrapropor.`;

  db.prepare(`
    INSERT INTO messages (team_id, type, title, body, player_id, related_team_id, transfer_offer_id)
    VALUES (@team_id, 'incoming_offer_pending', @title, @body, @player_id, @related_team_id, @transfer_offer_id)
  `).run({
    team_id: offer.seller_team_id, title, body, player_id: player.id,
    related_team_id: buyerTeam.id, transfer_offer_id: offer.id,
  });

  res.json({ ok: true, status: 'countered', offer_amount: raisedAmount, negotiation_round: nextRound, is_final_round: isFinalRound });
});

/* ---------- PUT /api/transfers/meetings/:id/respond — reunião de transferência ----------
   Chamada depois de o jogador ter recusado mudar-se apesar do clube vendedor
   ter aceitado a proposta (ver acima). Duas opções:
   - 'loan'         -> propõe um empréstimo ao jogador (ele pode aceitar ou não);
                       se aceitar, muda-se já para o clube comprador e volta
                       automaticamente a 1 de julho da época seguinte.
   - 'not_in_plans' -> avisa o jogador de que não conta com ele; fica muito
                       mais recetivo a sair e a decisão é logo reavaliada. */
router.put('/meetings/:id/respond', (req, res) => {
  const meeting = db.prepare('SELECT * FROM transfer_meetings WHERE id = ?').get(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada' });
  if (meeting.status !== 'pending') return res.status(400).json({ error: 'Esta reunião já foi resolvida' });

  const action = req.body.action;
  if (!['loan', 'not_in_plans'].includes(action)) {
    return res.status(400).json({ error: 'Ação inválida' });
  }

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(meeting.player_id);
  const buyerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(meeting.buyer_team_id);
  const sellerTeam = meeting.team_id ? db.prepare('SELECT * FROM teams WHERE id = ?').get(meeting.team_id) : null;
  if (!player || !buyerTeam) return res.status(404).json({ error: 'Jogador ou equipa não encontrados' });

  const amountFmt = `£${Math.round(meeting.offer_amount).toLocaleString('pt-PT')}`;
  let resolution, resultStatus, title, body, msgType, newsHeadline;

  if (action === 'loan') {
    /* O jogador está mais recetivo a um empréstimo (é temporário) do que a
       uma venda definitiva — o mesmo cálculo de sempre, com um pequeno
       viés extra a favor. */
    const repDelta = (buyerTeam.reputation_stars - (sellerTeam?.reputation_stars ?? buyerTeam.reputation_stars)) / 5;
    const luck = (Math.random() * 0.2) - 0.1;
    const boost = Number(player.consent_boost) || 0;
    const loanAccepted = ((repDelta * 0.6) + luck + 0.2 + boost) > 0;

    if (loanAccepted) {
      const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
      const returnDate = nextJulyFirst(state.current_date);
      finalizePlayerMove({ player, buyerTeam, sellerTeam, isLoan: true, loanReturnDate: returnDate });

      resolution = `Aceitaste propor um empréstimo e ${player.name} aceitou — está emprestado ao ${buyerTeam.name} até 1 de julho de ${Number(returnDate.slice(0, 4))}.`;
      resultStatus = 'loan_accepted';
      title = `Empréstimo acordado: ${player.name}`;
      body = `${player.name} aceitou ser emprestado ao ${buyerTeam.name} até 1 de julho de ${Number(returnDate.slice(0, 4))}, depois de teres recusado a venda direta.`;
      msgType = 'loan_agreed';
      newsHeadline = `${player.name} sai por empréstimo para o ${buyerTeam.name}`;
    } else {
      resolution = `Propuseste um empréstimo, mas ${player.name} recusou. O negócio caiu.`;
      resultStatus = 'loan_declined';
      title = `Negócio caiu: ${player.name}`;
      body = `Propuseste um empréstimo ao ${buyerTeam.name}, mas ${player.name} recusou. A transferência não se realizou.`;
      msgType = 'transfer_player_refused';
      newsHeadline = `${player.name} recusa empréstimo para o ${buyerTeam.name}`;
    }
  } else {
    /* 'not_in_plans': aumenta a vontade do jogador em sair e reavalia já a
       decisão original (venda definitiva) com esse reforço. */
    db.prepare('UPDATE players SET consent_boost = consent_boost + 0.4 WHERE id = ?').run(player.id);
    const boostedPlayer = db.prepare('SELECT * FROM players WHERE id = ?').get(player.id);
    const consent = decidePlayerConsent(boostedPlayer, buyerTeam, sellerTeam);

    if (consent.accepted) {
      const originalOffer = db.prepare('SELECT clauses_json FROM transfer_offers WHERE id = ?').get(meeting.transfer_offer_id);
      const clauses = (() => { try { return JSON.parse(originalOffer?.clauses_json || '[]'); } catch { return []; } })();
      finalizePlayerMove({ player: boostedPlayer, buyerTeam, sellerTeam, wageOffer: consent.wageOffer, amount: meeting.offer_amount, isLoan: false, clauses, transferOfferId: meeting.transfer_offer_id });

      resolution = `Disseste a ${player.name} que não faz parte dos teus planos — ele reconsiderou e aceitou mudar-se para o ${buyerTeam.name} por ${amountFmt}.`;
      resultStatus = 'accepted_after_talk';
      title = `Transferência concluída: ${player.name}`;
      body = `Depois de lhe dizeres que não faz parte dos teus planos, ${player.name} aceitou mudar-se para o ${buyerTeam.name} por ${amountFmt}.`;
      msgType = 'player_sold';
      newsHeadline = `${player.name} muda-se para o ${buyerTeam.name}`;
    } else {
      db.prepare('UPDATE players SET consent_boost = 0 WHERE id = ?').run(player.id);
      resolution = `Disseste a ${player.name} que não faz parte dos teus planos, mas mesmo assim ele recusou mudar-se. O negócio caiu.`;
      resultStatus = 'refused_after_talk';
      title = `Negócio caiu: ${player.name}`;
      body = `Mesmo depois de lhe dizeres que não faz parte dos teus planos, ${player.name} recusou mudar-se para o ${buyerTeam.name}. A transferência não se realizou.`;
      msgType = 'transfer_player_refused';
      newsHeadline = `${player.name} recusa mudar-se para o ${buyerTeam.name}`;
    }
  }

  db.prepare("UPDATE transfer_meetings SET status = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?")
    .run(resolution, meeting.id);

  db.prepare(`
    INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
    VALUES (@team_id, @type, @title, @body, @player_id, @related_team_id)
  `).run({ team_id: meeting.team_id, type: msgType, title, body, player_id: player.id, related_team_id: buyerTeam.id });

  db.logMarketNews({
    type: msgType,
    headline: newsHeadline,
    body,
    player_name: player.name,
    player_photo: player.photo_path,
    from_team_name: sellerTeam?.name,
    from_team_shield: sellerTeam?.shield_path,
    to_team_name: buyerTeam.name,
    to_team_shield: buyerTeam.shield_path,
    amount: resultStatus === 'accepted_after_talk' ? meeting.offer_amount : null,
  });

  res.json({ ok: true, status: resultStatus, resolution });
});

/* ---------- GET /api/transfers/messages?team_id=X — caixa de entrada do clube ----------
   Devolve também a foto do jogador, o escudo da minha equipa e o escudo da equipa
   relacionada (compradora/vendedora), e o estado da proposta quando a mensagem estiver
   ligada a uma transferência pendente de aprovação. */
router.get('/messages', (req, res) => {
  const { team_id } = req.query;
  if (!team_id) return res.status(400).json({ error: 'É preciso indicar team_id' });

  const rows = db.prepare(`
    SELECT
      m.*,
      p.name        AS player_name,
      p.photo_path  AS player_photo,
      p.season_stats_json AS player_season_stats_json,
      myTeam.name         AS my_team_name,
      myTeam.shield_path  AS my_team_shield,
      relTeam.name        AS related_team_name,
      relTeam.shield_path AS related_team_shield,
      t.status        AS offer_status,
      t.offer_amount  AS offer_amount,
      t.buyer_team_id AS offer_buyer_team_id,
      t.negotiation_round AS offer_negotiation_round,
      pi.kind         AS incident_kind,
      pi.status       AS incident_status,
      pi.resolution   AS incident_resolution,
      mq.options_json AS question_options_json,
      mq.status       AS question_status,
      mq.chosen_key   AS question_chosen_key,
      tm.status       AS meeting_status,
      tm.resolution   AS meeting_resolution,
      tm.offer_amount AS meeting_offer_amount,
      cf.status       AS friendly_status
    FROM messages m
    LEFT JOIN players p ON p.id = m.player_id
    LEFT JOIN teams myTeam ON myTeam.id = m.team_id
    LEFT JOIN teams relTeam ON relTeam.id = m.related_team_id
    LEFT JOIN transfer_offers t ON t.id = m.transfer_offer_id
    LEFT JOIN player_incidents pi ON pi.id = m.incident_id
    LEFT JOIN manager_questions mq ON mq.id = m.question_id
    LEFT JOIN transfer_meetings tm ON tm.id = m.meeting_id
    LEFT JOIN club_friendlies cf ON cf.id = m.friendly_id
    WHERE m.team_id = ?
    ORDER BY m.created_at DESC, m.id DESC
  `).all(team_id);

  res.json(rows);
});

/* ---------- DELETE /api/transfers/messages?team_id=X — limpar a caixa de entrada ----------
   Apaga todas as mensagens do clube, EXCETO as que ainda têm uma proposta pendente
   de resposta (incoming_offer_pending com status 'pending') — assim o utilizador
   nunca perde a oportunidade de aceitar/recusar uma transferência por limpar a caixa. */
router.delete('/messages', (req, res) => {
  const { team_id } = req.query;
  if (!team_id) return res.status(400).json({ error: 'É preciso indicar team_id' });

  const info = db.prepare(`
    DELETE FROM messages
    WHERE team_id = @team_id
      AND id NOT IN (
        SELECT m.id FROM messages m
        JOIN transfer_offers t ON t.id = m.transfer_offer_id
        WHERE m.team_id = @team_id AND m.transfer_offer_id IS NOT NULL AND t.status = 'pending'
      )
      AND id NOT IN (
        SELECT m.id FROM messages m
        JOIN player_incidents pi ON pi.id = m.incident_id
        WHERE m.team_id = @team_id AND m.incident_id IS NOT NULL AND pi.status = 'pending'
      )
      AND id NOT IN (
        SELECT m.id FROM messages m
        JOIN manager_questions mq ON mq.id = m.question_id
        WHERE m.team_id = @team_id AND m.question_id IS NOT NULL AND mq.status = 'pending'
      )
      AND id NOT IN (
        SELECT m.id FROM messages m
        JOIN transfer_meetings tm ON tm.id = m.meeting_id
        WHERE m.team_id = @team_id AND m.meeting_id IS NOT NULL AND tm.status = 'pending'
      )
      AND id NOT IN (
        SELECT m.id FROM messages m
        JOIN club_friendlies cf ON cf.id = m.friendly_id
        WHERE m.team_id = @team_id AND m.friendly_id IS NOT NULL AND cf.status = 'accepted'
      )
  `).run({ team_id });

  res.json({ ok: true, deleted: info.changes });
});

/* ---------- PUT /api/transfers/messages/:id/read ---------- */
router.put('/messages/:id/read', (req, res) => {
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- Ano do último mercado já fechado ----------
   O mercado está sempre aberto de 1 a 31 de julho, todos os anos (ver
   isMarketWindowOpen em db/database.js). A partir da data atual do jogo,
   devolve o ano do último "1-31 de julho" que já passou por completo:
   - se ainda estamos antes de julho (MM-DD < 07-01), foi julho do ano anterior;
   - caso contrário (estamos em ou depois de julho), foi julho deste ano
     (mesmo que o mercado esteja a decorrer agora mesmo). */
function lastClosedOrCurrentWindowYear(currentDateStr) {
  const year = Number(String(currentDateStr).slice(0, 4));
  const monthDay = String(currentDateStr).slice(5, 10);
  return monthDay < '07-01' ? year - 1 : year;
}

/* ---------- GET /api/transfers/window-summary — painel do fim do mercado ----------
   Todas as transferências CONCLUÍDAS (contratos assinados/vendas diretas,
   entre quaisquer clubes, incluindo negócios só entre equipas geridas pelo
   jogo) durante o último mercado — 1 a 31 de julho — ordenadas por
   relevância (valor da transferência, do maior para o menor). Pensado para
   aparecer ao lado do jornal de notícias na aba Mercado assim que a janela
   fecha (1 de agosto). */
router.get('/window-summary', (req, res) => {
  const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
  const year = lastClosedOrCurrentWindowYear(state.current_date);
  const isOpenNow = db.isMarketWindowOpen();

  const rows = db.prepare(`
    SELECT * FROM market_news
    WHERE type IN ('transfer_completed', 'player_sold', 'loan_agreed')
      AND event_date BETWEEN ? AND ?
    ORDER BY (amount IS NULL) ASC, amount DESC, id ASC
  `).all(`${year}-07-01`, `${year}-07-31`);

  res.json({
    window_year: year,
    is_market_closed: !isOpenNow,
    transfers: rows,
  });
});

/* ---------- GET /api/transfers/clauses — aba "Cláusulas" do Mercado ----------
   TODAS as cláusulas de transferência atualmente ativas (ainda por cumprir)
   e as cumpridas mais recentemente, de qualquer negócio — envolvendo o
   utilizador ou só entre clubes geridos pelo jogo — com o jogador, as duas
   equipas envolvidas e uma descrição pronta a mostrar. */
router.get('/clauses', (req, res) => {
  const rows = db.prepare(`
    SELECT tc.*,
           p.name AS player_name, p.photo_path AS player_photo,
           b.name AS beneficiary_name, b.shield_path AS beneficiary_shield,
           o.name AS obligor_name, o.shield_path AS obligor_shield
    FROM transfer_clauses tc
    JOIN players p ON p.id = tc.player_id
    LEFT JOIN teams b ON b.id = tc.beneficiary_team_id
    LEFT JOIN teams o ON o.id = tc.obligor_team_id
    ORDER BY (tc.status = 'active') DESC, tc.created_at DESC
    LIMIT 200
  `).all();

  res.json({ clauses: rows });
});

module.exports = router;
module.exports.runLoanReturnsIfDue = runLoanReturnsIfDue;
module.exports.settleTransferMoney = settleTransferMoney;
module.exports.maybeGenerateAiClauses = maybeGenerateAiClauses;