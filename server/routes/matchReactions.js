/* ==========================================================
   FMcriol — Reações pós-jogo (Adeptos + Direção) e Jogador do Jogo
   Partilhado entre routes/game.js (jogos simulados automaticamente) e
   routes/liveMatch.js (jogos assistidos ao vivo) — as duas vias produzem
   exatamente a mesma mensagem na caixa de entrada, só a fonte dos dados
   (friendly_player_stats já gravado por cada uma) muda.
   ========================================================== */
const db = require('../db/database');

/* ---------- Nota dos Adeptos (0-10) ----------
   Sobe com a vitória e com a diferença de golos, mas o que mais pesa é
   SE o resultado bateu a expectativa dada pela diferença de reputação:
   perder contra um adversário muito mais forte dói bem menos do que
   perder contra um mais fraco; empatar fora com um gigante é visto como
   um resultado positivo. `reputationGap` = reputação própria - reputação
   do adversário (positivo = a tua equipa era favorita). */
function computeFanRating({ goalsFor, goalsAgainst, reputationGap, isHome }) {
  const diff = goalsFor - goalsAgainst;
  let rating = 5.5 + diff * 1.1;
  const surpriseSwing = -reputationGap * 0.5; // surpreender um favorito vale mais do que bater um azarão
  rating += diff > 0 ? surpriseSwing : (diff < 0 ? surpriseSwing * 0.6 : surpriseSwing * 0.3);
  if (isHome && diff <= 0) rating -= 0.3; // jogar em casa cria mais expectativa
  rating += (Math.random() * 1.2 - 0.6);
  return Math.max(0, Math.min(10, Number(rating.toFixed(1))));
}

function fanRatingDescription(value, { opponentName }) {
  if (value >= 8.5) return `Bancada em festa — os adeptos saíram do estádio a cantar o nome da equipa depois de uma exibição de gala frente ao ${opponentName}.`;
  if (value >= 7) return `Adeptos muito satisfeitos com a exibição frente ao ${opponentName}. Bom ambiente à saída do estádio.`;
  if (value >= 5.5) return `Ambiente positivo nas bancadas, sem grandes euforias — resultado bem aceite pelos adeptos.`;
  if (value >= 4) return `Alguma insatisfação visível nas bancadas — esperava-se mais frente ao ${opponentName}.`;
  if (value >= 2.5) return `Assobios no apito final. Os adeptos não gostaram do que viram em campo.`;
  return `Fúria total nas bancadas — há já quem peça mudanças urgentes na equipa depois deste resultado.`;
}

/* ---------- Reação da Direção (0-10) ----------
   Mais fria e calculista que a dos adeptos: pesa sobretudo o resultado
   em si (menos sensível ao espetáculo do jogo). */
function computeBoardRating({ goalsFor, goalsAgainst, reputationGap }) {
  const diff = goalsFor - goalsAgainst;
  let rating = 5.5 + diff * 0.9 - reputationGap * (diff >= 0 ? 0.35 : -0.2);
  rating += (Math.random() * 0.8 - 0.4);
  return Math.max(0, Math.min(10, Number(rating.toFixed(1))));
}

function boardRatingDescription(value, { competitionPhrase }) {
  if (value >= 8.5) return `A direção do clube não podia estar mais satisfeita com o rumo da equipa ${competitionPhrase}.`;
  if (value >= 7) return `A direção elogiou publicamente o trabalho da equipa técnica após o jogo ${competitionPhrase}.`;
  if (value >= 5.5) return `A direção mantém-se satisfeita com o trabalho feito, mas pede continuidade.`;
  if (value >= 4) return `A direção espera uma reação da equipa nos próximos jogos ${competitionPhrase}.`;
  if (value >= 2.5) return `A direção deixou críticas discretas à exibição da equipa ${competitionPhrase}.`;
  return `A direção convocou uma reunião de urgência para analisar os maus resultados ${competitionPhrase}.`;
}

/* ---------- Jogador do Jogo ----------
   O jogador do próprio clube com melhor nota nesta partida (já gravada em
   friendly_player_stats por quem chamar este módulo — ver
   routes/game.js:simulateFriendlyMatchDetails e
   routes/liveMatch.js:finalizeMatch). O "parceiro" é quem mais assistências
   lhe deu neste jogo, usado nalguns títulos para dar a ideia de dupla. */
function pickPlayerOfMatch(friendlyId, teamId) {
  return db.prepare(`
    SELECT player_id, player_name, rating, goals, assists
    FROM friendly_player_stats
    WHERE friendly_id = ? AND team_id = ? AND player_id IS NOT NULL
    ORDER BY rating DESC LIMIT 1
  `).get(friendlyId, teamId);
}

function pickAssistPartner(friendlyId, teamId, excludePlayerId) {
  return db.prepare(`
    SELECT player_id, player_name, assists
    FROM friendly_player_stats
    WHERE friendly_id = ? AND team_id = ? AND player_id IS NOT NULL AND player_id != ? AND assists > 0
    ORDER BY assists DESC, rating DESC LIMIT 1
  `).get(friendlyId, teamId, excludePlayerId);
}

/* Primeiro nome (ou alcunha simples) para os títulos não ficarem enormes —
   "Rafa" em vez de "Rafael Monteiro Silva". */
function shortName(fullName) {
  return (fullName || '').trim().split(' ')[0] || fullName;
}

const TITLE_TEMPLATES = {
  win_big: [
    (p) => `${p} em noite inspirada na goleada`,
    (p) => `${p} brilha em vitória confortável`,
    (p, o) => `${p} mostra classe na goleada ao ${o}`,
    (p) => `Noite de gala para ${p} em grande vitória`,
  ],
  win_narrow: [
    (p) => `${p} de classe em vitória apertada`,
    (p) => `${p} brilha e crava vitória agónica`,
    (p) => `${p} resolve num jogo equilibrado`,
    (p, o) => `${p} decide um duelo emocionante frente ao ${o}`,
  ],
  draw: [
    (p) => `${p} não evita o empate mas foi o melhor em campo`,
    (p) => `${p} em grande exibição num empate justo`,
    (p, o, t) => `${p} salva a noite do ${t} com atuação de gala`,
    (p) => `Exibição de nível de ${p}, mas não chegou para a vitória`,
  ],
  loss: [
    (p) => `${p} exibe-se em grande classe mas não chega para garantir vitória`,
    (p) => `${p} em noite de luxo, mas não chegou`,
    (p, o, t) => `${p} brilha isolado numa noite para esquecer do ${t}`,
    (p) => `Nem a classe de ${p} evita a derrota`,
  ],
};
const PARTNER_TEMPLATES = [
  (p, partner) => `${p} brilha em conjunto com ${partner}`,
  (p, partner) => `${p} e ${partner} em grande plano de equipa`,
  (p, partner) => `${p} entende-se às mil maravilhas com ${partner}`,
  (p, partner) => `A dupla ${p}-${partner} faz a diferença`,
];

function resultCategory(goalsFor, goalsAgainst) {
  const diff = goalsFor - goalsAgainst;
  if (diff > 1) return 'win_big';
  if (diff === 1) return 'win_narrow';
  if (diff === 0) return 'draw';
  return 'loss';
}

function composePotmTitle({ playerName, partnerName, teamName, opponentName, category }) {
  const p = shortName(playerName);
  const usePartner = partnerName && Math.random() < 0.4;
  if (usePartner) {
    const template = PARTNER_TEMPLATES[Math.floor(Math.random() * PARTNER_TEMPLATES.length)];
    return `⭐ ${template(p, shortName(partnerName))}`;
  }
  const pool = TITLE_TEMPLATES[category] || TITLE_TEMPLATES.draw;
  const template = pool[Math.floor(Math.random() * pool.length)];
  return `⭐ ${template(p, opponentName, teamName)}`;
}

function composePotmBody({ playerName, rating, goals, assists, teamName, opponentName, goalsFor, goalsAgainst }) {
  const bits = [];
  if (goals) bits.push(`${goals} golo${goals === 1 ? '' : 's'}`);
  if (assists) bits.push(`${assists} assistência${assists === 1 ? '' : 's'}`);
  const contribution = bits.length ? `, com ${bits.join(' e ')}` : '';
  return `No jogo frente ao ${opponentName} (${teamName} ${goalsFor}-${goalsAgainst} ${opponentName}), `
    + `${playerName} foi eleito o melhor em campo${contribution}, com uma nota de ${rating.toFixed(1)}.`;
}

/* ---------- Função principal ----------
   Devolve { extraJson, potm } prontos a usar por quem grava as mensagens:
   - extraJson: string JSON com os dois medidores (adeptos/direção), para
     ir no campo messages.extra_json da mensagem de resultado.
   - potm: null, ou { player_id, title, body } para uma SEGUNDA mensagem
     dedicada ao jogador do jogo (com foto + estatísticas da época, já
     resolvidas no frontend a partir de messages.player_id — ver
     dashboard.js). */
function buildPostMatchReactions({
  friendlyId, teamId, teamName, opponentName, goalsFor, goalsAgainst,
  isHome, teamReputation, opponentReputation, competitionPhrase,
}) {
  const reputationGap = (teamReputation ?? 2) - (opponentReputation ?? 2);
  const fanValue = computeFanRating({ goalsFor, goalsAgainst, reputationGap, isHome });
  const boardValue = computeBoardRating({ goalsFor, goalsAgainst, reputationGap });

  const extraJson = JSON.stringify({
    gauges: [
      { key: 'fans', label: 'Adeptos', icon: '🎟️', value: fanValue, max: 10, description: fanRatingDescription(fanValue, { opponentName }) },
      { key: 'board', label: 'Direção', icon: '🏛️', value: boardValue, max: 10, description: boardRatingDescription(boardValue, { competitionPhrase }) },
    ],
  });

  let potm = null;
  const potmRow = pickPlayerOfMatch(friendlyId, teamId);
  if (potmRow) {
    const partner = pickAssistPartner(friendlyId, teamId, potmRow.player_id);
    const category = resultCategory(goalsFor, goalsAgainst);
    const title = composePotmTitle({
      playerName: potmRow.player_name, partnerName: partner?.player_name,
      teamName, opponentName, category,
    });
    const body = composePotmBody({
      playerName: potmRow.player_name, rating: potmRow.rating, goals: potmRow.goals, assists: potmRow.assists,
      teamName, opponentName, goalsFor, goalsAgainst,
    });
    potm = { player_id: potmRow.player_id, title, body };
  }

  return { extraJson, potm };
}

module.exports = { buildPostMatchReactions };
