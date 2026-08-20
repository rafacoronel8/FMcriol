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

function tierClass(tier){
  const t = String(tier || '').toLowerCase();
  if(t.includes('muito rico') || t === 'rico') return 'tier-good';
  if(t.includes('muito pobre') || t === 'pobre') return 'tier-bad';
  return 'tier-mid';
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
      body: JSON.stringify({ team_id: teamId, manager_name: managerName }),
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

  updateBudgetRegulator(team);

  el('dDivision').textContent = team.division === 2 ? '2ª Divisão' : '1ª Divisão';
  el('dReputation').textContent = '★'.repeat(Math.round(team.reputation_stars)) + '☆'.repeat(5 - Math.round(team.reputation_stars)) + ` (${team.reputation_stars})`;
  el('dLocation').textContent = team.location || 'Não definida';
  el('dStadium').textContent = team.stadium_name || 'Não definido';

  el('clubHeroShield').innerHTML = team.shield_path ? `<img src="${team.shield_path}" alt="${team.name}">` : '⚽';
  el('clubHeroName').textContent = team.name;
  el('clubHeroDivision').textContent = team.division === 2 ? '2ª Divisão' : '1ª Divisão';
  el('clubHeroStars').textContent = '★'.repeat(Math.round(team.reputation_stars)) + '☆'.repeat(5 - Math.round(team.reputation_stars)) + ` ${team.reputation_stars}`;
  const tierEl = el('clubHeroTier');
  tierEl.textContent = team.financial_tier;
  tierEl.className = 'club-hero-tier ' + tierClass(team.financial_tier);
}

/* ---------- Regulador de Orçamento: salários ⇄ transferências ----------
   Mesmo rácio de câmbio usado no servidor (ver BUDGET_EXCHANGE_RATE em
   routes/teams.js) — tem de ser exatamente o mesmo dos dois lados, senão a
   pré-visualização ao arrastar o cursor não bate certo com o valor
   gravado ao soltar. */
const BUDGET_EXCHANGE_RATE = 50;
let budgetTotalUnits = 0; // recalculado sempre que os dados do clube chegam

function updateBudgetRegulator(team){
  budgetTotalUnits = team.transfer_budget + team.wage_budget * BUDGET_EXCHANGE_RATE;
  const pct = budgetTotalUnits > 0 ? Math.round((team.transfer_budget / budgetTotalUnits) * 100) : 50;

  const slider = el('budgetSplitSlider');
  slider.value = pct;
  el('budgetWagePreview').textContent = fmtMoney(team.wage_budget) + ' / sem';
  el('budgetTransferPreview').textContent = fmtMoney(team.transfer_budget);
}

/* Enquanto arrastas: só pré-visualiza os valores, sem gravar a cada frame */
el('budgetSplitSlider').addEventListener('input', (e) => {
  const pct = Number(e.target.value);
  const newTransfer = Math.round(budgetTotalUnits * (pct / 100));
  const newWage = Math.round((budgetTotalUnits - newTransfer) / BUDGET_EXCHANGE_RATE);
  el('budgetWagePreview').textContent = fmtMoney(newWage) + ' / sem';
  el('budgetTransferPreview').textContent = fmtMoney(newTransfer);
});

/* Ao soltares o cursor: grava a nova distribuição no servidor */
el('budgetSplitSlider').addEventListener('change', async (e) => {
  const pct = Number(e.target.value);
  try{
    const res = await fetch(`/api/teams/${teamId}/budget-split`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transfer_pct: pct }),
    });
    if(!res.ok) throw new Error();
    const team = await res.json();
    fillClub(team);
  }catch(err){
    loadClub(); // repõe os valores reais se a gravação falhar
  }
});

/* ---------- Visão Geral: próximo jogo, posição na tabela, resumo do plantel ---------- */
function renderOverviewNextMatch(list){
  const box = el('overviewNextMatch');
  const next = (list || [])
    .filter((f) => f.status !== 'played')
    .sort((a, b) => (a.match_date < b.match_date ? -1 : 1))[0];

  if(!next){
    box.innerHTML = '<p class="placeholder-text">Sem jogos marcados.</p>';
    return;
  }

  const isHome = String(next.home_team_id) === String(teamId);
  const opponentName = isHome ? next.away_name : next.home_name;
  const opponentShield = isHome ? next.away_shield : next.home_shield;
  const competition = next.is_cup ? 'Taça São Vicente' : (next.is_league ? 'Campeonato' : 'Amigável');

  box.innerHTML = `
    <div class="overview-next-match-row">
      <span class="friendly-shield">${opponentShield ? `<img src="${opponentShield}" alt="">` : '⚽'}</span>
      <div>
        <div class="overview-next-opponent">${isHome ? 'vs' : '@'} ${opponentName}</div>
        <div class="overview-next-meta">${competition} · ${fmtShortDate(next.match_date)}</div>
      </div>
    </div>`;
}

async function loadOverviewLeague(){
  try{
    const res = await fetch(`/api/league/${teamId}`);
    if(!res.ok) throw new Error();
    const data = await res.json();
    const box = el('overviewLeague');

    if(!data.season_started){
      box.innerHTML = `<p class="placeholder-text">O Campeonato começa a ${fmtPt(data.season_start)}.</p>`;
      return;
    }

    const mine = (data.standings || []).find((t) => String(t.team_id) === String(teamId));
    if(!mine){
      box.innerHTML = '<p class="placeholder-text">Sem dados do Campeonato.</p>';
      return;
    }

    box.innerHTML = `
      <div class="finance-row"><span>Posição</span><b>${mine.position}º de ${data.standings.length}</b></div>
      <div class="finance-row"><span>Registo</span><b>${mine.v}V ${mine.e}E ${mine.d}D</b></div>
      <div class="finance-row"><span>Golos</span><b>${mine.gp}-${mine.gc} (${mine.sg > 0 ? '+' : ''}${mine.sg})</b></div>
      <div class="finance-row"><span>Pontos</span><b>${mine.pts}</b></div>
    `;
  }catch(err){
    // mantém o estado anterior se falhar
  }
}

function loadOverview(){
  renderOverviewNextMatch(upcomingFriendliesCache);
  loadOverviewLeague();
  loadStaffPanels();
}

/* ---------- Meu Clube: comissão técnica (ver aba, e admin/gestaoStaff.html) ---------- */
const STAFF_ROLE_CLASS = {
  'Adjunto': 'role-adjunto',
  'Fisioterapeuta': 'role-fisioterapeuta',
  'Preparador Físico': 'role-preparador',
};
const STAFF_ROLE_ICON = {
  'Adjunto': '🧠',
  'Fisioterapeuta': '💉',
  'Preparador Físico': '🏋️',
};

function staffStars(value){
  const rounded = Math.round(Number(value) || 0);
  return '★'.repeat(rounded) + '☆'.repeat(5 - rounded);
}

async function loadStaffPanels(){
  try{
    const [hiredRes, availableRes] = await Promise.all([
      fetch(`/api/staff?team_id=${teamId}`),
      fetch('/api/staff?available=1'),
    ]);
    const hired = hiredRes.ok ? await hiredRes.json() : [];
    const available = availableRes.ok ? await availableRes.json() : [];
    renderStaffHired(hired);
    renderStaffAvailable(available);
  }catch(err){
    // mantém o estado anterior se falhar
  }
}

function renderStaffHired(list){
  const box = el('staffHired');
  const empty = el('staffHiredEmpty');
  if(!list.length){
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  box.innerHTML = list.map((s) => `
    <div class="staff-hired-card">
      <div class="staff-hired-avatar">${STAFF_ROLE_ICON[s.role] || '🧑'}</div>
      <div class="staff-hired-info">
        <div class="staff-hired-name">${s.name}</div>
        <span class="staff-role-pill ${STAFF_ROLE_CLASS[s.role] || ''}">${s.role}</span>
        <div class="staff-hired-stars">${staffStars(s.quality_stars)}</div>
      </div>
      <button class="staff-release-btn" data-id="${s.id}" title="Despedir">✕</button>
    </div>`).join('');

  box.querySelectorAll('.staff-release-btn').forEach((btn) => {
    btn.addEventListener('click', () => releaseStaff(btn.dataset.id));
  });
}

function renderStaffAvailable(list){
  const box = el('staffAvailable');
  const empty = el('staffAvailableEmpty');
  el('staffAvailableCount').textContent = list.length;

  if(!list.length){
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  box.innerHTML = list.map((s) => `
    <div class="staff-available-row">
      <div class="staff-hired-avatar">${STAFF_ROLE_ICON[s.role] || '🧑'}</div>
      <div class="staff-hired-info">
        <div class="staff-hired-name">${s.name}</div>
        <span class="staff-role-pill ${STAFF_ROLE_CLASS[s.role] || ''}">${s.role}</span>
        <div class="staff-hired-stars">${staffStars(s.quality_stars)}</div>
      </div>
      <div class="staff-hire-action">
        ${s.hire_fee ? `<span class="staff-hire-fee">${fmtMoney(s.hire_fee)}</span>` : '<span class="staff-hire-fee">Grátis</span>'}
        <button class="btn-advance small" data-id="${s.id}">Contratar</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => hireStaff(btn.dataset.id, btn));
  });
}

async function hireStaff(id, btn){
  btn.disabled = true;
  btn.textContent = 'A contratar…';
  try{
    const res = await fetch(`/api/staff/${id}/hire`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: teamId }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível contratar');
    await loadStaffPanels();
    await loadClub();
  }catch(err){
    btn.disabled = false;
    btn.textContent = 'Contratar';
    alert(err.message);
  }
}

async function releaseStaff(id){
  if(!confirm('Despedir este membro da comissão técnica? Volta para a bolsa de contratação.')) return;
  try{
    const res = await fetch(`/api/staff/${id}/release`, { method: 'PUT' });
    if(!res.ok) throw new Error();
    await loadStaffPanels();
  }catch(err){
    // sem feedback especial — a lista simplesmente não muda
  }
}

/* ---------- Tabs ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    tab.classList.add('active');
    el(`panel-${tab.dataset.tab}`).classList.remove('hidden');
    if (tab.dataset.tab === 'minhaEquipa') loadSquad();
    if (tab.dataset.tab === 'inscritos') loadInscritos();
    if (tab.dataset.tab === 'tatica') loadTactics();
    if (tab.dataset.tab === 'mercado') { loadMarketNews(); loadWindowSummary(); }
    if (tab.dataset.tab === 'campeonato') loadLeague();
    if (tab.dataset.tab === 'taca') loadCup();
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
      const isStoodDown = p.stood_down_until && p.stood_down_until >= currentGameDate;
      const standDownPill = isStoodDown ? `<span class="squad-pill squad-pill-standdown">🚫 Afastado</span>` : '';
      return `
        <div class="squad-card${isStoodDown ? ' squad-card-standdown' : ''}">
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
              ${standDownPill}
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

/* ---------- Inscritos: números da camisola ---------- */
function renderInscritos(players){
  const box = el('inscritosList');
  const empty = el('inscritosEmpty');
  el('inscritosCount').textContent = players.length;

  if(!players.length){
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const numberCounts = {};
  players.forEach((p) => {
    const n = String(p.jersey_number || '').trim();
    if(n) numberCounts[n] = (numberCounts[n] || 0) + 1;
  });

  box.innerHTML = players.map((p) => {
    const avatar = p.photo_path ? `<img src="${p.photo_path}" alt="">` : '🧑';
    const n = String(p.jersey_number || '').trim();
    const isDuplicate = n && numberCounts[n] > 1;
    return `
      <div class="inscritos-row" data-id="${p.id}">
        <div class="inscritos-avatar">${avatar}</div>
        <div class="inscritos-info">
          <div class="inscritos-name">${p.name}</div>
          <div class="inscritos-position">${p.position_tag || 'Posição não definida'}</div>
        </div>
        <label class="inscritos-jersey-field${isDuplicate ? ' inscritos-jersey-dup' : ''}">
          <span>Nº</span>
          <input type="text" inputmode="numeric" maxlength="2" class="inscritos-jersey-input" value="${p.jersey_number || ''}">
        </label>
      </div>`;
  }).join('');

  box.querySelectorAll('.inscritos-jersey-input').forEach((input) => {
    input.addEventListener('change', () => saveJerseyNumber(input));
  });
}

async function saveJerseyNumber(input){
  const row = input.closest('.inscritos-row');
  const playerId = row.dataset.id;
  const value = input.value.trim();

  input.disabled = true;
  try{
    const res = await fetch(`/api/players/${playerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jersey_number: value }),
    });
    if(!res.ok) throw new Error();
    await loadInscritos(); // recarrega para atualizar avisos de números repetidos
  }catch(err){
    input.disabled = false;
    input.classList.add('inscritos-jersey-error');
    setTimeout(() => input.classList.remove('inscritos-jersey-error'), 1500);
  }
}

async function loadInscritos(){
  try{
    const res = await fetch(`/api/players?team_id=${teamId}`);
    if(!res.ok) throw new Error();
    const players = await res.json();
    players.sort((a, b) => {
      const na = Number(a.jersey_number) || 999;
      const nb = Number(b.jersey_number) || 999;
      return na - nb || a.name.localeCompare(b.name);
    });
    renderInscritos(players);
  }catch(err){
    el('inscritosList').innerHTML = '';
    el('inscritosEmpty').textContent = 'Não foi possível carregar o plantel.';
    el('inscritosEmpty').classList.remove('hidden');
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

/* ---------- Caixa de entrada (duas colunas: lista + detalhe, como o FM) ---------- */
let knownMessageIds = new Set();
let seenMessageIds = new Set(); // só nesta sessão — marca como "lida" ao abrir
let messagesCache = [];
let selectedMessageId = null;

async function loadMessages(notify = false){
  try{
    const res = await fetch(`/api/transfers/messages?team_id=${teamId}`);
    if(!res.ok) throw new Error();
    const messages = await res.json();
    messagesCache = messages;
    renderMessageList(messages);

    // mantém a mesma mensagem selecionada se ainda existir (ex: depois de a resolver);
    // caso contrário, seleciona a primeira (tal como o FM abre sempre a mais recente).
    const stillExists = messages.find((m) => m.id === selectedMessageId);
    if(stillExists){
      selectMessage(stillExists.id);
    }else if(messages.length){
      selectMessage(messages[0].id);
    }else{
      selectedMessageId = null;
      renderMessageDetail(null);
    }

    const currentIds = new Set(messages.map((m) => m.id));
    if(notify){
      const newCount = messages.filter((m) => !knownMessageIds.has(m.id)).length;
      if(newCount > 0) showNewMessageToast(newCount);
    }
    knownMessageIds = currentIds;

    // Fim de época: assim que aparece o aviso de que a época terminou (ainda
    // por ler), abre a cerimónia de prémios em vez de esperar que o
    // utilizador vá procurar a mensagem na caixa de entrada.
    const rolloverMsg = messages.find((m) => m.type === 'season_rollover' && !m.is_read);
    if(rolloverMsg) maybeOpenAwardsCeremony(rolloverMsg.id);
  }catch(err){
    // mantém o estado anterior se a caixa de entrada não carregar
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
  welcome: '🎉',
  loyalty_boost: '🤝',
  player_incident: '⚠️',
  manager_question: '💬',
  league_played: '🏆',
  cup_played: '🏆',
  friendly_played: '⚽',
  staff_hired: '✍️',
  assistant_report: '📋',
  season_rollover: '📅',
  trophy_won: '🏆',
  award_won: '🏅',
  transfer_meeting: '🗣️',
  loan_agreed: '🔄',
  loan_returned: '↩️',
};

function truncateText(text, n){
  if(!text) return '';
  return text.length > n ? text.slice(0, n - 1).trimEnd() + '…' : text;
}

function fmtMessageTimestamp(createdAt){
  if(!createdAt) return '';
  const [datePart, timePart] = createdAt.split(' ');
  const [y, m, d] = (datePart || '').split('-');
  const hm = (timePart || '').slice(0, 5);
  return d ? `${hm} · ${d}/${m}` : hm;
}

function messageNeedsResponse(m){
  return (m.type === 'incoming_offer_pending' && m.offer_status === 'pending')
    || (m.type === 'player_incident' && m.incident_status === 'pending')
    || (m.type === 'manager_question' && m.question_status === 'pending')
    || (m.type === 'transfer_meeting' && m.meeting_status === 'pending');
}

function messageSmallAvatar(m){
  if(m.player_photo) return `<img src="${m.player_photo}" alt="">`;
  if(m.related_team_shield) return `<img src="${m.related_team_shield}" alt="">`;
  if(m.my_team_shield) return `<img src="${m.my_team_shield}" alt="">`;
  return MESSAGE_ICONS[m.type] || '📋';
}

function renderMessageList(messages){
  el('inboxCount').textContent = messages.length;

  if(!messages.length){
    el('messagesList').innerHTML = '<p class="placeholder-text">Sem mensagens de momento.</p>';
    return;
  }

  el('messagesList').innerHTML = messages.map((m) => {
    const needsResponse = messageNeedsResponse(m);
    const unread = !seenMessageIds.has(m.id);
    const rowClasses = [
      'inbox-row',
      m.id === selectedMessageId ? 'inbox-row-active' : '',
      needsResponse ? 'inbox-row-flag' : '',
      unread ? 'inbox-row-unread' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${rowClasses}" data-id="${m.id}">
        <div class="inbox-row-icon">${messageSmallAvatar(m)}</div>
        <div class="inbox-row-text">
          <div class="inbox-row-title">${m.title}</div>
          <div class="inbox-row-snippet">${truncateText(m.body, 64)}</div>
        </div>
        <div class="inbox-row-meta">
          ${needsResponse ? '<span class="inbox-row-badge">!</span>' : ''}
          <span class="inbox-row-date">${fmtMessageTimestamp(m.created_at)}</span>
        </div>
      </div>`;
  }).join('');

  el('messagesList').querySelectorAll('.inbox-row').forEach((row) => {
    row.addEventListener('click', () => selectMessage(Number(row.dataset.id)));
  });
}

function selectMessage(id){
  selectedMessageId = id;
  seenMessageIds.add(id);

  el('messagesList').querySelectorAll('.inbox-row').forEach((row) => {
    const isActive = Number(row.dataset.id) === id;
    row.classList.toggle('inbox-row-active', isActive);
    row.classList.remove('inbox-row-unread');
  });

  const message = messagesCache.find((m) => m.id === id);
  renderMessageDetail(message);
}

function renderMessageDetail(m){
  const box = el('inboxDetail');
  if(!m){
    box.innerHTML = `
      <div class="inbox-detail-empty">
        <span class="inbox-detail-empty-icon">📭</span>
        <p class="placeholder-text">Sem mensagens de momento.</p>
      </div>`;
    return;
  }

  const avatarParts = [];
  if(m.related_team_shield) avatarParts.push(`<div class="inbox-detail-avatar shield"><img src="${m.related_team_shield}" alt=""></div>`);
  if(m.player_photo) avatarParts.push(`<div class="inbox-detail-avatar photo"><img src="${m.player_photo}" alt=""></div>`);
  else if(m.player_name) avatarParts.push(`<div class="inbox-detail-avatar photo">🧑</div>`);
  if(m.my_team_shield) avatarParts.push(`<div class="inbox-detail-avatar shield"><img src="${m.my_team_shield}" alt=""></div>`);
  const avatarsHtml = avatarParts.length
    ? `<div class="inbox-detail-avatars">${avatarParts.join('<span class="inbox-detail-avatar-sep">→</span>')}</div>`
    : `<div class="inbox-detail-avatars"><div class="inbox-detail-avatar icon-only">${MESSAGE_ICONS[m.type] || '📋'}</div></div>`;

  const needsResponse = messageNeedsResponse(m);
  const banner = needsResponse ? `<div class="msg-required-banner">⚠ Resposta necessária</div>` : '';

  const highlight = (m.type === 'incoming_offer_pending' && m.offer_amount)
    ? `<div class="inbox-detail-highlight">💷 Proposta: <b>${fmtMoney(m.offer_amount)}</b></div>` : '';

  let actions = '';
  const isPendingOffer = m.type === 'incoming_offer_pending' && m.offer_status === 'pending';
  const isPendingIncident = m.type === 'player_incident' && m.incident_status === 'pending';
  const isPendingQuestion = m.type === 'manager_question' && m.question_status === 'pending';

  if(isPendingOffer){
    actions = `<div class="msg-actions" data-offer-id="${m.transfer_offer_id}">
         <button class="msg-btn msg-btn-accept" data-action="accept">Aceitar</button>
         <button class="msg-btn msg-btn-reject" data-action="reject">Recusar</button>
       </div>`;
  }else if(m.type === 'incoming_offer_pending'){
    actions = `<p class="msg-decision-note">${m.offer_status === 'accepted' ? 'Proposta aceite.' : 'Proposta recusada.'}</p>`;
  }else if(isPendingIncident){
    actions = `<div class="msg-actions" data-incident-id="${m.incident_id}">
         <button class="msg-btn msg-btn-reject" data-action="transfer_list">Lista de Transferências</button>
         <button class="msg-btn msg-btn-neutral" data-action="stand_down">Afastar Temporariamente</button>
         <button class="msg-btn msg-btn-neutral" data-action="ignore">Ignorar</button>
       </div>`;
  }else if(m.type === 'player_incident' && m.incident_resolution){
    actions = `<p class="msg-decision-note">${m.incident_resolution}</p>`;
  }else if(isPendingQuestion){
    let options = [];
    try{ options = JSON.parse(m.question_options_json || '[]'); }catch(err){ options = []; }
    actions = `<div class="msg-actions msg-actions-question" data-question-id="${m.question_id}">
         ${options.map((o) => `<button class="msg-btn msg-btn-neutral" data-action="${o.key}">${o.label}</button>`).join('')}
       </div>`;
  }else if(m.type === 'transfer_meeting' && m.meeting_status === 'pending'){
    actions = `<div class="msg-actions" data-meeting-id="${m.meeting_id}">
         <button class="msg-btn msg-btn-neutral" data-action="loan">Propor Empréstimo</button>
         <button class="msg-btn msg-btn-reject" data-action="not_in_plans">Não faz parte dos meus planos</button>
       </div>`;
  }else if(m.type === 'transfer_meeting' && m.meeting_resolution){
    actions = `<p class="msg-decision-note">${m.meeting_resolution}</p>`;
  }

  box.innerHTML = `
    <div class="inbox-detail-header">
      ${avatarsHtml}
      <div class="inbox-detail-heading">
        <div class="inbox-detail-title">${m.title}</div>
        <div class="inbox-detail-date">${fmtMessageTimestamp(m.created_at)}</div>
      </div>
    </div>
    ${banner}
    ${highlight}
    <div class="inbox-detail-body">${m.body}</div>
    ${actions}
  `;

  const actionsBox = box.querySelector('.msg-actions');
  if(actionsBox){
    if(actionsBox.dataset.offerId){
      actionsBox.querySelectorAll('.msg-btn').forEach((btn) => {
        btn.addEventListener('click', () => respondToOffer(actionsBox.dataset.offerId, btn.dataset.action === 'accept', actionsBox));
      });
    }else if(actionsBox.dataset.incidentId){
      actionsBox.querySelectorAll('.msg-btn').forEach((btn) => {
        btn.addEventListener('click', () => respondToIncident(actionsBox.dataset.incidentId, btn.dataset.action, actionsBox));
      });
    }else if(actionsBox.dataset.questionId){
      actionsBox.querySelectorAll('.msg-btn').forEach((btn) => {
        btn.addEventListener('click', () => respondToQuestion(actionsBox.dataset.questionId, btn.dataset.action, actionsBox));
      });
    }else if(actionsBox.dataset.meetingId){
      actionsBox.querySelectorAll('.msg-btn').forEach((btn) => {
        btn.addEventListener('click', () => respondToMeeting(actionsBox.dataset.meetingId, btn.dataset.action, actionsBox));
      });
    }
  }
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
    loadOverview();
  }catch(err){
    actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = false));
    actionsBox.insertAdjacentHTML('afterend', '<p class="msg-decision-note">Não foi possível responder à proposta.</p>');
  }
}

/* ---------- Responder a um incidente de personalidade ---------- */
async function respondToIncident(incidentId, action, actionsBox){
  const body = { action };

  if(action === 'stand_down'){
    const daysText = window.prompt('Durante quantos dias fica o jogador afastado do plantel?', '7');
    if(daysText === null) return; // cancelou
    const days = Number(daysText);
    if(!days || days <= 0){
      actionsBox.insertAdjacentHTML('afterend', '<p class="msg-decision-note">Número de dias inválido.</p>');
      return;
    }
    body.duration_days = days;
  }else if(action === 'transfer_list'){
    const priceText = window.prompt('Por quanto colocas o jogador na lista de transferências? (deixa em branco para um valor automático)', '');
    if(priceText === null) return; // cancelou
    if(priceText.trim()) body.asking_price = Number(priceText);
  }

  actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = true));
  try{
    const res = await fetch(`/api/morale/incidents/${incidentId}/respond`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if(!res.ok) throw new Error();
    await loadMessages();
    await loadSquad();
    loadOverview();
  }catch(err){
    actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = false));
    actionsBox.insertAdjacentHTML('afterend', '<p class="msg-decision-note">Não foi possível registar a decisão.</p>');
  }
}

/* ---------- Responder a uma pergunta do treinador ---------- */
async function respondToQuestion(questionId, optionKey, actionsBox){
  actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = true));
  try{
    const res = await fetch(`/api/morale/questions/${questionId}/respond`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option_key: optionKey }),
    });
    if(!res.ok) throw new Error();
    await loadMessages();
  }catch(err){
    actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = false));
    actionsBox.insertAdjacentHTML('afterend', '<p class="msg-decision-note">Não foi possível responder.</p>');
  }
}

/* ---------- Responder a uma reunião de transferência (jogador hesitante) ---------- */
async function respondToMeeting(meetingId, action, actionsBox){
  actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = true));
  try{
    const res = await fetch(`/api/transfers/meetings/${meetingId}/respond`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if(!res.ok) throw new Error();
    await loadMessages();
    await loadClub();
    loadOverview();
  }catch(err){
    actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = false));
    actionsBox.insertAdjacentHTML('afterend', '<p class="msg-decision-note">Não foi possível registar a decisão.</p>');
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
    updateTodayMatchBanner();
  }catch(err){
    // mantém o traço se o calendário não carregar
  }
}
loadGameState();

async function advanceDay(){
  const btn = el('advanceDayBtn');
  const topbarBtn = el('topbarAdvanceBtn');
  const resultEl = el('advanceResult');
  [btn, topbarBtn].forEach((b) => { if(b){ b.disabled = true; b.textContent = 'A avançar…'; } });
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
    const freeAgentSignings = data.free_agent_signings || [];
    const friendlyResults = data.friendly_results || [];
    const leagueResults = data.league_results || [];
    const cupResults = data.cup_results || [];
    const notes = [];

    if(data.sales && data.sales.length){
      notes.push(data.sales.length === 1
        ? `${data.sales[0].player_name} foi vendido ao ${data.sales[0].buyer_team}!`
        : `${data.sales.length} jogadores da tua lista de transferências foram vendidos!`);
    }else if(aiMoves.length){
      notes.push(`${aiMoves.length === 1 ? 'Houve 1 transferência' : `Houve ${aiMoves.length} transferências`} noutros clubes.`);
    }
    if(freeAgentSignings.length){
      notes.push(`${freeAgentSignings.length === 1 ? '1 jogador livre assinou' : `${freeAgentSignings.length} jogadores livres assinaram`} por outros clubes.`);
    }

    const myClubName = el('clubName').textContent;
    const myFriendly = friendlyResults.find((f) => (f.home_team === myClubName || f.away_team === myClubName));
    if(myFriendly){
      const label = myFriendly.is_cup ? 'Taça São Vicente' : (myFriendly.is_league ? 'Campeonato' : 'Amigável');
      notes.push(`${label}: ${myFriendly.home_team} ${myFriendly.home_score}-${myFriendly.away_score} ${myFriendly.away_team}.`);
    }
    if(leagueResults.length){
      notes.push(`${leagueResults.length === 1 ? '1 jogo do Campeonato foi disputado' : `${leagueResults.length} jogos do Campeonato foram disputados`} noutros clubes.`);
    }
    if(cupResults.length){
      notes.push(`${cupResults.length === 1 ? '1 jogo da Taça São Vicente foi disputado' : `${cupResults.length} jogos da Taça São Vicente foram disputados`} noutros clubes.`);
    }
    if(!el('panel-taca').classList.contains('hidden')) loadCup();

    resultEl.textContent = notes.length ? notes.join(' ') : 'Nenhuma novidade hoje.';

    await loadMessages(true);
    await loadClub(); // refresca orçamentos, caso algum jogador tenha sido vendido
    await loadActivities();
    await loadFriendlies();
    if(!el('panel-campeonato').classList.contains('hidden')) loadLeague();
    marketNewsLoaded = false; // força atualização da próxima vez que a tab Mercado abrir
  }catch(err){
    resultEl.textContent = err.message;
  }finally{
    [btn, topbarBtn].forEach((b) => { if(b){ b.disabled = false; b.textContent = 'Continuar ▸'; } });
  }
}

el('advanceDayBtn').addEventListener('click', advanceDay);
el('topbarAdvanceBtn').addEventListener('click', advanceDay);

/* ---------- Atividades (treino a cada 7 dias) ---------- */
function fmtPt(isoDate){
  if(!isoDate) return '';
  return isoDate.split('-').reverse().join('/');
}

async function loadActivities(){
  const grid = el('activityGrid');
  const hint = el('activityStatusHint');
  const resultBox = el('activityResult');
  try{
    const res = await fetch(`/api/activities/${teamId}`);
    if(!res.ok) throw new Error();
    const data = await res.json();
    const lock = data.training_lock;

    if(lock){
      hint.textContent = `Podes treinar outra vez a ${fmtPt(lock.available_on)} (${lock.days_remaining} dia${lock.days_remaining === 1 ? '' : 's'})`;
      resultBox.textContent = lock.summary || '';
      resultBox.classList.remove('hidden');
    }else{
      hint.textContent = 'Escolhe uma atividade';
      resultBox.classList.add('hidden');
    }

    grid.innerHTML = data.activities.map((a) => {
      const isDone = lock && lock.activity_key === a.key;
      const disabled = !!lock;
      return `
        <button type="button" class="activity-btn${isDone ? ' done' : ''}" data-key="${a.key}" ${disabled ? 'disabled' : ''}>
          <span class="activity-icon">${a.icon}</span>
          <span class="activity-name">${a.name}</span>
          <span class="activity-desc">${a.description}</span>
          ${isDone ? `<span class="activity-done-tag">✓ Feito a ${fmtPt(lock.done_on)}</span>` : ''}
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
  // Mesma correção do lado do servidor: soma o dia só com os números da
  // data, sem passar por um objeto Date + toISOString (isso é o que causava
  // o campo a assumir a data real do computador em vez da data do jogo).
  const [y, m, d] = currentGameDate.split('-').map(Number);
  const utcNoon = Date.UTC(y, m - 1, d, 12);
  const next = new Date(utcNoon + 24 * 60 * 60 * 1000);
  const yyyy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  const nextIso = `${yyyy}-${mm}-${dd}`;
  const field = el('friendlyDate');
  field.min = nextIso;
  // Sempre que a data do jogo muda, o campo tem de acompanhar — nunca deve
  // ficar a mostrar uma data avulsa (ex: autopreenchida pelo browser de uma
  // sessão anterior) que já não bate certo com o calendário atual.
  if(!field.value || field.value < nextIso) field.value = nextIso;
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
        <thead><tr><th>Jogador</th><th class="num">G</th><th class="num">A</th><th class="num">Cartões</th><th class="num">Nota</th></tr></thead>
        <tbody>
          ${players.map((p) => `
            <tr>
              <td>${p.player_name}</td>
              <td class="num">${p.goals}</td>
              <td class="num">${p.assists}</td>
              <td class="num">${'🟨'.repeat(p.yellow_cards || 0)}${p.red_card ? '🟥' : ''}</td>
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

let upcomingFriendliesCache = [];

async function loadFriendlies(){
  try{
    const res = await fetch(`/api/friendlies/${teamId}`);
    if(!res.ok) throw new Error();
    const data = await res.json();
    // upcomingFriendliesCache guarda TUDO (incluindo jornadas do Campeonato
    // convertidas em "amigável" interno — ver is_league), porque é isto que
    // alimenta o banner "Jogo de Hoje" e o jogo ao vivo. As listas visíveis
    // de Amigáveis, no entanto, só mostram amigáveis reais.
    upcomingFriendliesCache = data.upcoming || [];
    renderFriendlyUpcoming(upcomingFriendliesCache.filter((f) => !f.is_league && !f.is_cup));
    renderFriendlyHistory((data.history || []).filter((f) => !f.is_league && !f.is_cup));
    updateTodayMatchBanner();
    loadOverview();
  }catch(err){
    // mantém o estado anterior se falhar
  }
}

/* ---------- Banner "Jogo de Hoje" — aparece quando há um amigável marcado
   para a data atual do calendário, com um botão para o assistir ao vivo. ---------- */
function updateTodayMatchBanner(){
  const banner = el('todayMatchBanner');
  if(!currentGameDate){ banner.classList.add('hidden'); return; }
  const todayMatch = upcomingFriendliesCache.find((f) => f.match_date === currentGameDate);
  if(!todayMatch){ banner.classList.add('hidden'); return; }

  el('todayMatchTeams').innerHTML =
    `${friendlyTeamHtml(todayMatch.home_name, todayMatch.home_shield)} <span class="friendly-vs">vs</span> ${friendlyTeamHtml(todayMatch.away_name, todayMatch.away_shield)}`;
  banner.classList.remove('hidden');
  el('watchTodayMatchBtn').onclick = () => openLiveMatch(todayMatch.id);
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

/* ---------- Campeonato: tabela classificativa + calendário ---------- */
function leagueTeamHtml(name, shieldPath){
  const shield = shieldPath ? `<img src="${shieldPath}" alt="">` : '⚽';
  return `<span class="friendly-shield">${shield}</span><span>${name}</span>`;
}

function renderLeagueTable(standings){
  const body = el('leagueTableBody');
  body.innerHTML = standings.map((t) => `
    <tr class="${String(t.team_id) === String(teamId) ? 'league-row-me' : ''}">
      <td class="league-pos">${t.position}</td>
      <td>
        <div class="league-team-cell">
          <span class="league-team-shield">${t.shield_path ? `<img src="${t.shield_path}" alt="">` : '⚽'}</span>
          <span>${t.name}</span>
        </div>
      </td>
      <td class="num">${t.pj}</td>
      <td class="num">${t.v}</td>
      <td class="num">${t.e}</td>
      <td class="num">${t.d}</td>
      <td class="num">${t.gp}</td>
      <td class="num">${t.gc}</td>
      <td class="num">${t.sg > 0 ? '+' : ''}${t.sg}</td>
      <td class="num league-pts">${t.pts}</td>
    </tr>`).join('');
}

function renderLeagueUpcoming(list){
  const box = el('leagueUpcomingList');
  const empty = el('leagueUpcomingEmpty');
  el('leagueUpcomingCount').textContent = list.length;

  if(!list.length){
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  box.innerHTML = list.map((f) => `
    <div class="friendly-item">
      <div class="friendly-teams">
        ${leagueTeamHtml(f.home_name, f.home_shield)}
        <span class="friendly-vs">vs</span>
        ${leagueTeamHtml(f.away_name, f.away_shield)}
      </div>
      <div class="friendly-meta">
        <span>Jornada ${f.round}</span>
        <span>${fmtShortDate(f.match_date)}</span>
      </div>
    </div>`).join('');
}

function renderLeagueHistory(list){
  const box = el('leagueHistoryList');
  const empty = el('leagueHistoryEmpty');

  if(!list.length){
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  box.innerHTML = list.map((f) => {
    const isHome = String(f.home_team_id) === String(teamId);
    const us = isHome ? f.home_score : f.away_score;
    const them = isHome ? f.away_score : f.home_score;
    const cls = us > them ? 'played-win' : (us < them ? 'played-loss' : 'played-draw');
    const badge = `<span class="friendly-badge ${cls}">${us > them ? 'Vitória' : (us < them ? 'Derrota' : 'Empate')}</span>`;
    return `
      <div class="friendly-item">
        <div class="friendly-teams">
          ${leagueTeamHtml(f.home_name, f.home_shield)}
          <span class="friendly-score">${f.home_score} - ${f.away_score}</span>
          ${leagueTeamHtml(f.away_name, f.away_shield)}
        </div>
        <div class="friendly-meta">
          <span>Jornada ${f.round}</span>
          <span>${fmtShortDate(f.match_date)}</span>
          ${badge}
        </div>
      </div>`;
  }).join('');
}

async function loadLeague(){
  try{
    const res = await fetch(`/api/league/${teamId}`);
    if(!res.ok) throw new Error();
    const data = await res.json();

    const note = el('leaguePreseasonNote');
    if(data.season_started){
      note.classList.add('hidden');
    }else{
      el('leaguePreseasonText').textContent =
        `A pré-época e o mercado de transferências decorrem até ${fmtPt(data.preseason_window.end)}. O Campeonato arranca a ${fmtPt(data.season_start)} — até lá, usa os Amigáveis para preparar a equipa.`;
      note.classList.remove('hidden');
    }

    renderLeagueTable(data.standings || []);
    renderStatLeaders('leagueStatLeaders', data.leaders || {});
    renderLeagueUpcoming(data.upcoming || []);
    renderLeagueHistory(data.history || []);
  }catch(err){
    // mantém o estado anterior se falhar
  }
}

/* ---------- Estatísticas da época (marcadores, assistências, cartões, cortes, % passe) ----------
   Partilhado entre a aba Campeonato e a aba Taça — ambos os endpoints
   devolvem "leaders" com a mesma forma (ver routes/competitionStats.js). */
const STAT_LEADER_CATEGORIES = [
  { key: 'top_scorers', label: 'Melhores Marcadores', icon: '⚽', valueKey: 'goals', suffix: '' },
  { key: 'top_assists', label: 'Mais Assistências', icon: '🎯', valueKey: 'assists', suffix: '' },
  { key: 'top_yellow', label: 'Cartões Amarelos', icon: '🟨', valueKey: 'yellow', suffix: '' },
  { key: 'top_red', label: 'Cartões Vermelhos', icon: '🟥', valueKey: 'red', suffix: '' },
  { key: 'top_tackles', label: 'Cortes / Jogo', icon: '🛡️', valueKey: 'tackles_per_game', suffix: '', decimals: 1 },
  { key: 'top_passing', label: 'Melhor % de Passe', icon: '🎽', valueKey: 'pass_pct', suffix: '%' },
];
const STAT_LEADER_MEDALS = ['🥇', '🥈', '🥉'];

function statLeaderAvatar(p){
  return p.player_photo ? `<img src="${p.player_photo}" alt="">` : '🧑';
}

function renderStatLeaders(containerId, leaders){
  const box = el(containerId);
  const hasAnyData = leaders && Object.values(leaders).some((list) => (list || []).length);
  if(!hasAnyData){
    box.innerHTML = '<p class="placeholder-text">Ainda sem jogos disputados nesta competição.</p>';
    return;
  }

  box.innerHTML = STAT_LEADER_CATEGORIES.map(({ key, label, icon, valueKey, suffix, decimals }) => {
    const list = leaders[key] || [];
    const rows = list.length
      ? list.map((p, i) => {
          const value = decimals ? Number(p[valueKey] || 0).toFixed(decimals) : (p[valueKey] || 0);
          const rankBadge = STAT_LEADER_MEDALS[i] || `<span class="stat-leader-pos">${i + 1}</span>`;
          const teamShield = p.team_shield ? `<img src="${p.team_shield}" alt="">` : '⚽';
          return `
            <div class="stat-leader-row">
              <span class="stat-leader-rank">${rankBadge}</span>
              <span class="stat-leader-avatar">${statLeaderAvatar(p)}</span>
              <span class="stat-leader-info">
                <span class="stat-leader-name">${p.player_name}</span>
                <span class="stat-leader-team"><span class="stat-leader-team-shield">${teamShield}</span>${p.team_name}</span>
              </span>
              <span class="stat-leader-value">${value}<small>${suffix}</small></span>
            </div>`;
        }).join('')
      : '<p class="placeholder-text stat-leader-empty">Sem dados ainda.</p>';

    return `
      <div class="stat-leader-block">
        <div class="stat-leader-title"><span class="stat-leader-icon">${icon}</span>${label}</div>
        ${rows}
      </div>`;
  }).join('');
}

/* ---------- Taça São Vicente: mata-mata + sorteio animado ---------- */
function sleep(ms){ return new Promise((resolve) => setTimeout(resolve, ms)); }

function renderCupBracket(rounds){
  const wrap = el('tacaBracketWrap');
  if(!rounds || !rounds.length){
    wrap.innerHTML = '';
    return;
  }

  wrap.innerHTML = rounds.slice().reverse().map((r) => {
    const rows = r.fixtures.map((f) => {
      const involvesMe = String(f.home_team_id) === String(teamId) || String(f.away_team_id) === String(teamId);

      if(f.is_bye){
        return `
          <div class="taca-fixture-row${involvesMe ? ' taca-fixture-me' : ''}">
            <div class="taca-fixture-teams">
              ${leagueTeamHtml(f.home_name, f.home_shield)}
              <span class="taca-bye-tag">passou por bye</span>
            </div>
          </div>`;
      }

      const played = f.status === 'played';
      const homeWon = played && f.winner_team_id === f.home_team_id;
      const awayWon = played && f.winner_team_id === f.away_team_id;
      const scoreHtml = played
        ? `<span class="friendly-score">${f.home_score} - ${f.away_score}${f.decided_by_penalties ? ' <small>(g.p.)</small>' : ''}</span>`
        : `<span class="friendly-vs">vs</span>`;

      return `
        <div class="taca-fixture-row${involvesMe ? ' taca-fixture-me' : ''}">
          <div class="taca-fixture-teams">
            <span class="${homeWon ? 'taca-winner' : (played ? 'taca-loser' : '')}">${leagueTeamHtml(f.home_name, f.home_shield)}</span>
            ${scoreHtml}
            <span class="${awayWon ? 'taca-winner' : (played ? 'taca-loser' : '')}">${leagueTeamHtml(f.away_name, f.away_shield)}</span>
          </div>
          <div class="friendly-meta"><span>${played ? fmtShortDate(f.match_date) : `Agendado · ${fmtShortDate(f.match_date)}`}</span></div>
        </div>`;
    }).join('');

    return `
      <div class="card">
        <div class="card-title no-margin">${r.round_name}</div>
        <div class="friendly-list">${rows}</div>
      </div>`;
  }).join('');
}

function renderCupState(data){
  el('tacaLockedNote').classList.toggle('hidden', data.status !== 'locked');
  el('tacaChampionBanner').classList.toggle('hidden', data.status !== 'finished');
  el('tacaProgressCard').classList.toggle('hidden', data.status !== 'round_in_progress');
  el('tacaDrawCard').classList.toggle('hidden', data.status !== 'ready_to_draw');

  if(data.status === 'finished' && data.champion){
    el('tacaChampionName').textContent = data.champion.name;
  }

  if(data.status === 'round_in_progress'){
    el('tacaProgressTitle').textContent = data.round_name || 'Ronda a decorrer';
  }

  if(data.status === 'ready_to_draw'){
    el('tacaDrawTitle').textContent = data.round_name || 'Sorteio';
    el('tacaDrawHint').textContent = `${(data.pool || []).length} equipas nesta ronda. Pronto para sortear.`;
    el('tacaDrum').classList.add('hidden');
    el('tacaDrumBalls').innerHTML = '';
    el('tacaReveal').innerHTML = '';
    el('tacaDrawBtn').disabled = false;
    el('tacaDrawBtn').classList.remove('hidden');
    el('tacaDrawBtn').textContent = '🎱 Realizar Sorteio';
  }
}

async function loadCup(){
  try{
    const res = await fetch(`/api/cup/${teamId}`);
    if(!res.ok) throw new Error();
    const data = await res.json();
    renderCupState(data);
    renderStatLeaders('tacaStatLeaders', data.leaders || {});
    renderCupBracket(data.rounds || []);
  }catch(err){
    // mantém o estado anterior se falhar
  }
}

/* Cor estável por equipa, só para as bolinhas do sorteio terem alguma
   variedade — não tem qualquer significado além disso. */
const TACA_BALL_COLORS = ['#7c5cff', '#9b3dff', '#3ecf6e', '#e8a33d', '#e2495b', '#4ea1e8', '#f2c14e', '#5ce0c6'];
function ballColorFor(teamId_){
  return TACA_BALL_COLORS[Number(teamId_) % TACA_BALL_COLORS.length];
}

async function runCupDrawAnimation(payload){
  const drum = el('tacaDrum');
  const ballsBox = el('tacaDrumBalls');
  const revealBox = el('tacaReveal');

  // Junta todas as equipas envolvidas nesta ronda, para encherem o "tambor".
  const allTeams = [];
  payload.reveal.forEach((entry) => {
    if(entry.type === 'bye') allTeams.push(entry.team);
    else { allTeams.push(entry.home); allTeams.push(entry.away); }
  });

  drum.classList.remove('hidden');
  ballsBox.innerHTML = allTeams.map((t) => `
    <div class="taca-ball" id="tacaBall-${t.id}" style="--ball-color:${ballColorFor(t.id)}; --bounce-delay:${(Math.random() * 0.6).toFixed(2)}s; --bounce-duration:${(1.6 + Math.random() * 0.8).toFixed(2)}s">
      ${t.shield_path ? `<img src="${t.shield_path}" alt="">` : t.name.slice(0, 3).toUpperCase()}
    </div>`).join('');
  revealBox.innerHTML = '';

  await sleep(1100); // deixa as bolinhas "saltar no tambor" antes de começar a tirar

  for(const entry of payload.reveal){
    const ids = entry.type === 'bye' ? [entry.team.id] : [entry.home.id, entry.away.id];
    ids.forEach((id) => {
      const ball = el(`tacaBall-${id}`);
      if(ball) ball.classList.add('taca-ball-drawn');
    });

    await sleep(450);
    ids.forEach((id) => el(`tacaBall-${id}`)?.remove());

    const row = document.createElement('div');
    const involvesMe = entry.type === 'bye'
      ? String(entry.team.id) === String(teamId)
      : (String(entry.home.id) === String(teamId) || String(entry.away.id) === String(teamId));
    row.className = `taca-reveal-row${involvesMe ? ' taca-reveal-me' : ''}`;
    row.innerHTML = entry.type === 'bye'
      ? `${leagueTeamHtml(entry.team.name, entry.team.shield_path)}<span class="taca-bye-tag">bye — passa à próxima ronda</span>`
      : `${leagueTeamHtml(entry.home.name, entry.home.shield_path)}<span class="friendly-vs">vs</span>${leagueTeamHtml(entry.away.name, entry.away.shield_path)}`;
    revealBox.appendChild(row);

    await sleep(600);
  }

  const note = document.createElement('p');
  note.className = 'placeholder-text';
  note.textContent = `Sorteio concluído — jogos marcados para ${fmtPt(payload.match_date)}.`;
  revealBox.appendChild(note);

  await sleep(400);
  drum.classList.add('hidden');
  loadCup();
}

el('tacaDrawBtn').addEventListener('click', async () => {
  const btn = el('tacaDrawBtn');
  btn.disabled = true;
  btn.textContent = 'A sortear…';
  try{
    const res = await fetch('/api/cup/draw', { method: 'POST' });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível sortear');
    btn.classList.add('hidden');
    await runCupDrawAnimation(data);
  }catch(err){
    btn.disabled = false;
    btn.textContent = '🎱 Realizar Sorteio';
    el('tacaDrawHint').textContent = err.message;
  }
});

/* ---------- Cerimónia de Prémios de Fim de Época ---------- */
let ceremonyShownForMsgId = null;

async function maybeOpenAwardsCeremony(rolloverMsgId){
  if(ceremonyShownForMsgId === rolloverMsgId) return; // já mostrada nesta sessão
  ceremonyShownForMsgId = rolloverMsgId;

  try{
    const res = await fetch(`/api/league/awards-ceremony/${teamId}`);
    if(!res.ok) throw new Error();
    const data = await res.json();
    if(data.status !== 'ready' || !data.awards.length) return;

    openAwardsCeremony(data);
    fetch(`/api/transfers/messages/${rolloverMsgId}/read`, { method: 'PUT' }).then(() => loadMessages());
  }catch(err){
    // se falhar, o utilizador continua a ver os prémios normalmente na caixa de entrada
  }
}

function openAwardsCeremony(data){
  el('ceremonyTitle').textContent = `Época ${data.season_label}`;
  el('ceremonyReveal').classList.add('hidden');

  el('ceremonyDots').innerHTML = data.awards.map((a, i) => `
    <div class="ceremony-dot" id="ceremonyDot-${i}" data-index="${i}" title="${a.label}">
      🏅
      <span class="ceremony-dot-label">${a.label}</span>
    </div>`).join('');

  el('ceremonyDots').querySelectorAll('.ceremony-dot').forEach((dot) => {
    dot.addEventListener('click', () => revealCeremonyAward(data.awards, Number(dot.dataset.index)));
  });

  el('ceremonyOverlay').classList.remove('hidden');
}

function revealCeremonyAward(awards, index){
  const award = awards[index];
  const dot = el(`ceremonyDot-${index}`);
  if(!award || !dot || dot.classList.contains('ceremony-dot-revealed')) return;

  dot.classList.add('ceremony-dot-revealed');
  dot.innerHTML = `${award.icon}<span class="ceremony-dot-label">${award.label}</span>`;

  el('ceremonyRevealIcon').textContent = award.icon;
  el('ceremonyRevealAward').textContent = award.label;
  el('ceremonyRevealPhoto').innerHTML = award.player_photo ? `<img src="${award.player_photo}" alt="">` : '🧑';
  el('ceremonyRevealName').textContent = award.player_name;
  el('ceremonyRevealTeam').textContent = award.team_name || '';
  el('ceremonyReveal').classList.remove('hidden');
}

el('ceremonyClose').addEventListener('click', () => el('ceremonyOverlay').classList.add('hidden'));
el('ceremonyOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'ceremonyOverlay') el('ceremonyOverlay').classList.add('hidden');
});

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
  loan_agreed: '🔄',
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
    const avatar = n.player_photo
      ? `<img src="${n.player_photo}" alt="">`
      : (n.to_team_shield || n.from_team_shield ? `<img src="${n.to_team_shield || n.from_team_shield}" alt="">` : icon);
    const fromShield = n.from_team_shield ? `<img src="${n.from_team_shield}" alt="">` : (n.from_team_name ? '⚽' : '');
    const toShield = n.to_team_shield ? `<img src="${n.to_team_shield}" alt="">` : (n.to_team_name ? '⚽' : '');
    const teamsLine = n.from_team_name && n.to_team_name
      ? `${n.from_team_name} → ${n.to_team_name}`
      : (n.to_team_name || n.from_team_name || '');

    return `
      <div class="market-news-item" data-news-id="${n.id}">
        <span class="market-news-icon${n.player_photo ? ' has-photo' : ''}">${avatar}</span>
        <div class="market-news-content">
          <div class="market-news-headline">${n.headline}</div>
          <div class="market-news-sub">
            <span class="market-news-teams-mini">${fromShield}${n.from_team_name && n.to_team_name ? '<span class="arrow">→</span>' : ''}${toShield}</span>
            <span>${teamsLine}</span>
            ${n.event_date ? `<span class="market-news-date">· ${fmtNewsDate(n.event_date)}</span>` : ''}
            ${n.amount ? `<span class="market-news-amount">${fmtMoney(n.amount)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.market-news-item').forEach((item) => {
    item.addEventListener('click', () => openNewsModal(Number(item.dataset.newsId)));
  });
}

/* ---------- Resumo do mercado: painel com todas as transferências do último mercado fechado ---------- */
async function loadWindowSummary(){
  const card = el('windowSummaryCard');
  try{
    const res = await fetch('/api/transfers/window-summary');
    if(!res.ok) throw new Error();
    const data = await res.json();
    renderWindowSummary(data);
  }catch(err){
    card.classList.add('hidden');
  }
}

function renderWindowSummary(data){
  const card = el('windowSummaryCard');
  const list = el('windowSummaryList');

  if(!data.is_market_closed || !data.transfers.length){
    card.classList.add('hidden');
    return;
  }

  el('windowSummaryTitle').textContent = `Resumo do Mercado ${data.window_year}`;
  list.innerHTML = data.transfers.map((t, i) => {
    const photo = t.player_photo ? `<img src="${t.player_photo}" alt="">` : '🧑';
    const fromShield = t.from_team_shield ? `<img src="${t.from_team_shield}" alt="">` : '';
    const toShield = t.to_team_shield ? `<img src="${t.to_team_shield}" alt="">` : '';
    const teams = [t.from_team_name, t.to_team_name].filter(Boolean).join(' → ');
    return `
      <div class="window-summary-item">
        <div class="window-summary-rank">${i + 1}</div>
        <div class="window-summary-photo">${photo}</div>
        <div class="window-summary-mid">
          <div class="window-summary-player">${t.player_name || '—'}</div>
          <div class="window-summary-teams">${fromShield}${toShield}<span>${teams}</span></div>
        </div>
        ${t.amount ? `<div class="window-summary-amount">${fmtMoney(t.amount)}</div>` : ''}
      </div>`;
  }).join('');

  card.classList.remove('hidden');
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
  if(n.from_team_name && n.player_name) parts.push('<div class="news-modal-arrow">→</div>');
  if(n.player_name){
    parts.push(`<div class="news-modal-team news-modal-player">
      <div class="news-modal-player-photo">${n.player_photo ? `<img src="${n.player_photo}" alt="">` : '🧑'}</div>
      <span>${n.player_name}</span>
    </div>`);
  }
  if(n.player_name && n.to_team_name) parts.push('<div class="news-modal-arrow">→</div>');
  else if(n.from_team_name && n.to_team_name && !n.player_name) parts.push('<div class="news-modal-arrow">→</div>');
  if(n.to_team_name){
    parts.push(`<div class="news-modal-team">
      <div class="news-modal-team-shield">${n.to_team_shield ? `<img src="${n.to_team_shield}" alt="">` : '⚽'}</div>
      <span>${n.to_team_name}</span>
    </div>`);
  }
  el('newsModalTeams').innerHTML = parts.join('');

  const amountEl = el('newsModalAmount');
  if(n.amount){
    amountEl.innerHTML = `💷 Valor: <b>${fmtMoney(n.amount)}</b>`;
    amountEl.classList.remove('hidden');
  }else{
    amountEl.classList.add('hidden');
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
  const standDown = squadPlayers.filter((p) => p.stood_down_until && p.stood_down_until >= currentGameDate);
  const available = squadPlayers.filter((p) => !isAssignedElsewhere(p.id) && !(p.stood_down_until && p.stood_down_until >= currentGameDate));

  const standDownNote = standDown.length
    ? `<p class="placeholder-text pool-standdown-note">🚫 Afastados do plantel: ${standDown.map((p) => p.name).join(', ')}</p>`
    : '';

  if (!available.length) {
    container.innerHTML = (squadPlayers.length
      ? '<p class="placeholder-text">Todos os jogadores já estão colocados no onze ou nos suplentes.</p>'
      : '<p class="placeholder-text">Sem jogadores no plantel.</p>') + standDownNote;
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
    </div>`).join('') + standDownNote;

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

/* ==========================================================
   Jogo ao Vivo — acompanhar o jogo minuto a minuto, com
   substituições, mudanças de tática e cartões amarelos/vermelhos.
   ========================================================== */
let liveFriendlyId = null;
let liveState = null;
let liveMySide = null;   // 'home' | 'away' | null (jogo entre duas equipas geridas pelo jogo)
let liveAutoTimer = null;
let liveBusy = false;    // evita pedidos sobrepostos (duplo clique / autoplay + clique manual)
let liveSubOutId = null; // jogador em campo selecionado para sair, à espera de um clique no banco

function shieldHtml(team){
  return team.team_shield
    ? `<img src="${team.team_shield}" alt="">`
    : '⚽';
}

async function openLiveMatch(friendlyId){
  liveFriendlyId = friendlyId;
  liveState = null;
  liveBusy = false;
  liveSubOutId = null;
  el('liveMatchOverlay').classList.remove('hidden');
  el('liveFeed').innerHTML = '<p class="placeholder-text">A carregar…</p>';
  el('livePitchTokens').innerHTML = '';
  el('liveScoreNumbers').textContent = '0 - 0';
  el('liveMinute').textContent = "0'";
  el('liveProgressFill').style.width = '0%';
  el('liveHalfLine').textContent = '';
  el('liveSummaryPanel').classList.add('hidden');
  el('livePlayBtn').disabled = true;
  el('liveAutoBtn').disabled = true;

  try{
    let res = await fetch(`/api/live-matches/${friendlyId}`);
    if(res.status === 404){
      res = await fetch(`/api/live-matches/${friendlyId}/start`, { method: 'POST' });
    }
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível carregar o jogo');
    applyLiveState(data, data.events || []);
    startLiveAuto(); // o jogo começa a simular-se sozinho assim que abre — não é preciso clicar em nada
  }catch(err){
    el('liveFeed').innerHTML = `<p class="placeholder-text">${err.message}</p>`;
  }
}

function closeLiveMatch(){
  el('liveMatchOverlay').classList.add('hidden');
  stopLiveAuto();
  liveFriendlyId = null;
  liveState = null;
  liveSubOutId = null;
}
el('liveMatchClose').addEventListener('click', closeLiveMatch);
el('liveMatchOverlay').addEventListener('click', (e) => {
  if(e.target === el('liveMatchOverlay')) closeLiveMatch();
});

function renderLiveFeedItems(events){
  const feed = el('liveFeed');
  if(feed.querySelector('.placeholder-text')) feed.innerHTML = '';
  events.forEach((ev) => {
    const item = document.createElement('div');
    item.className = `live-feed-item evt-${ev.kind}`;
    item.innerHTML = `<span class="live-feed-minute">${ev.minute}'</span><span>${ev.text}</span>`;
    feed.prepend(item);
  });
}

function renderLiveSummary(data){
  const panel = el('liveSummaryPanel');
  if(data.status !== 'finished'){ panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const teamBlock = (team) => {
    const rows = (team.notable_players || []).map((p) => {
      const bits = [];
      if(p.goals) bits.push(`⚽×${p.goals}`);
      if(p.assists) bits.push(`🅰️×${p.assists}`);
      if(p.yellow) bits.push('🟨');
      if(p.sent_off) bits.push('🟥');
      return `<div class="live-summary-row"><span>${p.name}</span><span>${bits.join(' ')}</span></div>`;
    }).join('') || '<p class="live-summary-empty">Sem destaques.</p>';
    return `<div class="live-summary-team"><div class="live-summary-team-name">${team.team_name}</div>${rows}</div>`;
  };

  el('liveSummaryBody').innerHTML = teamBlock(data.home) + teamBlock(data.away);
}

/* ---------- Campo: posiciona os 2x11 jogadores usando as coordenadas de
   FORMATIONS (as mesmas da Tática) — a equipa de baixo (casa) usa as
   coordenadas tal e qual; a equipa de cima (fora) usa as mesmas
   coordenadas espelhadas na vertical, para as duas equipas ficarem
   viradas uma para a outra, cada uma a defender a baliza do seu lado. ---------- */
function slotCoords(formation, slotIndex, mirrored){
  const def = FORMATIONS[formation] || FORMATIONS['4-3-3'];
  const fallback = def[slotIndex % def.length] || def[0];
  const slot = (Number.isInteger(slotIndex) && def[slotIndex]) ? def[slotIndex] : fallback;
  const x = slot.x;
  const y = mirrored ? (50 - (slot.y / 100) * 50) : (50 + (slot.y / 100) * 50);
  return { x, y };
}

function liveTokenHtml(p, x, y, teamState){
  const isMySelectable = teamState.is_user && liveState && liveState.status !== 'finished';
  const sideClass = teamState.is_user ? 'side-user' : 'side-opponent';
  const selectedClass = liveSubOutId === p.id ? ' selected' : '';
  const badges = [];
  if(p.goals) badges.push(`<span class="live-token-badge">⚽${p.goals > 1 ? `×${p.goals}` : ''}</span>`);
  if(p.assists) badges.push(`<span class="live-token-badge">🅰️${p.assists > 1 ? `×${p.assists}` : ''}</span>`);
  return `
    <div class="live-token ${sideClass}${isMySelectable ? ' selectable' : ''}${selectedClass}"
         style="left:${x}%;top:${y}%;" data-player-id="${p.id}">
      <div class="live-token-circle">${p.jersey_number || '•'}
        ${badges.length ? `<span class="live-token-badges">${badges.join('')}</span>` : ''}
        ${p.yellow ? '<span class="live-token-yellow"></span>' : ''}
      </div>
      <span class="live-token-name">${p.name.split(' ').slice(-1)[0]}</span>
    </div>`;
}

function renderLivePitch(data){
  const container = el('livePitchTokens');
  el('livePitchHomeLabel').textContent = data.home.team_name;
  el('livePitchAwayLabel').textContent = data.away.team_name;

  const tokens = [];
  data.home.on_pitch.forEach((p, i) => {
    const { x, y } = slotCoords(data.home.formation, p.slot_index ?? i, false);
    tokens.push(liveTokenHtml(p, x, y, data.home));
  });
  data.away.on_pitch.forEach((p, i) => {
    const { x, y } = slotCoords(data.away.formation, p.slot_index ?? i, true);
    tokens.push(liveTokenHtml(p, x, y, data.away));
  });
  container.innerHTML = tokens.join('');

  container.querySelectorAll('.live-token.selectable').forEach((tokenEl) => {
    tokenEl.addEventListener('click', () => selectSubOut(Number(tokenEl.dataset.playerId)));
  });
}

function applyLiveState(data, newEvents){
  const prevScoreText = liveState ? `${liveState.home_score} - ${liveState.away_score}` : null;
  liveState = data;
  liveMySide = data.home.is_user ? 'home' : (data.away.is_user ? 'away' : null);

  el('liveHomeShield').innerHTML = shieldHtml(data.home);
  el('liveAwayShield').innerHTML = shieldHtml(data.away);
  el('liveHomeTeam').textContent = data.home.team_name;
  el('liveAwayTeam').textContent = data.away.team_name;

  const scoreText = `${data.home_score} - ${data.away_score}`;
  const scoreEl = el('liveScoreNumbers');
  scoreEl.textContent = scoreText;
  if(prevScoreText !== null && prevScoreText !== scoreText){
    scoreEl.classList.remove('pop');
    void scoreEl.offsetWidth; // reinicia a animação mesmo em golos seguidos
    scoreEl.classList.add('pop');
  }

  el('liveMinute').textContent = data.status === 'finished' ? 'Fim' : `${data.minute}'`;
  el('liveProgressFill').style.width = `${Math.min(100, (data.minute / 90) * 100)}%`;
  el('liveHalfLine').textContent = data.minute >= 45 ? '2ª parte' : '1ª parte';

  const badge = el('liveBadge');
  badge.classList.toggle('is-finished', data.status === 'finished');
  badge.lastChild.textContent = data.status === 'finished' ? 'FIM DE JOGO' : 'AO VIVO';

  if(newEvents && newEvents.length) renderLiveFeedItems(newEvents);
  renderLiveSummary(data);
  renderLivePitch(data);

  const myState = liveMySide ? data[liveMySide] : null;
  renderLiveSubPanel(myState);
  renderLiveTacticPanel(myState);

  const playBtn = el('livePlayBtn');
  const autoBtn = el('liveAutoBtn');
  const hint = el('liveStatusHint');
  if(data.status === 'finished'){
    playBtn.disabled = true;
    autoBtn.disabled = true;
    playBtn.textContent = 'Jogo terminado';
    stopLiveAuto();
    hint.textContent = 'Resultado final registado — podes fechar esta janela.';
    loadFriendlies();
    loadClub();
    loadSquad();
  }else{
    playBtn.disabled = liveBusy;
    autoBtn.disabled = false;
    playBtn.textContent = "▶ Avançar 5'";
    if(!liveBusy) hint.textContent = '';
  }
}

async function liveTick(minutes){
  if(!liveFriendlyId || !liveState || liveState.status === 'finished' || liveBusy) return;
  liveBusy = true;
  el('livePlayBtn').disabled = true;
  try{
    const res = await fetch(`/api/live-matches/${liveFriendlyId}/tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: minutes || 5 }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Erro ao avançar o jogo');
    liveBusy = false;
    applyLiveState(data, data.new_events || []);
  }catch(err){
    liveBusy = false;
    stopLiveAuto();
    el('liveStatusHint').textContent = err.message;
    if(liveState && liveState.status !== 'finished') el('livePlayBtn').disabled = false;
  }
}
el('livePlayBtn').addEventListener('click', () => liveTick(5));

function stopLiveAuto(){
  if(liveAutoTimer){ clearInterval(liveAutoTimer); liveAutoTimer = null; }
  el('liveAutoBtn').classList.remove('active');
  el('liveAutoBtn').textContent = '⏵ Reprodução Automática';
}
function startLiveAuto(){
  if(liveAutoTimer || !liveState || liveState.status === 'finished') return;
  el('liveAutoBtn').classList.add('active');
  el('liveAutoBtn').textContent = '⏸ Pausar';
  liveAutoTimer = setInterval(() => liveTick(3), 1400);
}
el('liveAutoBtn').addEventListener('click', () => {
  if(liveAutoTimer){ stopLiveAuto(); return; }
  startLiveAuto();
});

/* ---------- Substituições: clica num jogador em campo (fica marcado a
   vermelho), depois num do banco — a troca acontece de imediato. ---------- */
function selectSubOut(playerId){
  const myState = liveMySide ? liveState[liveMySide] : null;
  if(!myState || liveState.status === 'finished') return;
  if(!myState.on_pitch.some((p) => p.id === playerId)) return;
  liveSubOutId = liveSubOutId === playerId ? null : playerId;
  renderLivePitch(liveState);
  renderLiveSubPanel(myState);
}

function renderLiveSubPanel(myState){
  const panel = el('liveSubPanel');
  const hint = el('liveSubHint');
  const strip = el('liveBenchStrip');

  if(!myState || liveState.status === 'finished'){
    panel.classList.add('disabled');
    strip.innerHTML = '';
    return;
  }
  panel.classList.remove('disabled');
  el('liveSubsRemaining').textContent = myState.subs_remaining;

  if(myState.subs_remaining <= 0){
    hint.textContent = 'Já não tens substituições disponíveis.';
  }else if(!myState.bench.length){
    hint.textContent = 'O banco está vazio.';
  }else if(liveSubOutId){
    const outPlayer = myState.on_pitch.find((p) => p.id === liveSubOutId);
    hint.textContent = outPlayer ? `${outPlayer.name} vai sair — clica em quem entra.` : 'Clica num jogador em campo, depois num do banco.';
  }else{
    hint.textContent = 'Clica num jogador em campo, depois num do banco.';
  }

  if(!myState.bench.length){
    strip.innerHTML = '<p class="live-bench-empty">Banco vazio.</p>';
    return;
  }

  const disabled = myState.subs_remaining <= 0;
  strip.innerHTML = myState.bench.map((p) => `
    <div class="live-bench-chip${disabled ? ' disabled' : ''}" data-player-id="${p.id}">
      <div class="live-token-circle">${p.jersey_number || '•'}</div>
      <span class="live-bench-chip-name">${p.name.split(' ').slice(-1)[0]}</span>
    </div>`).join('');

  strip.querySelectorAll('.live-bench-chip').forEach((chip) => {
    chip.addEventListener('click', () => completeSubstitution(Number(chip.dataset.playerId)));
  });
}

async function completeSubstitution(inId){
  const myState = liveMySide ? liveState[liveMySide] : null;
  const resultBox = el('liveSubResult');
  if(!myState) return;
  if(!liveSubOutId){
    resultBox.textContent = 'Escolhe primeiro quem sai, clicando num jogador em campo.';
    resultBox.classList.remove('hidden');
    return;
  }

  try{
    const res = await fetch(`/api/live-matches/${liveFriendlyId}/substitution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: myState.team_id, player_out_id: liveSubOutId, player_in_id: inId }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível fazer a substituição');
    liveSubOutId = null;
    resultBox.classList.add('hidden');
    applyLiveState(data, data.new_events || []);
  }catch(err){
    resultBox.textContent = err.message;
    resultBox.classList.remove('hidden');
  }
}

/* ---------- Mudança tática (formação) a meio do jogo ---------- */
function renderLiveTacticPanel(myState){
  const panel = el('liveTacticPanel');
  if(!myState || liveState.status === 'finished'){
    panel.classList.add('disabled');
    return;
  }
  panel.classList.remove('disabled');
  panel.querySelectorAll('.formation-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.formation === myState.formation);
  });
}

el('liveFormationPicker').querySelectorAll('.formation-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const myState = liveMySide ? liveState[liveMySide] : null;
    const resultBox = el('liveTacticResult');
    if(!myState || btn.dataset.formation === myState.formation) return;

    try{
      const res = await fetch(`/api/live-matches/${liveFriendlyId}/tactic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: myState.team_id, formation: btn.dataset.formation }),
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Não foi possível mudar a tática');
      resultBox.classList.add('hidden');
      applyLiveState(data, data.new_events || []);
    }catch(err){
      resultBox.textContent = err.message;
      resultBox.classList.remove('hidden');
    }
  });
});