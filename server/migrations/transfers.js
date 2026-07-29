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
  const score = (repDelta * 0.6) + luck + 0.05; // ligeiro viés a favor, já que o clube vendedor aceitou vender
  return { accepted: score > 0, wageOffer: Math.max(expectedWage, currentWage) };
}

/* ---------- POST /api/transfers/offer — enviar proposta financeira por um jogador ---------- */
router.post('/offer', (req, res) => {
  const { player_id, buyer_team_id, offer_amount } = req.body;
  const offerAmount = Number(offer_amount);

  if (!player_id || !buyer_team_id || !offerAmount || offerAmount <= 0) {
    return res.status(400).json({ error: 'Dados da proposta incompletos' });
  }

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(player_id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });
  if (!player.team_id) return res.status(400).json({ error: 'Este jogador não pertence a nenhum clube' });
  if (String(player.team_id) === String(buyer_team_id)) {
    return res.status(400).json({ error: 'Este jogador já está na tua equipa' });
  }

  const buyerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(buyer_team_id);
  if (!buyerTeam) return res.status(404).json({ error: 'Equipa não encontrada' });
  if (offerAmount > buyerTeam.transfer_budget) {
    return res.status(400).json({ error: 'A proposta excede o teu orçamento de transferências disponível' });
  }

  const sellerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(player.team_id);

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
    const contractEnd = new Date();
    contractEnd.setFullYear(contractEnd.getFullYear() + 3);
    const contractEndText = `${contractEnd.getDate()}/${contractEnd.getMonth() + 1}/${contractEnd.getFullYear()}`;

    db.prepare(`
      UPDATE players SET
        team_id = @team_id, club_status = @club_status,
        wage_text = @wage_text, contract_end = @contract_end,
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
  const { player_id, buyer_team_id } = req.body;
  if (!player_id || !buyer_team_id) return res.status(400).json({ error: 'Dados incompletos' });

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(player_id);
  if (!player) return res.status(404).json({ error: 'Jogador não encontrado' });
  if (player.team_id) return res.status(400).json({ error: 'Este jogador já pertence a um clube — usa a proposta de transferência normal' });

  const buyerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(buyer_team_id);
  if (!buyerTeam) return res.status(404).json({ error: 'Equipa não encontrada' });

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

  const respond = db.transaction(() => {
    db.prepare("UPDATE transfer_offers SET status = ?, resolved_at = datetime('now') WHERE id = ?")
      .run(accept ? 'accepted' : 'rejected', offer.id);

    if (accept && !playerRefused) {
      const amount = offer.offer_amount;
      const contractEnd = new Date();
      contractEnd.setFullYear(contractEnd.getFullYear() + 3);
      const contractEndText = `${contractEnd.getDate()}/${contractEnd.getMonth() + 1}/${contractEnd.getFullYear()}`;

      db.prepare(`
        UPDATE players SET team_id = @team_id, is_listed = 0, asking_price = NULL,
          club_status = 'Titular Regular', wage_text = @wage_text, contract_end = @contract_end,
          updated_at = datetime('now')
        WHERE id = @player_id
      `).run({ team_id: buyerTeam.id, player_id: player.id, wage_text: `£${Number(consent.wageOffer).toLocaleString('pt-PT')} p/s`, contract_end: contractEndText });

      if (sellerTeam) {
        db.prepare('UPDATE teams SET balance = balance + @amount, transfer_budget = transfer_budget + @amount, updated_at = datetime(\'now\') WHERE id = @id')
          .run({ amount, id: sellerTeam.id });
      }
      db.prepare('UPDATE teams SET balance = balance - @amount, transfer_budget = transfer_budget - @amount, updated_at = datetime(\'now\') WHERE id = @id')
        .run({ amount, id: buyerTeam.id });
    }
    /* Proposta recusada por ti OU aceite mas recusada pelo próprio jogador:
       o estado de "listado" do jogador não muda por causa disto. Se já
       estava na lista de transferências, continua lá (outros clubes podem
       voltar a propor); se não estava — porque a proposta chegou sem o
       jogador estar à venda — continua sem estar, em vez de passar a ficar
       listado automaticamente só por ter recusado uma proposta. */

    const amountFmt = `£${Math.round(offer.offer_amount).toLocaleString('pt-PT')}`;
    let title, body, msgType;
    if (playerRefused) {
      title = `Negócio caiu: ${player.name}`;
      body = `Aceitaste a proposta do ${buyerTeam.name} de ${amountFmt} por ${player.name}, mas o próprio jogador recusou a mudança de clube. A transferência não se realizou.`;
      msgType = 'transfer_player_refused';
    } else if (accept) {
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
      headline: playerRefused ? `${player.name} recusa mudar-se para o ${buyerTeam.name}` : (accept ? `${player.name} muda-se para o ${buyerTeam.name}` : `${sellerTeam?.name || 'Clube'} recusa proposta por ${player.name}`),
      body,
      player_name: player.name,
      player_photo: player.photo_path,
      from_team_name: sellerTeam?.name,
      from_team_shield: sellerTeam?.shield_path,
      to_team_name: buyerTeam.name,
      to_team_shield: buyerTeam.shield_path,
      amount: accept && !playerRefused ? offer.offer_amount : null,
    });
  });

  respond();
  res.json({ ok: true, status: playerRefused ? 'player_refused' : (accept ? 'accepted' : 'rejected') });
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
      t.buyer_team_id AS offer_buyer_team_id
    FROM messages m
    LEFT JOIN players p ON p.id = m.player_id
    LEFT JOIN teams myTeam ON myTeam.id = m.team_id
    LEFT JOIN teams relTeam ON relTeam.id = m.related_team_id
    LEFT JOIN transfer_offers t ON t.id = m.transfer_offer_id
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
  `).run({ team_id });

  res.json({ ok: true, deleted: info.changes });
});

/* ---------- PUT /api/transfers/messages/:id/read ---------- */
router.put('/messages/:id/read', (req, res) => {
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;