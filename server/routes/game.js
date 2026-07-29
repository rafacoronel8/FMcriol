/* ==========================================================
   FMcriol — Reiniciar o mundo do jogo ("Novo Jogo")
   Desfaz transferências, limpa a caixa de entrada e repõe
   os orçamentos das equipas aos valores calculados na seed.
   ========================================================== */
const express = require('express');
const db = require('../db/database');

const router = express.Router();

/* Tem de refletir exatamente a fórmula usada em db/seed.js, para que o
   reset devolva as equipas aos valores com que o jogo começou. */
const FINANCIAL_MULTIPLIER = {
  'Muito Rico': 5.0,
  'Rico': 3.0,
  'Medio': 1.5,
  'Pobre': 0.8,
  'Muito Pobre': 0.4,
};
const BASE_WAGE_BUDGET = 5000;
const BASE_TRANSFER_BUDGET = 250000;
const BASE_BALANCE = 200000;

/* Nome da linha em season_stats_json onde se acumulam golos, assistências e
   nota média dos jogos amigáveis (não oficiais) de cada jogador — ver
   runFriendliesTick() e applyFriendlyStatsToPlayer() mais abaixo. */
const FRIENDLY_COMPETITION_NAME = 'Amigáveis (Não Oficial)';

function computeBudgets(reputation, tier) {
  const mult = FINANCIAL_MULTIPLIER[tier] ?? 1;
  const repFactor = reputation / 3;
  return {
    wage_budget: Math.round(BASE_WAGE_BUDGET * mult * repFactor),
    transfer_budget: Math.round(BASE_TRANSFER_BUDGET * mult * repFactor),
    balance: Math.round(BASE_BALANCE * mult * repFactor),
  };
}

/* ---------- POST /api/game/reset — repõe o mundo ao estado inicial ---------- */
router.post('/reset', (req, res) => {
  const resetAll = db.transaction(() => {
    /* 1. Devolve TODOS os jogadores ao seu clube de origem (original_team_id),
          seja qual for a forma como foram transferidos: proposta manual e
          contrato assinado, venda automática pela lista de transferências, ou
          negócio entre duas equipas geridas pelo computador. Usar original_team_id
          em vez de reconstruir o histórico a partir de contract_offers garante que
          nenhuma transferência escapa ao reset.

          IMPORTANTE: jogadores livres (criados sem clube) têm original_team_id
          IS NULL — a condição tinha de incluir esse caso também, senão um
          agente livre contratado durante a carreira ficava "preso" na equipa
          do utilizador para sempre, mesmo depois de "Novo Jogo". Um jogador
          livre num novo jogo tem sempre de voltar a ser jogador livre. */
    const moved = db.prepare(`
      SELECT id, original_team_id FROM players
      WHERE (original_team_id IS NOT NULL AND team_id IS NOT original_team_id)
         OR (original_team_id IS NULL AND team_id IS NOT NULL)
    `).all();

    const revertPlayer = db.prepare(`
      UPDATE players SET
        team_id = original_team_id,
        club_status = CASE WHEN original_team_id IS NULL THEN 'Jogador Livre' ELSE 'Titular Regular' END,
        wage_text = '', contract_end = '', is_listed = 0, asking_price = NULL,
        updated_at = datetime('now')
      WHERE id = ?
    `);
    moved.forEach((m) => revertPlayer.run(m.id));

    /* Novo jogo = nova janela de mercado: todos os jogadores voltam a poder
       ser transferidos, mesmo os que não mudaram de clube. */
    db.prepare('UPDATE players SET transferred_in_window = 0').run();

    /* Garante que nenhum jogador fica listado para venda, mesmo que já
       estivesse no clube de origem. */
    db.prepare("UPDATE players SET is_listed = 0, asking_price = NULL WHERE is_listed = 1 OR asking_price IS NOT NULL").run();

    /* 2. Limpa toda a atividade do mercado de transferências e a caixa de entrada */
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM contract_offers').run();
    db.prepare('DELETE FROM transfer_offers').run();
    /* market_news alimenta a tab "Mercado" (jornal de notícias) — tinha ficado
       de fora, por isso as notícias de uma partida anterior continuavam a
       aparecer mesmo depois de "apagar jogo guardado". */
    db.prepare('DELETE FROM market_news').run();

    /* 2b. Limpa as atividades diárias e os amigáveis do save anterior.
       Sem isto, ao repor o calendário para o dia inicial (abaixo) o jogo
       encontrava logo um registo de team_activity_log já feito nesse
       mesmo dia num save anterior — ficando "preso" nesse treino desde o
       primeiro dia — e a lista de amigáveis continuava a mostrar convites,
       jogos e resultados de saves anteriores. friendly_player_stats
       apaga-se sozinha em cascata (ON DELETE CASCADE) quando as linhas de
       club_friendlies são removidas. */
    db.prepare('DELETE FROM team_activity_log').run();
    db.prepare('DELETE FROM club_friendlies').run();

    /* Remove também o resumo "Amigáveis" acumulado no perfil de cada
       jogador (season_stats_json) — golos/assistências/nota de amigáveis
       de um save anterior não devem continuar a contar para a média de um
       save novo. As restantes linhas de estatísticas (época oficial, etc.)
       mantêm-se como estavam. */
    const playersWithStats = db.prepare("SELECT id, season_stats_json FROM players WHERE season_stats_json LIKE '%Amig%'").all();
    const stripFriendlyRow = db.prepare('UPDATE players SET season_stats_json = ? WHERE id = ?');
    playersWithStats.forEach((p) => {
      let rows;
      try { rows = JSON.parse(p.season_stats_json || '[]'); } catch { rows = []; }
      if (!Array.isArray(rows)) return;
      const filtered = rows.filter((r) => r.competition !== FRIENDLY_COMPETITION_NAME);
      if (filtered.length !== rows.length) {
        stripFriendlyRow.run(JSON.stringify(filtered), p.id);
      }
    });

    /* 3. Repõe o calendário ao dia inicial */
    db.prepare("UPDATE game_state SET current_date = '2026-07-01' WHERE id = 1").run();

    /* 4. Repõe os orçamentos de todas as equipas aos valores da seed,
          e desmarca qual delas era controlada pelo utilizador — a próxima
          equipa escolhida volta a reivindicar isto (ver /claim-team). */
    const teams = db.prepare('SELECT id, reputation_stars, financial_tier FROM teams').all();
    const updateBudget = db.prepare(`
      UPDATE teams SET balance = @balance, wage_budget = @wage_budget,
        transfer_budget = @transfer_budget, is_user_controlled = 0, updated_at = datetime('now')
      WHERE id = @id
    `);
    teams.forEach((t) => {
      const budgets = computeBudgets(t.reputation_stars, t.financial_tier);
      updateBudget.run({ ...budgets, id: t.id });
    });

    return { players_revertidos: moved.length, equipas_repostas: teams.length };
  });

  const summary = resetAll();
  res.json({ ok: true, ...summary });
});

/* ---------- POST /api/game/claim-team — marca a equipa do utilizador ----------
   O dashboard chama isto sempre que carrega, para que o servidor saiba qual
   das 15 equipas é a "minha equipa" (as restantes são geridas pelo jogo).
   Isto é o que permite ao mercado de transferências pedir a MINHA aprovação
   antes de vender um jogador meu, em vez de concluir a venda sozinho. */
router.post('/claim-team', (req, res) => {
  const { team_id } = req.body;
  if (!team_id) return res.status(400).json({ error: 'É preciso indicar team_id' });

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const claim = db.transaction(() => {
    db.prepare('UPDATE teams SET is_user_controlled = 0 WHERE is_user_controlled = 1 AND id != ?').run(team_id);
    db.prepare('UPDATE teams SET is_user_controlled = 1 WHERE id = ?').run(team_id);
  });
  claim();

  res.json({ ok: true, team_id: Number(team_id) });
});

/* ---------- GET /api/game/state — data atual do calendário ---------- */
router.get('/state', (req, res) => {
  res.json(db.prepare('SELECT * FROM game_state WHERE id = 1').get());
});

/* ---------- Lista de transferências: interesse dos clubes por dia ----------
   Um clube só se interessa por um jogador se a reputação do clube for
   compatível com o nível do jogador (não anda atrás de qualquer um) e
   se conseguir pagar o valor pedido. */
function reputationCompatible(buyerReputation, playerQuality) {
  return Math.abs(buyerReputation - playerQuality) <= 1.1;
}

/* Lê um número aproximado de um texto de salário tipo "£41.5K p/s" ou "£3.000 p/s". */
function parseWageAmount(text) {
  const match = String(text || '').match(/[\d]+(?:[.,]\d+)?/);
  if (!match) return 3000;
  const num = parseFloat(match[0].replace(',', '.'));
  const isThousands = /K/i.test(text || '');
  const value = isThousands ? num * 1000 : num;
  return Number.isFinite(value) && value > 0 ? value : 3000;
}

/* Data atual do jogo (calendário), NUNCA a data real do computador — o
   calendário do jogo tem de ficar sempre coerente com a data de fim de
   contrato e outras contas de data, mesmo que a carreira já vá muito à
   frente da data real. */
function currentGameDateObj() {
  const state = db.prepare('SELECT current_date FROM game_state WHERE id = 1').get();
  return new Date(`${state.current_date}T00:00:00`);
}
function computeContractEndText(years = 3) {
  const end = currentGameDateObj();
  end.setFullYear(end.getFullYear() + years);
  return `${end.getDate()}/${end.getMonth() + 1}/${end.getFullYear()}`;
}

/* ---------- Mensagem de interesse ----------
   Antes de QUALQUER equipa avançar com uma proposta por um jogador, tem de
   entrar uma mensagem a avisar que essa equipa está interessada — só depois
   é que a proposta em si aparece. Vai para a caixa de entrada do clube
   vendedor (se for o utilizador) e fica sempre registada no jornal do
   mercado, para as jogadas entre equipas geridas pelo jogo também ficarem
   visíveis. */
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

/* ---------- Decisão do próprio jogador ----------
   Um clube ter combinado o valor da transferência com o clube vendedor não significa
   que o jogador aceite mudar-se: compara a reputação do clube comprador com a do
   vendedor e o salário que estaria disposto a aceitar, tal como acontece nas
   propostas de contrato manuais. Isto evita que "aceitar uma proposta" signifique
   sempre uma transferência garantida. */
function decidePlayerJoins(player, buyerTeam, sellerTeam) {
  const currentWage = parseWageAmount(player.wage_text);
  /* Normalmente o jogador só pede um salário igual ou ligeiramente melhor do
     que já tem — não uma subida enorme. */
  const wageOffer = Math.round(currentWage * (1.0 + Math.random() * 0.15));
  const repDelta = (buyerTeam.reputation_stars - (sellerTeam?.reputation_stars ?? buyerTeam.reputation_stars)) / 5;
  const wageFactor = Math.max(-0.3, Math.min(0.5, ((wageOffer / currentWage) - 1) * 0.4));
  const luck = (Math.random() * 0.2) - 0.1;
  const score = (repDelta * 0.55) + wageFactor + luck;
  return { accepted: score > 0, wageOffer: Math.max(wageOffer, currentWage) };
}

/* ---------- Necessidades do plantel, posição a posição ----------
   Para as contratações entre clubes geridos pelo jogo deixarem de ser
   praticamente ao acaso: um clube com poucos jogadores numa posição (ex:
   só 1 lateral esquerdo) fica com prioridade muito maior para comprar um
   jogador dessa posição do que um clube que já está bem servido nela.
   Usa-se só a posição PRINCIPAL de cada jogador (o código antes da
   primeira "/" em position_code — ver getSelectedPositions() em
   gestaoJogadores.js, que constrói position_code assim). */
const POSITION_TARGET_MIN = {
  GR: 2,
  DD: 2, DE: 2, DC: 3, L: 1,
  MCD: 2, MC: 2, MCO: 1, MOD: 1, MOE: 1, ME: 1, MD: 1,
  PL: 2, AD: 1, AE: 1, ED: 1, EE: 1,
};
const DEFAULT_POSITION_TARGET = 2;

function getMainPositionCode(positionCodeText) {
  return String(positionCodeText || '').split('/')[0].trim().toUpperCase();
}

/* Conta quantos jogadores de cada posição principal uma equipa já tem. */
function loadSquadPositionCounts(teamId) {
  const rows = db.prepare('SELECT position_code FROM players WHERE team_id = ?').all(teamId);
  const counts = {};
  rows.forEach((r) => {
    const code = getMainPositionCode(r.position_code);
    if (!code) return;
    counts[code] = (counts[code] || 0) + 1;
  });
  return counts;
}

/* Cache válida só durante um avanço de dia (advance): evita reler a base de
   dados para a mesma equipa vezes sem conta, e é atualizada em memória
   sempre que uma transferência se conclui (ver applyNeedsTransfer), para
   que o resto do tick veja logo o plantel correto de ambos os clubes. */
function getSquadNeeds(cache, teamId) {
  if (!cache.has(teamId)) cache.set(teamId, loadSquadPositionCounts(teamId));
  return cache.get(teamId);
}

/* Quanto maior o valor devolvido, mais urgente é a necessidade daquela
   posição para a equipa — 0 significa que já tem jogadores suficientes. */
function positionNeedScore(counts, code) {
  if (!code) return 0;
  const target = POSITION_TARGET_MIN[code] ?? DEFAULT_POSITION_TARGET;
  const have = counts[code] || 0;
  return Math.max(0, target - have);
}

function applyNeedsTransfer(cache, code, fromTeamId, toTeamId) {
  if (!code) return;
  if (fromTeamId != null) {
    const fromCounts = getSquadNeeds(cache, fromTeamId);
    fromCounts[code] = Math.max(0, (fromCounts[code] || 0) - 1);
  }
  if (toTeamId != null) {
    const toCounts = getSquadNeeds(cache, toTeamId);
    toCounts[code] = (toCounts[code] || 0) + 1;
  }
}

function runTransferListTick(squadNeedsCache) {
  if (!db.isMarketWindowOpen()) return { sales: [], pendingApprovals: [] };

  const listed = db.prepare(`
    SELECT * FROM players
    WHERE is_listed = 1 AND team_id IS NOT NULL AND asking_price > 0
      AND (transferred_in_window IS NULL OR transferred_in_window = 0)
  `).all();
  const sales = [];
  const pendingApprovals = [];

  listed.forEach((player) => {
    /* Nem todos os dias há movimento no mercado para um jogador listado — na
       maioria dos dias não acontece nada, tal como num mercado real. Estas
       probabilidades foram reduzidas para que propostas por um jogador sejam
       um acontecimento pouco frequente, não diário. */
    if (Math.random() > 0.16) return;

    const sellerTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(player.team_id);
    if (!sellerTeam) return;

    const quality = player.current_ability_stars ?? 2.5;
    const playerCode = getMainPositionCode(player.position_code);
    const candidates = db.prepare('SELECT * FROM teams WHERE id != ?').all(player.team_id)
      .filter((t) => reputationCompatible(t.reputation_stars, quality))
      .filter((t) => t.transfer_budget >= player.asking_price);
    if (!candidates.length) return;

    /* Contratações inteligentes: a chance de um clube se interessar sobe
       bastante quando lhe falta gente naquela posição, e o comprador
       escolhido de entre os interessados é sempre o que tem mais
       necessidade dela (não só o de maior reputação). */
    const scored = candidates.map((t) => {
      const need = positionNeedScore(getSquadNeeds(squadNeedsCache, t.id), playerCode);
      const chance = Math.min(0.6, 0.06 + need * 0.22);
      return { team: t, need, chance };
    });
    const interested = scored.filter((s) => Math.random() < s.chance);
    if (!interested.length) return;

    interested.sort((a, b) => (b.need - a.need) || (b.team.reputation_stars - a.team.reputation_stars));
    const buyer = interested[0].team;
    const amount = Math.min(buyer.transfer_budget, Math.round(player.asking_price * (1 + Math.random() * 0.15)));
    const amountFmt = `£${Math.round(amount).toLocaleString('pt-PT')}`;

    if (sellerTeam.is_user_controlled) {
      logInterestMessage(buyer, sellerTeam, player);

      const offerInfo = db.prepare(`
        INSERT INTO transfer_offers (player_id, buyer_team_id, seller_team_id, offer_amount, status)
        VALUES (@player_id, @buyer_team_id, @seller_team_id, @offer_amount, 'pending')
      `).run({ player_id: player.id, buyer_team_id: buyer.id, seller_team_id: sellerTeam.id, offer_amount: amount });

      const msgInfo = db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id, related_team_id, transfer_offer_id)
        VALUES (@team_id, 'incoming_offer_pending', @title, @body, @player_id, @related_team_id, @transfer_offer_id)
      `).run({
        team_id: sellerTeam.id,
        title: `Proposta recebida: ${player.name}`,
        body: `O ${buyer.name} quer comprar ${player.name} por ${amountFmt}. Aceita ou recusa a proposta.`,
        player_id: player.id,
        related_team_id: buyer.id,
        transfer_offer_id: offerInfo.lastInsertRowid,
      });

      pendingApprovals.push({
        player_id: player.id, player_name: player.name, buyer_team: buyer.name,
        amount, transfer_offer_id: offerInfo.lastInsertRowid, message_id: msgInfo.lastInsertRowid,
      });

      db.logMarketNews({
        type: 'incoming_offer_pending',
        headline: `${buyer.name} propõe-se a comprar ${player.name}`,
        body: `O ${buyer.name} enviou uma proposta de ${amountFmt} ao ${sellerTeam.name} por ${player.name}. O negócio está pendente de resposta.`,
        player_name: player.name, player_photo: player.photo_path,
        from_team_name: sellerTeam.name, from_team_shield: sellerTeam.shield_path,
        to_team_name: buyer.name, to_team_shield: buyer.shield_path,
        amount,
      });
      return;
    }

    /* ---------- Venda automática entre duas equipas geridas pelo jogo ----------
       O clube vendedor aceita o valor, mas o jogador ainda tem de querer mudar-se. */
    logInterestMessage(buyer, sellerTeam, player);

    const decision = decidePlayerJoins(player, buyer, sellerTeam);
    if (!decision.accepted) {
      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
        VALUES (@team_id, 'transfer_player_refused', @title, @body, @player_id, @related_team_id)
      `).run({
        team_id: sellerTeam.id,
        title: `Transferência caiu: ${player.name}`,
        body: `O ${buyer.name} tinha um acordo de ${amountFmt} por ${player.name}, mas o próprio jogador recusou a mudança de clube. A transferência não se realizou.`,
        player_id: player.id,
        related_team_id: buyer.id,
      });

      db.logMarketNews({
        type: 'transfer_player_refused',
        headline: `${player.name} recusa mudar-se para o ${buyer.name}`,
        body: `O ${buyer.name} tinha um acordo de ${amountFmt} com o ${sellerTeam.name} por ${player.name}, mas o próprio jogador recusou a mudança de clube.`,
        player_name: player.name, player_photo: player.photo_path,
        from_team_name: sellerTeam.name, from_team_shield: sellerTeam.shield_path,
        to_team_name: buyer.name, to_team_shield: buyer.shield_path,
      });
      return;
    }

    const contractEndText = computeContractEndText();

    db.prepare(`
      UPDATE players SET team_id = @team_id, is_listed = 0, asking_price = NULL,
        club_status = 'Titular Regular', wage_text = @wage_text, contract_end = @contract_end,
        transferred_in_window = 1, updated_at = datetime('now')
      WHERE id = @player_id
    `).run({
      team_id: buyer.id, player_id: player.id,
      wage_text: `£${Number(decision.wageOffer).toLocaleString('pt-PT')} p/s`, contract_end: contractEndText,
    });

    db.prepare('UPDATE teams SET balance = balance + @amount, transfer_budget = transfer_budget + @amount, updated_at = datetime(\'now\') WHERE id = @id')
      .run({ amount, id: sellerTeam.id });
    db.prepare('UPDATE teams SET balance = balance - @amount, transfer_budget = transfer_budget - @amount, updated_at = datetime(\'now\') WHERE id = @id')
      .run({ amount, id: buyer.id });
    applyNeedsTransfer(squadNeedsCache, playerCode, sellerTeam.id, buyer.id);

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, player_id, related_team_id)
      VALUES (@team_id, 'player_sold', @title, @body, @player_id, @related_team_id)
    `).run({
      team_id: sellerTeam.id,
      title: `Jogador vendido: ${player.name}`,
      body: `O ${buyer.name} propôs ${amountFmt} por ${player.name} — igual ou acima do valor que pediste, e o jogador aceitou a mudança. A transferência foi concluída.`,
      player_id: player.id,
      related_team_id: buyer.id,
    });

    db.logMarketNews({
      type: 'transfer_completed',
      headline: `${player.name} muda-se para o ${buyer.name}`,
      body: `${player.name} foi transferido do ${sellerTeam.name} para o ${buyer.name} por ${amountFmt}.`,
      player_name: player.name, player_photo: player.photo_path,
      from_team_name: sellerTeam.name, from_team_shield: sellerTeam.shield_path,
      to_team_name: buyer.name, to_team_shield: buyer.shield_path,
      amount,
    });

    sales.push({ player_id: player.id, player_name: player.name, buyer_team: buyer.name, amount });
  });

  return { sales, pendingApprovals };
}

/* Estimativa simples de valor de mercado, só para decidir se um negócio entre
   duas equipas geridas pelo jogo faz sentido financeiramente (não usa o texto
   já preenchido no perfil, ao contrário da estimativa em routes/transfers.js).

   IMPORTANTE — escala: os orçamentos de transferência das equipas (ver
   computeBudgets acima) andam entre ~£33.000 (clube "Muito Pobre" com baixa
   reputação) e ~£2.100.000 (clube "Muito Rico" com reputação máxima). A
   fórmula anterior (ability * 12.000.000) dava valores de ~£12M a ~£60M —
   30x acima do orçamento do clube mais rico do jogo. Como candidates exige
   `t.transfer_budget >= referenceValue * tierRatio`, NENHUM clube passava
   nunca nesse filtro, e por isso nenhuma equipa geria pelo jogo comprava
   fosse o que fosse. Este valor por estrela foi escolhido para que jogadores
   de topo custem uma fatia significativa (mas pagável) do orçamento de um
   clube rico, e jogadores fracos sejam acessíveis mesmo a clubes pobres. */
function estimateScoutingValue(player) {
  const ability = player.current_ability_stars ?? 2.5;
  return Math.round(ability * 60_000);
}

/* ---------- Atividade de transferências entre clubes geridos pelo jogo ----------
   Além da lista de transferências (que só mexe em jogadores que alguém pôs à
   venda), o mercado tem de ter vida própria: equipas geridas pelo jogo também
   compram e vendem jogadores entre si todos os dias, sem envolver o utilizador
   nem precisar que o jogador esteja listado. Fica tudo registado no jornal do
   mercado (market_news), mesmo não indo à caixa de entrada de ninguém. */
function runAiScoutingTick(squadNeedsCache) {
  if (!db.isMarketWindowOpen()) return { moves: [], pendingApprovals: [] };

  const userTeam = db.prepare('SELECT id FROM teams WHERE is_user_controlled = 1').get();
  const userTeamId = userTeam ? userTeam.id : null;

  const allTeams = db.prepare('SELECT * FROM teams').all();
  const aiTeams = allTeams.filter((t) => String(t.id) !== String(userTeamId));
  const teamsById = new Map(allTeams.map((t) => [t.id, t]));

  /* IMPORTANTE: ao contrário da versão anterior, isto já não se limita aos
     jogadores de clubes geridos pelo jogo — um clube pode fazer uma
     proposta por QUALQUER jogador não listado, incluindo os do utilizador.
     Só os jogadores já listados (is_listed = 1) ficam de fora daqui, porque
     esses têm o seu próprio circuito com muito mais frequência de propostas
     (ver runTransferListTick) — estar listado só significa "aparecem mais
     propostas", nunca foi suposto ser um requisito para receber alguma. */
  const eligiblePlayers = db.prepare(`
    SELECT * FROM players
    WHERE team_id IS NOT NULL AND is_listed = 0
      AND (transferred_in_window IS NULL OR transferred_in_window = 0)
  `).all();

  const moves = [];
  const pendingApprovals = [];

  eligiblePlayers.forEach((player) => {
    if (Math.random() > 0.035) return; // continua a ser raro por jogador, mas mais visível ao fim de vários dias

    const sellerTeam = teamsById.get(player.team_id);
    if (!sellerTeam) return;

    const quality = player.current_ability_stars ?? 2.5;
    const playerCode = getMainPositionCode(player.position_code);
    const referenceValue = estimateScoutingValue(player);
    const tierRatio = TIER_ACCEPT_RATIO_SCOUT[sellerTeam.financial_tier] ?? 0.70;

    /* IMPORTANTE: o orçamento de cada equipa (transfer_budget/balance) é lido
       diretamente dos objetos em aiTeams, que são atualizados em memória logo
       a seguir a cada negócio fechado (ver abaixo). Isto garante que uma
       equipa nunca gasta, no mesmo dia, mais do que o orçamento que ainda lhe
       resta — mesmo que compre mais do que um jogador nesse dia. Os
       compradores possíveis continuam a ser só clubes geridos pelo jogo:
       o utilizador nunca é escolhido automaticamente como comprador aqui —
       ele propõe através das suas próprias ações no perfil do jogador. */
    const candidates = aiTeams
      .filter((t) => t.id !== sellerTeam.id)
      .filter((t) => reputationCompatible(t.reputation_stars, quality))
      .filter((t) => t.transfer_budget >= referenceValue * tierRatio);
    if (!candidates.length) return;

    /* Contratações inteligentes: um clube a quem falte gente naquela posição
       (ex: sem laterais esquerdos) tem prioridade muito maior do que um
       clube que já tem essa posição bem coberta — não é só quem tem mais
       reputação a levar sempre o jogador. */
    const scored = candidates.map((t) => {
      const need = positionNeedScore(getSquadNeeds(squadNeedsCache, t.id), playerCode);
      const chance = Math.min(0.85, 0.15 + need * 0.3);
      return { team: t, need, chance };
    });
    const interested = scored.filter((s) => Math.random() < s.chance);
    if (!interested.length) return;

    interested.sort((a, b) => (b.need - a.need) || (b.team.reputation_stars - a.team.reputation_stars));
    const buyer = interested[0].team;
    const amount = Math.min(buyer.transfer_budget, Math.round(referenceValue * tierRatio * (0.95 + Math.random() * 0.2)));
    if (amount <= 0 || amount > buyer.transfer_budget) return;
    const amountFmt = `£${Math.round(amount).toLocaleString('pt-PT')}`;

    /* Se o vendedor for o clube do utilizador, o negócio não se conclui
       sozinho — fica pendente de resposta, tal como as propostas para
       jogadores listados (ver runTransferListTick). A diferença é só que
       este jogador nunca foi posto à venda. */
    if (sellerTeam.is_user_controlled) {
      logInterestMessage(buyer, sellerTeam, player);

      const offerInfo = db.prepare(`
        INSERT INTO transfer_offers (player_id, buyer_team_id, seller_team_id, offer_amount, status)
        VALUES (@player_id, @buyer_team_id, @seller_team_id, @offer_amount, 'pending')
      `).run({ player_id: player.id, buyer_team_id: buyer.id, seller_team_id: sellerTeam.id, offer_amount: amount });

      const msgInfo = db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id, related_team_id, transfer_offer_id)
        VALUES (@team_id, 'incoming_offer_pending', @title, @body, @player_id, @related_team_id, @transfer_offer_id)
      `).run({
        team_id: sellerTeam.id,
        title: `Proposta recebida: ${player.name}`,
        body: `O ${buyer.name} quer comprar ${player.name} por ${amountFmt}, mesmo não estando na lista de transferências. Aceita ou recusa a proposta.`,
        player_id: player.id,
        related_team_id: buyer.id,
        transfer_offer_id: offerInfo.lastInsertRowid,
      });

      pendingApprovals.push({
        player_id: player.id, player_name: player.name, buyer_team: buyer.name,
        amount, transfer_offer_id: offerInfo.lastInsertRowid, message_id: msgInfo.lastInsertRowid,
      });

      db.logMarketNews({
        type: 'incoming_offer_pending',
        headline: `${buyer.name} propõe-se a comprar ${player.name}`,
        body: `O ${buyer.name} enviou uma proposta de ${amountFmt} ao ${sellerTeam.name} por ${player.name}, que não estava à venda. O negócio está pendente de resposta.`,
        player_name: player.name, player_photo: player.photo_path,
        from_team_name: sellerTeam.name, from_team_shield: sellerTeam.shield_path,
        to_team_name: buyer.name, to_team_shield: buyer.shield_path,
        amount,
      });
      return;
    }

    logInterestMessage(buyer, sellerTeam, player);

    const decision = decidePlayerJoins(player, buyer, sellerTeam);

    if (!decision.accepted) {
      db.logMarketNews({
        type: 'transfer_player_refused',
        headline: `${player.name} recusa mudar-se para o ${buyer.name}`,
        body: `O ${buyer.name} chegou a acordo de ${amountFmt} com o ${sellerTeam.name} por ${player.name}, mas o jogador recusou a mudança de clube.`,
        player_name: player.name, player_photo: player.photo_path,
        from_team_name: sellerTeam.name, from_team_shield: sellerTeam.shield_path,
        to_team_name: buyer.name, to_team_shield: buyer.shield_path,
      });
      return;
    }

    const contractEndText = computeContractEndText();

    db.prepare(`
      UPDATE players SET team_id = @team_id, is_listed = 0, asking_price = NULL,
        club_status = 'Titular Regular', wage_text = @wage_text, contract_end = @contract_end,
        transferred_in_window = 1, updated_at = datetime('now')
      WHERE id = @player_id
    `).run({
      team_id: buyer.id, player_id: player.id,
      wage_text: `£${Number(decision.wageOffer).toLocaleString('pt-PT')} p/s`, contract_end: contractEndText,
    });

    db.prepare('UPDATE teams SET balance = balance + @amount, transfer_budget = transfer_budget + @amount, updated_at = datetime(\'now\') WHERE id = @id')
      .run({ amount, id: sellerTeam.id });
    db.prepare('UPDATE teams SET balance = balance - @amount, transfer_budget = transfer_budget - @amount, updated_at = datetime(\'now\') WHERE id = @id')
      .run({ amount, id: buyer.id });

    /* Atualiza os objetos em memória (mesma referência dentro de aiTeams) para
       que o resto deste tick veja logo o orçamento correto de ambas as
       equipas, em vez de trabalhar com valores desatualizados. */
    sellerTeam.balance += amount;
    sellerTeam.transfer_budget += amount;
    buyer.balance -= amount;
    buyer.transfer_budget -= amount;
    applyNeedsTransfer(squadNeedsCache, playerCode, sellerTeam.id, buyer.id);

    db.logMarketNews({
      type: 'transfer_completed',
      headline: `${player.name} muda-se para o ${buyer.name}`,
      body: `${player.name} foi transferido do ${sellerTeam.name} para o ${buyer.name} por ${amountFmt}.`,
      player_name: player.name, player_photo: player.photo_path,
      from_team_name: sellerTeam.name, from_team_shield: sellerTeam.shield_path,
      to_team_name: buyer.name, to_team_shield: buyer.shield_path,
      amount,
    });

    moves.push({ player_id: player.id, player_name: player.name, from_team: sellerTeam.name, to_team: buyer.name, amount });
  });

  return { moves, pendingApprovals };
}

/* Mesma tabela de "quão facilmente um clube vende abaixo do valor" usada em
   routes/transfers.js — duplicada aqui para manter os dois ficheiros independentes. */
const TIER_ACCEPT_RATIO_SCOUT = {
  'Muito Rico': 0.95, 'Rico': 0.85, 'Medio': 0.70, 'Pobre': 0.55, 'Muito Pobre': 0.40,
};

/* ---------- Amigáveis: simulação do resultado quando o dia marcado chega ----------
   Um resultado simples baseado na reputação de cada equipa (+ vantagem de
   jogar em casa) e alguma aleatoriedade — não é uma simulação jogo a jogo,
   só o suficiente para o amigável ter um marcador plausível. */
function simulateFriendlyGoals(attackStrength, defendStrength) {
  const lambda = Math.max(0.35, 1.15 + (attackStrength - defendStrength) * 0.3);
  let goals = 0;
  for (let i = 0; i < 8; i += 1) {
    if (Math.random() < lambda / (i + 1.7)) goals += 1;
  }
  return Math.min(goals, 7);
}

/* ---------- Quem marca e quem assiste num amigável ----------
   Classifica cada jogador do onze inicial numa das 4 categorias pedidas a
   partir do código da posição usado na Tática (ver FORMATIONS em
   dashboard.js): GR fica de fora (guarda-redes não entra no sorteio de
   golo/assistência). */
function classifyPositionCode(code) {
  const c = String(code || '').toUpperCase();
  if (c.startsWith('GR')) return 'GR';
  if (c === 'PL') return 'PL';
  if (c.startsWith('MO') || c === 'MCO' || c.startsWith('ED') || c.startsWith('EE')) return 'MO';
  if (c.startsWith('M')) return 'MED';
  return 'DEF';
}

/* Percentagens pedidas: Defesas 15%, Médios 20%, Médios Ofensivos 30%,
   Pontas de Lança 35% de hipótese de marcar; Defesas 10%, Médios 30%,
   Médios Ofensivos 35%, Pontas de Lança 20% de hipótese de assistir. */
const SCORE_WEIGHT = { DEF: 15, MED: 20, MO: 30, PL: 35, GR: 0 };
const ASSIST_WEIGHT = { DEF: 10, MED: 30, MO: 35, PL: 20, GR: 0 };

function pickWeighted(candidates, weightMap) {
  const pool = candidates.filter((p) => (weightMap[p.category] || 0) > 0);
  if (!pool.length) return null;
  const total = pool.reduce((sum, p) => sum + weightMap[p.category], 0);
  let roll = Math.random() * total;
  for (const p of pool) {
    roll -= weightMap[p.category];
    if (roll <= 0) return p;
  }
  return pool[pool.length - 1];
}

/* Onze inicial guardado na Tática do clube; se a equipa nunca guardou uma
   tática (ou guardou menos de 11 jogadores), completa com o resto do
   plantel ordenado por nível, para o amigável ter sempre jogadores a
   marcar/assistir/receber nota. */
function resolveMatchLineup(teamId) {
  const squad = db.prepare('SELECT id, name, position_tag, position_code FROM players WHERE team_id = ?')
    .all(teamId)
    .map((p) => ({ ...p, category: classifyPositionCode(p.position_code) }));
  if (!squad.length) return [];

  const tactic = db.prepare('SELECT lineup_json FROM tactics WHERE team_id = ?').get(teamId);
  const chosen = [];
  const usedIds = new Set();

  if (tactic) {
    let lineupEntries = [];
    try { lineupEntries = JSON.parse(tactic.lineup_json || '[]'); } catch { lineupEntries = []; }
    lineupEntries.forEach((entry) => {
      const player = squad.find((p) => p.id === entry.player_id);
      if (player && !usedIds.has(player.id)) {
        chosen.push({ ...player, category: classifyPositionCode(entry.code || player.position_code) });
        usedIds.add(player.id);
      }
    });
  }

  if (chosen.length < 11) {
    squad
      .filter((p) => !usedIds.has(p.id))
      .forEach((p) => {
        if (chosen.length < 11) { chosen.push(p); usedIds.add(p.id); }
      });
  }

  return chosen.slice(0, 11);
}

/* Guarda a nota + golos/assistências deste amigável no perfil do jogador:
   acumula na linha "Amigáveis (Não Oficial)" de season_stats_json, com a
   Média a ser sempre a média de TODOS os amigáveis já jogados. */
function applyFriendlyStatsToPlayer(playerId, goals, assists, rating) {
  const player = db.prepare('SELECT season_stats_json FROM players WHERE id = ?').get(playerId);
  if (!player) return;

  let rows;
  try { rows = JSON.parse(player.season_stats_json || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];

  let row = rows.find((r) => r.competition === FRIENDLY_COMPETITION_NAME);
  if (!row) {
    row = { competition: FRIENDLY_COMPETITION_NAME, j: 0, g: 0, a: 0, xg: 0, pen: 0, mdp: 0, am: 0, verm: 0, media: '-' };
    rows.push(row);
  }

  const prevJ = Number(row.j) || 0;
  const prevMedia = parseFloat(row.media);
  const prevMediaTotal = Number.isFinite(prevMedia) ? prevMedia * prevJ : 0;

  row.j = prevJ + 1;
  row.g = (Number(row.g) || 0) + goals;
  row.a = (Number(row.a) || 0) + assists;
  row.media = ((prevMediaTotal + rating) / row.j).toFixed(2);

  db.prepare("UPDATE players SET season_stats_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(rows), playerId);
}

/* Simula os eventos (golos + assistências) e as notas de um amigável já
   com resultado definido, guarda tudo em friendly_player_stats e atualiza
   o perfil de cada jogador que participou. */
function simulateFriendlyMatchDetails(friendlyId, homeTeamId, awayTeamId, homeGoals, awayGoals) {
  const sides = [
    { teamId: homeTeamId, goalsFor: homeGoals, goalsAgainst: awayGoals },
    { teamId: awayTeamId, goalsFor: awayGoals, goalsAgainst: homeGoals },
  ];

  const insertStat = db.prepare(`
    INSERT INTO friendly_player_stats (friendly_id, team_id, player_id, player_name, position_tag, goals, assists, rating)
    VALUES (@friendly_id, @team_id, @player_id, @player_name, @position_tag, @goals, @assists, @rating)
  `);

  sides.forEach(({ teamId, goalsFor, goalsAgainst }) => {
    const lineup = resolveMatchLineup(teamId);
    if (!lineup.length) return;

    const outfield = lineup.filter((p) => p.category !== 'GR');
    const tally = new Map(lineup.map((p) => [p.id, { goals: 0, assists: 0 }]));

    for (let g = 0; g < goalsFor; g += 1) {
      const scorer = pickWeighted(outfield, SCORE_WEIGHT);
      if (scorer) tally.get(scorer.id).goals += 1;

      if (scorer && Math.random() < 0.8) {
        const assistCandidates = outfield.filter((p) => p.id !== scorer.id);
        const assister = pickWeighted(assistCandidates, ASSIST_WEIGHT);
        if (assister) tally.get(assister.id).assists += 1;
      }
    }

    const resultBonus = goalsFor > goalsAgainst ? 0.3 : goalsFor < goalsAgainst ? -0.2 : 0.1;

    lineup.forEach((player) => {
      const { goals, assists } = tally.get(player.id);
      let rating = 6.0 + resultBonus + (Math.random() * 0.6 - 0.3) + goals * 0.8 + assists * 0.4;
      if (player.category === 'GR') rating += goalsAgainst === 0 ? 0.5 : (goalsAgainst >= 3 ? -0.4 : 0);
      rating = Math.max(4.0, Math.min(10.0, rating));

      insertStat.run({
        friendly_id: friendlyId, team_id: teamId, player_id: player.id,
        player_name: player.name, position_tag: player.position_tag || '',
        goals, assists, rating: Number(rating.toFixed(2)),
      });

      applyFriendlyStatsToPlayer(player.id, goals, assists, Number(rating.toFixed(2)));
    });
  });
}

function runFriendliesTick(nextDateStr) {
  const due = db.prepare(`
    SELECT f.*, h.name AS home_name, h.reputation_stars AS home_reputation, h.is_user_controlled AS home_user,
           a.name AS away_name, a.reputation_stars AS away_reputation, a.is_user_controlled AS away_user
    FROM club_friendlies f
    JOIN teams h ON h.id = f.home_team_id
    JOIN teams a ON a.id = f.away_team_id
    WHERE f.status = 'accepted' AND f.match_date = ?
  `).all(nextDateStr);

  const results = [];

  due.forEach((f) => {
    const homeGoals = simulateFriendlyGoals(f.home_reputation + 0.25, f.away_reputation);
    const awayGoals = simulateFriendlyGoals(f.away_reputation, f.home_reputation + 0.25);

    db.prepare(`
      UPDATE club_friendlies SET status = 'played', home_score = ?, away_score = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(homeGoals, awayGoals, f.id);

    simulateFriendlyMatchDetails(f.id, f.home_team_id, f.away_team_id, homeGoals, awayGoals);

    const scoreText = `${f.home_name} ${homeGoals}-${awayGoals} ${f.away_name}`;
    const outcomeFor = (isHome) => {
      const us = isHome ? homeGoals : awayGoals;
      const them = isHome ? awayGoals : homeGoals;
      if (us > them) return 'Vitória';
      if (us < them) return 'Derrota';
      return 'Empate';
    };

    [
      { userFlag: f.home_user, teamId: f.home_team_id, opponentName: f.away_name, isHome: true },
      { userFlag: f.away_user, teamId: f.away_team_id, opponentName: f.home_name, isHome: false },
    ].forEach(({ userFlag, teamId, opponentName, isHome }) => {
      if (!userFlag) return;
      const result = outcomeFor(isHome);
      db.prepare(`
        INSERT INTO messages (team_id, type, title, body)
        VALUES (@team_id, 'friendly_played', @title, @body)
      `).run({
        team_id: teamId,
        title: `${result === 'Vitória' ? '🏆' : result === 'Derrota' ? '📉' : '🤝'} Amigável: ${result.toLowerCase()} contra o ${opponentName}`,
        body: `Resultado final: ${scoreText}.`,
      });
    });

    results.push({ id: f.id, home_team: f.home_name, away_team: f.away_name, home_score: homeGoals, away_score: awayGoals });
  });

  return results;
}

/* ---------- POST /api/game/advance — avança 1 dia no calendário ---------- */
router.post('/advance', (req, res) => {
  const state = db.prepare('SELECT * FROM game_state WHERE id = 1').get();
  const next = new Date(`${state.current_date}T00:00:00`);
  next.setDate(next.getDate() + 1);
  const nextDateStr = next.toISOString().slice(0, 10);

  db.prepare('UPDATE game_state SET current_date = ? WHERE id = 1').run(nextDateStr);

  /* Cache partilhada das necessidades do plantel (por posição) para este
     avanço de dia — assim as duas funções abaixo veem sempre a versão mais
     atualizada do plantel de cada equipa, mesmo entre negócios do mesmo tick. */
  const squadNeedsCache = new Map();
  const { sales, pendingApprovals: pendingFromListed } = runTransferListTick(squadNeedsCache);
  const { moves: aiMoves, pendingApprovals: pendingFromScouting } = runAiScoutingTick(squadNeedsCache);
  const pendingApprovals = [...pendingFromListed, ...pendingFromScouting];
  const friendlyResults = runFriendliesTick(nextDateStr);

  res.json({ current_date: nextDateStr, sales, pending_approvals: pendingApprovals, ai_moves: aiMoves, friendly_results: friendlyResults });
});

/* ---------- GET /api/game/news — jornal do mercado (todas as movimentações) ---------- */
router.get('/news', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  res.json(db.prepare('SELECT * FROM market_news ORDER BY id DESC LIMIT ?').all(limit));
});

module.exports = router;