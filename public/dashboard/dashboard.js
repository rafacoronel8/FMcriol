/* ==========================================================
   FMcriol — Painel do Clube
   ========================================================== */
const el = (id) => document.getElementById(id);

const teamId = localStorage.getItem('fmcriol_teamId');
const managerName = localStorage.getItem('fmcriol_managerName');

/* Sem clube escolhido? Volta ao início da seleção. */
if (!teamId) {
  window.location.href = '/inicio/selecaoClube.html';
}

function fmtMoney(v){
  return '£' + Number(v || 0).toLocaleString('pt-PT');
}

/* ---------- Marca esta equipa como "controlada pelo utilizador" ----------
   O servidor precisa de saber qual das 15 equipas és tu, para que o mercado
   de transferências peça a tua aprovação antes de vender um jogador teu em
   vez de vender sozinho. Chamado sempre que o dashboard carrega. */
async function claimTeam(){
  try{
    await fetch('/api/game/claim-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: teamId }),
    });
  }catch(err){
    // não bloqueia o resto do dashboard se isto falhar
  }
}

/* ---------- Carregar dados do clube ---------- */
async function loadClub(){
  try{
    await claimTeam();
    const res = await fetch(`/api/teams/${teamId}`);
    if (!res.ok) throw new Error('Clube não encontrado');
    const team = await res.json();
    fillClub(team);
  }catch(err){
    document.body.innerHTML = `<p style="color:#e2495b;padding:40px;font-family:sans-serif">
      Não foi possível carregar o clube. Verifica se o servidor está a correr, ou
      <a href="/inicio/selecaoClube.html" style="color:#7c5cff">escolhe outro clube</a>.
    </p>`;
  }
}

function fillClub(team){
  el('clubName').textContent = team.name;
  el('managerName').textContent = managerName || 'Treinador';
  document.title = `${team.name} — FMcriol`;

  if (team.shield_path) {
    el('clubShield').innerHTML = `<img src="${team.shield_path}" alt="${team.name}">`;
  }

  el('fBalance').textContent = fmtMoney(team.balance);
  el('fWage').textContent = fmtMoney(team.wage_budget) + ' / semana';
  el('fTransfer').textContent = fmtMoney(team.transfer_budget);
  el('fTier').textContent = team.financial_tier;

  el('dDivision').textContent = team.division === 2 ? '2ª Divisão' : '1ª Divisão';
  el('dReputation').textContent = '★'.repeat(Math.round(team.reputation_stars)) + '☆'.repeat(5 - Math.round(team.reputation_stars)) + ` (${team.reputation_stars})`;
  el('dLocation').textContent = team.location || 'Não definida';
  el('dStadium').textContent = team.stadium_name || 'Não definido';
}

/* ---------- Tabs ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    tab.classList.add('active');
    el(`panel-${tab.dataset.tab}`).classList.remove('hidden');
    if (tab.dataset.tab === 'minhaEquipa') loadSquad();
    if (tab.dataset.tab === 'tatica') loadTactics();
    if (tab.dataset.tab === 'mercado') loadMarketNews();
  });
});

/* ---------- Minha Equipa (plantel) ---------- */
const FITNESS_CLASS = {
  'No Auge': 'fitness-good',
  'Em Recuperação': 'fitness-warn',
  'Lesionado': 'fitness-bad',
  'Cansado': 'fitness-warn',
};

function fitnessClass(status){
  return FITNESS_CLASS[status] || '';
}

function starsText(value){
  const n = Math.round(Number(value) || 0);
  return '★'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(Math.max(0, 5 - n));
}

async function loadSquad(){
  const grid = el('squadGrid');
  const empty = el('squadEmpty');
  try{
    const res = await fetch(`/api/players?team_id=${teamId}`);
    if(!res.ok) throw new Error();
    const players = await res.json();

    el('squadCount').textContent = players.length;

    if(!players.length){
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    grid.innerHTML = players.map((p) => {
      const avatar = p.photo_path ? `<img src="${p.photo_path}" alt="">` : '🧑';
      const fClass = fitnessClass(p.fitness_status);
      return `
        <div class="squad-card">
          <div class="squad-avatar">${avatar}</div>
          <div class="squad-info">
            <div class="squad-name-row">
              <span class="squad-name">${p.name}</span>
              <span class="squad-jersey">#${p.jersey_number || '00'}</span>
            </div>
            <div class="squad-position">${p.position_tag || 'Posição não definida'}</div>
            <div class="squad-status-row">
              <span class="squad-pill ${fClass}">${p.fitness_status || '—'}</span>
              <span class="squad-pill">${p.club_status || '—'}</span>
            </div>
            <div class="squad-stars">${starsText(p.current_ability_stars)}</div>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.squad-card').forEach((card, i) => {
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => {
        window.location.href = `/jogador/perfilJogador.html?id=${players[i].id}`;
      });
    });
  }catch(err){
    grid.innerHTML = '';
    empty.textContent = 'Não foi possível carregar o plantel.';
    empty.classList.remove('hidden');
  }
}

/* ---------- Pesquisa global ---------- */
let searchDebounce = null;

el('searchInput').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchDebounce);

  if (!q) {
    el('searchResults').classList.add('hidden');
    return;
  }

  el('searchResults').classList.remove('hidden');
  el('searchResults').innerHTML = '<div class="search-loading">A procurar…</div>';

  searchDebounce = setTimeout(() => runSearch(q), 250);
});

async function runSearch(q){
  try{
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderSearchResults(data);
  }catch(err){
    el('searchResults').innerHTML = '<div class="search-empty">Erro na pesquisa.</div>';
  }
}

function renderSearchResults(data){
  const box = el('searchResults');
  const hasTeams = data.teams && data.teams.length > 0;
  const hasPlayers = data.players && data.players.length > 0;

  if (!hasTeams && !hasPlayers) {
    box.innerHTML = `<div class="search-empty">Sem resultados para "${data.query}".</div>`;
    return;
  }

  let html = '';

  if (hasTeams) {
    html += '<div class="search-group-label">Clubes</div>';
    data.teams.forEach((t) => {
      const icon = t.shield_path ? `<img src="${t.shield_path}" alt="">` : '⚽';
      html += `
        <div class="search-result-item" data-type="equipa" data-id="${t.id}">
          <div class="result-icon">${icon}</div>
          <div>
            <div class="result-name">${t.name}</div>
            <div class="result-sub">${t.division === 2 ? '2ª Divisão' : '1ª Divisão'} · ${t.financial_tier}</div>
          </div>
        </div>`;
    });
  }

  if (hasPlayers) {
    html += '<div class="search-group-label">Jogadores</div>';
    data.players.forEach((p) => {
      const icon = p.photo_path ? `<img src="${p.photo_path}" alt="">` : '🧑';
      html += `
        <div class="search-result-item" data-type="jogador" data-id="${p.id}">
          <div class="result-icon">${icon}</div>
          <div>
            <div class="result-name">${p.name}</div>
            <div class="result-sub">${p.team_name || 'Sem clube'}</div>
          </div>
        </div>`;
    });
  }

  box.innerHTML = html;

  box.querySelectorAll('.search-result-item').forEach((item) => {
    item.addEventListener('click', () => {
      const { type, id } = item.dataset;
      if (type === 'equipa') window.location.href = `/equipa/perfilEquipa.html?id=${id}`;
      else window.location.href = `/jogador/perfilJogador.html?id=${id}`;
    });
  });
}

/* Fecha os resultados ao clicar fora */
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) el('searchResults').classList.add('hidden');
});

loadClub();

/* ---------- Caixa de entrada ---------- */
let knownMessageIds = new Set();

async function loadMessages(notify = false){
  try{
    const res = await fetch(`/api/transfers/messages?team_id=${teamId}`);
    if(!res.ok) throw new Error();
    const messages = await res.json();
    renderMessages(messages);

    const currentIds = new Set(messages.map((m) => m.id));
    if(notify){
      const newCount = messages.filter((m) => !knownMessageIds.has(m.id)).length;
      if(newCount > 0) showNewMessageToast(newCount);
    }
    knownMessageIds = currentIds;
  }catch(err){
    // mantém a mensagem de boas-vindas estática se a caixa de entrada não carregar
  }
}

function showNewMessageToast(count){
  const toast = el('newMsgToast');
  toast.textContent = count === 1
    ? '📬 Tens 1 mensagem nova na caixa de entrada'
    : `📬 Tens ${count} mensagens novas na caixa de entrada`;
  toast.classList.remove('hidden');
  clearTimeout(showNewMessageToast._t);
  showNewMessageToast._t = setTimeout(() => toast.classList.add('hidden'), 6000);
}

el('newMsgToast').addEventListener('click', () => {
  el('newMsgToast').classList.add('hidden');
  document.querySelector('.tab[data-tab="visaoGeral"]')?.click();
  el('messagesList').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

const MESSAGE_ICONS = {
  transfer_accepted: '✅',
  transfer_rejected: '❌',
  contract_accepted: '✍️',
  contract_rejected: '🚫',
  player_sold: '💰',
  incoming_offer_pending: '📥',
  offer_declined_by_user: '↩️',
  transfer_player_refused: '🙅',
  transfer_interest: '👀',
};

function renderMessages(messages){
  if(!messages.length){
    el('messagesList').innerHTML = '<p class="placeholder-text">Sem mensagens de momento.</p>';
    return;
  }

  el('messagesList').innerHTML = messages.map((m) => {
    const playerAvatar = m.player_photo
      ? `<div class="msg-avatar"><img src="${m.player_photo}" alt=""></div>`
      : (m.player_name ? `<div class="msg-avatar">🧑</div>` : '');
    const myShield = m.my_team_shield
      ? `<div class="msg-avatar shield"><img src="${m.my_team_shield}" alt=""></div>` : '';
    const relatedShield = m.related_team_shield
      ? `<div class="msg-avatar shield"><img src="${m.related_team_shield}" alt=""></div>` : '';

    const isPendingOffer = m.type === 'incoming_offer_pending' && m.offer_status === 'pending';
    const banner = isPendingOffer ? `<div class="msg-required-banner">⚠ Resposta necessária</div>` : '';
    const actions = isPendingOffer
      ? `<div class="msg-actions" data-offer-id="${m.transfer_offer_id}">
           <button class="msg-btn msg-btn-accept" data-action="accept">Aceitar</button>
           <button class="msg-btn msg-btn-reject" data-action="reject">Recusar</button>
         </div>`
      : (m.type === 'incoming_offer_pending'
          ? `<p class="msg-decision-note">${m.offer_status === 'accepted' ? 'Proposta aceite.' : 'Proposta recusada.'}</p>`
          : '');

    return `
      <div class="message-item${isPendingOffer ? ' action-required' : ''}">
        <div class="msg-avatars">${playerAvatar}${myShield}${relatedShield}</div>
        <div class="msg-content">
          ${banner}
          <div class="msg-title">${m.title}</div>
          <div class="msg-body">${m.body}</div>
          ${actions}
        </div>
      </div>`;
  }).join('');

  el('messagesList').querySelectorAll('.msg-actions').forEach((box) => {
    box.querySelectorAll('.msg-btn').forEach((btn) => {
      btn.addEventListener('click', () => respondToOffer(box.dataset.offerId, btn.dataset.action === 'accept', box));
    });
  });
}
loadMessages();

/* ---------- Limpar mensagens ---------- */
el('clearMessagesBtn').addEventListener('click', async () => {
  const btn = el('clearMessagesBtn');
  btn.disabled = true;
  btn.textContent = 'A limpar…';
  try{
    const res = await fetch(`/api/transfers/messages?team_id=${teamId}`, { method: 'DELETE' });
    if(!res.ok) throw new Error();
    await loadMessages();
  }catch(err){
    // se falhar, mantém as mensagens como estavam
  }finally{
    btn.disabled = false;
    btn.textContent = 'Limpar mensagens';
  }
});

/* ---------- Responder a uma proposta pendente (Aceitar / Recusar) ---------- */
async function respondToOffer(offerId, accept, actionsBox){
  actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = true));
  try{
    const res = await fetch(`/api/transfers/${offerId}/respond`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept }),
    });
    if(!res.ok) throw new Error();
    await loadMessages();
    await loadClub(); // refresca orçamentos se a transferência foi aceite
  }catch(err){
    actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = false));
    actionsBox.insertAdjacentHTML('afterend', '<p class="msg-decision-note">Não foi possível responder à proposta.</p>');
  }
}

/* ---------- Calendário ---------- */
const WEEKDAYS_PT = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

let currentGameDate = null;

function fmtGameDate(isoDate){
  const d = new Date(`${isoDate}T00:00:00`);
  return `${WEEKDAYS_PT[d.getDay()]}, ${d.getDate()} de ${MONTHS_PT[d.getMonth()]} de ${d.getFullYear()}`;
}

function fmtShortDate(isoDate){
  const d = new Date(`${isoDate}T00:00:00`);
  return `${d.getDate()} de ${MONTHS_PT[d.getMonth()]}`;
}

async function loadGameState(){
  try{
    const res = await fetch('/api/game/state');
    if(!res.ok) throw new Error();
    const state = await res.json();
    currentGameDate = state.current_date;
    el('topbarDate').textContent = fmtGameDate(state.current_date);
    el('calendarDate').textContent = fmtGameDate(state.current_date);
    updateFriendlyDateMin();
  }catch(err){
    // mantém o traço se o calendário não carregar
  }
}
loadGameState();

el('advanceDayBtn').addEventListener('click', async () => {
  const btn = el('advanceDayBtn');
  const resultEl = el('advanceResult');
  btn.disabled = true;
  btn.textContent = 'A avançar…';
  resultEl.textContent = '';

  try{
    const res = await fetch('/api/game/advance', { method: 'POST' });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Erro ao avançar o dia');

    currentGameDate = data.current_date;
    el('topbarDate').textContent = fmtGameDate(data.current_date);
    el('calendarDate').textContent = fmtGameDate(data.current_date);
    updateFriendlyDateMin();

    const aiMoves = data.ai_moves || [];
    const friendlyResults = data.friendly_results || [];
    const notes = [];

    if(data.sales && data.sales.length){
      notes.push(data.sales.length === 1
        ? `${data.sales[0].player_name} foi vendido ao ${data.sales[0].buyer_team}!`
        : `${data.sales.length} jogadores da tua lista de transferências foram vendidos!`);
    }else if(aiMoves.length){
      notes.push(`${aiMoves.length === 1 ? 'Houve 1 transferência' : `Houve ${aiMoves.length} transferências`} noutros clubes.`);
    }

    const myFriendly = friendlyResults.find((f) => f.home_team === el('clubName').textContent || f.away_team === el('clubName').textContent);
    if(myFriendly){
      notes.push(`Amigável: ${myFriendly.home_team} ${myFriendly.home_score}-${myFriendly.away_score} ${myFriendly.away_team}.`);
    }

    resultEl.textContent = notes.length ? notes.join(' ') : 'Nenhuma novidade hoje.';

    await loadMessages(true);
    await loadClub(); // refresca orçamentos, caso algum jogador tenha sido vendido
    await loadActivities();
    await loadFriendlies();
    marketNewsLoaded = false; // força atualização da próxima vez que a tab Mercado abrir
  }catch(err){
    resultEl.textContent = err.message;
  }finally{
    btn.disabled = false;
    btn.textContent = 'Continuar ▸';
  }
});

/* ---------- Atividades diárias ---------- */
async function loadActivities(){
  const grid = el('activityGrid');
  const hint = el('activityStatusHint');
  const resultBox = el('activityResult');
  try{
    const res = await fetch(`/api/activities/${teamId}`);
    if(!res.ok) throw new Error();
    const data = await res.json();

    hint.textContent = data.done_today ? 'Atividade de hoje concluída' : 'Escolhe uma atividade';
    if(data.done_today){
      resultBox.textContent = data.done_today.summary || '';
      resultBox.classList.remove('hidden');
    }else{
      resultBox.classList.add('hidden');
    }

    grid.innerHTML = data.activities.map((a) => {
      const isDone = data.done_today && data.done_today.activity_key === a.key;
      const disabled = !!data.done_today;
      return `
        <button type="button" class="activity-btn${isDone ? ' done' : ''}" data-key="${a.key}" ${disabled ? 'disabled' : ''}>
          <span class="activity-icon">${a.icon}</span>
          <span class="activity-name">${a.name}</span>
          <span class="activity-desc">${a.description}</span>
          ${isDone ? '<span class="activity-done-tag">✓ Feito hoje</span>' : ''}
        </button>`;
    }).join('');

    grid.querySelectorAll('.activity-btn').forEach((btn) => {
      btn.addEventListener('click', () => runActivity(btn.dataset.key));
    });
  }catch(err){
    grid.innerHTML = '<p class="placeholder-text">Não foi possível carregar as atividades.</p>';
  }
}

async function runActivity(key){
  const resultBox = el('activityResult');
  el('activityGrid').querySelectorAll('.activity-btn').forEach((b) => (b.disabled = true));
  try{
    const res = await fetch(`/api/activities/${teamId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity_key: key }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível realizar a atividade');

    resultBox.textContent = data.summary;
    resultBox.classList.remove('hidden');
    await loadActivities();
    await loadMessages(true);
  }catch(err){
    resultBox.textContent = err.message;
    resultBox.classList.remove('hidden');
    await loadActivities();
  }
}

/* ---------- Marcar amigável ---------- */
let allTeamsCache = [];

async function loadTeamsForFriendly(){
  const select = el('friendlyOpponent');
  try{
    const res = await fetch('/api/teams');
    if(!res.ok) throw new Error();
    allTeamsCache = await res.json();
    const others = allTeamsCache.filter((t) => String(t.id) !== String(teamId));
    select.innerHTML = '<option value="">Escolhe um clube…</option>' +
      others.map((t) => `<option value="${t.id}">${t.name} (${'★'.repeat(Math.round(t.reputation_stars))})</option>`).join('');
  }catch(err){
    select.innerHTML = '<option value="">Não foi possível carregar os clubes</option>';
  }
}
loadTeamsForFriendly();

function updateFriendlyDateMin(){
  if(!currentGameDate) return;
  const next = new Date(`${currentGameDate}T00:00:00`);
  next.setDate(next.getDate() + 1);
  el('friendlyDate').min = next.toISOString().slice(0, 10);
}

el('friendlyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('friendlySubmitBtn');
  const resultBox = el('friendlyFormResult');
  const opponentId = el('friendlyOpponent').value;
  const date = el('friendlyDate').value;

  if(!opponentId || !date){
    resultBox.textContent = 'Escolhe o adversário e a data.';
    resultBox.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'A enviar…';
  resultBox.classList.add('hidden');

  try{
    const res = await fetch('/api/friendlies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: teamId, opponent_team_id: opponentId, match_date: date }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível marcar o amigável');

    resultBox.textContent = data.status === 'accepted'
      ? 'Convite aceite! O amigável foi marcado.'
      : `Convite recusado. ${data.decline_reason || ''}`;
    resultBox.classList.remove('hidden');
    el('friendlyForm').reset();
    updateFriendlyDateMin();
    await loadFriendlies();
    await loadMessages(true);
  }catch(err){
    resultBox.textContent = err.message;
    resultBox.classList.remove('hidden');
  }finally{
    btn.disabled = false;
    btn.textContent = 'Enviar Convite';
  }
});

/* ---------- Listas de amigáveis ---------- */
function friendlyTeamHtml(name, shieldPath){
  const shield = shieldPath ? `<img src="${shieldPath}" alt="">` : '⚽';
  return `<span class="friendly-shield">${shield}</span><span>${name}</span>`;
}

function renderFriendlyUpcoming(list){
  const box = el('friendlyUpcomingList');
  const empty = el('friendlyUpcomingEmpty');
  el('friendlyUpcomingCount').textContent = list.length;

  if(!list.length){
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  box.innerHTML = list.map((f) => `
    <div class="friendly-item" data-friendly-id="${f.id}">
      <div class="friendly-teams">
        ${friendlyTeamHtml(f.home_name, f.home_shield)}
        <span class="friendly-vs">vs</span>
        ${friendlyTeamHtml(f.away_name, f.away_shield)}
      </div>
      <div class="friendly-meta">
        <span>${fmtShortDate(f.match_date)}</span>
        <span class="friendly-badge accepted">Marcado</span>
        <button type="button" class="friendly-cancel-btn" data-cancel-id="${f.id}">Cancelar</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-cancel-id]').forEach((btn) => {
    btn.addEventListener('click', () => cancelFriendly(btn.dataset.cancelId));
  });
}

function renderFriendlyHistory(list){
  const box = el('friendlyHistoryList');
  const empty = el('friendlyHistoryEmpty');

  if(!list.length){
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  box.innerHTML = list.map((f) => {
    let badge = `<span class="friendly-badge declined">Recusado</span>`;
    let score = '';
    if(f.status === 'played'){
      const isHome = String(f.home_team_id) === String(teamId);
      const us = isHome ? f.home_score : f.away_score;
      const them = isHome ? f.away_score : f.home_score;
      const cls = us > them ? 'played-win' : (us < them ? 'played-loss' : 'played-draw');
      badge = `<span class="friendly-badge ${cls}">${us > them ? 'Vitória' : (us < them ? 'Derrota' : 'Empate')}</span>`;
      score = `<span class="friendly-score">${f.home_score} - ${f.away_score}</span>`;
    }else if(f.status === 'cancelled'){
      badge = `<span class="friendly-badge cancelled">Cancelado</span>`;
    }
    return `
      <div class="friendly-item${f.status === 'played' ? ' friendly-item-clickable' : ''}" ${f.status === 'played' ? `data-friendly-id="${f.id}"` : ''}>
        <div class="friendly-teams">
          ${friendlyTeamHtml(f.home_name, f.home_shield)}
          ${score || '<span class="friendly-vs">vs</span>'}
          ${friendlyTeamHtml(f.away_name, f.away_shield)}
        </div>
        <div class="friendly-meta">
          <span>${fmtShortDate(f.match_date)}</span>
          ${badge}
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('[data-friendly-id]').forEach((item) => {
    item.style.cursor = 'pointer';
    item.addEventListener('click', () => openFriendlyModal(item.dataset.friendlyId));
  });
}

/* ---------- Modal de detalhe do amigável: golos, assistências, notas ---------- */
async function openFriendlyModal(friendlyId){
  try{
    const res = await fetch(`/api/friendlies/match/${friendlyId}`);
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível carregar o amigável');
    renderFriendlyModal(data);
    el('friendlyModalOverlay').classList.remove('hidden');
  }catch(err){
    // se falhar, simplesmente não abre o modal
  }
}

function renderFriendlyModal(f){
  el('friendlyModalHeadline').textContent = `${f.home_name} ${f.home_score} - ${f.away_score} ${f.away_name}`;
  el('friendlyModalDate').textContent = fmtNewsDate(f.match_date);

  el('friendlyModalTeams').innerHTML = `
    <div class="news-modal-team">
      <div class="news-modal-team-shield">${f.home_shield ? `<img src="${f.home_shield}" alt="">` : '⚽'}</div>
      <span>${f.home_name}</span>
    </div>
    <div class="news-modal-arrow">${f.home_score} - ${f.away_score}</div>
    <div class="news-modal-team">
      <div class="news-modal-team-shield">${f.away_shield ? `<img src="${f.away_shield}" alt="">` : '⚽'}</div>
      <span>${f.away_name}</span>
    </div>`;

  const scorers = [...f.home_players, ...f.away_players].filter((p) => p.goals > 0);
  if(!scorers.length){
    el('friendlyModalEvents').innerHTML = '<p class="friendly-modal-empty">Não houve golos neste jogo.</p>';
  }else{
    el('friendlyModalEvents').innerHTML = scorers.map((p) => {
      const assister = [...f.home_players, ...f.away_players].find((a) => a.team_id === p.team_id && a.assists > 0 && a.player_id !== p.player_id);
      const times = p.goals > 1 ? ` (${p.goals}x)` : '';
      return `
        <div class="friendly-modal-event">
          <span class="evt-icon">⚽</span>
          <span class="evt-scorer">${p.player_name}${times}</span>
          ${assister ? `<span class="evt-assist">assistência de ${assister.player_name}</span>` : ''}
        </div>`;
    }).join('');
  }

  const teamBlock = (teamName, teamShield, players) => `
    <div class="friendly-modal-team-block">
      <div class="friendly-modal-team-name">${teamShield ? `<img src="${teamShield}" alt="">` : '⚽'} ${teamName}</div>
      <table class="friendly-modal-players">
        <thead><tr><th>Jogador</th><th class="num">G</th><th class="num">A</th><th class="num">Nota</th></tr></thead>
        <tbody>
          ${players.map((p) => `
            <tr>
              <td>${p.player_name}</td>
              <td class="num">${p.goals}</td>
              <td class="num">${p.assists}</td>
              <td class="num"><span class="rating-pill">${Number(p.rating).toFixed(1)}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  el('friendlyModalLineups').innerHTML =
    teamBlock(f.home_name, f.home_shield, f.home_players) +
    teamBlock(f.away_name, f.away_shield, f.away_players);
}

function closeFriendlyModal(){
  el('friendlyModalOverlay').classList.add('hidden');
}
el('friendlyModalClose').addEventListener('click', closeFriendlyModal);
el('friendlyModalOverlay').addEventListener('click', (e) => {
  if(e.target === el('friendlyModalOverlay')) closeFriendlyModal();
});
document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape') closeFriendlyModal();
});

async function loadFriendlies(){
  try{
    const res = await fetch(`/api/friendlies/${teamId}`);
    if(!res.ok) throw new Error();
    const data = await res.json();
    renderFriendlyUpcoming(data.upcoming || []);
    renderFriendlyHistory(data.history || []);
  }catch(err){
    // mantém o estado anterior se falhar
  }
}

async function cancelFriendly(id){
  try{
    const res = await fetch(`/api/friendlies/${id}/cancel`, { method: 'PUT' });
    if(!res.ok) throw new Error();
    await loadFriendlies();
  }catch(err){
    // se falhar, a lista mantém-se como estava
  }
}

loadActivities();
loadFriendlies();
/* ---------- Mercado: jornal de notícias com todas as movimentações ---------- */
const MARKET_NEWS_ICONS = {
  offer_accepted: '🤝',
  offer_rejected: '🚫',
  transfer_completed: '✅',
  contract_rejected: '❌',
  incoming_offer_pending: '📥',
  transfer_player_refused: '🙅',
  player_sold: '💰',
  offer_declined_by_user: '↩️',
  transfer_interest: '👀',
};

let marketNewsCache = [];
let marketNewsLoaded = false;

function fmtNewsDate(isoDate){
  if(!isoDate) return '';
  const d = new Date(`${isoDate}T00:00:00`);
  if(isNaN(d.getTime())) return '';
  return `${d.getDate()} de ${MONTHS_PT[d.getMonth()]} de ${d.getFullYear()}`;
}

async function loadMarketNews(){
  const list = el('marketNewsList');
  const empty = el('marketNewsEmpty');
  try{
    const res = await fetch('/api/game/news');
    if(!res.ok) throw new Error();
    marketNewsCache = await res.json();
    marketNewsLoaded = true;
    renderMarketNews();
  }catch(err){
    if(!marketNewsLoaded){
      list.innerHTML = '';
      empty.textContent = 'Não foi possível carregar o mercado.';
      empty.classList.remove('hidden');
    }
  }
}

function renderMarketNews(){
  const list = el('marketNewsList');
  const empty = el('marketNewsEmpty');

  if(!marketNewsCache.length){
    list.innerHTML = '';
    empty.textContent = 'Ainda não há movimentações no mercado. Avança o calendário para veres a atividade dos outros clubes.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = marketNewsCache.map((n) => {
    const icon = MARKET_NEWS_ICONS[n.type] || '📰';
    const fromShield = n.from_team_shield ? `<img src="${n.from_team_shield}" alt="">` : (n.from_team_name ? '⚽' : '');
    const toShield = n.to_team_shield ? `<img src="${n.to_team_shield}" alt="">` : (n.to_team_name ? '⚽' : '');
    const teamsLine = n.from_team_name && n.to_team_name
      ? `${n.from_team_name} → ${n.to_team_name}`
      : (n.to_team_name || n.from_team_name || '');

    return `
      <div class="market-news-item" data-news-id="${n.id}">
        <span class="market-news-icon">${icon}</span>
        <div class="market-news-content">
          <div class="market-news-headline">${n.headline}</div>
          <div class="market-news-sub">
            <span class="market-news-teams-mini">${fromShield}${n.from_team_name && n.to_team_name ? '<span class="arrow">→</span>' : ''}${toShield}</span>
            <span>${teamsLine}</span>
            ${n.event_date ? `<span class="market-news-date">· ${fmtNewsDate(n.event_date)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.market-news-item').forEach((item) => {
    item.addEventListener('click', () => openNewsModal(Number(item.dataset.newsId)));
  });
}

function openNewsModal(newsId){
  const n = marketNewsCache.find((item) => item.id === newsId);
  if(!n) return;

  el('newsModalHeadline').textContent = n.headline;
  el('newsModalDate').textContent = n.event_date ? fmtNewsDate(n.event_date) : '';
  el('newsModalBody').textContent = n.body;

  const parts = [];
  if(n.from_team_name){
    parts.push(`<div class="news-modal-team">
      <div class="news-modal-team-shield">${n.from_team_shield ? `<img src="${n.from_team_shield}" alt="">` : '⚽'}</div>
      <span>${n.from_team_name}</span>
    </div>`);
  }
  if(n.from_team_name && n.to_team_name) parts.push('<div class="news-modal-arrow">→</div>');
  if(n.to_team_name){
    parts.push(`<div class="news-modal-team">
      <div class="news-modal-team-shield">${n.to_team_shield ? `<img src="${n.to_team_shield}" alt="">` : '⚽'}</div>
      <span>${n.to_team_name}</span>
    </div>`);
  }
  el('newsModalTeams').innerHTML = parts.join('');

  if(n.amount){
    el('newsModalBody').textContent += `\n\nValor: ${fmtMoney(n.amount)}`;
  }

  el('newsModalOverlay').classList.remove('hidden');
}

function closeNewsModal(){
  el('newsModalOverlay').classList.add('hidden');
}
el('newsModalClose').addEventListener('click', closeNewsModal);
el('newsModalOverlay').addEventListener('click', (e) => {
  if(e.target === el('newsModalOverlay')) closeNewsModal();
});
document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape') closeNewsModal();
});

/* ==========================================================
   Tática — formação, onze inicial (arrastar e largar) e suplentes
   ========================================================== */

/* Cada formação define, por posição, as coordenadas no campo em percentagem
   (x: esquerda→direita, y: 0% = ataque no topo, 100% = a baliza em baixo). */
const FORMATIONS = {
  '4-3-3': [
    { code: 'GR',  x: 50, y: 92 },
    { code: 'DD',  x: 82, y: 74 }, { code: 'DC', x: 62, y: 78 }, { code: 'DC', x: 38, y: 78 }, { code: 'DE', x: 18, y: 74 },
    { code: 'MCD', x: 50, y: 58 }, { code: 'MC', x: 30, y: 50 }, { code: 'MC', x: 70, y: 50 },
    { code: 'ED',  x: 80, y: 26 }, { code: 'PL', x: 50, y: 16 }, { code: 'EE', x: 20, y: 26 },
  ],
  '4-4-2': [
    { code: 'GR', x: 50, y: 92 },
    { code: 'DD', x: 82, y: 74 }, { code: 'DC', x: 62, y: 78 }, { code: 'DC', x: 38, y: 78 }, { code: 'DE', x: 18, y: 74 },
    { code: 'MD', x: 82, y: 50 }, { code: 'MC', x: 62, y: 50 }, { code: 'MC', x: 38, y: 50 }, { code: 'ME', x: 18, y: 50 },
    { code: 'PL', x: 38, y: 20 }, { code: 'PL', x: 62, y: 20 },
  ],
  '4-2-3-1': [
    { code: 'GR', x: 50, y: 92 },
    { code: 'DD', x: 82, y: 74 }, { code: 'DC', x: 62, y: 78 }, { code: 'DC', x: 38, y: 78 }, { code: 'DE', x: 18, y: 74 },
    { code: 'MCD', x: 38, y: 58 }, { code: 'MCD', x: 62, y: 58 },
    { code: 'MOD', x: 78, y: 36 }, { code: 'MCO', x: 50, y: 32 }, { code: 'MOE', x: 22, y: 36 },
    { code: 'PL', x: 50, y: 16 },
  ],
  '3-4-3': [
    { code: 'GR', x: 50, y: 92 },
    { code: 'DC', x: 65, y: 78 }, { code: 'DC', x: 50, y: 82 }, { code: 'DC', x: 35, y: 78 },
    { code: 'MD', x: 82, y: 52 }, { code: 'MC', x: 62, y: 50 }, { code: 'MC', x: 38, y: 50 }, { code: 'ME', x: 18, y: 52 },
    { code: 'ED', x: 78, y: 22 }, { code: 'PL', x: 50, y: 16 }, { code: 'EE', x: 22, y: 22 },
  ],
};

let currentFormation = '4-3-3';
let lineup = {};              // slot_id -> objeto jogador
let bench = new Array(8).fill(null); // 8 posições fixas, null quando vazias
let squadPlayers = [];        // plantel completo do clube (para o pool e para resolver ids)
let tacticsLoaded = false;

function slotAvatarHtml(player){
  return player.photo_path ? `<img src="${player.photo_path}" alt="">` : '🧑';
}

function tacticsRenderAll(){
  renderFormationButtons();
  renderPitch();
  renderBench();
  renderSquadPool();
}

function renderFormationButtons(){
  document.querySelectorAll('.formation-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.formation === currentFormation);
  });
}

function isAssignedElsewhere(playerId){
  if (Object.values(lineup).some((p) => p.id === playerId)) return true;
  if (bench.some((p) => p && p.id === playerId)) return true;
  return false;
}

/* ---------- Getters/setters genéricos para o campo e o banco ---------- */
function getOccupant(targetType, targetKey){
  return targetType === 'pitch' ? (lineup[targetKey] || null) : bench[targetKey];
}
function setOccupant(targetType, targetKey, player){
  if (targetType === 'pitch') {
    if (player) lineup[targetKey] = player; else delete lineup[targetKey];
  } else {
    bench[targetKey] = player;
  }
}
function clearSource(source, sourceKey){
  if (source === 'pitch') delete lineup[sourceKey];
  else if (source === 'bench') bench[sourceKey] = null;
}

function handleDrop(targetType, targetKey, data){
  const incomingPlayer = squadPlayers.find((p) => p.id === data.playerId);
  if (!incomingPlayer) return;

  const occupant = getOccupant(targetType, targetKey);
  if (occupant && occupant.id === incomingPlayer.id && data.source === targetType && String(data.sourceKey) === String(targetKey)) {
    return; // largou em cima de si mesmo
  }

  clearSource(data.source, data.sourceKey);

  if (occupant && occupant.id !== incomingPlayer.id && data.source !== 'pool') {
    // troca de posições
    setOccupant(data.source, data.sourceKey, occupant);
  }

  setOccupant(targetType, targetKey, incomingPlayer);
  tacticsRenderAll();
}

function renderPitch(){
  const formationDef = FORMATIONS[currentFormation];
  const container = el('pitchSlots');

  container.innerHTML = formationDef.map((slotDef, i) => {
    const slotId = `${slotDef.code}_${i}`;
    const player = lineup[slotId];
    const inner = player
      ? `<div class="slot-avatar-wrap">
           <div class="slot-circle">${slotAvatarHtml(player)}</div>
           <span class="slot-jersey">${player.jersey_number || ''}</span>
         </div>
         <button class="slot-remove" data-remove-pitch="${slotId}">×</button>
         <span class="slot-label">${player.name.split(' ')[0]}</span>`
      : `<div class="slot-avatar-wrap"><div class="slot-circle">${slotDef.code}</div></div><span class="slot-label">${slotDef.code}</span>`;
    return `<div class="pitch-slot${player ? ' filled' : ''}" data-slot-id="${slotId}"
                style="left:${slotDef.x}%;top:${slotDef.y}%;" draggable="${player ? 'true' : 'false'}">${inner}</div>`;
  }).join('');

  container.querySelectorAll('.pitch-slot').forEach((slotEl) => {
    const slotId = slotEl.dataset.slotId;

    slotEl.addEventListener('dragover', (e) => { e.preventDefault(); slotEl.classList.add('drag-over'); });
    slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drag-over'));
    slotEl.addEventListener('drop', (e) => {
      e.preventDefault();
      slotEl.classList.remove('drag-over');
      const data = safeParseDnD(e);
      if (data) handleDrop('pitch', slotId, data);
    });

    if (slotEl.getAttribute('draggable') === 'true') {
      slotEl.addEventListener('dragstart', (e) => {
        const player = lineup[slotId];
        e.dataTransfer.setData('text/plain', JSON.stringify({ playerId: player.id, source: 'pitch', sourceKey: slotId }));
      });
    }

    const removeBtn = slotEl.querySelector('[data-remove-pitch]');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        delete lineup[slotId];
        tacticsRenderAll();
      });
    }
  });
}

function renderBench(){
  const container = el('benchSlots');

  container.innerHTML = bench.map((player, i) => {
    if (!player) return `<div class="bench-slot" data-bench-index="${i}"></div>`;
    return `<div class="bench-slot filled" data-bench-index="${i}" draggable="true">
      <div class="slot-avatar-wrap bench">
        <div class="squad-avatar">${slotAvatarHtml(player)}</div>
        <span class="slot-jersey small">${player.jersey_number || ''}</span>
      </div>
      <span class="bench-name">${player.name.split(' ')[0]}</span>
      <button class="slot-remove" data-remove-bench="${i}">×</button>
    </div>`;
  }).join('');

  el('benchCount').textContent = `${bench.filter(Boolean).length} / 8`;

  container.querySelectorAll('.bench-slot').forEach((slotEl) => {
    const idx = Number(slotEl.dataset.benchIndex);

    slotEl.addEventListener('dragover', (e) => { e.preventDefault(); slotEl.classList.add('drag-over'); });
    slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drag-over'));
    slotEl.addEventListener('drop', (e) => {
      e.preventDefault();
      slotEl.classList.remove('drag-over');
      const data = safeParseDnD(e);
      if (data) handleDrop('bench', idx, data);
    });

    if (slotEl.classList.contains('filled')) {
      slotEl.addEventListener('dragstart', (e) => {
        const player = bench[idx];
        e.dataTransfer.setData('text/plain', JSON.stringify({ playerId: player.id, source: 'bench', sourceKey: idx }));
      });
      slotEl.querySelector('[data-remove-bench]').addEventListener('click', (e) => {
        e.stopPropagation();
        bench[idx] = null;
        tacticsRenderAll();
      });
    }
  });
}

function renderSquadPool(){
  const container = el('squadPool');
  const available = squadPlayers.filter((p) => !isAssignedElsewhere(p.id));

  if (!available.length) {
    container.innerHTML = squadPlayers.length
      ? '<p class="placeholder-text">Todos os jogadores já estão colocados no onze ou nos suplentes.</p>'
      : '<p class="placeholder-text">Sem jogadores no plantel.</p>';
    return;
  }

  container.innerHTML = available.map((p) => `
    <div class="pool-chip" data-player-id="${p.id}" draggable="true">
      <div class="squad-avatar">${slotAvatarHtml(p)}</div>
      <div class="pool-chip-info">
        <div class="pool-chip-name">${p.name}</div>
        <div class="pool-chip-pos">${p.position_tag || '—'}</div>
      </div>
      <span class="pool-chip-jersey">#${p.jersey_number || '00'}</span>
    </div>`).join('');

  container.querySelectorAll('.pool-chip').forEach((chip) => {
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ playerId: Number(chip.dataset.playerId), source: 'pool', sourceKey: null }));
    });
  });
}

function safeParseDnD(e){
  try{
    const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
    return data.playerId ? data : null;
  }catch(err){
    return null;
  }
}

/* Largar de volta no plantel desmarca o jogador (fica só ligado uma vez, o
   contentor nunca é recriado — só o innerHTML muda). */
el('squadPool').addEventListener('dragover', (e) => e.preventDefault());
el('squadPool').addEventListener('drop', (e) => {
  e.preventDefault();
  const data = safeParseDnD(e);
  if (!data || data.source === 'pool') return;
  clearSource(data.source, data.sourceKey);
  tacticsRenderAll();
});

/* ---------- Trocar de formação ---------- */
document.querySelectorAll('.formation-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.formation === currentFormation) return;
    currentFormation = btn.dataset.formation;
    lineup = {}; // as posições da formação anterior deixam de fazer sentido
    renderFormationButtons();
    renderPitch();
    renderSquadPool();
  });
});

/* ---------- Guardar tática ---------- */
el('saveTacticBtn').addEventListener('click', async () => {
  const status = el('tacticSaveStatus');
  status.textContent = 'A guardar…';

  const lineupPayload = Object.entries(lineup).map(([slotId, player]) => ({
    slot_id: slotId, code: slotId.split('_')[0], player_id: player.id,
  }));
  const benchPayload = bench.filter(Boolean).map((p) => p.id);

  try{
    const res = await fetch(`/api/tactics/${teamId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formation: currentFormation, lineup: lineupPayload, bench: benchPayload }),
    });
    if (!res.ok) throw new Error();
    status.textContent = 'Tática guardada ✔';
  }catch(err){
    status.textContent = 'Não foi possível guardar a tática.';
  }finally{
    clearTimeout(el('saveTacticBtn')._statusTimer);
    el('saveTacticBtn')._statusTimer = setTimeout(() => { status.textContent = ''; }, 3500);
  }
});

/* ---------- Carregar tática + plantel ---------- */
async function loadTactics(){
  try{
    const [playersRes, tacticRes] = await Promise.all([
      fetch(`/api/players?team_id=${teamId}`),
      fetch(`/api/tactics/${teamId}`),
    ]);
    if (!playersRes.ok || !tacticRes.ok) throw new Error();

    squadPlayers = await playersRes.json();
    const tactic = await tacticRes.json();

    currentFormation = FORMATIONS[tactic.formation] ? tactic.formation : '4-3-3';

    lineup = {};
    (tactic.lineup || []).forEach((entry) => {
      const player = squadPlayers.find((p) => p.id === entry.player_id);
      if (player) lineup[entry.slot_id] = player;
    });

    bench = new Array(8).fill(null);
    (tactic.bench || []).slice(0, 8).forEach((playerId, i) => {
      const player = squadPlayers.find((p) => p.id === playerId);
      if (player) bench[i] = player;
    });

    tacticsLoaded = true;
    tacticsRenderAll();
  }catch(err){
    el('pitchSlots').innerHTML = '';
    el('squadPool').innerHTML = '<p class="placeholder-text">Não foi possível carregar a tática.</p>';
  }
}