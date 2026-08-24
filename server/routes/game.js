/* ==========================================================
   FMcriol — Reiniciar o mundo do jogo ("Novo Jogo")
   Desfaz transferências, limpa a caixa de entrada e repõe
   os orçamentos das equipas aos valores calculados na seed.
   ========================================================== */
const express = require('express');
const db = require('../db/database');
const liveMatch = require('./liveMatch');
const league = require('./league');
const cup = require('./cup');
const transfers = require('./transfers');
const morale = require('./morale');
const { buildPostMatchReactions } = require('./matchReactions');

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

/* Nomes das linhas de season_stats_json onde se acumulam golos, assistências,
   cartões, cortes, % de passe e nota média de cada competição — ver
   db.COMPETITION_ROW_NAMES (db/database.js) e simulateFriendlyMatchDetails()
   mais abaixo. */

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

    /* 1b. Repõe TODOS os jogadores aos valores iniciais ("de fábrica") —
       condição física, forma, disciplina, felicidade e estatísticas da
       época. É o treino e os amigáveis que vão fazendo estes números
       subir/descer ao longo da carreira; sem isto, um "Novo Jogo" herdava
       os números já alterados da carreira anterior em vez de recomeçar do
       zero. Ver baseline_* em db/database.js.

       Os ATRIBUTOS INDIVIDUAIS (technical_json/set_pieces_json/mental_json/
       physical_json/goalkeeping_json) ficam de FORA de propósito: um
       jogador editado/desenvolvido à mão (ou pelo "Gerar Atributos") deve
       manter esses valores para sempre, mesmo depois de "Apagar jogo
       guardado" / "Novo Jogo" — só o resto do estado da época (forma,
       condição física, disciplina, felicidade, estatísticas) é que
       recomeça do zero. As colunas baseline_technical_json e afins
       continuam a existir na base de dados (não fazem mal a ninguém), só
       deixaram de ser aplicadas aqui. */
    const allPlayerIds = db.prepare('SELECT id FROM players').all();
    const restoreBaseline = db.prepare(`
      UPDATE players SET
        training_status = COALESCE(baseline_training_status, training_status),
        training_rating = COALESCE(baseline_training_rating, training_rating),
        fitness_status = COALESCE(baseline_fitness_status, fitness_status),
        fitness_note = COALESCE(baseline_fitness_note, fitness_note),
        happiness = COALESCE(baseline_happiness, happiness),
        positive_count = COALESCE(baseline_positive_count, positive_count),
        negative_count = COALESCE(baseline_negative_count, negative_count),
        discipline_text = COALESCE(baseline_discipline_text, discipline_text),
        discipline_note = COALESCE(baseline_discipline_note, discipline_note),
        form_text = COALESCE(baseline_form_text, form_text),
        season_stats_json = COALESCE(baseline_season_stats_json, season_stats_json),
        caps = COALESCE(baseline_caps, caps),
        international_goals = COALESCE(baseline_international_goals, international_goals),
        updated_at = datetime('now')
      WHERE id = ?
    `);
    allPlayerIds.forEach((row) => restoreBaseline.run(row.id));

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

    /* club_friendlies em cascata já limpa friendly_player_stats ligadas a
       amigáveis — mas jogos do Campeonato/Taça inteiramente entre equipas
       geridas pelo jogo não têm nenhum amigável por trás (friendly_id fica
       a NULL), por isso precisam de ser apagados aqui à parte. */
    db.prepare('DELETE FROM friendly_player_stats').run();

    /* 2b-ii. Limpa a moral do balneário do save anterior — incidentes e
       perguntas por resolver, e qualquer jogador que tivesse ficado
       afastado temporariamente (ver routes/morale.js). Também apaga o
       nome do treinador e a flag de boas-vindas, para o novo save receber
       de novo a mensagem de boas-vindas. */
    db.prepare('DELETE FROM player_incidents').run();
    db.prepare('DELETE FROM manager_questions').run();
    db.prepare("UPDATE players SET stood_down_until = NULL, stood_down_reason = NULL").run();
    db.prepare("UPDATE game_state SET manager_name = NULL, welcome_sent = 0, current_season_start = '2026-08-01' WHERE id = 1").run();

    /* Palmarés, prémios individuais e o histórico de carreira (estatísticas
       por época + títulos coletivos) também recomeçam do zero num "Novo
       Jogo" — sem isto, um jogador herdava anos de carreira de um save
       completamente diferente. */
    db.prepare('DELETE FROM trophies').run();
    db.prepare('DELETE FROM player_awards').run();
    db.prepare('DELETE FROM player_season_history').run();
    db.prepare('DELETE FROM player_trophies').run();

    /* Reuniões de transferência e empréstimos por resolver de um save
       anterior também não fazem sentido continuar. */
    db.prepare('DELETE FROM transfer_meetings').run();
    db.prepare('UPDATE players SET loan_from_team_id = NULL, loan_return_date = NULL, consent_boost = 0').run();

    /* Comissão técnica: volta toda para a bolsa de contratação disponível —
       um "Novo Jogo" começa sem nenhum adjunto/fisioterapeuta/preparador
       físico já contratado, tal como começa sem nenhum amigável marcado. */
    db.prepare('UPDATE staff SET team_id = NULL').run();

    /* 2b-iii. A Taça São Vicente recomeça do zero — sem rondas sorteadas —
       já que só volta a existir depois de o novo Campeonato acabar. */
    db.prepare('DELETE FROM cup_fixtures').run();

    /* 2c. Gera um calendário novo para o Campeonato — jornadas e datas
       novas a cada "Novo Jogo" (as equipas trocam de sorteio casa/fora),
       sempre a começar a 1 de agosto. Ver routes/league.js. */
    league.regenerateSeasonFixtures();

    /* Remove também o resumo acumulado no perfil de cada jogador
       (season_stats_json) de Amigáveis, Campeonato e Taça — golos,
       assistências, cartões, cortes e % de passe de um save anterior não
       devem continuar a contar para a média de um save novo. As restantes
       linhas de estatísticas (época oficial, carreira, etc.) mantêm-se
       como estavam. */
    const resettableRowNames = Object.values(db.COMPETITION_ROW_NAMES);
    const playersWithStats = db.prepare("SELECT id, season_stats_json FROM players").all();
    const stripFriendlyRow = db.prepare('UPDATE players SET season_stats_json = ? WHERE id = ?');
    playersWithStats.forEach((p) => {
      let rows;
      try { rows = JSON.parse(p.season_stats_json || '[]'); } catch { rows = []; }
      if (!Array.isArray(rows)) return;
      const filtered = rows.filter((r) => !resettableRowNames.includes(r.competition));
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

  try {
    const summary = resetAll();
    res.json({ ok: true, ...summary });
  } catch (err) {
    /* Antes disto, um erro aqui dentro (ex: a tabela órfã
       "player_incidents_old" — ver a migração em db/database.js) fazia o
       Express devolver um 500 em HTML sem o frontend perceber que o
       reset falhou a meio — por isso "Apagar jogo guardado"/"Novo Jogo"
       parecia não fazer nada e o save anterior continuava. Devolver um
       JSON com o erro dá ao frontend uma resposta que consegue verificar
       (res.ok) e mostrar ao treinador, em vez de falhar em silêncio. */
    console.error('Falha ao repor o jogo (POST /api/game/reset):', err);
    res.status(500).json({ error: 'Não foi possível reiniciar o jogo. Tenta novamente.', detail: err.message });
  }
});

/* ---------- POST /api/game/claim-team — marca a equipa do utilizador ----------
   O dashboard chama isto sempre que carrega, para que o servidor saiba qual
   das 15 equipas é a "minha equipa" (as restantes são geridas pelo jogo).
   Isto é o que permite ao mercado de transferências pedir a MINHA aprovação
   antes de vender um jogador meu, em vez de concluir a venda sozinho. */
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

const WELCOME_FLAVOUR = [
  'Chegas a um plantel com ambição e talento por afinar — o resto da história escreve-se em campo.',
  'O balneário aguarda o teu primeiro discurso. As expectativas são altas, mas o grupo está pronto para trabalhar.',
  'Entre a pré-época, o mercado e o primeiro dia de treinos, tens um mês inteiro para moldar a equipa à tua imagem.',
];

router.post('/claim-team', (req, res) => {
  const { team_id, manager_name } = req.body;
  if (!team_id) return res.status(400).json({ error: 'É preciso indicar team_id' });

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
  if (!team) return res.status(404).json({ error: 'Equipa não encontrada' });

  const claim = db.transaction(() => {
    db.prepare('UPDATE teams SET is_user_controlled = 0 WHERE is_user_controlled = 1 AND id != ?').run(team_id);
    db.prepare('UPDATE teams SET is_user_controlled = 1 WHERE id = ?').run(team_id);

    const state = db.prepare('SELECT * FROM game_state WHERE id = 1').get();
    const cleanName = (manager_name || '').trim();
    if (cleanName && cleanName !== state.manager_name) {
      db.prepare('UPDATE game_state SET manager_name = ? WHERE id = 1').run(cleanName);
    }

    /* Mensagem de boas-vindas — só uma vez por save, assim que soubermos o
       nome do treinador (o dashboard só o envia depois de o pedir na
       seleção de clube). */
    if (!state.welcome_sent && (cleanName || state.manager_name)) {
      const nameToUse = cleanName || state.manager_name;
      db.prepare(`
        INSERT INTO messages (team_id, type, title, body)
        VALUES (@team_id, 'welcome', @title, @body)
      `).run({
        team_id: team.id,
        title: `🎉 ${nameToUse} é o novo treinador do ${team.name}!`,
        body: `Bem-vindo ao ${team.name}. ${pick(WELCOME_FLAVOUR)}`,
      });
      db.prepare('UPDATE game_state SET welcome_sent = 1 WHERE id = 1').run();
    }
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
  /* IMPORTANTE: "current_date" tem de vir qualificado com o nome da tabela.
     Sem isto, o SQLite interpreta "current_date" como a sua própria palavra-chave
     incorporada (a data REAL do computador), em vez da coluna da tabela — o que
     fazia os fins de contrato serem calculados a partir da data real do sistema
     em vez da data do calendário do jogo. */
  const state = db.prepare('SELECT game_state.current_date FROM game_state WHERE id = 1').get();
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
function decidePlayerJoins(player, buyerTeam, sellerTeam, isReserve = false) {
  const currentWage = parseWageAmount(player.wage_text);
  /* Normalmente o jogador só pede um salário igual ou ligeiramente melhor do
     que já tem — não uma subida enorme. */
  const wageOffer = Math.round(currentWage * (1.0 + Math.random() * 0.15));
  const repDelta = (buyerTeam.reputation_stars - (sellerTeam?.reputation_stars ?? buyerTeam.reputation_stars)) / 5;
  const wageFactor = Math.max(-0.3, Math.min(0.5, ((wageOffer / currentWage) - 1) * 0.4));
  const luck = (Math.random() * 0.2) - 0.1;
  /* Quem não é titular no seu clube atual está muito mais aberto a sair —
     quer é minutos de jogo, mesmo que isso signifique um clube ligeiramente
     mais pequeno (ver isReserve, calculado em runAiScoutingTick a partir do
     onze mais forte da equipa por nível de jogador). */
  const reserveBonus = isReserve ? 0.45 : 0;
  const score = (repDelta * 0.55) + wageFactor + luck + reserveBonus;
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
       um acontecimento pouco frequente, não diário. (Reduzido mais 25% a
       pedido — 0.16 * 0.75 = 0.12.) */
    if (Math.random() > 0.12) return;

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

/* ---------- Jogadores livres: acabam sempre por ser contratados ----------
   Ao contrário dos outros negócios entre equipas geridas pelo jogo, isto
   NÃO fica preso ao mês de mercado — um clube em apuros de plantel pode
   sempre assinar um jogador sem clube, a qualquer altura da época. A
   prioridade vai para equipas com poucos jogadores (risco de não
   conseguirem sequer fazer um onze), mas qualquer equipa da IA com um
   plantel a precisar de reforço tem sempre alguma chance. O clube do
   utilizador nunca é afetado por isto — as suas contratações continuam a
   ser sempre uma decisão manual. */
function runFreeAgentSigningTick() {
  const results = [];
  const freeAgents = db.prepare('SELECT * FROM players WHERE team_id IS NULL').all();
  if (!freeAgents.length) return results;

  const aiTeams = db.prepare('SELECT * FROM teams WHERE is_user_controlled = 0').all();
  const pool = [...freeAgents];

  aiTeams.forEach((team) => {
    if (!pool.length) return;

    const squadSize = db.prepare('SELECT COUNT(*) AS c FROM players WHERE team_id = ?').get(team.id).c;
    if (squadSize >= 18) return; // plantel já bem composto, sem urgência

    /* Quanto mais pequeno o plantel, maior a urgência — uma equipa com
       menos de 11 jogadores quase de certeza vai atrás de reforços. */
    const need = Math.max(0, (18 - squadSize) / 18);
    const chance = Math.min(0.9, 0.05 + need * 0.55);
    if (Math.random() >= chance) return;

    const idx = Math.floor(Math.random() * pool.length);
    const player = pool.splice(idx, 1)[0];
    if (!player) return;

    db.prepare(`
      UPDATE players SET team_id = ?, original_team_id = COALESCE(original_team_id, ?),
        club_status = 'Titular Regular', is_listed = 0, asking_price = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(team.id, team.id, player.id);

    db.logMarketNews({
      type: 'transfer_completed',
      headline: `${player.name} assina pelo ${team.name}`,
      body: `${player.name} estava sem clube e assinou como agente livre pelo ${team.name}.`,
      player_name: player.name,
      player_photo: player.photo_path,
      to_team_name: team.name,
      to_team_shield: team.shield_path,
    });

    results.push({ player_id: player.id, player_name: player.name, team_name: team.name });
  });

  return results;
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

  /* ---------- Quem é "titular" em cada equipa, para efeitos de mercado ----------
     Como a maioria das equipas geridas pelo jogo nunca guarda uma tática
     manualmente, usa-se antes o onze mais forte por nível (current_ability_stars)
     de cada plantel como aproximação de "quem joga". Os restantes contam
     como reservas — saem mais facilmente, por um preço mais baixo, tal
     como pedido: ninguém quer ficar KO no banco a época toda. */
  const reservePlayerIds = new Set();
  {
    const byTeam = new Map();
    eligiblePlayers.forEach((p) => {
      if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, []);
      byTeam.get(p.team_id).push(p);
    });
    byTeam.forEach((squad) => {
      const sorted = [...squad].sort((a, b) => (b.current_ability_stars ?? 0) - (a.current_ability_stars ?? 0));
      sorted.slice(11).forEach((p) => reservePlayerIds.add(p.id));
    });
  }

  const moves = [];
  const pendingApprovals = [];

  eligiblePlayers.forEach((player) => {
    const isReserve = reservePlayerIds.has(player.id);
    const scoutChance = isReserve ? 0.02625 * 3 : 0.02625; // reservas são notadas ~3x mais
    if (Math.random() > scoutChance) return;

    const sellerTeam = teamsById.get(player.team_id);
    if (!sellerTeam) return;

    const quality = player.current_ability_stars ?? 2.5;
    const playerCode = getMainPositionCode(player.position_code);
    /* Um reserva pede um valor bem mais baixo — quer é sair, não fazer
       fortuna com a venda (ver pedido: "por um preço razoavelmente baixo"). */
    const referenceValue = Math.round(estimateScoutingValue(player) * (isReserve ? 0.6 : 1));
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

    const decision = decidePlayerJoins(player, buyer, sellerTeam, isReserve);

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

/* "Os jogadores com maiores números individuais destacam-se mais": a
   percentagem da posição continua a ser a base do sorteio, mas é multiplicada
   por um fator de qualidade tirado da média dos atributos reais do jogador
   (técnica/mental/físico, ou defesa de baliza no caso do guarda-redes) — a
   mesma escala usada no perfil (10 é o valor "de fábrica"). Um jogador com
   média 15 pesa 1.5x mais do que um com média 10 dentro da sua categoria. */
function playerQualityFactor(player) {
  const fields = player.category === 'GR'
    ? ['goalkeeping_json', 'mental_json', 'physical_json']
    : ['technical_json', 'mental_json', 'physical_json'];
  let sum = 0;
  let count = 0;
  fields.forEach((field) => {
    let list;
    try { list = JSON.parse(player[field] || '[]'); } catch { list = []; }
    if (Array.isArray(list)) {
      list.forEach(([, value]) => {
        const v = Number(value);
        if (Number.isFinite(v)) { sum += v; count += 1; }
      });
    }
  });
  const avg = count ? sum / count : 10;
  return Math.max(0.5, Math.min(2.2, avg / 10));
}

function pickWeighted(candidates, weightMap) {
  const pool = candidates.filter((p) => (weightMap[p.category] || 0) > 0);
  if (!pool.length) return null;
  const total = pool.reduce((sum, p) => sum + weightMap[p.category] * p.quality, 0);
  let roll = Math.random() * total;
  for (const p of pool) {
    roll -= weightMap[p.category] * p.quality;
    if (roll <= 0) return p;
  }
  return pool[pool.length - 1];
}

/* Mesma ideia de pickWeighted, mas o peso vem de uma função em vez de um
   mapa fixo por categoria — usado para aplicar o bónus de especialização
   (Goleador/Garçom) por cima do peso normal (ver scoreWeightFor/assistWeightFor). */
function pickWeightedCustom(candidates, weightFn) {
  const pool = candidates.filter((p) => weightFn(p) > 0);
  if (!pool.length) return null;
  const total = pool.reduce((sum, p) => sum + weightFn(p) * p.quality, 0);
  let roll = Math.random() * total;
  for (const p of pool) {
    roll -= weightFn(p) * p.quality;
    if (roll <= 0) return p;
  }
  return pool[pool.length - 1];
}

/* Onze inicial guardado na Tática do clube; se a equipa nunca guardou uma
   tática (ou guardou menos de 11 jogadores), completa com o resto do
   plantel ordenado por nível, para o amigável ter sempre jogadores a
   marcar/assistir/receber nota. */
function resolveMatchLineup(teamId) {
  const squad = db.prepare(`
    SELECT id, name, position_tag, position_code, focus_role,
           technical_json, mental_json, physical_json, goalkeeping_json
    FROM players WHERE team_id = ?
  `).all(teamId).map((p) => ({ ...p, category: classifyPositionCode(p.position_code) }));
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

  return chosen.slice(0, 11).map((p) => ({ ...p, quality: playerQualityFactor(p) }));
}

/* CARD_WEIGHT/TACKLE_BASE: mesmo critério de routes/liveMatch.js (cartões)
   mais um novo, para os cortes por jogo — defesas e médios defensivos
   cortam muito mais bolas do que avançados, tal como seria de esperar. */
const CARD_WEIGHT = { DEF: 30, MED: 30, MO: 20, PL: 15, GR: 5 };
const TACKLE_BASE = { GR: 0, DEF: 3.2, MED: 2.4, MO: 1.1, PL: 0.6 };

/* Simula os eventos (golos + assistências + cartões + cortes + % de passe)
   e as notas de um jogo já com resultado definido (amigável, Campeonato ou
   Taça — ver `competition`), guarda tudo em friendly_player_stats e
   atualiza o perfil de cada jogador que participou. */
function simulateFriendlyMatchDetails(friendlyId, homeTeamId, awayTeamId, homeGoals, awayGoals, competition = 'friendly') {
  const rowName = db.COMPETITION_ROW_NAMES[competition] || db.COMPETITION_ROW_NAMES.friendly;
  const sides = [
    { teamId: homeTeamId, goalsFor: homeGoals, goalsAgainst: awayGoals },
    { teamId: awayTeamId, goalsFor: awayGoals, goalsAgainst: homeGoals },
  ];

  const insertStat = db.prepare(`
    INSERT INTO friendly_player_stats
      (friendly_id, competition, team_id, player_id, player_name, position_tag, goals, assists, rating, yellow_cards, red_card, tackles, pass_pct)
    VALUES
      (@friendly_id, @competition, @team_id, @player_id, @player_name, @position_tag, @goals, @assists, @rating, @yellow_cards, @red_card, @tackles, @pass_pct)
  `);

  sides.forEach(({ teamId, goalsFor, goalsAgainst }) => {
    const lineup = resolveMatchLineup(teamId);
    if (!lineup.length) return;

    const outfield = lineup.filter((p) => p.category !== 'GR');
    const tally = new Map(lineup.map((p) => [p.id, { goals: 0, assists: 0, yellow: 0, red: 0 }]));

    /* Um plantel incompleto (poucos jogadores de campo) não deve fazer com
       que um único jogador leve sempre com todos os golos da equipa —
       depois de marcar 3 vezes no mesmo jogo, deixa de poder ser
       escolhido outra vez enquanto houver alternativa. Só volta a poder
       marcar se REALMENTE não houver mais ninguém (equipa com 1-2
       jogadores de campo apenas). Quem tem a especialização "Goleador"
       pesa mais na escolha de quem marca; "Garçom" pesa mais nas
       assistências (ver focus_role, escolhido no perfil do jogador).
       Além disso, com um plantel muito curto (menos de 6 jogadores ao
       todo), nem todos os golos da equipa têm de ficar atribuídos a
       alguém do plantel reduzido — parte fica por "desconhecido", tal
       como aconteceria com um plantel a menos jogadores do que uma equipa
       de futebol precisa mesmo. */
    const scoreWeightFor = (p) => SCORE_WEIGHT[p.category] * (p.focus_role === 'Goleador' ? 2.2 : 1);
    const assistWeightFor = (p) => ASSIST_WEIGHT[p.category] * (p.focus_role === 'Garçom' ? 2.2 : 1);
    const anonymousGoalChance = lineup.length < 6 ? 0.35 : 0;
    const pickScorer = () => {
      const underCap = outfield.filter((p) => tally.get(p.id).goals < 3);
      const pool = underCap.length ? underCap : outfield;
      return pickWeightedCustom(pool, scoreWeightFor);
    };

    for (let g = 0; g < goalsFor; g += 1) {
      if (anonymousGoalChance && Math.random() < anonymousGoalChance) continue; // golo sem marcador atribuído

      const scorer = pickScorer();
      if (scorer) tally.get(scorer.id).goals += 1;

      if (scorer && Math.random() < 0.8) {
        const assistCandidates = outfield.filter((p) => p.id !== scorer.id);
        const assister = pickWeightedCustom(assistCandidates, assistWeightFor);
        if (assister) tally.get(assister.id).assists += 1;
      }
    }

    /* Cartões — mesmo modelo já usado no jogo ao vivo (routes/liveMatch.js),
       só que aqui o jogo não é assistido, por isso os cartões são
       sorteados de uma vez em vez de minuto a minuto. */
    let yellows = 0;
    for (let i = 0; i < 5; i += 1) { if (Math.random() < 0.32) yellows += 1; }
    for (let i = 0; i < yellows; i += 1) {
      const pool = lineup.filter((p) => tally.get(p.id).red === 0);
      const player = pickWeighted(pool, CARD_WEIGHT) || pool[Math.floor(Math.random() * pool.length)];
      if (!player) continue;
      const t = tally.get(player.id);
      if (t.yellow) { t.yellow += 1; t.red = 1; } else { t.yellow = 1; }
    }
    if (Math.random() < 0.08) {
      const pool = lineup.filter((p) => tally.get(p.id).red === 0);
      const player = pool[Math.floor(Math.random() * pool.length)];
      if (player) tally.get(player.id).red = 1;
    }

    const resultBonus = goalsFor > goalsAgainst ? 0.3 : goalsFor < goalsAgainst ? -0.2 : 0.1;

    lineup.forEach((player) => {
      const { goals, assists, yellow, red } = tally.get(player.id);
      let rating = 6.0 + resultBonus + (Math.random() * 0.6 - 0.3) + goals * 0.8 + assists * 0.4;
      if (player.category === 'GR') rating += goalsAgainst === 0 ? 0.5 : (goalsAgainst >= 3 ? -0.4 : 0);
      rating -= yellow * 0.1;
      if (red) rating -= 1.0;
      rating = Math.max(4.0, Math.min(10.0, rating));

      const tackles = Math.max(0, Math.round((TACKLE_BASE[player.category] || 0) * player.quality + (Math.random() * 2 - 1)));
      const passPct = Math.max(40, Math.min(98, Math.round(62 + player.quality * 10 + (Math.random() * 16 - 8))));

      insertStat.run({
        friendly_id: friendlyId, competition, team_id: teamId, player_id: player.id,
        player_name: player.name, position_tag: player.position_tag || '',
        goals, assists, rating: Number(rating.toFixed(2)),
        yellow_cards: yellow, red_card: red, tackles, pass_pct: passPct,
      });

      db.applySeasonStat(player.id, rowName, {
        goals, assists, yellow, red, tackles, passPct, rating: Number(rating.toFixed(2)),
      });
    });
  });
}

function runFriendliesTick(nextDateStr) {
  /* Nota: "<= nextDateStr" (e não só "="), porque um amigável de hoje que
     envolva o clube do utilizador NÃO é resolvido aqui — fica à espera de
     ser assistido ao vivo (ver routes/liveMatch.js). Se o utilizador saltar
     esse jogo e avançar o calendário sem o assistir, ele passa a ter uma
     match_date no passado e é resolvido aqui, tal como sempre foi, para o
     calendário nunca ficar bloqueado. */
  const due = db.prepare(`
    SELECT f.*, h.name AS home_name, h.reputation_stars AS home_reputation, h.is_user_controlled AS home_user,
           a.name AS away_name, a.reputation_stars AS away_reputation, a.is_user_controlled AS away_user
    FROM club_friendlies f
    JOIN teams h ON h.id = f.home_team_id
    JOIN teams a ON a.id = f.away_team_id
    WHERE f.status = 'accepted' AND f.match_date <= ?
  `).all(nextDateStr);

  const results = [];

  due.forEach((f) => {
    /* Jogo de hoje com o clube do utilizador envolvido: fica para ser
       assistido ao vivo ou simulado a partir da mensagem "Jogo de Hoje" na
       caixa de entrada (ver abaixo) — nunca aqui diretamente. Se for
       ignorado, resolve-se sozinho no próximo avanço, como sempre. */
    if (f.match_date === nextDateStr && (f.home_user || f.away_user)) {
      /* Garante que a mensagem com os botões Jogar/Simular existe — só
         insere uma vez por jogo (várias chamadas a /advance no mesmo dia,
         ou o utilizador a recarregar a página, não devem duplicar a
         mensagem). */
      const userTeamId = f.home_user ? f.home_team_id : f.away_team_id;
      const opponentName = f.home_user ? f.away_name : f.home_name;
      const opponentTeamId = f.home_user ? f.away_team_id : f.home_team_id;
      const already = db.prepare('SELECT 1 FROM messages WHERE friendly_id = ? AND type = \'match_day\'').get(f.id);
      if (!already) {
        const label = f.is_cup ? 'Taça São Vicente' : (f.is_league ? 'Campeonato' : 'Amigável');
        const venue = f.home_user ? 'em casa' : 'fora';
        db.prepare(`
          INSERT INTO messages (team_id, type, title, body, related_team_id, friendly_id)
          VALUES (@team_id, 'match_day', @title, @body, @related_team_id, @friendly_id)
        `).run({
          team_id: userTeamId, related_team_id: opponentTeamId, friendly_id: f.id,
          title: `⚽ Jogo de Hoje: ${label} contra o ${opponentName}`,
          body: `Tens um jogo hoje (${venue}) contra o ${opponentName}, a contar para ${label === 'Amigável' ? 'um amigável' : label}. Queres jogar (escalar, dar a palestra e assistir ao vivo) ou simular o resultado?`,
        });
      }
      return;
    }

    simulateSingleFriendly(f);
    results.push({
      id: f.id, home_team: f.home_name, away_team: f.away_name,
      home_score: f.__homeGoals, away_score: f.__awayGoals, is_league: !!f.is_league, is_cup: !!f.is_cup,
    });
  });

  return results;
}

/* ---------- Resolve um único jogo (amigável/Campeonato/Taça) já devido ----------
   Extraído do corpo de runFriendliesTick para poder ser chamado também a
   partir de POST /api/game/matches/:friendlyId/simulate-now (botão
   "Simular" na mensagem "Jogo de Hoje" da caixa de entrada) — as duas vias
   têm de produzir exatamente o mesmo resultado, por isso ficam no mesmo
   sítio em vez de duplicadas. `f` é a linha de club_friendlies já com os
   nomes/reputações das equipas feitos por JOIN (ver query acima e a rota
   /simulate-now mais abaixo). */
function simulateSingleFriendly(f) {
  const homeGoals = simulateFriendlyGoals(f.home_reputation + 0.25, f.away_reputation);
  const awayGoals = simulateFriendlyGoals(f.away_reputation, f.home_reputation + 0.25);

  db.prepare(`
    UPDATE club_friendlies SET status = 'played', home_score = ?, away_score = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(homeGoals, awayGoals, f.id);

  /* Se este "amigável" foi na verdade criado para uma jornada do
     Campeonato (ver is_league em db/database.js e routes/league.js),
     propaga o resultado para league_fixtures — é o que mantém a tabela
     classificativa e o histórico do Campeonato atualizados quando o
     jogo do utilizador não é assistido ao vivo. */
  db.syncLeagueFixtureFromFriendly(f.id, homeGoals, awayGoals);
  db.syncCupFixtureFromFriendly(f.id, homeGoals, awayGoals);

  simulateFriendlyMatchDetails(f.id, f.home_team_id, f.away_team_id, homeGoals, awayGoals, f.is_cup ? 'cup' : (f.is_league ? 'league' : 'friendly'));

  const scoreText = `${f.home_name} ${homeGoals}-${awayGoals} ${f.away_name}`;
  const outcomeFor = (isHome) => {
    const us = isHome ? homeGoals : awayGoals;
    const them = isHome ? awayGoals : homeGoals;
    if (us > them) return 'Vitória';
    if (us < them) return 'Derrota';
    return 'Empate';
  };

  /* Na Taça não há empates — se ficou empatado a 90 minutos,
     syncCupFixtureFromFriendly (db/database.js) já decidiu o vencedor
     por desempate; usa-se isso para a mensagem em vez do resultado
     literal do marcador, e nota-se que foi "nos penáltis". */
  const cupFixture = f.is_cup ? db.prepare('SELECT winner_team_id, decided_by_penalties FROM cup_fixtures WHERE friendly_id = ?').get(f.id) : null;
  const cupOutcomeFor = (teamId) => (cupFixture.winner_team_id === teamId ? 'Vitória' : 'Derrota');

  [
    { userFlag: f.home_user, teamId: f.home_team_id, opponentName: f.away_name, isHome: true },
    { userFlag: f.away_user, teamId: f.away_team_id, opponentName: f.home_name, isHome: false },
  ].forEach(({ userFlag, teamId, opponentName, isHome }) => {
    if (!userFlag) return;
    const result = cupFixture ? cupOutcomeFor(teamId) : outcomeFor(isHome);
    const label = f.is_cup ? 'Taça São Vicente' : (f.is_league ? 'Campeonato' : 'Amigável');
    const penaltiesNote = cupFixture?.decided_by_penalties ? ' (nos penáltis)' : '';
    const cupTail = f.is_cup
      ? (result === 'Vitória' ? ' Seguem em frente na competição.' : ' Estão eliminados da Taça São Vicente.')
      : '';

    const teamName = isHome ? f.home_name : f.away_name;
    const goalsFor = isHome ? homeGoals : awayGoals;
    const goalsAgainst = isHome ? awayGoals : homeGoals;
    const teamReputation = isHome ? f.home_reputation : f.away_reputation;
    const opponentReputation = isHome ? f.away_reputation : f.home_reputation;
    const competitionPhrase = f.is_cup ? 'na Taça São Vicente' : (f.is_league ? 'no Campeonato' : 'nos amigáveis');

    /* Nota dos adeptos + reação da direção (medidores) e Jogador do Jogo
       (com foto + estatísticas da época) — ver routes/matchReactions.js,
       partilhado com routes/liveMatch.js para os jogos vistos ao vivo
       produzirem exatamente a mesma coisa. */
    const { extraJson, potm } = buildPostMatchReactions({
      friendlyId: f.id, teamId, teamName, opponentName, goalsFor, goalsAgainst, isHome,
      teamReputation, opponentReputation, competitionPhrase,
    });

    db.prepare(`
      INSERT INTO messages (team_id, type, title, body, extra_json)
      VALUES (@team_id, @type, @title, @body, @extra_json)
    `).run({
      team_id: teamId,
      type: f.is_cup ? 'cup_played' : (f.is_league ? 'league_played' : 'friendly_played'),
      title: `${result === 'Vitória' ? '🏆' : '📉'} ${label}: ${result.toLowerCase()} contra o ${opponentName}${penaltiesNote}`,
      body: `Resultado final: ${scoreText}${penaltiesNote}.${cupTail}`,
      extra_json: extraJson,
    });

    if (potm) {
      db.prepare(`
        INSERT INTO messages (team_id, type, title, body, player_id)
        VALUES (@team_id, 'player_of_match', @title, @body, @player_id)
      `).run({ team_id: teamId, title: potm.title, body: potm.body, player_id: potm.player_id });
    }
  });

  f.__homeGoals = homeGoals;
  f.__awayGoals = awayGoals;
  return { home_score: homeGoals, away_score: awayGoals };
}

/* ---------- POST /api/game/matches/:friendlyId/simulate-now ----------
   Botão "Simular" na mensagem "Jogo de Hoje" — resolve o jogo já, sem
   esperar pelo próximo avanço de calendário e sem abrir o jogo ao vivo. */
router.post('/matches/:friendlyId/simulate-now', (req, res) => {
  const f = db.prepare(`
    SELECT cf.*, h.name AS home_name, h.reputation_stars AS home_reputation, h.is_user_controlled AS home_user,
           a.name AS away_name, a.reputation_stars AS away_reputation, a.is_user_controlled AS away_user
    FROM club_friendlies cf
    JOIN teams h ON h.id = cf.home_team_id
    JOIN teams a ON a.id = cf.away_team_id
    WHERE cf.id = ?
  `).get(req.params.friendlyId);
  if (!f) return res.status(404).json({ error: 'Jogo não encontrado' });
  if (f.status !== 'accepted') return res.status(400).json({ error: 'Este jogo já foi resolvido.' });
  if (!f.home_user && !f.away_user) return res.status(400).json({ error: 'Este jogo não envolve o teu clube.' });

  const result = simulateSingleFriendly(f);
  db.prepare("UPDATE messages SET is_read = 1 WHERE friendly_id = ? AND type = 'match_day'").run(f.id);

  res.json({ ok: true, home_team: f.home_name, away_team: f.away_name, ...result });
});

/* ---------- POST /api/game/advance — avança 1 dia no calendário ----------
   IMPORTANTE: o cálculo do "dia seguinte" tem de ser sempre o mesmo,
   independentemente do fuso horário onde o servidor está a correr. A versão
   antiga (`new Date(...); .setDate(+1); .toISOString()`) misturava hora
   LOCAL (na leitura) com UTC (na escrita) — em fusos horários à frente de
   UTC (ex: Portugal no verão, UTC+1) isto fazia o cálculo devolver a MESMA
   data em vez do dia seguinte, deixando o calendário do jogo preso por
   dentro mesmo que o ecrã parecesse avançar. Isto tornava impossível voltar
   a treinar (o "hoje" do servidor nunca mudava) e rejeitava datas de
   amigável válidas (o "hoje" real do servidor não batia com o que era
   mostrado). Agora o cálculo é feito só com os números do texto da data —
   nunca cria um objeto Date a partir da string, por isso não há fuso
   horário nenhum envolvido. */
function addOneDayToIsoDate(isoDateStr) {
  const [year, month, day] = isoDateStr.split('-').map(Number);
  const utcNoon = Date.UTC(year, month - 1, day, 12); // meio-dia UTC: nunca cruza para o dia errado
  const next = new Date(utcNoon + 24 * 60 * 60 * 1000);
  const yyyy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

router.post('/advance', (req, res) => {
  const state = db.prepare('SELECT * FROM game_state WHERE id = 1').get();
  const nextDateStr = addOneDayToIsoDate(state.current_date);

  /* Se ficou um jogo ao vivo por terminar (o utilizador começou a assistir mas
     saiu antes do fim, ou nem chegou a abrir), termina-o agora à força — a
     avançar o dia sem isto, esse amigável ficaria preso para sempre em
     "accepted" sem nunca ser resolvido. */
  const liveMatchesAutoFinished = liveMatch.finishStaleLiveMatches(state.current_date);

  db.prepare('UPDATE game_state SET current_date = ? WHERE id = 1').run(nextDateStr);

  /* Avança o Campeonato ANTES dos amigáveis: se hoje for jornada do clube
     do utilizador, isto cria o "amigável" interno ligado a essa jornada
     (ver routes/league.js) a tempo de runFriendliesTick, logo a seguir, o
     deixar de fora tal como qualquer jogo de hoje que envolva o
     utilizador — fica à espera de ser assistido ao vivo. */
  const leagueResults = league.runLeagueTick(nextDateStr);

  /* Taça São Vicente: mesma ideia do Campeonato, mas as rondas só existem
     depois de sorteadas (ver routes/cup.js) — se não houver nenhuma ronda
     agendada para hoje, isto não faz nada. */
  const cupResults = cup.runCupTick(nextDateStr);

  /* Empréstimos: jogadores cuja loan_return_date chegou voltam hoje
     automaticamente ao clube de origem — ver routes/transfers.js. */
  transfers.runLoanReturnsIfDue(nextDateStr);

  /* Cache partilhada das necessidades do plantel (por posição) para este
     avanço de dia — assim as duas funções abaixo veem sempre a versão mais
     atualizada do plantel de cada equipa, mesmo entre negócios do mesmo tick. */
  const squadNeedsCache = new Map();
  const { sales, pendingApprovals: pendingFromListed } = runTransferListTick(squadNeedsCache);
  const { moves: aiMoves, pendingApprovals: pendingFromScouting } = runAiScoutingTick(squadNeedsCache);
  const pendingApprovals = [...pendingFromListed, ...pendingFromScouting];
  const freeAgentSignings = runFreeAgentSigningTick();
  const friendlyResults = runFriendliesTick(nextDateStr);

  /* Moral do balneário: incidentes de personalidade + pergunta ocasional
     ao treinador (ver routes/morale.js). Só afeta o clube do utilizador. */
  morale.runMoraleTick(nextDateStr);

  res.json({
    current_date: nextDateStr, sales, pending_approvals: pendingApprovals, ai_moves: aiMoves,
    free_agent_signings: freeAgentSignings,
    friendly_results: friendlyResults, league_results: leagueResults, cup_results: cupResults,
    live_matches_auto_finished: liveMatchesAutoFinished,
  });
});

/* ---------- GET /api/game/news — jornal do mercado (todas as movimentações) ---------- */
router.get('/news', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  res.json(db.prepare('SELECT * FROM market_news ORDER BY id DESC LIMIT ?').all(limit));
});

module.exports = router;