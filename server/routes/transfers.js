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

/* Extrai números de texto tipo "£95M - £113M" ou "£41.5K p/s" -> [95000000, 113000000] */
function parseMoneyRange(text) {
  const matches = [...String(text || '').matchAll(/([\d]+(?:[.,]\d+)?)\s*(M|K)?/gi)]
    .map((m) => {
      const num = parseFloat(m[1].replace(',', '.'));
      if (Number.isNaN(num) || num <= 0) return null;
      const suffix = (m[2] || '').toUpperCase();
      const mult = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : 1;
      return num * mult;
    })
    .filter((n) => n !== null);
  return matches;
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
   proposta conseguia alguma vez atingir o acceptRatio necessário. */
function estimateMarketValue(player) {
  const parsed = parseMoneyRange(player.market_value_text);
  if (parsed.length) return parsed.reduce((a, b) => a + b, 0) / parsed.length;

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
   como data de regresso de um empréstimo (ver reunião de transferência
   abaixo). O mercado só está aberto entre 1 e 31 de julho (ver
   isMarketWindowOpen em db/database.js), por isso uma reunião só pode
   acontecer dentro dessa janela — "a época seguinte" começa sempre no
   1 de julho do ANO SEGUINTE ao da data atual. */
function nextJulyFirst(currentDateStr) {
  const year = Number(String(currentDateStr).slice(0, 4));
  return `${year + 1}-07-01`;
}

/* Concretiza a mudança de clube de um jogador, com ou sem empréstimo —
   partilhado entre a aceitação normal de uma proposta (PUT
   /:id/respond) e a reunião de transferência (PUT /meetings/:id/respond),
   para as duas seguirem sempre exatamente as mesmas regras. */
function finalizePlayerMove({ player, buyerTeam, sellerTeam, wageOffer, amount, isLoan, loanReturnDate }) {
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
    return;
  }

  db.prepare(`
    UPDATE players SET team_id = @team_id, is_listed = 0, asking_price = NULL,
      club_status = 'Titular Regular', wage_text = @wage_text, contract_end = @contract_end,
      transferred_in_window = 1, consent_boost = 0, updated_at = datetime('now')
    WHERE id = @player_id
  `).run({ team_id: buyerTeam.id, player_id: player.id, wage_text: `£${Number(wageOffer).toLocaleString('pt-PT')} p/s`, contract_end: contractEndText });

  if (sellerTeam) {
    db.prepare("UPDATE teams SET balance = balance + @amount, transfer_budget = transfer_budget + @amount, updated_at = datetime('now') WHERE id = @id")
      .run({ amount, id: sellerTeam.id });
  }
  db.prepare("UPDATE teams SET balance = balance - @amount, transfer_budget = transfer_budget - @amount, updated_at = datetime('now') WHERE id = @id")
    .run({ amount, id: buyerTeam.id });
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

/* ---------- POST /api/transfers/offer — enviar proposta financeira por um jogador ---------- */
router.post('/offer', (req, res) => {
  const { player_id, buyer_team_id, offer_amount } = req.body;
  const offerAmount = Number(offer_amount);

  if (!player_id || !buyer_team_id || !offerAmount || offerAmount <= 0) {
    return res.status(400).json({ error: 'Dados da proposta incompletos' });
  }

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
  const tierRatio = TIER_ACCEPT_RATIO[sellerTeam?.financial_tier] ?? 0.70;
  const reputationPremium = ((sellerTeam?.reputation_stars ?? 3) - 3) * 0.03;
  const abilityPremium = Math.max(0, (player.current_ability_stars ?? 2.5) - 3.5) * 0.05;
  const acceptRatio = tierRatio + reputationPremium + abilityPremium;

  const offerRatio = offerAmount / referenceValue;
  const luck = (Math.random() * 0.16) - 0.08;
  const accepted = (offerRatio + luck) >= acceptRatio;

  const info = db.prepare(`
    INSERT INTO transfer_offers (player_id, buyer_team_id, seller_team_id, offer_amount, status, resolved_at)
    VALUES (@player_id, @buyer_team_id, @seller_team_id, @offer_amount, @status, datetime('now'))
  `).run({
    player_id, buyer_team_id, seller_team_id: player.team_id, offer_amount: offerAmount,
    status: accepted ? 'accepted' : 'rejected',
  });

  const offerFmt = `£${Math.round(offerAmount).toLocaleString('pt-PT')}`;
  const title = accepted ? `Proposta aceite: ${player.name}` : `Proposta recusada: ${player.name}`;
  const body = accepted
    ? `O ${sellerTeam?.name || 'clube'} aceitou a tua proposta de ${offerFmt} por ${player.name}. Já podes negociar o contrato com o jogador no perfil dele.`
    : `O ${sellerTeam?.name || 'clube'} recusou a tua proposta de ${offerFmt} por ${player.name}. Tenta um valor mais alto ou volta a tentar mais tarde.`;

  db.prepare(`
    INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
    VALUES (@team_id, @type, @title, @body, @player_id, @related_team_id)
  `).run({ team_id: buyer_team_id, type: accepted ? 'transfer_accepted' : 'transfer_rejected', title, body, player_id, related_team_id: player.team_id });

  db.logMarketNews({
    type: accepted ? 'offer_accepted' : 'offer_rejected',
    headline: accepted ? `${sellerTeam?.name || 'Clube'} aceita proposta por ${player.name}` : `${sellerTeam?.name || 'Clube'} recusa proposta por ${player.name}`,
    body: accepted
      ? `O ${buyerTeam.name} propôs ${offerFmt} pelo passe de ${player.name} e o ${sellerTeam?.name || 'clube vendedor'} aceitou o negócio. Falta agora fechar os termos do contrato com o jogador.`
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

    db.prepare(`
      UPDATE teams SET
        balance = balance - @totalCost, transfer_budget = transfer_budget - @totalCost,
        wage_budget = wage_budget - @wage_offer, updated_at = datetime('now')
      WHERE id = @id
    `).run({ totalCost, wage_offer: wageOffer, id: buyerTeam.id });
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

  /* Mesmo que aceites vender, o jogador ainda tem de querer mudar-se — decide-se
     agora, antes de qualquer dinheiro mudar de mãos. */
  const consent = accept ? decidePlayerConsent(player, buyerTeam, sellerTeam) : null;
  const playerRefused = accept && consent && !consent.accepted;

  /* O jogador recusou mudar-se: em vez do negócio cair já, o treinador
     vendedor tem direito a uma reunião com ele antes de o negócio ser dado
     como falhado — ver PUT /api/transfers/meetings/:id/respond. O estado da
     proposta ainda fica 'accepted' (o acordo entre clubes mantém-se; falta
     só o próprio jogador). */
  if (playerRefused) {
    db.prepare("UPDATE transfer_offers SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?").run(offer.id);

    const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
    const meetingInfo = db.prepare(`
      INSERT INTO transfer_meetings (team_id, player_id, buyer_team_id, transfer_offer_id, offer_amount, event_date)
      VALUES (@team_id, @player_id, @buyer_team_id, @transfer_offer_id, @offer_amount, @event_date)
    `).run({
      team_id: offer.seller_team_id, player_id: player.id, buyer_team_id: buyerTeam.id,
      transfer_offer_id: offer.id, offer_amount: offer.offer_amount, event_date: state.current_date,
    });

    const amountFmt = `£${Math.round(offer.offer_amount).toLocaleString('pt-PT')}`;
    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, player_id, related_team_id, meeting_id)
      VALUES (@team_id, 'transfer_meeting', @title, @body, @player_id, @related_team_id, @meeting_id)
    `).run({
      team_id: offer.seller_team_id, player_id: player.id, related_team_id: buyerTeam.id,
      meeting_id: meetingInfo.lastInsertRowid,
      title: `Reunião necessária: ${player.name}`,
      body: `Aceitaste a proposta do ${buyerTeam.name} de ${amountFmt} por ${player.name}, mas ele não quer mudar-se. Podes reunir com ele antes de o negócio cair — propõe um empréstimo (volta a 1 de julho da época seguinte) ou diz-lhe que não faz parte dos teus planos, para o deixar mais recetivo a sair.`,
    });

    return res.json({ ok: true, status: 'player_hesitant', meeting_id: meetingInfo.lastInsertRowid });
  }

  const respond = db.transaction(() => {
    db.prepare("UPDATE transfer_offers SET status = ?, resolved_at = datetime('now') WHERE id = ?")
      .run(accept ? 'accepted' : 'rejected', offer.id);

    if (accept) {
      finalizePlayerMove({ player, buyerTeam, sellerTeam, wageOffer: consent.wageOffer, amount: offer.offer_amount, isLoan: false });
    }
    /* Proposta recusada por ti: o estado de "listado" do jogador não muda
       por causa disto. Se já estava na lista de transferências, continua
       lá (outros clubes podem voltar a propor); se não estava — porque a
       proposta chegou sem o jogador estar à venda — continua sem estar, em
       vez de passar a ficar listado automaticamente só por ter recusado
       uma proposta. */

    const amountFmt = `£${Math.round(offer.offer_amount).toLocaleString('pt-PT')}`;
    let title, body, msgType;
    if (accept) {
      title = `Transferência aceite: ${player.name}`;
      body = `Aceitaste a proposta do ${buyerTeam.name} de ${amountFmt} por ${player.name}. A transferência foi concluída.`;
      msgType = 'player_sold';
    } else {
      title = `Transferência recusada: ${player.name}`;
      body = `Recusaste a proposta do ${buyerTeam.name} de ${amountFmt} por ${player.name}. O jogador continua na lista de transferências.`;
      msgType = 'offer_declined_by_user';
    }

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
      VALUES (@team_id, @type, @title, @body, @player_id, @related_team_id)
    `).run({
      team_id: offer.seller_team_id, type: msgType,
      title, body, player_id: player.id, related_team_id: buyerTeam.id,
    });

    db.logMarketNews({
      type: msgType,
      headline: accept ? `${player.name} muda-se para o ${buyerTeam.name}` : `${sellerTeam?.name || 'Clube'} recusa proposta por ${player.name}`,
      body,
      player_name: player.name,
      player_photo: player.photo_path,
      from_team_name: sellerTeam?.name,
      from_team_shield: sellerTeam?.shield_path,
      to_team_name: buyerTeam.name,
      to_team_shield: buyerTeam.shield_path,
      amount: accept ? offer.offer_amount : null,
    });
  });

  respond();
  res.json({ ok: true, status: accept ? 'accepted' : 'rejected' });
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
      finalizePlayerMove({ player: boostedPlayer, buyerTeam, sellerTeam, wageOffer: consent.wageOffer, amount: meeting.offer_amount, isLoan: false });

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
      myTeam.name         AS my_team_name,
      myTeam.shield_path  AS my_team_shield,
      relTeam.name        AS related_team_name,
      relTeam.shield_path AS related_team_shield,
      t.status        AS offer_status,
      t.offer_amount  AS offer_amount,
      t.buyer_team_id AS offer_buyer_team_id,
      pi.kind         AS incident_kind,
      pi.status       AS incident_status,
      pi.resolution   AS incident_resolution,
      mq.options_json AS question_options_json,
      mq.status       AS question_status,
      mq.chosen_key   AS question_chosen_key,
      tm.status       AS meeting_status,
      tm.resolution   AS meeting_resolution,
      tm.offer_amount AS meeting_offer_amount
    FROM messages m
    LEFT JOIN players p ON p.id = m.player_id
    LEFT JOIN teams myTeam ON myTeam.id = m.team_id
    LEFT JOIN teams relTeam ON relTeam.id = m.related_team_id
    LEFT JOIN transfer_offers t ON t.id = m.transfer_offer_id
    LEFT JOIN player_incidents pi ON pi.id = m.incident_id
    LEFT JOIN manager_questions mq ON mq.id = m.question_id
    LEFT JOIN transfer_meetings tm ON tm.id = m.meeting_id
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

module.exports = router;
module.exports.runLoanReturnsIfDue = runLoanReturnsIfDue;