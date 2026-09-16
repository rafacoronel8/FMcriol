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

/* Tem de bater certo com MAX_NEGOTIATION_ROUNDS em routes/transfers.js —
   só serve para decidir se ainda mostramos o botão "Contrapropor". */
const MAX_NEGOTIATION_ROUNDS = 3;

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

/* ---------- Guardar Jogo: dá um nome ao save e escreve o .db no dispositivo ----------
   Ver routes/save.js — devolve o ficheiro .db do dispositivo/browser atual.
   Para "continuar" mais tarde, basta escolher esse ficheiro em
   "Continuar jogo guardado" na seleção de clube.

   Em browsers com File System Access API (Chrome/Edge), usamos
   showSaveFilePicker: é a própria janela nativa de guardar que, ao
   escolheres um nome já usado, pergunta se queres substituir esse
   ficheiro — sem descarregar uma cópia nova ao lado. Em browsers sem
   suporte (Firefox, Safari), cai-se num download normal com esse nome. */
function sanitizeSaveFileName(name){
  const clean = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
  return clean || 'fmcriol-save';
}

function suggestedSaveName(){
  const stored = localStorage.getItem('fmcriol_lastSaveName');
  if (stored) return stored;
  const club = el('clubName')?.textContent?.trim();
  return (club && club !== '—') ? club : 'O meu save';
}

/* No telemóvel a File System Access API não existe, e o truque do
   <a download> com blob: é pouco fiável — o iOS Safari ignora muitas
   vezes o atributo download e abre o ficheiro em vez de o guardar.
   O caminho fiável nestes casos é a Web Share API com ficheiros, que
   abre o menu de partilha nativo com a opção "Guardar em Ficheiros"
   (iOS) / "Guardar no dispositivo" (Android). */
function canShareSaveFile(file){
  try{
    return !!(navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share);
  }catch(err){
    return false;
  }
}

function isIosLike(){
  const ua = navigator.userAgent || '';
  // iPadOS recente identifica-se como Mac, daí o teste do touch
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/* Descarrega via <a download>. Duas diferenças críticas face à versão
   anterior, ambas responsáveis por "diz que guardou mas não aparece":
   - o revoke do object URL passa a ser adiado; se for feito logo a
     seguir ao click(), o telemóvel ainda não começou a transferência
     e o ficheiro morre a meio, sem erro nenhum;
   - o <a> fica no DOM até o revoke, porque alguns browsers móveis
     cancelam a transferência se o elemento desaparecer antes. */
function downloadViaAnchor(blob, fileName){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60000);
}

async function saveGameToFile(){
  const btn = el('saveGameBtn');
  if (!btn || btn.disabled) return;

  const nameInput = await openDecisionModal({
    title: 'Guardar Jogo',
    message: 'Dá um nome a este save. Se já existir um ficheiro com o mesmo nome, o teu browser vai perguntar se queres substituí-lo.',
    label: 'Nome do save',
    placeholder: 'ex: Época 2026-27',
    defaultValue: suggestedSaveName(),
    confirmLabel: 'Guardar',
  });
  if (nameInput === null) return; // cancelou

  const safeName = sanitizeSaveFileName(nameInput);
  const fileName = `${safeName}.db`;
  localStorage.setItem('fmcriol_lastSaveName', safeName);

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'A guardar…';

  const finish = (text) => {
    btn.textContent = text;
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2200);
  };

  try{
    // Pede logo o destino/nome ANTES de ir buscar os dados ao servidor —
    // é aqui que o browser mostra "Substituir ficheiro existente?" se for
    // o caso, e se o treinador cancelar não vale a pena ter pedido nada ao servidor.
    // Só no desktop: no telemóvel esta API não existe e o fluxo é outro.
    let handle = null;
    if (window.showSaveFilePicker){
      handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'Save do FMcriol', accept: { 'application/octet-stream': ['.db'] } }],
      });
    }

    const res = await fetch('/api/save/export', { cache: 'no-store' });
    if (!res.ok) throw new Error(`export falhou (HTTP ${res.status})`);
    const blob = await res.blob();
    // Um save vazio seria pior do que nenhum: mais vale falhar aqui do
    // que o treinador só descobrir quando tentar continuar o jogo.
    if (!blob || blob.size === 0) throw new Error('o servidor devolveu um save vazio');

    if (handle){
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      finish('Guardado ✓');
      return;
    }

    const file = new File([blob], fileName, { type: 'application/octet-stream' });

    if (canShareSaveFile(file)){
      // O share tem de partir de um toque do treinador — depois do fetch
      // já se perdeu o gesto original, por isso pede-se um toque novo.
      const confirmed = await openDecisionModal({
        title: 'Guardar no dispositivo',
        message: `O save "${fileName}" está pronto. Toca em Guardar e escolhe «Guardar em Ficheiros» para o encontrares depois na app Ficheiros.`,
        confirmLabel: 'Guardar',
        hideInput: true,
      });
      if (confirmed === null){
        btn.textContent = original;
        btn.disabled = false;
        return;
      }
      try{
        await navigator.share({ files: [file], title: fileName });
        finish('Guardado ✓');
        return;
      }catch(shareErr){
        if (shareErr && shareErr.name === 'AbortError'){
          btn.textContent = original;
          btn.disabled = false;
          return;
        }
        // Partilha recusada pelo sistema: continua para o download normal.
        console.warn('Partilha falhou, a tentar download normal:', shareErr);
      }
    }

    // Último recurso. No iOS sem Web Share o <a download> não guarda
    // nada de forma fiável, por isso avisa-se o treinador em vez de
    // deixar o botão dizer "Guardado" sem ficheiro nenhum aparecer.
    downloadViaAnchor(blob, fileName);
    if (isIosLike()){
      finish('Verifica Transferências');
      await openDecisionModal({
        title: 'Confere o ficheiro',
        message: 'Se o save não aparecer em Ficheiros › Transferências, abre o jogo no Safari (em vez de uma app com browser embutido, como Instagram ou Facebook) e tenta outra vez.',
        confirmLabel: 'Entendido',
        hideInput: true,
      });
      return;
    }
    finish('Guardado ✓');
  }catch(err){
    if (err && err.name === 'AbortError'){
      // Fechou a janela de guardar sem escolher nada — não é um erro.
      btn.textContent = original;
      btn.disabled = false;
      return;
    }
    console.error('Erro ao guardar o jogo:', err);
    finish('Erro ao guardar');
    await openDecisionModal({
      title: 'Não foi possível guardar',
      message: `O save não chegou a ser escrito: ${err?.message || 'erro desconhecido'}. O teu jogo continua intacto no servidor — podes tentar de novo.`,
      confirmLabel: 'Fechar',
      hideInput: true,
    });
  }
}
el('saveGameBtn')?.addEventListener('click', saveGameToFile);

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
  'Olheiro': 'role-olheiro',
};
const STAFF_ROLE_ICON = {
  'Adjunto': '🧠',
  'Fisioterapeuta': '💉',
  'Preparador Físico': '🏋️',
  'Olheiro': '🔎',
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

/* ---------- Aba Olheiro ---------- */
/* Só aparece alguma coisa se o clube tiver um Olheiro contratado E o
   mercado de transferências estiver aberto (ver routes/scout.js). Clicar
   num cartão leva ao perfil do jogador, onde já é possível fazer uma
   proposta a sério. */
let scoutState = { hasScout: false, marketOpen: false, scoutId: null };

function renderScoutCard(r){
  const teamShieldHtml = r.team_shield ? `<img src="${r.team_shield}" alt="">` : '';
  const tags = [];
  if(r.need_reason) tags.push(r.need_reason);
  if(r.age != null) tags.push(`${r.age} anos`);
  return `
    <div class="scout-card" data-id="${r.player_id}">
      <div class="scout-card-top">
        <div class="scout-card-avatar">${r.photo_path ? `<img src="${r.photo_path}" alt="">` : '🧑'}</div>
        <div style="flex:1;min-width:0;">
          <div class="scout-card-name">${r.name}</div>
          <div class="scout-card-meta">${r.position_tag || 'Posição não definida'}</div>
        </div>
      </div>
      <div class="scout-card-team">${teamShieldHtml}<span>${r.team_name || ''}</span></div>
      ${tags.length ? `<div class="scout-card-tags">${tags.map((t) => `<span class="scout-card-tag">${t}</span>`).join('')}</div>` : ''}
      <div class="scout-card-bottom">
        <span class="scout-card-value">${fmtMoney(r.estimated_value)}</span>
        <span class="scout-card-stars">${staffStars(r.current_ability_stars)}</span>
      </div>
    </div>`;
}

function bindScoutCardClicks(container){
  container.querySelectorAll('.scout-card').forEach((card) => {
    card.addEventListener('click', () => {
      window.location.href = `/jogador/perfilJogador.html?id=${card.dataset.id}`;
    });
  });
}

function renderScoutHero(name, stars, statusText, marketOpen, photoPath){
  const avatar = el('scoutHeroAvatar');
  avatar.innerHTML = photoPath ? `<img src="${photoPath}" alt="">` : '🔎';
  el('scoutHeroName').textContent = name;
  el('scoutHeroStars').textContent = stars;
  el('scoutHeroStatus').textContent = statusText;
  const badge = el('scoutHeroMarketBadge');
  badge.textContent = marketOpen ? 'Mercado Aberto' : 'Mercado Fechado';
  badge.className = 'scout-hero-badge ' + (marketOpen ? 'market-open' : 'market-closed');
}

async function loadScoutPanel(){
  const noScoutMsg = el('scoutNoScout');
  const closedMsg = el('scoutMarketClosed');
  const workArea = el('scoutWorkArea');
  [noScoutMsg, closedMsg].forEach((box) => box.classList.add('hidden'));
  workArea.classList.add('hidden');

  try{
    // Usamos /recommendations só para saber se há olheiro, o estado do
    // mercado e a tarefa atual — o resto (cartões) é tratado abaixo.
    const res = await fetch(`/api/scout/${teamId}/recommendations`);
    if(!res.ok) throw new Error();
    const data = await res.json();

    scoutState = { hasScout: data.has_scout, marketOpen: data.market_open, scoutId: data.scout_id || null };

    if(!data.has_scout){
      renderScoutHero('Sem Olheiro contratado', '—', 'Vai à Comissão Técnica', false);
      noScoutMsg.classList.remove('hidden');
      return;
    }

    renderScoutHero(data.scout_name, staffStars(5), 'Ao serviço do clube', data.market_open);
    workArea.classList.remove('hidden');

    const taskForm = el('scoutTaskForm');
    taskForm.dataset.scoutId = data.scout_id;
    el('scoutTaskMinAge').value = data.task?.min_age ?? '';
    el('scoutTaskMaxAge').value = data.task?.max_age ?? '';
    el('scoutTaskPosition').value = data.task?.position ?? '';
    el('scoutTaskMaxPrice').value = data.task?.max_price ?? '';

    if(!data.market_open){
      closedMsg.classList.remove('hidden');
      el('scoutRecommendations').innerHTML = '';
      el('scoutEmpty').classList.add('hidden');
      return;
    }

    renderScoutRecommendations(data.recommendations || []);
  }catch(err){
    renderScoutHero('Não foi possível carregar', '—', 'Tenta novamente', false);
  }
}

function renderScoutRecommendations(recommendations){
  const list = el('scoutRecommendations');
  const emptyMsg = el('scoutEmpty');
  if(!recommendations.length){
    list.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');
  list.innerHTML = recommendations.map(renderScoutCard).join('');
  bindScoutCardClicks(list);
}

el('scoutTaskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const resultBox = el('scoutTaskResult');
  const submitBtn = form.querySelector('button[type="submit"]');
  const scoutId = form.dataset.scoutId;
  if(!scoutId) return;

  submitBtn.disabled = true;
  resultBox.classList.add('hidden');

  try{
    const res = await fetch(`/api/staff/${scoutId}/task`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        min_age: el('scoutTaskMinAge').value || null,
        max_age: el('scoutTaskMaxAge').value || null,
        position: el('scoutTaskPosition').value || null,
        max_price: el('scoutTaskMaxPrice').value || null,
      }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível guardar a tarefa');

    resultBox.textContent = 'Tarefa guardada — o olheiro passa a procurar dentro destes critérios.';
    resultBox.className = 'activity-result ok';
    resultBox.classList.remove('hidden');
    loadScoutPanel();
  }catch(err){
    resultBox.textContent = err.message;
    resultBox.className = 'activity-result err';
    resultBox.classList.remove('hidden');
  }finally{
    submitBtn.disabled = false;
  }
});

/* ---------- Pesquisa avançada do Olheiro ---------- */
function buildScoutSearchQuery(){
  const params = new URLSearchParams();
  const map = {
    q: el('scoutSearchName').value.trim(),
    position: el('scoutSearchPosition').value,
    nationality: el('scoutSearchNationality').value.trim(),
    min_age: el('scoutSearchMinAge').value,
    max_age: el('scoutSearchMaxAge').value,
    min_stars: el('scoutSearchMinStars').value,
    max_stars: el('scoutSearchMaxStars').value,
    max_price: el('scoutSearchMaxPrice').value,
    sort: el('scoutSearchSort').value,
  };
  Object.entries(map).forEach(([key, value]) => { if(value) params.set(key, value); });
  return params.toString();
}

el('scoutSearchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultsBox = el('scoutSearchResults');
  const emptyMsg = el('scoutSearchEmpty');
  const hintMsg = el('scoutSearchHint');
  const metaBox = el('scoutSearchMeta');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  hintMsg.classList.add('hidden');
  emptyMsg.classList.add('hidden');
  submitBtn.disabled = true;
  resultsBox.innerHTML = '';
  metaBox.classList.add('hidden');

  try{
    const query = buildScoutSearchQuery();
    const res = await fetch(`/api/scout/${teamId}/search?${query}`);
    if(!res.ok) throw new Error();
    const data = await res.json();

    if(!data.has_scout || !data.market_open){
      emptyMsg.textContent = !data.has_scout
        ? 'Contrata um Olheiro primeiro para poderes pesquisar.'
        : 'O mercado está fechado — a pesquisa só funciona durante a janela de transferências.';
      emptyMsg.classList.remove('hidden');
      return;
    }

    if(!data.results.length){
      emptyMsg.textContent = 'Nenhum jogador encontrado com esses filtros.';
      emptyMsg.classList.remove('hidden');
      return;
    }

    metaBox.innerHTML = `<b>${data.total_matches}</b> jogador${data.total_matches === 1 ? '' : 'es'} encontrado${data.total_matches === 1 ? '' : 's'}${data.total_matches > data.results.length ? ` — a mostrar os ${data.results.length} melhores` : ''}`;
    metaBox.classList.remove('hidden');
    resultsBox.innerHTML = data.results.map(renderScoutCard).join('');
    bindScoutCardClicks(resultsBox);
  }catch(err){
    emptyMsg.textContent = 'Não foi possível pesquisar agora. Tenta outra vez.';
    emptyMsg.classList.remove('hidden');
  }finally{
    submitBtn.disabled = false;
  }
});

el('scoutSearchClear').addEventListener('click', () => {
  el('scoutSearchForm').reset();
  el('scoutSearchResults').innerHTML = '';
  el('scoutSearchMeta').classList.add('hidden');
  el('scoutSearchEmpty').classList.add('hidden');
  el('scoutSearchHint').classList.remove('hidden');
});

/* ---------- Aba Lista Preferencial ----------
   Alvos de mercado marcados manualmente a partir do perfil de um jogador
   ("Adicionar à Lista Preferencial" — ver script_perfilJogador.js) —
   ver routes/shortlist.js. Ao contrário das recomendações do Olheiro
   acima, isto não depende de ter Olheiro contratado nem do mercado estar
   aberto: é só uma lista de vigilância que o treinador guarda à sua
   maneira. Clicar num cartão abre o perfil do jogador; o clique no botão
   ⭐ ou na nota nunca propaga para o cartão (ver stopPropagation abaixo). */
function renderShortlistCard(entry){
  const p = entry.player;
  const teamShieldHtml = p.team_shield ? `<img src="${p.team_shield}" alt="">` : '';
  const ageText = calcAgeFromBirth(p.birth_date);
  const tags = [];
  if(ageText !== '—') tags.push(`${ageText} anos`);
  if(!p.team_id) tags.push('<span class="shortlist-tag-free">Agente Livre</span>');
  else if(p.is_listed) tags.push('<span class="shortlist-tag-listed">Listado p/ Transferência</span>');

  return `
    <div class="scout-card shortlist-card" data-id="${p.id}">
      <button type="button" class="shortlist-remove-btn" data-remove-shortlist="${p.id}" title="Remover da Lista Preferencial">★</button>
      <div class="scout-card-top">
        <div class="scout-card-avatar">${p.photo_path ? `<img src="${p.photo_path}" alt="">` : '🧑'}</div>
        <div style="flex:1;min-width:0;">
          <div class="scout-card-name">${p.name}</div>
          <div class="scout-card-meta">${p.position_tag || p.position_code || 'Posição não definida'}</div>
        </div>
      </div>
      <div class="scout-card-team">${teamShieldHtml}<span>${p.team_name || entry.status}</span></div>
      ${tags.length ? `<div class="scout-card-tags">${tags.map((t) => `<span class="scout-card-tag">${t}</span>`).join('')}</div>` : ''}
      <textarea class="shortlist-note" data-note-id="${entry.shortlist_id}" placeholder="Nota (opcional)…" rows="2">${p ? (entry.note || '') : ''}</textarea>
      <div class="scout-card-bottom">
        <span class="scout-card-value">${p.market_value_text || '—'}</span>
        <span class="scout-card-stars">${staffStars(p.current_ability_stars)}</span>
      </div>
    </div>`;
}

async function loadShortlistPanel(){
  const grid = el('shortlistGrid');
  const emptyMsg = el('shortlistEmpty');
  try{
    const res = await fetch(`/api/shortlist/${teamId}`);
    if(!res.ok) throw new Error();
    const data = await res.json();
    const entries = data.entries || [];

    el('shortlistCount').textContent = `${entries.length} alvo${entries.length === 1 ? '' : 's'}`;
    emptyMsg.classList.toggle('hidden', entries.length > 0);
    grid.innerHTML = entries.map(renderShortlistCard).join('');
    bindShortlistCardEvents(grid);
  }catch(err){
    grid.innerHTML = '';
    emptyMsg.textContent = 'Não foi possível carregar a Lista Preferencial agora.';
    emptyMsg.classList.remove('hidden');
  }
}

function bindShortlistCardEvents(grid){
  grid.querySelectorAll('.shortlist-card').forEach((card) => {
    card.addEventListener('click', () => {
      window.location.href = `/jogador/perfilJogador.html?id=${card.dataset.id}`;
    });
  });

  grid.querySelectorAll('[data-remove-shortlist]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const playerId = btn.dataset.removeShortlist;
      btn.disabled = true;
      try{
        await fetch(`/api/shortlist/${teamId}/${playerId}`, { method: 'DELETE' });
        loadShortlistPanel();
      }catch(err){
        btn.disabled = false;
      }
    });
  });

  grid.querySelectorAll('.shortlist-note').forEach((textarea) => {
    textarea.addEventListener('click', (e) => e.stopPropagation());
    textarea.addEventListener('blur', async () => {
      const shortlistId = textarea.dataset.noteId;
      try{
        await fetch(`/api/shortlist/${shortlistId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: textarea.value }),
        });
      }catch(err){
        // sem feedback dedicado — a nota fica só na caixa até tentares outra vez
      }
    });
  });
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
    document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'auto' });
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (tab.dataset.tab === 'minhaEquipa') loadSquad();
    if (tab.dataset.tab === 'inscritos') loadInscritos();
    if (tab.dataset.tab === 'tatica') loadTactics();
    if (tab.dataset.tab === 'mercado') { loadMarketNews(); loadWindowSummary(); }
    if (tab.dataset.tab === 'clausulas') loadClauses();
    if (tab.dataset.tab === 'campeonato') loadLeague();
    if (tab.dataset.tab === 'taca') loadCup();
    if (tab.dataset.tab === 'olheiro') loadScoutPanel();
    if (tab.dataset.tab === 'listaPreferencial') loadShortlistPanel();
    if (tab.dataset.tab === 'financas') loadFinancesPanel();
  });
});

/* ---------- Finanças: folha salarial vs. saldo / orçamento de transferências ----------
   GET /api/teams/:id/finances (routes/teams.js) devolve os orçamentos da
   equipa + a folha salarial ATUAL do plantel (somada ao vivo a partir de
   wage_text), o valor que vai ser debitado no fecho da época (soma dos
   salários semanais × 12 — ver db.chargeSeasonWages em db/database.js,
   que paga primeiro do SALDO e só recorre ao orçamento de transferências
   para o que faltar) e uma indicação simples de saúde financeira. */
const FIN_HEALTH_CLASS = {
  'Excelente': 'fin-health-good',
  'Estável': 'fin-health-good',
  'Preocupante': 'fin-health-warn',
  'Crítico': 'fin-health-bad',
};

async function loadFinancesPanel(){
  try{
    const res = await fetch(`/api/teams/${teamId}/finances`);
    if(!res.ok) throw new Error();
    const f = await res.json();
    fillFinancesPanel(f);
  }catch(err){
    el('finHealthSub').textContent = 'Não foi possível carregar os dados financeiros.';
  }
}

function fillFinancesPanel(f){
  const healthClass = FIN_HEALTH_CLASS[f.health] || 'fin-health-mid';
  const badge = el('finHealthBadge');
  badge.textContent = f.health;
  badge.className = 'fin-hero-badge ' + healthClass;

  const daysText = f.days_until_charge != null
    ? `daqui a ${f.days_until_charge} dia${f.days_until_charge === 1 ? '' : 's'} (1 de agosto)`
    : 'no próximo fecho de época';
  el('finHealthSub').textContent =
    `A folha salarial × 4 representa ${f.wage_share_of_cushion_pct}% do que o clube tem disponível (saldo + orçamento de transferências) — cobrada ${daysText}.`;

  el('finBalance').textContent = fmtMoney(f.balance);
  el('finTransferBudget').textContent = fmtMoney(f.transfer_budget);
  el('finWageBudget').textContent = fmtMoney(f.wage_budget) + ' / semana';
  el('finTier').textContent = f.financial_tier;

  el('finPlayerCount').textContent = f.player_count;
  el('finWeeklyWages').textContent = fmtMoney(f.weekly_wage_bill) + ' / semana';
  el('finSeasonCharge').textContent = fmtMoney(f.projected_season_wage_charge);
  el('finChargeHint').textContent = f.already_charged_this_season
    ? `Já debitado na época ${f.season_label}.`
    : `Ainda não debitado esta época (${f.season_label}).`;

  const total = f.projected_season_wage_charge || 1;
  const balancePct = Math.max(0, Math.min(100, (f.projected_from_balance / total) * 100));
  const transferPct = Math.max(0, Math.min(100 - balancePct, (f.projected_from_transfer_budget / total) * 100));
  el('finCompareFillBalance').style.width = balancePct + '%';
  el('finCompareFillTransfer').style.width = transferPct + '%';
  el('finCompareFillTransfer').className = 'fin-compare-fill fin-compare-fill-transfer ' + healthClass;

  el('finFromBalance').textContent = fmtMoney(f.projected_from_balance);
  el('finFromTransfer').textContent = fmtMoney(f.projected_from_transfer_budget);
  el('finBalanceAfter').textContent = fmtMoney(f.balance_after_charge);
  el('finAfterCharge').textContent = fmtMoney(f.transfer_budget_after_charge);
}

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

/* Cor da média de classificação no plantel — mesma leitura rápida (verde
   boa média, amarelo média, vermelho fraca) que já existe no perfil do
   jogador para a mesma coluna "Média". */
function ratingClass(mediaValue){
  const n = parseFloat(mediaValue);
  if(!Number.isFinite(n)) return '';
  if(n >= 7) return 'squad-rating-good';
  if(n >= 6) return 'squad-rating-ok';
  return 'squad-rating-bad';
}

/* Idade a partir da data de nascimento, usando a data do calendário do
   jogo (currentGameDate) — mesma ideia de calcAge em script_perfilJogador.js. */
function calcAgeFromBirth(birthDateStr){
  if(!birthDateStr || !currentGameDate) return '—';
  const birth = new Date(`${birthDateStr}T00:00:00`);
  const today = new Date(`${currentGameDate}T00:00:00`);
  if(isNaN(birth)) return '—';
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if(m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

/* Soma as estatísticas REAIS do jogador em todas as competições em que já
   jogou esta época (Campeonato, Taça, Amigáveis — ver COMPETITION_ROW_NAMES
   em db/database.js e applySeasonStat, que é quem realmente escreve estas
   linhas depois de cada jogo). Antes, esta função procurava uma linha
   chamada "Geral (Clube)" que nunca chega a ser criada pelo jogo (só existe
   nos dados de demonstração do perfil), por isso o plantel mostrava sempre
   0 jogos/golos/assistências mesmo depois de a equipa ter jogado a época
   toda. Agora soma tudo, tal como aparece somado no perfil de cada
   jogador. */
function squadGeneralStats(seasonStatsJson){
  try{
    const list = JSON.parse(seasonStatsJson || '[]');
    if(!Array.isArray(list) || !list.length) return { j: 0, g: 0, a: 0, am: 0, verm: 0, tk: 0, pp: '-', media: '-' };

    let j = 0, g = 0, a = 0, am = 0, verm = 0, tk = 0;
    let mediaWeightedTotal = 0, mediaWeight = 0;
    let ppWeightedTotal = 0, ppWeight = 0;

    list.forEach((r) => {
      const rowJ = Number(r.j) || 0;
      j += rowJ;
      g += Number(r.g) || 0;
      a += Number(r.a) || 0;
      am += Number(r.am) || 0;
      verm += Number(r.verm) || 0;
      tk += Number(r.tk) || 0;

      const media = parseFloat(r.media);
      if(Number.isFinite(media) && rowJ){ mediaWeightedTotal += media * rowJ; mediaWeight += rowJ; }

      const pp = parseFloat(r.pp);
      if(Number.isFinite(pp) && rowJ){ ppWeightedTotal += pp * rowJ; ppWeight += rowJ; }
    });

    return {
      j, g, a, am, verm, tk,
      media: mediaWeight ? (mediaWeightedTotal / mediaWeight).toFixed(2) : '-',
      pp: ppWeight ? `${(ppWeightedTotal / ppWeight).toFixed(1)}%` : '-',
    };
  }catch(err){
    return { j: 0, g: 0, a: 0, am: 0, verm: 0, tk: 0, pp: '-', media: '-' };
  }
}

/* ---------- Minha Equipa — grupos de posição, filtros, pesquisa e
   ordenação por coluna (substitui o antigo botão "Gerar Valores
   Automáticos", que agora foi removido do painel). ---------- */
const POSITION_ORDER = ['GR', 'DD', 'DC', 'DE', 'LD', 'LE', 'L', 'MCD', 'MC', 'MD', 'ME', 'MOD', 'MCO', 'MOE', 'VOL', 'AD', 'AE', 'ED', 'PL', 'EE'];

/* Cada código de posição individual (defesa, médio ou avançado) e o
   grupo largo a que pertence — ex: laterais DD/DE/LD/LE contam como
   Defesa, qualquer médio (incluindo os ofensivos MOD/MCO/MOE) conta
   como Médio, extremos AD/AE/ED/EE contam como Avançado. */
const POS_CODE_GROUP = {
  GR: 'GR',
  DD: 'DEF', DC: 'DEF', DE: 'DEF', LD: 'DEF', LE: 'DEF', L: 'DEF',
  MCD: 'MED', MC: 'MED', MD: 'MED', ME: 'MED', MOD: 'MED', MCO: 'MED', MOE: 'MED', VOL: 'MED', MAD: 'MED', MAE: 'MED',
  ED: 'AVA', PL: 'AVA', EE: 'AVA', AD: 'AVA', AE: 'AVA', SA: 'AVA',
};

/* Separa um campo de posições tipo "MOE/MCO/MOD/ME/AD/AE" ou
   "MCD / DD" nos códigos individuais que o compõem. */
function squadParsePositions(raw){
  return String(raw || '')
    .toUpperCase()
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* Agrupa um único código de posição no respetivo grupo largo
   GR / DEF / MED / AVA. Códigos desconhecidos caem por heurística
   (primeira letra) em vez de ficarem de fora dos filtros. */
function squadPosGroup(code){
  const c = String(code || '').toUpperCase().trim();
  if(POS_CODE_GROUP[c]) return POS_CODE_GROUP[c];
  if(c.startsWith('G')) return 'GR';
  if(c.startsWith('D') || c.startsWith('L')) return 'DEF';
  if(c.startsWith('M') || c.startsWith('V')) return 'MED';
  if(c.startsWith('A') || c.startsWith('E') || c.startsWith('P') || c.startsWith('S')) return 'AVA';
  return 'OUTRO';
}

/* Um jogador pode jogar em várias posições (ex: "DE/MCD/ME/AE"), e deve
   contar em CADA grupo correspondente — basta jogar numa posição de
   Defesa, por exemplo, para aparecer no filtro "Defesas", mesmo que
   também jogue a Médio. Devolve a lista de grupos únicos do jogador. */
function squadPosGroups(rawPositionField){
  const tokens = squadParsePositions(rawPositionField);
  const groups = tokens.map(squadPosGroup).filter((g) => g && g !== 'OUTRO');
  const unique = Array.from(new Set(groups));
  return unique.length ? unique : ['OUTRO'];
}

const POS_GROUP_LABEL = { GR: 'Guarda-Redes', DEF: 'Defesa', MED: 'Médio', AVA: 'Avançado', OUTRO: '—' };

/* Converte texto de dinheiro (ex: "£1.250.000" ou "£12.500/sem", no
   formato pt-PT usado por fmtMoney) num número, só para permitir
   ordenar as colunas VM e Salário. */
function squadMoneyToNumber(text){
  if(!text) return -1;
  const cleaned = String(text).replace(/[^\d,.\-]/g, '');
  if(!cleaned) return -1;
  const normalized = cleaned.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : -1;
}

let squadPlayersData = [];
let squadFilterPos = 'all';
let squadSearchTerm = '';
let squadSortKey = null;
let squadSortDir = 'desc';

async function loadSquad(){
  const tbody = el('squadTableBody');
  const empty = el('squadEmpty');
  const noMatch = el('squadNoMatch');
  try{
    const res = await fetch(`/api/players?team_id=${teamId}`);
    if(!res.ok) throw new Error();
    const players = await res.json();

    el('squadCount').textContent = players.length;
    noMatch.classList.add('hidden');

    if(!players.length){
      tbody.innerHTML = '';
      squadPlayersData = [];
      el('squadHighlights').classList.add('hidden');
      el('squadMetaStrip').classList.add('hidden');
      renderSquadFilterCounts([]);
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    /* Enriquece cada jogador uma única vez, para filtrar/ordenar sem
       ter de voltar a somar as estatísticas da época a cada clique. */
    squadPlayersData = players.map((p) => {
      const stats = squadGeneralStats(p.season_stats_json);
      const mediaNum = parseFloat(stats.media);
      const ppNum = parseFloat(stats.pp);
      return {
        raw: p,
        id: p.id,
        name: p.name,
        jersey: p.jersey_number || '00',
        posCode: p.position_code || p.position_tag || '—',
        posGroup: squadPosGroup(squadParsePositions(p.position_code)[0]),
        posGroups: squadPosGroups(p.position_code),
        age: calcAgeFromBirth(p.birth_date),
        isStoodDown: !!(p.stood_down_until && p.stood_down_until >= currentGameDate),
        photo: p.photo_path || '',
        j: stats.j ?? 0,
        g: stats.g ?? 0,
        a: stats.a ?? 0,
        am: stats.am ?? 0,
        verm: stats.verm ?? 0,
        tk: stats.tk ?? 0,
        pp: stats.pp ?? '-',
        ppNum: Number.isFinite(ppNum) ? ppNum : -1,
        media: stats.media ?? '-',
        mediaNum: Number.isFinite(mediaNum) ? mediaNum : -1,
        vmText: p.market_value_text || '—',
        vmNum: squadMoneyToNumber(p.market_value_text),
        wageText: p.wage_text || '—',
        wageNum: squadMoneyToNumber(p.wage_text),
      };
    });

    renderSquadHighlights(squadPlayersData);
    renderSquadMetaStrip(squadPlayersData);
    renderSquadFilterCounts(squadPlayersData);
    renderSquadTable();
  }catch(err){
    tbody.innerHTML = '';
    squadPlayersData = [];
    el('squadHighlights').classList.add('hidden');
    el('squadMetaStrip').classList.add('hidden');
    renderSquadFilterCounts([]);
    empty.querySelector('p').textContent = 'Não foi possível carregar o plantel.';
    empty.classList.remove('hidden');
  }
}

/* Atualiza os números dentro de cada "chip" de filtro (Todos / Guarda-Redes
   / Defesas / Médios / Avançados). Um jogador com várias posições (ex:
   "DE/MCD/AE") conta em CADA grupo a que pertence — daí somar mais do
   que o total de "Todos" quando há jogadores polivalentes. */
function renderSquadFilterCounts(players){
  const counts = { all: players.length, GR: 0, DEF: 0, MED: 0, AVA: 0 };
  players.forEach((p) => {
    (p.posGroups || [p.posGroup]).forEach((g) => { if(counts[g] !== undefined) counts[g] += 1; });
  });
  document.querySelectorAll('.squad-chip-count').forEach((badge) => {
    const key = badge.dataset.count;
    badge.textContent = counts[key] ?? 0;
  });
}

/* Tira de resumo por cima da tabela: tamanho do plantel, idade média,
   valor de mercado total e massa salarial total — dá uma leitura rápida
   do plantel sem teres de somar a tabela à mão. */
function renderSquadMetaStrip(players){
  const box = el('squadMetaStrip');
  if(!players.length){ box.classList.add('hidden'); box.innerHTML = ''; return; }

  const ages = players.map((p) => Number(p.age)).filter((n) => Number.isFinite(n) && n > 0);
  const avgAge = ages.length ? (ages.reduce((s, n) => s + n, 0) / ages.length) : null;

  const totalValue = players.reduce((s, p) => s + (p.vmNum > 0 ? p.vmNum : 0), 0);
  const totalWage = players.reduce((s, p) => s + (p.wageNum > 0 ? p.wageNum : 0), 0);

  const groupCounts = { GR: 0, DEF: 0, MED: 0, AVA: 0 };
  players.forEach((p) => { if(groupCounts[p.posGroup] !== undefined) groupCounts[p.posGroup] += 1; });
  const total = players.length || 1;
  const barsHtml = ['GR', 'DEF', 'MED', 'AVA'].map((g) => {
    const pct = (groupCounts[g] / total) * 100;
    return pct > 0 ? `<div class="squad-meta-bar bar-${g}" style="width:${pct}%" title="${POS_GROUP_LABEL[g]}: ${groupCounts[g]}"></div>` : '';
  }).join('');

  box.innerHTML = `
    <div class="squad-meta-card" style="animation-delay:.02s">
      <span class="squad-meta-icon">👥</span>
      <div class="squad-meta-label">Jogadores</div>
      <div class="squad-meta-value">${players.length}</div>
      <div class="squad-meta-bars">${barsHtml}</div>
    </div>
    <div class="squad-meta-card" style="animation-delay:.06s">
      <span class="squad-meta-icon">🎂</span>
      <div class="squad-meta-label">Idade Média</div>
      <div class="squad-meta-value">${avgAge !== null ? avgAge.toFixed(1) : '—'}<small>anos</small></div>
    </div>
    <div class="squad-meta-card" style="animation-delay:.1s">
      <span class="squad-meta-icon">💎</span>
      <div class="squad-meta-label">Valor de Plantel</div>
      <div class="squad-meta-value">${fmtMoney(totalValue)}</div>
    </div>
    <div class="squad-meta-card" style="animation-delay:.14s">
      <span class="squad-meta-icon">💼</span>
      <div class="squad-meta-label">Massa Salarial</div>
      <div class="squad-meta-value">${fmtMoney(totalWage)}<small>/sem</small></div>
    </div>`;
  box.classList.remove('hidden');
}

/* Cartões de destaque no topo do separador — melhor marcador, melhor
   assistente e melhor média da época, só a partir de jogadores que já
   têm jogos disputados. */
function renderSquadHighlights(players){
  const box = el('squadHighlights');
  const withGames = players.filter((p) => p.j > 0);
  if(!withGames.length){
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  const topGoals = withGames.reduce((best, p) => (p.g > best.g ? p : best), withGames[0]);
  const topAssists = withGames.reduce((best, p) => (p.a > best.a ? p : best), withGames[0]);
  const topRating = withGames.filter((p) => p.mediaNum >= 0)
    .reduce((best, p) => (!best || p.mediaNum > best.mediaNum ? p : best), null);

  const cardHtml = (p, cls, kickerIcon, kickerText, value, valueLabel) => {
    if(!p) return '';
    const avatar = p.photo ? `<img src="${p.photo}" alt="">` : '🧑';
    return `
      <div class="squad-highlight-card ${cls}" data-id="${p.id}">
        <div class="squad-highlight-photo">${avatar}</div>
        <div class="squad-highlight-body">
          <div class="squad-highlight-kicker">${kickerIcon} ${kickerText}</div>
          <div class="squad-highlight-name">${p.name}</div>
          <div class="squad-highlight-sub">${POS_GROUP_LABEL[p.posGroup] || p.posCode}</div>
        </div>
        <div class="squad-highlight-value">${value}<small>${valueLabel}</small></div>
      </div>`;
  };

  box.innerHTML = [
    cardHtml(topGoals, 'squad-highlight-goals', '⚽', 'Melhor Marcador', topGoals.g, 'golos'),
    cardHtml(topAssists, 'squad-highlight-assists', '🎯', 'Melhor Assistente', topAssists.a, 'assist.'),
    topRating ? cardHtml(topRating, 'squad-highlight-rating', '⭐', 'Melhor Média', topRating.media, 'média') : '',
  ].join('');

  box.classList.remove('hidden');

  box.querySelectorAll('.squad-highlight-card').forEach((card) => {
    card.addEventListener('click', () => {
      window.location.href = `/jogador/perfilJogador.html?id=${card.dataset.id}`;
    });
  });
}

/* Aplica o filtro de posição + pesquisa + ordenação escolhidos e
   volta a desenhar as linhas da tabela. */
function renderSquadTable(){
  const tbody = el('squadTableBody');
  const noMatch = el('squadNoMatch');

  let list = squadPlayersData.slice();

  if(squadFilterPos !== 'all'){
    /* Um jogador com várias posições aparece em todos os filtros a
       que pertence (ex: um "DE/MCD/AE" surge em Defesas, Médios e
       Avançados), não só no grupo da sua primeira posição. */
    list = list.filter((p) => (p.posGroups || [p.posGroup]).includes(squadFilterPos));
  }
  if(squadSearchTerm){
    const term = squadSearchTerm.toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(term));
  }

  if(squadSortKey){
    const dir = squadSortDir === 'asc' ? 1 : -1;
    list.sort((x, y) => {
      let vx, vy;
      switch(squadSortKey){
        case 'name': vx = x.name.toLowerCase(); vy = y.name.toLowerCase(); return vx.localeCompare(vy) * dir;
        case 'pos': vx = POSITION_ORDER.indexOf(x.posCode); vy = POSITION_ORDER.indexOf(y.posCode);
          if(vx === -1) vx = 99; if(vy === -1) vy = 99;
          return (vx - vy) * dir;
        case 'age': vx = Number(x.age) || 0; vy = Number(y.age) || 0; return (vx - vy) * dir;
        case 'j': return (x.j - y.j) * dir;
        case 'g': return (x.g - y.g) * dir;
        case 'a': return (x.a - y.a) * dir;
        case 'am': return (x.am - y.am) * dir;
        case 'verm': return (x.verm - y.verm) * dir;
        case 'tk': return (x.tk - y.tk) * dir;
        case 'pp': return (x.ppNum - y.ppNum) * dir;
        case 'media': return (x.mediaNum - y.mediaNum) * dir;
        case 'vm': return (x.vmNum - y.vmNum) * dir;
        case 'wage': return (x.wageNum - y.wageNum) * dir;
        default: return 0;
      }
    });
  }

  document.querySelectorAll('.squad-th-sortable').forEach((th) => {
    th.classList.toggle('squad-sort-active', th.dataset.sort === squadSortKey);
    th.querySelector('.squad-sort-arrow').textContent = th.dataset.sort === squadSortKey
      ? (squadSortDir === 'asc' ? '▲' : '▼')
      : '';
  });

  if(!list.length){
    tbody.innerHTML = '';
    noMatch.classList.remove('hidden');
    return;
  }
  noMatch.classList.add('hidden');

  tbody.innerHTML = list.map((p) => {
    const avatar = p.photo ? `<img src="${p.photo}" alt="">` : '🧑';
    return `
      <tr class="${p.isStoodDown ? 'squad-row-standdown' : ''}" data-id="${p.id}">
        <td><div class="squad-row-photo pos-ring-${p.posGroup}">${avatar}</div></td>
        <td>
          <div class="squad-row-name-cell">
            <span class="squad-row-name">${p.name}${p.isStoodDown ? '<span class="squad-row-standdown-pill">🚫 Afastado</span>' : ''}</span>
            <span class="squad-row-jersey">#${p.jersey}</span>
          </div>
        </td>
        <td><span class="squad-row-pos pos-tag-${p.posGroup}">${p.posCode}</span></td>
        <td>${p.age}</td>
        <td>${p.j}</td>
        <td>${p.g}</td>
        <td>${p.a}</td>
        <td>${p.am}</td>
        <td>${p.verm}</td>
        <td>${p.tk}</td>
        <td>${p.pp}</td>
        <td class="${p.mediaNum >= 0 ? ratingClass(p.media) : ''}">${p.media}</td>
        <td>${p.vmText}</td>
        <td>${p.wageText}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach((row) => {
    row.addEventListener('click', () => {
      window.location.href = `/jogador/perfilJogador.html?id=${row.dataset.id}`;
    });
  });
}

document.querySelectorAll('.squad-th-sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if(squadSortKey === key){
      squadSortDir = squadSortDir === 'asc' ? 'desc' : 'asc';
    }else{
      squadSortKey = key;
      squadSortDir = (key === 'name' || key === 'pos') ? 'asc' : 'desc';
    }
    renderSquadTable();
  });
});

el('squadPosFilter').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.squad-chip');
  if(!chip) return;
  squadFilterPos = chip.dataset.pos;
  el('squadPosFilter').querySelectorAll('.squad-chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderSquadTable();
});

el('squadSearchInput').addEventListener('input', (ev) => {
  squadSearchTerm = ev.target.value.trim();
  renderSquadTable();
});

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
    if(rolloverMsg) handleSeasonRolloverPopups(rolloverMsg.id);
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
  transfer_budget_bonus: '💰',
  transfer_meeting: '🗣️',
  loan_agreed: '🔄',
  loan_returned: '↩️',
  match_day: '⚽',
  player_of_match: '⭐',
  scout_tip: '🔎',
  season_prize_money: '💰',
  season_wage_charge: '📉',
  choose_captain: '🎖️',
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

/* ---------- Medidores (nota dos adeptos / reação da direção) ----------
   messages.extra_json guarda { gauges: [{ key, label, icon, value, max,
   description }, ...] } — ver routes/matchReactions.js. Cada medidor
   aparece como uma barra 0-10 colorida consoante o valor, com a
   descrição por baixo. */
function renderMessageGauges(m){
  if(!m.extra_json) return '';
  let extra;
  try{ extra = JSON.parse(m.extra_json); }catch(err){ return ''; }
  if(!extra || !Array.isArray(extra.gauges) || !extra.gauges.length) return '';

  return `<div class="msg-gauges">${extra.gauges.map((g) => {
    const max = g.max || 10;
    const pct = Math.max(0, Math.min(100, (Number(g.value) / max) * 100));
    const colorClass = pct >= 70 ? 'gauge-good' : (pct >= 45 ? 'gauge-mid' : 'gauge-bad');
    return `
      <div class="msg-gauge">
        <div class="msg-gauge-head">
          <span class="msg-gauge-label">${g.icon || ''} ${g.label}</span>
          <span class="msg-gauge-value">${Number(g.value).toFixed(1)}/${max}</span>
        </div>
        <div class="msg-gauge-bar"><div class="msg-gauge-fill ${colorClass}" style="width:${pct}%"></div></div>
        <p class="msg-gauge-desc">${g.description || ''}</p>
      </div>`;
  }).join('')}</div>`;
}

/* ---------- Caixa do Jogador do Jogo (foto + estatísticas da época) ----------
   Reaproveita squadGeneralStats (já usada na tabela do plantel) para
   somar as estatísticas do jogador em todas as competições a partir de
   messages.player_season_stats_json — ver routes/transfers.js. */
function renderPotmStatsBox(m){
  if(m.type !== 'player_of_match' || !m.player_name) return '';
  const stats = squadGeneralStats(m.player_season_stats_json);
  return `
    <div class="msg-potm-box">
      <div class="msg-potm-photo">${m.player_photo ? `<img src="${m.player_photo}" alt="">` : '🧑'}</div>
      <div class="msg-potm-info">
        <div class="msg-potm-name">${m.player_name}</div>
        <div class="msg-potm-label">Estatísticas da Época</div>
        <div class="msg-potm-stats">
          <div class="msg-potm-stat"><b>${stats.j}</b><span>Jogos</span></div>
          <div class="msg-potm-stat"><b>${stats.g}</b><span>Golos</span></div>
          <div class="msg-potm-stat"><b>${stats.a}</b><span>Assist.</span></div>
          <div class="msg-potm-stat"><b>${stats.media}</b><span>Média</span></div>
        </div>
      </div>
    </div>`;
}

/* ---------- Prémios de fim de época (Campeonato + Taça) ----------
   messages.extra_json guarda { prize_breakdown: { total, season_label,
   items: [{ icon, label, amount }] } } — ver
   db/database.js:awardLeagueSeasonPrizeMoney. Mostra o total em destaque
   e depois uma linha por cada fonte de dinheiro (posição no Campeonato,
   rondas da Taça, bónus de campeão), em vez de só um parágrafo corrido. */
function renderSeasonPrizeBox(m){
  if(m.type !== 'season_prize_money' || !m.extra_json) return '';
  let extra;
  try{ extra = JSON.parse(m.extra_json); }catch(err){ return ''; }
  const p = extra && extra.prize_breakdown;
  if(!p || !Array.isArray(p.items) || !p.items.length) return '';

  return `
    <div class="msg-prize-box">
      <div class="msg-prize-total">
        <span class="msg-prize-total-label">Total recebido</span>
        <span class="msg-prize-total-value">${fmtMoney(p.total)}</span>
      </div>
      <div class="msg-prize-items">
        ${p.items.map((item) => `
          <div class="msg-prize-item">
            <span class="msg-prize-item-icon">${item.icon || '💰'}</span>
            <span class="msg-prize-item-label">${item.label}</span>
            <span class="msg-prize-item-amount">+${fmtMoney(item.amount)}</span>
          </div>`).join('')}
      </div>
      <p class="msg-prize-footnote">Já somado ao orçamento de transferências.</p>
    </div>`;
}

/* ---------- Débito da folha salarial de fim de época ----------
   messages.extra_json guarda { wage_charge: { total, season_label,
   weekly_wage_bill, player_count, balance_before, balance_after,
   paid_from_balance, paid_from_transfer_budget, transfer_budget_before,
   transfer_budget_after } } — ver db/database.js:chargeSeasonWages. O
   saldo paga primeiro; só mostra a linha do orçamento de transferências
   se sobrou algum valor por pagar (paid_from_transfer_budget > 0). */
function renderWageChargeBox(m){
  if(m.type !== 'season_wage_charge' || !m.extra_json) return '';
  let extra;
  try{ extra = JSON.parse(m.extra_json); }catch(err){ return ''; }
  const w = extra && extra.wage_charge;
  if(!w) return '';

  const items = [
    `<div class="msg-prize-item">
      <span class="msg-prize-item-icon">📋</span>
      <span class="msg-prize-item-label">${w.player_count} jogador${w.player_count === 1 ? '' : 'es'} sob contrato · ${fmtMoney(w.weekly_wage_bill)} / semana</span>
      <span class="msg-prize-item-amount">×4</span>
    </div>`,
    `<div class="msg-prize-item">
      <span class="msg-prize-item-icon">💰</span>
      <span class="msg-prize-item-label">Pago pelo saldo do clube</span>
      <span class="msg-prize-item-amount">-${fmtMoney(w.paid_from_balance)}</span>
    </div>`,
  ];
  if(w.paid_from_transfer_budget > 0){
    items.push(`
      <div class="msg-prize-item">
        <span class="msg-prize-item-icon">🔁</span>
        <span class="msg-prize-item-label">Diferença tirada do orçamento de transferências</span>
        <span class="msg-prize-item-amount">-${fmtMoney(w.paid_from_transfer_budget)}</span>
      </div>`);
  }

  const footnote = w.paid_from_transfer_budget > 0
    ? `Saldo: ${fmtMoney(w.balance_before)} → ${fmtMoney(w.balance_after)}. Orçamento de transferências: ${fmtMoney(w.transfer_budget_before)} → ${fmtMoney(w.transfer_budget_after)}.`
    : `Saldo: ${fmtMoney(w.balance_before)} → ${fmtMoney(w.balance_after)}. O orçamento de transferências não foi tocado.`;

  return `
    <div class="msg-prize-box msg-wage-box">
      <div class="msg-prize-total msg-wage-total">
        <span class="msg-prize-total-label">Total debitado</span>
        <span class="msg-prize-total-value msg-wage-total-value">-${fmtMoney(w.total)}</span>
      </div>
      <div class="msg-prize-items">${items.join('')}</div>
      <p class="msg-prize-footnote">${footnote}</p>
    </div>`;
}

/* ---------- Relatório do Olheiro (indicação na caixa de entrada) ----------
   messages.extra_json guarda { scout_report: { photo_path, name,
   position_tag, team_name, quality_stars, specialization, personality,
   estimated_value, description } } — ver routes/scout.js. */
function renderScoutTipBox(m){
  if(m.type !== 'scout_tip' || !m.extra_json) return '';
  let extra;
  try{ extra = JSON.parse(m.extra_json); }catch(err){ return ''; }
  const r = extra && extra.scout_report;
  if(!r) return '';

  const personalityClass = {
    'Muito Fiel': 'chip-good', 'Fiel': 'chip-good',
    'Normal': 'chip-neutral',
    'Problemático': 'chip-bad', 'Muito Problemático': 'chip-bad',
  }[r.personality] || 'chip-neutral';

  return `
    <div class="msg-scout-box">
      <div class="msg-scout-photo">${r.photo_path ? `<img src="${r.photo_path}" alt="">` : '🧑'}</div>
      <div class="msg-scout-info">
        <div class="msg-scout-name">${r.name}</div>
        <div class="msg-scout-meta">${r.position_tag || 'Posição não definida'} · ${r.team_name || ''}</div>
        <div class="msg-scout-chips">
          <span class="msg-scout-chip">${staffStars(r.quality_stars)}</span>
          <span class="msg-scout-chip">${r.specialization}</span>
          <span class="msg-scout-chip ${personalityClass}">${r.personality}</span>
        </div>
        <div class="msg-scout-value">💰 Valor estimado: ${fmtMoney(r.estimated_value)}</div>
      </div>
    </div>`;
}

/* ---------- Escolha do Capitão (início de época) ----------
   messages.extra_json guarda { captain_candidates: [{ player_id, name,
   position_tag, leadership }], resolved: true/undefined } — ver
   routes/league.js (envia a mensagem) e routes/players.js (PUT
   /captain/:teamId, que reescreve a mensagem já resolvida). */
function captainChoiceCandidates(m){
  try{ return JSON.parse(m.extra_json || '{}').captain_candidates || []; }catch(err){ return []; }
}
function captainChoiceResolved(m){
  try{ return !!JSON.parse(m.extra_json || '{}').resolved; }catch(err){ return false; }
}

function messageNeedsResponse(m){
  return (m.type === 'incoming_offer_pending' && m.offer_status === 'pending')
    || (m.type === 'player_incident' && m.incident_status === 'pending')
    || (m.type === 'manager_question' && m.question_status === 'pending')
    || (m.type === 'transfer_meeting' && m.meeting_status === 'pending')
    || (m.type === 'match_day' && m.friendly_status === 'accepted')
    || (m.type === 'choose_captain' && !captainChoiceResolved(m) && captainChoiceCandidates(m).length > 0);
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
    const roundsLeft = MAX_NEGOTIATION_ROUNDS - (m.offer_negotiation_round || 0);
    const counterBtn = roundsLeft > 0
      ? `<button class="msg-btn msg-btn-neutral" data-action="counter">Contrapropor</button>` : '';
    actions = `<div class="msg-actions" data-offer-id="${m.transfer_offer_id}">
         <button class="msg-btn msg-btn-accept" data-action="accept">Aceitar</button>
         ${counterBtn}
         <button class="msg-btn msg-btn-reject" data-action="reject">Recusar</button>
       </div>`;
  }else if(m.type === 'incoming_offer_pending'){
    actions = `<p class="msg-decision-note">${m.offer_status === 'accepted' ? 'Proposta aceite.' : 'Proposta recusada.'}</p>`;
  }else if(isPendingIncident){
    actions = m.incident_kind === 'playing_time'
      ? `<div class="msg-actions" data-incident-id="${m.incident_id}">
           <button class="msg-btn msg-btn-accept" data-action="promise">Prometer Mais Minutos</button>
           <button class="msg-btn msg-btn-reject" data-action="transfer_list">Lista de Transferências</button>
           <button class="msg-btn msg-btn-neutral" data-action="ignore">Ignorar</button>
         </div>`
      : `<div class="msg-actions" data-incident-id="${m.incident_id}">
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
  }else if(m.type === 'match_day' && m.friendly_status === 'accepted'){
    actions = `<div class="msg-actions" data-friendly-id="${m.friendly_id}">
         <button class="msg-btn msg-btn-neutral" data-action="play">▶ Jogar</button>
         <button class="msg-btn msg-btn-neutral" data-action="simulate">⏭ Simular</button>
       </div>`;
  }else if(m.type === 'choose_captain' && !captainChoiceResolved(m) && captainChoiceCandidates(m).length){
    const candidates = captainChoiceCandidates(m);
    actions = `<div class="msg-actions msg-actions-captain" data-message-id="${m.id}">
         ${candidates.map((c) => `
           <button class="captain-pick-btn" data-player-id="${c.player_id}">
             <span class="captain-pick-name">${c.name}</span>
             <span class="captain-pick-meta">${c.position_tag || 'Posição não definida'} · Liderança ${c.leadership}</span>
           </button>`).join('')}
       </div>`;
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
    ${renderPotmStatsBox(m)}
    ${renderScoutTipBox(m)}
    ${renderSeasonPrizeBox(m)}
    ${renderWageChargeBox(m)}
    <div class="inbox-detail-body">${m.body}</div>
    ${renderMessageGauges(m)}
    ${actions}
  `;

  const actionsBox = box.querySelector('.msg-actions');
  if(actionsBox){
    if(actionsBox.dataset.offerId){
      actionsBox.querySelectorAll('.msg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if(btn.dataset.action === 'counter'){
            counterOffer(actionsBox.dataset.offerId, actionsBox, m.offer_amount);
          }else{
            respondToOffer(actionsBox.dataset.offerId, btn.dataset.action === 'accept', actionsBox);
          }
        });
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
    }else if(actionsBox.dataset.friendlyId){
      const friendlyId = Number(actionsBox.dataset.friendlyId);
      actionsBox.querySelectorAll('.msg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if(btn.dataset.action === 'play'){
            openPreMatchTalk(friendlyId);
          }else{
            simulateTodayMatch(friendlyId, btn);
          }
        });
      });
    }else if(actionsBox.dataset.messageId){
      actionsBox.querySelectorAll('.captain-pick-btn').forEach((btn) => {
        btn.addEventListener('click', () => respondToCaptainChoice(actionsBox.dataset.messageId, btn.dataset.playerId, actionsBox));
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

/* ---------- Escolher o capitão (início de época) ---------- */
async function respondToCaptainChoice(messageId, playerId, actionsBox){
  actionsBox.querySelectorAll('.captain-pick-btn').forEach((b) => (b.disabled = true));
  try{
    const res = await fetch(`/api/players/captain/${teamId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: Number(playerId), message_id: Number(messageId) }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível escolher o capitão');
    actionsBox.insertAdjacentHTML('afterend', `<p class="msg-decision-note">${data.body}</p>`);
    actionsBox.remove();
    await loadMessages();
  }catch(err){
    actionsBox.querySelectorAll('.captain-pick-btn').forEach((b) => (b.disabled = false));
    actionsBox.insertAdjacentHTML('afterend', `<p class="msg-decision-note">${err.message}</p>`);
  }
}

/* ---------- Painel genérico de decisão (substitui window.prompt) ----------
   Usado sempre que é preciso pedir um valor ao treinador antes de continuar
   uma ação — contrapropostas, dias de afastamento, preço de lista de
   transferências, etc. — com um painel próprio da interface em vez do
   prompt() nativo do browser. Quando `step` é passado, mostra também os
   botões +/- que ajustam o campo nesse incremento fixo (ex: contraproposta
   em saltos de £2.000). Devolve uma Promise que resolve com o texto
   introduzido, ou null se o treinador cancelar (Cancelar, X, clique fora,
   ou tecla Esc). */
function openDecisionModal({
  title = '',
  message = '',
  label = '',
  placeholder = '',
  defaultValue = '',
  hint = '',
  confirmLabel = 'OK',
  cancelLabel = 'Cancelar',
  inputMode = '',
  step = null,
  min = 0,
  // Diálogos que só precisam de confirmação (sem nada para escrever)
  // escondem a caixa de texto — senão abria o teclado do telemóvel sem
  // razão nenhuma. Nesse caso o confirmar devolve '' em vez do texto.
  hideInput = false,
} = {}){
  return new Promise((resolve) => {
    const overlay = el('decisionModalOverlay');
    const input = el('decisionModalInput');
    const labelEl = el('decisionModalLabel');
    const hintEl = el('decisionModalHint');
    const errorEl = el('decisionModalError');
    const confirmBtn = el('decisionModalConfirm');
    const cancelBtn = el('decisionModalCancel');
    const closeBtn = el('decisionModalClose');
    const stepperEl = el('decisionModalStepper');
    const stepDownBtn = el('decisionModalStepDown');
    const stepUpBtn = el('decisionModalStepUp');

    el('decisionModalTitle').textContent = title;
    el('decisionModalMessage').textContent = message;
    labelEl.textContent = label;
    labelEl.classList.toggle('hidden', !label);
    input.value = defaultValue;
    input.placeholder = placeholder;
    input.inputMode = inputMode || '';
    if(hint){ hintEl.textContent = hint; hintEl.classList.remove('hidden'); }
    else{ hintEl.classList.add('hidden'); }
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
    confirmBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    stepperEl.classList.toggle('hidden-steppers', !step);

    input.classList.toggle('hidden', !!hideInput);
    if(hideInput) stepperEl.classList.add('hidden-steppers');

    overlay.classList.remove('hidden');
    if(!hideInput) setTimeout(() => { input.focus(); input.select(); }, 20);
    else setTimeout(() => confirmBtn.focus(), 20);

    function adjust(delta){
      const current = Number(String(input.value).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
      const next = Math.max(min, current + delta);
      input.value = String(Math.round(next));
    }
    function onStepUp(){ adjust(step); }
    function onStepDown(){ adjust(-step); }

    function cleanup(){
      overlay.classList.add('hidden');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      input.removeEventListener('keydown', onKeydown);
      stepUpBtn.removeEventListener('click', onStepUp);
      stepDownBtn.removeEventListener('click', onStepDown);
    }
    function onConfirm(){
      const value = input.value;
      cleanup();
      resolve(value);
    }
    function onCancel(){
      cleanup();
      resolve(null);
    }
    function onOverlayClick(e){
      if(e.target === overlay) onCancel();
    }
    function onKeydown(e){
      if(e.key === 'Enter'){ e.preventDefault(); onConfirm(); }
      else if(e.key === 'Escape'){ e.preventDefault(); onCancel(); }
    }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    input.addEventListener('keydown', onKeydown);
    if(step){
      stepUpBtn.addEventListener('click', onStepUp);
      stepDownBtn.addEventListener('click', onStepDown);
    }
  });
}

/* ---------- Contrapropor uma oferta pendente ---------- */
async function counterOffer(offerId, actionsBox, currentAmount){
  const suggested = Math.round((Number(currentAmount) || 0) * 1.15);
  const amountText = await openDecisionModal({
    title: 'Contraproposta',
    message: `Oferta atual: ${fmtMoney(currentAmount)}. Por quanto queres contrapropor?`,
    label: 'Valor da contraproposta',
    placeholder: suggested ? String(suggested) : '',
    defaultValue: suggested ? String(suggested) : '',
    inputMode: 'decimal',
    confirmLabel: 'Enviar Contraproposta',
    step: 2000,
    min: Number(currentAmount) || 0,
  });
  if(amountText === null) return; // cancelou

  const counterAmount = Number(String(amountText).replace(/[^\d.,]/g, '').replace(',', '.'));
  if(!counterAmount || counterAmount <= Number(currentAmount)){
    actionsBox.insertAdjacentHTML('afterend', '<p class="msg-decision-note">A contraproposta tem de ser um valor acima da oferta atual.</p>');
    return;
  }

  actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = true));
  try{
    const res = await fetch(`/api/transfers/${offerId}/counter`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ counter_amount: counterAmount }),
    });
    const data = await res.json().catch(() => null);
    if(!res.ok) throw new Error(data?.error || 'Erro ao contrapropor');
    await loadMessages();
    await loadClub();
    loadOverview();
  }catch(err){
    actionsBox.querySelectorAll('.msg-btn').forEach((b) => (b.disabled = false));
    actionsBox.insertAdjacentHTML('afterend', `<p class="msg-decision-note">${err.message || 'Não foi possível enviar a contraproposta.'}</p>`);
  }
}

/* ---------- Responder a um incidente de personalidade ---------- */
async function respondToIncident(incidentId, action, actionsBox){
  const body = { action };

  if(action === 'stand_down'){
    const daysText = await openDecisionModal({
      title: 'Afastar Temporariamente',
      message: 'Durante quantos dias fica o jogador afastado do plantel?',
      label: 'Dias de afastamento',
      defaultValue: '7',
      inputMode: 'numeric',
      confirmLabel: 'Confirmar Afastamento',
    });
    if(daysText === null) return; // cancelou
    const days = Number(daysText);
    if(!days || days <= 0){
      actionsBox.insertAdjacentHTML('afterend', '<p class="msg-decision-note">Número de dias inválido.</p>');
      return;
    }
    body.duration_days = days;
  }else if(action === 'transfer_list'){
    const priceText = await openDecisionModal({
      title: 'Lista de Transferências',
      message: 'Por quanto colocas o jogador na lista de transferências?',
      label: 'Preço pedido',
      placeholder: 'Automático',
      hint: 'Deixa em branco para um valor automático.',
      inputMode: 'decimal',
      confirmLabel: 'Colocar na Lista',
    });
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

/* ---------- Banner "Jogo de Hoje" — aparece quando há um jogo marcado
   para a data atual do calendário, com os botões Jogar / Simular. Mesma
   informação da mensagem "match_day" na caixa de entrada (ver
   renderMessageDetail) — o banner é só um atalho mais visível. ---------- */
function updateTodayMatchBanner(){
  const banner = el('todayMatchBanner');
  if(!currentGameDate){ banner.classList.add('hidden'); return; }
  const todayMatch = upcomingFriendliesCache.find((f) => f.match_date === currentGameDate);
  if(!todayMatch){ banner.classList.add('hidden'); return; }

  el('todayMatchTeams').innerHTML =
    `${friendlyTeamHtml(todayMatch.home_name, todayMatch.home_shield)} <span class="friendly-vs">vs</span> ${friendlyTeamHtml(todayMatch.away_name, todayMatch.away_shield)}`;
  banner.classList.remove('hidden');
  el('playTodayMatchBtn').onclick = () => openPreMatchTalk(todayMatch.id);
  el('simulateTodayMatchBtn').onclick = () => simulateTodayMatch(todayMatch.id, el('simulateTodayMatchBtn'));
}

/* ---------- Botão "Simular": resolve o jogo já, sem abrir o ecrã ao vivo ---------- */
async function simulateTodayMatch(friendlyId, btn){
  btn.disabled = true;
  const playBtn = el('playTodayMatchBtn');
  if(playBtn) playBtn.disabled = true;
  try{
    const res = await fetch(`/api/game/matches/${friendlyId}/simulate-now`, { method: 'POST' });
    if(!res.ok) throw new Error();
    const result = await res.json();
    await loadMessages();
    await loadFriendlies();
    loadOverview();
    if(result.home_score !== undefined){
      showNewMessageToast(1);
    }
  }catch(err){
    btn.disabled = false;
    if(playBtn) playBtn.disabled = false;
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

/* ---------- Cerimónia de Prémios de Fim de Época + Gala do 11 ---------- */
let ceremonyShownForMsgId = null;
let galaShownForMsgId = null;
let pendingGalaData = null;

async function handleSeasonRolloverPopups(rolloverMsgId){
  if(ceremonyShownForMsgId === rolloverMsgId && galaShownForMsgId === rolloverMsgId) return; // já mostrado nesta sessão

  let awardsData = null;
  let galaData = null;
  try{
    const res = await fetch(`/api/league/awards-ceremony/${teamId}`);
    if(res.ok){
      const d = await res.json();
      if(d.status === 'ready' && d.awards.length) awardsData = d;
    }
  }catch(err){ /* segue sem a cerimónia, o utilizador continua a ver os prémios na caixa de entrada */ }

  try{
    const res = await fetch(`/api/league/season-gala/${teamId}`);
    if(res.ok){
      const d = await res.json();
      if(d.status === 'ready' && d.lineup.length) galaData = d;
    }
  }catch(err){ /* sem gala não há problema, é só um extra visual */ }

  if(!awardsData && !galaData) return;

  ceremonyShownForMsgId = rolloverMsgId;
  galaShownForMsgId = rolloverMsgId;

  if(awardsData){
    // A Gala só abre depois de a cerimónia de prémios ser fechada (ver
    // closeCeremonyAndMaybeOpenGala) — não faz sentido as duas ao mesmo tempo.
    pendingGalaData = galaData;
    openAwardsCeremony(awardsData);
  }else if(galaData){
    openSeasonGala(galaData);
  }

  fetch(`/api/transfers/messages/${rolloverMsgId}/read`, { method: 'PUT' }).then(() => loadMessages());
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

function closeCeremonyAndMaybeOpenGala(){
  el('ceremonyOverlay').classList.add('hidden');
  if(pendingGalaData){
    const data = pendingGalaData;
    pendingGalaData = null;
    openSeasonGala(data);
  }
}

el('ceremonyClose').addEventListener('click', closeCeremonyAndMaybeOpenGala);
el('ceremonyOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'ceremonyOverlay') closeCeremonyAndMaybeOpenGala();
});

/* ---------- Gala do 11 da Época ----------
   Anima a entrada de cada jogador do "11 do Ano" (ver GET
   /api/league/season-gala/:teamId) um a um no relvado, na posição certa
   de uma formação 4-3-3 fixa — reaproveita exatamente as mesmas
   coordenadas x/y usadas na Tática (ver FORMATIONS mais abaixo neste
   ficheiro) para o visual bater certo com o resto do jogo. */
const GALA_REVEAL_DELAY_MS = 1100;
let galaRevealTimer = null;
let galaRevealTimeouts = [];

function galaSlotPositions(){
  // FORMATIONS só é definida mais abaixo neste ficheiro, mas por essa
  // altura o script já correu por completo — esta função só é chamada em
  // resposta a eventos (nunca durante o carregamento inicial do ficheiro).
  return (typeof FORMATIONS !== 'undefined' && FORMATIONS['4-3-3']) || [
    { x: 50, y: 92 }, { x: 82, y: 74 }, { x: 62, y: 78 }, { x: 38, y: 78 }, { x: 18, y: 74 },
    { x: 50, y: 58 }, { x: 30, y: 50 }, { x: 70, y: 50 },
    { x: 80, y: 26 }, { x: 50, y: 16 }, { x: 20, y: 26 },
  ];
}

function openSeasonGala(data){
  clearTimeout(galaRevealTimer);
  galaRevealTimeouts.forEach((t) => clearTimeout(t));
  galaRevealTimeouts = [];

  el('galaTitle').textContent = `O 11 do Ano — Época ${data.season_label}`;
  el('galaCaption').textContent = 'A preparar a entrada dos jogadores…';

  const positions = galaSlotPositions();
  const slots = el('galaPitchSlots');
  slots.innerHTML = data.lineup.map((p, i) => {
    const pos = positions[i] || { x: 50, y: 50 };
    return `
      <div class="gala-slot" id="galaSlot-${i}" style="left:${pos.x}%;top:${pos.y}%;">
        <div class="slot-avatar-wrap"><div class="slot-circle">${p.player_photo ? `<img src="${p.player_photo}" alt="">` : '🧑'}</div></div>
        <div class="gala-slot-name">${p.player_name}</div>
        <div class="gala-slot-team">${p.team_name || ''}</div>
      </div>`;
  }).join('');

  el('galaOverlay').classList.remove('hidden');
  galaRevealPlayers(data.lineup);
}

function galaRevealPlayers(lineup){
  lineup.forEach((p, i) => {
    const t = setTimeout(() => {
      const slotEl = el(`galaSlot-${i}`);
      if(slotEl) slotEl.classList.add('gala-slot-in');
      el('galaCaption').textContent = i === lineup.length - 1
        ? 'O 11 do Ano está completo!'
        : `A entrar em campo: ${p.player_name} (${p.team_name || 'Sem clube'})`;
    }, i * GALA_REVEAL_DELAY_MS);
    galaRevealTimeouts.push(t);
  });
}

function galaSkipToEnd(){
  galaRevealTimeouts.forEach((t) => clearTimeout(t));
  galaRevealTimeouts = [];
  document.querySelectorAll('#galaPitchSlots .gala-slot').forEach((s) => s.classList.add('gala-slot-in'));
  el('galaCaption').textContent = 'O 11 do Ano está completo!';
}

el('galaSkip').addEventListener('click', galaSkipToEnd);
el('galaClose').addEventListener('click', () => {
  el('galaOverlay').classList.add('hidden');
  galaRevealTimeouts.forEach((t) => clearTimeout(t));
  galaRevealTimeouts = [];
});
el('galaOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'galaOverlay') el('galaClose').click();
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

/* ---------- Aba Cláusulas ---------- */
const CLAUSE_TYPE_LABELS = {
  installments: '💷 Pagamento em prestações',
  goal_bonus: '🎯 Prémio por golos',
  sell_on_percentage: '📈 Percentagem de próxima venda',
};

async function loadClauses(){
  const list = el('clausesList');
  const empty = el('clausesEmpty');
  list.innerHTML = '<p class="placeholder-text">A carregar…</p>';
  try{
    const res = await fetch('/api/transfers/clauses');
    if(!res.ok) throw new Error();
    const data = await res.json();
    const clauses = data.clauses || [];

    if(!clauses.length){
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    list.innerHTML = clauses.map((c) => {
      const photo = c.player_photo ? `<img class="clause-item-photo" src="${c.player_photo}" alt="">` : '<div class="clause-item-photo"></div>';
      const beneficiaryShield = c.beneficiary_shield ? `<img src="${c.beneficiary_shield}" alt="">` : '';
      const obligorShield = c.obligor_shield ? `<img src="${c.obligor_shield}" alt="">` : '';
      const statusLabel = c.status === 'fulfilled' ? 'Cumprida' : 'Ativa';
      let progress = '';
      if(c.type === 'installments'){
        progress = `${c.months_paid}/${c.months} prestações pagas`;
      }else if(c.type === 'goal_bonus'){
        progress = `${c.goals_scored_since}/${c.goals_threshold} golos`;
      }
      return `
        <div class="clause-item">
          ${photo}
          <div class="clause-item-main">
            <div class="clause-item-title">${CLAUSE_TYPE_LABELS[c.type] || 'Cláusula'} — ${c.player_name || '—'}</div>
            <div class="clause-item-teams">${obligorShield}<span>${c.obligor_name || '—'}</span><span class="arrow">→</span>${beneficiaryShield}<span>${c.beneficiary_name || '—'}</span></div>
            <div class="clause-item-desc">${c.description}</div>
            ${progress ? `<div class="clause-item-progress">${progress}</div>` : ''}
          </div>
          <div class="clause-item-status ${c.status}">${statusLabel}</div>
        </div>`;
    }).join('');
  }catch(err){
    list.innerHTML = '';
    empty.classList.remove('hidden');
  }
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
let liveSubModalOutId = null; // jogador escolhido para sair, dentro da janela de substituições
let liveAnimQueue = [];  // fila dos golos/lances por animar no campo (ver playLiveBallAnimation)
let liveAnimPlaying = false;
let liveIdleTimer = null;      // ver startLiveIdleMotion — movimento de posse "fantasma" fora dos lances
let liveIdleZone = { x: 50, y: 50 };
let liveInstructionsMeta = null; // catálogo de /meta/instructions (labels/dicas), pedido uma única vez

function shieldHtml(team){
  return team.team_shield
    ? `<img src="${team.team_shield}" alt="">`
    : '⚽';
}

async function openLiveMatch(friendlyId){
  liveFriendlyId = friendlyId;
  liveState = null;
  liveBusy = false;
  liveSubModalOutId = null;
  liveAnimQueue = [];
  liveAnimPlaying = false;
  liveIdleZone = { x: 50, y: 50 };
  postTalkPromptShownFor = null;
  el('liveMatchOverlay').classList.remove('hidden');
  el('liveSubModalOverlay').classList.add('hidden');
  el('liveSideCol').classList.remove('open');
  el('liveDrawerBackdrop').classList.remove('open');
  el('liveFeed').innerHTML = '<p class="placeholder-text">A carregar…</p>';
  el('livePitchTokens').innerHTML = '';
  el('livePitchBall').style.opacity = '0';
  el('livePitchIdleBall').style.left = '50%';
  el('livePitchIdleBall').style.top = '50%';
  el('liveGoalFlash').classList.remove('show');
  el('liveScoreNumbers').textContent = '0 - 0';
  el('liveMinute').textContent = "0'";
  el('liveProgressFill').style.width = '0%';
  el('liveHalfLine').textContent = '';
  el('liveSummaryPanel').classList.add('hidden');
  el('livePlayBtn').disabled = true;
  el('liveAutoBtn').disabled = true;

  // Tenta abrir mesmo em ecrã inteiro (não só CSS) e, dentro dele, travar
  // a orientação na horizontal — falha silenciosamente em navegadores/
  // dispositivos que não suportem (ex.: iOS Safari), sem incomodar ninguém.
  try{
    const rootEl = document.documentElement;
    if(rootEl.requestFullscreen) await rootEl.requestFullscreen().catch(() => {});
    if(screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(() => {});
  }catch(err){ /* ecrã inteiro/orientação são só um extra — o CSS já cobre o essencial */ }

  try{
    let res = await fetch(`/api/live-matches/${friendlyId}`);
    if(res.status === 404){
      res = await fetch(`/api/live-matches/${friendlyId}/start`, { method: 'POST' });
    }
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível carregar o jogo');
    applyLiveState(data, data.events || []);
    startLiveAuto(); // o jogo começa a simular-se sozinho assim que abre — não é preciso clicar em nada
    startLiveIdleMotion();
    loadLiveInstructionsMeta();
  }catch(err){
    el('liveFeed').innerHTML = `<p class="placeholder-text">${err.message}</p>`;
  }
}

function closeLiveMatch(){
  el('liveMatchOverlay').classList.add('hidden');
  el('liveSubModalOverlay').classList.add('hidden');
  stopLiveAuto();
  stopLiveIdleMotion();
  if(document.fullscreenElement) document.exitFullscreen().catch(() => {});
  liveFriendlyId = null;
  liveState = null;
  liveSubModalOutId = null;
  liveAnimQueue = [];
  liveAnimPlaying = false;
}
el('liveMatchClose').addEventListener('click', closeLiveMatch);
el('liveMatchOverlay').addEventListener('click', (e) => {
  if(e.target === el('liveMatchOverlay')) closeLiveMatch();
});

el('liveFullscreenBtn').addEventListener('click', async () => {
  try{
    if(document.fullscreenElement){
      await document.exitFullscreen();
    }else{
      await document.documentElement.requestFullscreen();
      if(screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }
  }catch(err){ /* alguns browsers recusam pedidos de ecrã inteiro fora de um gesto direto — sem problema */ }
});
document.addEventListener('fullscreenchange', () => {
  el('liveFullscreenBtn').classList.toggle('active', !!document.fullscreenElement);
});

el('liveDrawerToggle').addEventListener('click', () => {
  el('liveSideCol').classList.toggle('open');
  el('liveDrawerBackdrop').classList.toggle('open');
});
el('liveDrawerBackdrop').addEventListener('click', () => {
  el('liveSideCol').classList.remove('open');
  el('liveDrawerBackdrop').classList.remove('open');
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

/* ---------- Campo desenhado na horizontal ----------
   Toda a lógica do "motor" acima (slotCoords, alvo dos remates, empurrões
   táticos de playOrganizedMovement, zona de posse de startLiveIdleMotion)
   continua a pensar sempre num campo vertical clássico: x = posição na
   largura do campo, y = profundidade (perto da própria baliza a perto de
   100, perto da baliza contrária a perto de 0). É só aqui, no momento de
   desenhar no ecrã, que se trocam os eixos — o campo aparece deitado
   (balizas à esquerda/direita) para caber melhor num ecrã inteiro em
   modo paisagem, sem ter de reescrever toda a matemática do jogo. */
function toScreenPct(pt){
  return { left: pt.y, top: pt.x };
}

function liveTokenHtml(p, x, y, teamState){
  const isMySelectable = teamState.is_user && liveState && liveState.status !== 'finished';
  const sideClass = teamState.is_user ? 'side-user' : 'side-opponent';
  const badges = [];
  if(p.goals) badges.push(`<span class="live-token-badge">⚽${p.goals > 1 ? `×${p.goals}` : ''}</span>`);
  if(p.assists) badges.push(`<span class="live-token-badge">🅰️${p.assists > 1 ? `×${p.assists}` : ''}</span>`);
  const swayDelay = (Math.random() * 2.6).toFixed(2); // dessincroniza o "balanço" de cada jogador — não parecem estátuas
  const screen = toScreenPct({ x, y });
  return `
    <div class="live-token ${sideClass}${isMySelectable ? ' selectable' : ''}"
         style="left:${screen.left}%;top:${screen.top}%;--sway-delay:${swayDelay}s;" data-player-id="${p.id}">
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

  /* Clicar num boneco em campo (só os teus) abre a janela dedicada de
     substituições já com esse jogador escolhido para sair — ver
     openSubModal. */
  container.querySelectorAll('.live-token.selectable').forEach((tokenEl) => {
    tokenEl.addEventListener('click', () => openSubModal(Number(tokenEl.dataset.playerId)));
  });
}

/* ---------- Animação dos golos e lances de perigo no campo ----------
   Usa os campos player_id / side / outcome / keeper_id que o servidor
   agora inclui em cada evento de golo/lance (ver resolveEvent em
   routes/liveMatch.js) para saber que boneco mexe a bola e para onde ela
   vai: a baliza (golo), o guarda-redes (defesa) ou para fora da área
   (remate ao lado / trave). */
function findLiveTokenPosition(playerId, side, data){
  if(!playerId || !data || !data[side]) return null;
  const teamState = data[side];
  const idx = teamState.on_pitch.findIndex((p) => p.id === playerId);
  if(idx === -1) return null;
  const p = teamState.on_pitch[idx];
  return slotCoords(teamState.formation, p.slot_index ?? idx, side === 'away');
}

/* ================================================================
   GEOMETRIA REAL DO CAMPO -----------------------------------------
   O espaço de jogo (x = largura, y = profundidade) é 0-100 nos dois
   eixos, mas um campo não é quadrado: 105m de comprimento por 68m de
   largura. Logo 1% de y = 1,05m e 1% de x = 0,68m. Sem isto, tudo o
   que fosse calculado "em percentagem" ficava esticado à largura e
   esmagado ao comprimento, e as distâncias não correspondiam a nada.

   IMPORTANTE — era daqui que vinha o problema dos golos de muito
   longe: slotCoords comprime cada equipa na SUA metade (o ponta de
   lança do 4-3-3 fica em y=58, a baliza adversária está em y≈0), por
   isso rematar a partir do slot da formação dava sempre um remate de
   ~59 metros. As jogadas abaixo passam a levar a bola até ao último
   terço ANTES de rematar, e o ponto de remate é sorteado nas zonas
   onde se marcam golos a sério (quase sempre dentro da área).
   ================================================================ */
const PITCH = {
  LENGTH_M: 105,
  WIDTH_M: 68,
  // metros -> % do eixo correspondente
  yFromM: (m) => (m / 105) * 100,
  xFromM: (m) => (m / 68) * 100,
};

// Marcações oficiais, convertidas para % de profundidade (distância à
// linha de baliza que se ataca).
const AREA = {
  SIX_YARD: PITCH.yFromM(5.5),      // ~5.2%
  PEN_SPOT: PITCH.yFromM(11),       // ~10.5%
  PEN_AREA: PITCH.yFromM(16.5),     // ~15.7%
  EDGE_D: PITCH.yFromM(20),         // ~19%  (bico da meia-lua)
  FINAL_THIRD: PITCH.yFromM(35),    // ~33%
};

// Meias-larguras das marcações, em % de largura, medidas a partir do
// centro (x=50).
const HALF_W = {
  GOAL: PITCH.xFromM(7.32 / 2),     // ~5.4%  -> postes em x 44.6 / 55.4
  SIX_YARD: PITCH.xFromM(18.32 / 2),// ~13.5%
  PEN_AREA: PITCH.xFromM(40.32 / 2),// ~29.6%
};

/* Converte "distância à linha de baliza que esta equipa ataca" em y de
   jogo, e vice-versa. O 'home' ataca para y=0, o 'away' para y=100. */
function depthY(side, distPct){ return side === 'home' ? distPct : 100 - distPct; }
function distFromGoal(side, y){ return side === 'home' ? y : 100 - y; }

/* Distância real, em metros, entre dois pontos do campo — respeitando
   que os eixos têm escalas diferentes. */
function metersBetween(a, b){
  const dx = (a.x - b.x) / 100 * PITCH.WIDTH_M;
  const dy = (a.y - b.y) / 100 * PITCH.LENGTH_M;
  return Math.sqrt(dx * dx + dy * dy);
}

function rand(min, max){ return min + Math.random() * (max - min); }

/* Zonas de remate com a frequência aproximada com que se marcam golos
   a sério. Aferido por simulação: mediana ~13m, 82% dentro da área,
   38% a 11m ou menos, e no máximo ~29m — que é o perfil real do
   futebol. Antes disto, TODOS os golos saíam a ~59m. */
const SHOT_ZONES = [
  { weight: 26, dist: [1.8, AREA.SIX_YARD + 0.5], halfWidth: HALF_W.SIX_YARD - 2 },        // desvio / tap-in na pequena área
  { weight: 46, dist: [AREA.SIX_YARD, AREA.PEN_SPOT + 2.5], halfWidth: HALF_W.SIX_YARD + 5 }, // coração da área
  { weight: 20, dist: [AREA.PEN_SPOT + 1, AREA.PEN_AREA + 1], halfWidth: HALF_W.PEN_AREA - 11 }, // bico da área
  { weight: 8, dist: [AREA.PEN_AREA + 1, AREA.EDGE_D + 6], halfWidth: 16 },                 // remate de fora
];

function pickShotZone(preferred){
  if(preferred) return preferred;
  const total = SHOT_ZONES.reduce((sum, z) => sum + z.weight, 0);
  let roll = Math.random() * total;
  for(const zone of SHOT_ZONES){
    roll -= zone.weight;
    if(roll <= 0) return zone;
  }
  return SHOT_ZONES[1];
}

/* Ponto de onde se remata, já no lado certo do campo. */
function shotSpot(side, zone){
  const z = pickShotZone(zone);
  return {
    x: Math.max(6, Math.min(94, 50 + rand(-z.halfWidth, z.halfWidth))),
    y: depthY(side, rand(z.dist[0], z.dist[1])),
  };
}

/* Alvo dentro da baliza: canto, meia-altura ou ao centro — nunca sempre
   o mesmo sítio. 'y' fica ligeiramente atrás da linha para a bola
   parecer entrar mesmo na rede. */
function goalTarget(side, placement){
  const spots = placement ? [placement] : ['left', 'right', 'center', 'left', 'right'];
  const pick = spots[Math.floor(Math.random() * spots.length)];
  const offset = pick === 'center' ? rand(-1.5, 1.5)
    : (pick === 'left' ? -rand(HALF_W.GOAL * 0.45, HALF_W.GOAL * 0.85)
                       : rand(HALF_W.GOAL * 0.45, HALF_W.GOAL * 0.85));
  return { x: 50 + offset, y: depthY(side, -1.2) };
}

function liveGoalMouthFor(side){
  // mantido para o resto do código que só quer "a baliza" sem pontaria
  return { x: 50, y: side === 'home' ? 1.6 : 98.4 };
}

/* Posição de partida do guarda-redes e o quanto ele sai da linha
   consoante a distância do remate — um GR sai muito num frente-a-frente
   e quase nada num remate de fora. */
function keeperHomeSpot(side){
  return { x: 50, y: depthY(side, 2.5) };
}

function keeperRushSpot(side, ballPos){
  const dist = distFromGoal(side, ballPos.y);
  const advance = Math.max(1.5, Math.min(AREA.PEN_SPOT, dist * 0.35));
  const lateral = (ballPos.x - 50) * 0.35; // fecha o ângulo, sem colar ao poste
  return { x: 50 + Math.max(-9, Math.min(9, lateral)), y: depthY(side, advance) };
}

/* ---------- Jogadas de equipa organizadas (ataque vs. defesa) ----------
   Nos golos e lances de perigo, os 10 jogadores de campo de cada equipa
   movem-se como um bloco organizado, não só quem remata:

   - Equipa a atacar: amplitude e profundidade — os avançados correm para
     as costas da defesa (perto do alvo do lance), os restantes abrem um
     pouco mais o campo nas laterais para esticar a marcação adversária,
     todos empurrando em direção à baliza contrária (mais os avançados,
     menos os defesas — ver CATEGORY_ATTACK_PUSH).
   - Equipa a defender: bloco compacto — todos recuam em direção à própria
     baliza (mais quem está mais avançado, que tem mais terreno para
     cobrir) e fecham ligeiramente para o centro, para proteger a zona
     central e a grande área (ver CATEGORY_DEFEND_DROP).

   São movimentos temporários (voltam à posição da formação a seguir),
   só para dar a sensação de bloco organizado no momento do lance — não
   uma IA tática completa. */
const CATEGORY_ATTACK_PUSH = { DEF: 4, MED: 8, MO: 13, PL: 17 };
const CATEGORY_DEFEND_DROP = { DEF: 3, MED: 6, MO: 9, PL: 11 };

function moveTokenTemporarily(playerId, board, targetPct, holdMs, moveMs){
  const tokenEl = board.querySelector(`.live-token[data-player-id="${playerId}"]`);
  if(!tokenEl) return;
  const originLeft = tokenEl.style.left;
  const originTop = tokenEl.style.top;
  const screen = toScreenPct(targetPct);
  tokenEl.style.transition = `left ${moveMs || 900}ms ease, top ${moveMs || 900}ms ease`;
  tokenEl.style.left = `${screen.left}%`;
  tokenEl.style.top = `${screen.top}%`;
  setTimeout(() => {
    tokenEl.style.left = originLeft;
    tokenEl.style.top = originTop;
  }, holdMs);
}

function playOrganizedMovement(ev, data, origin, target, defendSide, holdMs, moveMs){
  const board = el('livePitchTokens');
  if(!board) return;

  const attackState = data[ev.side];
  const defendState = data[defendSide];
  const attackDir = ev.side === 'home' ? -1 : 1; // sentido do ataque, para a baliza adversária

  attackState.on_pitch.filter((p) => p.category !== 'GR').forEach((p) => {
    const pos = findLiveTokenPosition(p.id, ev.side, data);
    if(!pos) return;
    const push = CATEGORY_ATTACK_PUSH[p.category] ?? 8;
    let targetX;
    if(p.category === 'PL'){
      // avançados: correm para as costas da defesa, perto do alvo do lance
      targetX = pos.x + (target.x - pos.x) * 0.3;
    }else{
      // restantes: mantêm a amplitude, abrindo mais um pouco o campo
      targetX = pos.x + (pos.x >= 50 ? 3 : -3);
    }
    const targetY = pos.y + attackDir * push;
    moveTokenTemporarily(p.id, board, {
      x: Math.max(6, Math.min(94, targetX)),
      y: Math.max(3, Math.min(97, targetY)),
    }, holdMs || 1500, moveMs);
  });

  defendState.on_pitch.filter((p) => p.category !== 'GR').forEach((p) => {
    const pos = findLiveTokenPosition(p.id, defendSide, data);
    if(!pos) return;
    const drop = CATEGORY_DEFEND_DROP[p.category] ?? 6;
    const dropDir = -attackDir; // recua para a própria baliza
    const targetY = pos.y + dropDir * drop;
    const targetX = pos.x + (50 - pos.x) * 0.18; // fecha ligeiramente para o centro, protegendo a grande área
    moveTokenTemporarily(p.id, board, {
      x: Math.max(6, Math.min(94, targetX)),
      y: Math.max(3, Math.min(97, targetY)),
    }, holdMs || 1500, moveMs);
  });
}

/* ================================================================
   MOTOR DE GOLOS "AO ESTILO CAMPO.JS" ------------------------------
   Porta para aqui a mesma linguagem visual do protótipo campo.js —
   bola em curva (Bezier), cabeceamentos com salto, jogadas construídas
   passo a passo com awaits, rede a abanar, "GOLO!" a aparecer, e a
   equipa toda a correr para a bandeirola de canto a festejar — só que
   em cima das posições REAIS dos jogadores em campo (não há coordenadas
   fixas por jogada como no protótipo, por isso a "jogada" em si é
   sorteada de um pequeno leque de coreografias a cada golo).
   ================================================================ */

function wait(ms){ return new Promise((resolve) => setTimeout(resolve, ms)); }

// Todas as jogadas de golo ficam mais lentas do que a velocidade "base"
// escrita nas coreografias — dois abrandamentos de 10% acumulados
// (1,1 x 1,1), para dar tempo de seguir a bola de jogador em jogador.
// T() converte cada duração/pausa das coreografias abaixo.
const GOAL_TIME_SCALE = 1.21;
function T(ms){ return Math.round(ms * GOAL_TIME_SCALE); }

// Converte um ponto em espaço de campo (x=largura, y=profundidade, tal
// como slotCoords/findLiveTokenPosition) diretamente para as % de ecrã
// já usadas por toScreenPct, e desloca o boneco com uma transição CSS —
// equivalente ao movePlayer do campo.js.
function moveTokenSmooth(playerId, board, targetPct, durationMs){
  const tokenEl = board.querySelector(`.live-token[data-player-id="${playerId}"]`);
  const d = T(durationMs);
  if(!tokenEl) return wait(d);
  const screen = toScreenPct(targetPct);
  tokenEl.style.transition = `left ${d}ms cubic-bezier(.4,0,.2,1), top ${d}ms cubic-bezier(.4,0,.2,1)`;
  requestAnimationFrame(() => {
    tokenEl.style.left = `${screen.left}%`;
    tokenEl.style.top = `${screen.top}%`;
  });
  return wait(d);
}

// Equivalente ao moveBallLinear do campo.js — desloca a bola em linha
// reta (passes curtos, toques, etc.).
function moveBallLinearField(point, durationMs){
  const ball = el('livePitchBall');
  const d = T(durationMs);
  if(!ball) return wait(d);
  const screen = toScreenPct(point);
  ball.style.transition = `left ${d}ms linear, top ${d}ms linear`;
  ball.style.opacity = '1';
  requestAnimationFrame(() => {
    ball.style.left = `${screen.left}%`;
    ball.style.top = `${screen.top}%`;
  });
  return wait(d);
}

// Equivalente ao moveBallCurve do campo.js — voo em curva de Bezier
// quadrática (cruzamentos, remates, passes em profundidade). Os 3 pontos
// são em espaço de campo; convertem-se para % de ecrã antes de animar,
// frame a frame, tal como no protótipo.
function moveBallCurveField(p0, p1, p2, durationMs){
  const ball = el('livePitchBall');
  const d = T(durationMs);
  if(!ball) return wait(d);
  const s0 = toScreenPct(p0);
  const s1 = toScreenPct(p1);
  const s2 = toScreenPct(p2);
  ball.style.transition = 'none';
  ball.style.opacity = '1';
  const start = performance.now();
  return new Promise((resolve) => {
    function frame(now){
      const t = Math.min(1, (now - start) / d);
      const left = (1 - t) * (1 - t) * s0.left + 2 * (1 - t) * t * s1.left + t * t * s2.left;
      const top = (1 - t) * (1 - t) * s0.top + 2 * (1 - t) * t * s1.top + t * t * s2.top;
      ball.style.left = `${left}%`;
      ball.style.top = `${top}%`;
      if(t < 1){ requestAnimationFrame(frame); } else { resolve(); }
    }
    requestAnimationFrame(frame);
  });
}

function placeBallInstant(point){
  const ball = el('livePitchBall');
  if(!ball) return;
  const screen = toScreenPct(point);
  ball.style.transition = 'none';
  ball.style.left = `${screen.left}%`;
  ball.style.top = `${screen.top}%`;
  ball.style.opacity = '1';
  void ball.offsetWidth;
}

function tokenClass(playerId, board, cls, on){
  const tokenEl = board.querySelector(`.live-token[data-player-id="${playerId}"]`);
  if(!tokenEl) return;
  tokenEl.classList.toggle(cls, on);
}

// desloca por instantes um grupo de defesas parcialmente na direção de um
// ponto (a bola, o corredor do ataque) — mesma ideia do trackDefenders do
// campo.js, para a defesa parecer reagir à jogada em vez de ficar imóvel.
function trackDefendersToward(ids, target, side, data, board, durationMs, pull){
  ids.forEach((id) => {
    const pos = findLiveTokenPosition(id, side, data);
    if(!pos) return;
    const nx = pos.x + (target.x - pos.x) * pull;
    const ny = pos.y + (target.y - pos.y) * pull;
    moveTokenSmooth(id, board, { x: Math.max(4, Math.min(96, nx)), y: Math.max(2, Math.min(98, ny)) }, durationMs);
  });
}

const GOAL_FLASH_MESSAGES = ['⚽ GOLO!', '⚽ GOLAÇO!', '⚽ QUE GOLO!', '⚽ ESTÁ LÁ DENTRO!', '⚽ SEM HIPÓTESE!'];

// baliza aberta para 'right center' (topo) ou 'left center' (fundo) — ver
// transform-origin em dashboard.css — para a rede parecer mesmo a abanar
// para dentro/fora, e não só a esticar do centro.
function pulseGoalNet(side){
  const goalEl = document.querySelector(side === 'home' ? '.live-pitch-goal-top' : '.live-pitch-goal-bottom');
  if(!goalEl) return;
  goalEl.classList.remove('net-ripple');
  void goalEl.offsetWidth; // força reflow para poder repetir a animação em golos seguidos
  goalEl.classList.add('net-ripple');
}

function showGoalFlash(){
  const flash = el('liveGoalFlash');
  if(!flash) return;
  flash.textContent = GOAL_FLASH_MESSAGES[Math.floor(Math.random() * GOAL_FLASH_MESSAGES.length)];
  flash.classList.remove('show');
  void flash.offsetWidth;
  flash.classList.add('show');
}

// bandeirolas de canto perto da baliza que a equipa acabou de festejar —
// duas opções (lado de cima/baixo do campo), tal como CORNER_TOP/BOTTOM
// no protótipo campo.js.
function goalCornersFor(side){
  const y = side === 'home' ? 3 : 97;
  return [{ x: 6, y }, { x: 94, y }];
}

/* ---------- Festejo final — SEMPRE o mesmo, tal como finishGoal no
   campo.js: rede a abanar, "GOLO!" a aparecer, e toda a equipa (menos
   o guarda-redes) a correr para a bandeirola de canto mais próxima para
   festejar em grupo. A defesa fica por instantes mais apagada. A única
   coisa que varia de golo para golo é a JOGADA que leva até aqui (ver
   GOAL_SEQUENCES mais abaixo), não o festejo em si. ---------- */
async function finishGoalOnPitch(ctx){
  const { board, ev, data, teamState, defendState, defendSide } = ctx;

  pulseGoalNet(ev.side);
  showGoalFlash();

  defendState.on_pitch.filter((p) => p.category !== 'GR').forEach((p) => tokenClass(p.id, board, 'slump', true));

  await wait(T(280));

  const corners = goalCornersFor(ev.side);
  const corner = corners[Math.floor(Math.random() * corners.length)];
  const celebrators = teamState.on_pitch.filter((p) => p.category !== 'GR').map((p) => p.id);

  const runPromises = celebrators.map((id, i) => {
    const target = {
      x: Math.max(3, Math.min(97, corner.x + (Math.random() * 16 - 8))),
      y: Math.max(1, Math.min(99, corner.y + (i % 5) * 2.4 * (ev.side === 'home' ? 1 : -1))),
    };
    return moveTokenSmooth(id, board, target, 620 + (i % 5) * 70).then(() => {
      tokenClass(id, board, id === ctx.scorerId ? 'celebrate-big' : 'celebrate', true);
    });
  });
  await Promise.all(runPromises);
  await wait(T(700));

  defendState.on_pitch.forEach((p) => tokenClass(p.id, board, 'slump', false));
  celebrators.forEach((id) => tokenClass(id, board, 'celebrate', false));
  celebrators.forEach((id) => tokenClass(id, board, 'celebrate-big', false));

  // devolve toda a gente à posição da formação (a próxima jogada/idle
  // motion continua a partir daí, tal como já acontecia antes).
  renderLivePitch(data);
}

/* ---------- Jogadas até ao golo — sorteada uma de cada vez, sem repetir
   a anterior, tal como pickVariant/lastVariantIndex no campo.js.

   Todas seguem a mesma gramática do futebol a sério: a bola SOBE o campo
   por fases (construção -> último terço -> zona de remate) e só depois é
   que se remata, de um ponto sorteado por shotSpot(). O guarda-redes sai
   da linha consoante a distância, e os defesas mais próximos tentam
   fechar a linha de remate. ---------- */

/* Leva um jogador + bola de onde estão até ao último terço, passando por
   um ponto intermédio — é o "carregar a bola" que faltava e que fazia
   com que se rematasse sempre da linha média. */
async function advanceToFinalThird(ctx, carrierId, fromPos, targetSpot){
  const { board, side } = ctx;
  const mid = {
    x: (fromPos.x + targetSpot.x) / 2 + rand(-8, 8),
    y: (fromPos.y + targetSpot.y) / 2,
  };
  const legMs = Math.max(260, Math.min(620, metersBetween(fromPos, mid) * 11));
  await Promise.all([
    moveBallLinearField(mid, legMs),
    moveTokenSmooth(carrierId, board, mid, legMs),
  ]);
  const leg2 = Math.max(260, Math.min(620, metersBetween(mid, targetSpot) * 11));
  await Promise.all([
    moveBallLinearField(targetSpot, leg2),
    moveTokenSmooth(carrierId, board, targetSpot, leg2),
  ]);
  return targetSpot;
}

/* O remate propriamente dito: duração proporcional à distância real
   (um tap-in é instantâneo, um remate de 25m demora), curva mais aberta
   nos remates de longe, e o GR a sair à bola. */
async function strikeAtGoal(ctx, fromPos, opts = {}){
  const { side, board, keeperId } = ctx;
  const target = opts.target || goalTarget(side);
  const meters = metersBetween(fromPos, target);
  const flightMs = Math.max(220, Math.min(760, meters * 26));

  if(keeperId){
    moveTokenSmooth(keeperId, board, keeperRushSpot(side, fromPos), Math.min(420, flightMs));
  }

  const bend = Math.min(16, meters * 0.55);
  const mid = {
    x: (fromPos.x + target.x) / 2 + rand(-bend, bend),
    y: (fromPos.y + target.y) / 2,
  };
  await moveBallCurveField(fromPos, mid, target, flightMs);
  return target;
}

/* ---------- Defesa coletiva: os 10 reagem, não só um ----------
   Numa defesa a sério ninguém fica parado: quem está perto da bola
   pressiona, quem está atrás faz cobertura, e TODO o bloco desliza
   para o lado da bola (ball-side compactness) mantendo a linha. Estas
   funções tratam o conjunto; devolvem sempre o bloco todo mexido. */

// Posições atuais (formação) de todos os defesas de campo, já ordenadas
// pela distância real à bola.
function defendersByDistance(ctx, point){
  const { defendState, defendSide, data } = ctx;
  return defendState.on_pitch
    .filter((p) => p.category !== 'GR')
    .map((p) => ({ id: p.id, category: p.category, pos: findLiveTokenPosition(p.id, defendSide, data) }))
    .filter((d) => d.pos)
    .sort((a, b) => metersBetween(a.pos, point) - metersBetween(b.pos, point));
}

function closestDefendersTo(ctx, point, count){
  return defendersByDistance(ctx, point).slice(0, count);
}

/* O bloco defensivo inteiro reage à posição da bola:
   - os 2 mais próximos saem à bola (pressão + apoio);
   - os 3 seguintes fazem cobertura, a meio caminho entre a bola e a
     própria baliza;
   - os restantes deslizam para o lado da bola e recuam, mantendo a
     linha compacta em vez de ficarem colados ao slot da formação. */
function defensiveBlock(ctx, point, durationMs){
  const { board, defendSide } = ctx;
  const goalY = depthY(defendSide === 'home' ? 'away' : 'home', 0); // a baliza que ESTES defendem
  const ranked = defendersByDistance(ctx, point);

  ranked.forEach((d, i) => {
    let target;
    if(i < 2){
      // pressão direta à bola
      const pull = i === 0 ? 0.78 : 0.5;
      target = {
        x: d.pos.x + (point.x - d.pos.x) * pull,
        y: d.pos.y + (point.y - d.pos.y) * pull,
      };
    } else if(i < 5){
      // cobertura: entre a bola e a própria baliza
      const cover = 0.34;
      target = {
        x: d.pos.x + (point.x - d.pos.x) * cover,
        y: d.pos.y + ((point.y + goalY) / 2 - d.pos.y) * cover,
      };
    } else {
      // resto do bloco: desliza para o lado da bola e encurta a linha
      target = {
        x: d.pos.x + (point.x - d.pos.x) * 0.2,
        y: d.pos.y + (goalY - d.pos.y) * 0.12,
      };
    }
    moveTokenSmooth(d.id, board, {
      x: Math.max(4, Math.min(96, target.x)),
      y: Math.max(2, Math.min(98, target.y)),
    }, durationMs);
  });
  return ranked;
}

// Mantido para chamadas antigas: pressão só dos mais próximos.
function pressBall(ctx, point, durationMs, count = 2){
  closestDefendersTo(ctx, point, count).forEach((d, i) => {
    const pull = i === 0 ? 0.72 : 0.45;
    moveTokenSmooth(d.id, ctx.board, {
      x: Math.max(4, Math.min(96, d.pos.x + (point.x - d.pos.x) * pull)),
      y: Math.max(2, Math.min(98, d.pos.y + (point.y - d.pos.y) * pull)),
    }, durationMs);
  });
}

/* Um defesa tenta mesmo o corte/desarme: vai à bola e falha por pouco
   (a bola já saiu). Dá a sensação de lance disputado. */
async function attemptTackle(ctx, point, durationMs){
  const d = closestDefendersTo(ctx, point, 1)[0];
  if(!d) return;
  await moveTokenSmooth(d.id, ctx.board, {
    x: Math.max(4, Math.min(96, d.pos.x + (point.x - d.pos.x) * 0.92)),
    y: Math.max(2, Math.min(98, d.pos.y + (point.y - d.pos.y) * 0.92)),
  }, durationMs);
}

/* ---------- Construção com muitos jogadores ----------
   Encadeia uma série de passes por vários colegas, subindo o campo a
   cada toque. A cada passe: o passador acompanha a jogada, o recetor
   sai para o espaço, e o bloco defensivo inteiro desliza outra vez.
   Devolve a posição final da bola e quem a tem. */
async function buildUpChain(ctx, carrierIds, startPos, endDepthPct){
  const { board, side } = ctx;
  let ballPos = startPos;
  let holderId = carrierIds[0];

  placeBallInstant(startPos);

  const links = Math.min(carrierIds.length - 1, 4);
  for(let i = 1; i <= links; i += 1){
    const nextId = carrierIds[i];
    const progress = i / (links + 1);
    // ponto de receção: sobe o campo e alterna de corredor, como numa
    // circulação real (não é uma linha reta até à baliza)
    const depth = distFromGoal(side, startPos.y) +
      (endDepthPct - distFromGoal(side, startPos.y)) * progress;
    const receive = {
      x: Math.max(8, Math.min(92, 50 + Math.sin(i * 1.9) * rand(16, 30))),
      y: depthY(side, depth),
    };

    // o recetor desloca-se para o espaço enquanto a bola viaja
    moveTokenSmooth(nextId, board, receive, T(420));
    defensiveBlock(ctx, receive, T(480));

    const meters = metersBetween(ballPos, receive);
    const passMs = Math.max(240, Math.min(620, meters * 13));
    await moveBallLinearField(receive, passMs);

    // o passador acompanha a jogada em vez de ficar para trás
    const followPos = {
      x: Math.max(6, Math.min(94, ballPos.x + (receive.x - ballPos.x) * 0.35)),
      y: depthY(side, distFromGoal(side, ballPos.y) - rand(3, 7)),
    };
    moveTokenSmooth(holderId, board, followPos, T(520));

    ballPos = receive;
    holderId = nextId;
    await wait(T(70));
  }

  return { ballPos, holderId };
}

/* Escolhe uma cadeia de colegas para a construção, começando pelos mais
   recuados e acabando perto do marcador — assim a bola sobe mesmo o
   campo de trás para a frente, passando por muita gente. */
function buildUpSquad(ctx, links){
  const { side, teamState, data, scorerId, assisterId } = ctx;
  const outfield = teamState.on_pitch
    .filter((p) => p.category !== 'GR' && p.id !== scorerId && p.id !== assisterId)
    .map((p) => ({ id: p.id, pos: findLiveTokenPosition(p.id, side, data) }))
    .filter((p) => p.pos)
    // mais recuado primeiro (maior distância à baliza que se ataca)
    .sort((a, b) => distFromGoal(side, b.pos.y) - distFromGoal(side, a.pos.y));

  const chain = outfield.slice(0, Math.max(2, links)).map((p) => p.id);
  if(assisterId) chain.push(assisterId);
  return chain;
}

// Cruzamento: construção por vários jogadores até ao ala, que leva a
// bola à linha de fundo e cruza; vários colegas atacam a área e toda a
// defesa recua para a proteger.
async function seqCruzamento(ctx){
  const { board, data, side, scorerId, assisterId, teammateIds, scorerPos } = ctx;
  const wingerId = assisterId || teammateIds[0] || scorerId;

  // construção coletiva até ao meio-campo ofensivo
  const chain = buildUpSquad(ctx, 3);
  chain.push(wingerId);
  const startPos = findLiveTokenPosition(chain[0], side, data) || scorerPos;
  const built = await buildUpChain(ctx, chain, startPos, AREA.FINAL_THIRD + 6);

  // ala vai à linha de fundo, do lado onde a bola já está
  const flank = built.ballPos.x >= 50 ? 1 : -1;
  const wideSpot = { x: 50 + flank * rand(30, 38), y: depthY(side, rand(4, 9)) };
  defensiveBlock(ctx, wideSpot, T(560));
  await advanceToFinalThird(ctx, built.holderId, built.ballPos, wideSpot);
  await attemptTackle(ctx, wideSpot, T(300));

  // vários atacantes carregam a área: 1º poste, 2º poste e entrada
  const headerSpot = {
    x: 50 - flank * rand(2, 12),
    y: depthY(side, rand(AREA.SIX_YARD, AREA.PEN_SPOT + 2)),
  };
  const runners = teammateIds.filter((id) => id !== wingerId).slice(0, 3);
  runners.forEach((id, i) => {
    moveTokenSmooth(id, board, {
      x: Math.max(10, Math.min(90, 50 + flank * (i === 0 ? -18 : (i === 1 ? 12 : 0)))),
      y: depthY(side, [AREA.SIX_YARD - 1, AREA.PEN_SPOT + 1, AREA.PEN_AREA + 2][i]),
    }, T(520));
  });
  moveTokenSmooth(scorerId, board, headerSpot, T(500));
  defensiveBlock(ctx, headerSpot, T(540));
  await wait(T(320));

  const crossMid = { x: (wideSpot.x + headerSpot.x) / 2, y: depthY(side, rand(2, 5)) };
  await moveBallCurveField(wideSpot, crossMid, headerSpot, 620);

  tokenClass(scorerId, board, 'jump', true);
  await wait(T(190));
  tokenClass(scorerId, board, 'jump', false);

  await strikeAtGoal(ctx, headerSpot);
}

// Contra-ataque: saída rápida com 3-4 jogadores a correr em conjunto,
// com a defesa a recuar em bloco a tentar chegar a tempo.
async function seqContraAtaque(ctx){
  const { board, data, side, teammateIds, scorerId, scorerPos } = ctx;

  const chain = buildUpSquad(ctx, 2);
  chain.push(scorerId);
  const startPos = findLiveTokenPosition(chain[0], side, data) || scorerPos;

  // colegas acompanham a transição em vários corredores
  const support = teammateIds.filter((id) => !chain.includes(id)).slice(0, 3);
  support.forEach((id, i) => {
    moveTokenSmooth(id, board, {
      x: Math.max(10, Math.min(90, 50 + (i - 1) * rand(22, 30))),
      y: depthY(side, rand(AREA.FINAL_THIRD - 4, AREA.FINAL_THIRD + 8)),
    }, T(900));
  });

  const built = await buildUpChain(ctx, chain, startPos, AREA.FINAL_THIRD - 2);
  defensiveBlock(ctx, built.ballPos, T(620));

  const finish = shotSpot(side, SHOT_ZONES[1]);
  // os apoios entram na área com o portador
  support.forEach((id, i) => {
    moveTokenSmooth(id, board, {
      x: Math.max(10, Math.min(90, finish.x + (i - 1) * rand(12, 20))),
      y: depthY(side, rand(AREA.SIX_YARD, AREA.PEN_AREA)),
    }, T(620));
  });
  await advanceToFinalThird(ctx, built.holderId, built.ballPos, finish);
  await attemptTackle(ctx, finish, T(280));
  defensiveBlock(ctx, finish, T(420));
  await strikeAtGoal(ctx, finish);
}

// Triangulação: circulação por vários jogadores à entrada da área,
// contra um bloco defensivo fechado, terminando num um-dois.
async function seqTriangulacao(ctx){
  const { board, data, side, teammateIds, scorerId, scorerPos } = ctx;
  const wallId = teammateIds[0] || scorerId;

  const chain = buildUpSquad(ctx, 4);
  const startPos = findLiveTokenPosition(chain[0], side, data) || scorerPos;
  const built = await buildUpChain(ctx, chain, startPos, AREA.EDGE_D + 8);

  // entrada da área, com o bloco todo a fechar o centro
  const entry = { x: 50 + rand(-18, 18), y: depthY(side, rand(AREA.PEN_AREA + 1, AREA.EDGE_D + 3)) };
  const wallUp = { x: entry.x + rand(-18, -9), y: depthY(side, rand(AREA.PEN_AREA, AREA.EDGE_D)) };
  moveTokenSmooth(wallId, board, wallUp, T(620));
  moveTokenSmooth(scorerId, board, entry, T(620));
  defensiveBlock(ctx, entry, T(660));
  await moveBallLinearField(entry, 600);

  await attemptTackle(ctx, entry, T(300));

  // um-dois a abrir o bloco
  await moveBallLinearField(wallUp, 320);
  defensiveBlock(ctx, wallUp, T(360));

  const finish = shotSpot(side, SHOT_ZONES[1]);
  moveTokenSmooth(scorerId, board, finish, T(400));
  defensiveBlock(ctx, finish, T(420));
  await moveBallLinearField(finish, 380);

  await strikeAtGoal(ctx, finish);
}

// Jogada individual, mas com a equipa a dar opções e a defesa a
// fechar-lhe o caminho jogador a jogador.
async function seqSolo(ctx){
  const { board, side, scorerId, scorerPos, teammateIds } = ctx;
  placeBallInstant(scorerPos);

  // colegas abrem o campo para arrastar marcações
  teammateIds.slice(0, 3).forEach((id, i) => {
    moveTokenSmooth(id, board, {
      x: Math.max(8, Math.min(92, 50 + (i - 1) * rand(24, 32))),
      y: depthY(side, rand(AREA.PEN_AREA, AREA.FINAL_THIRD)),
    }, T(880));
  });

  const finish = shotSpot(side, Math.random() < 0.6 ? SHOT_ZONES[1] : SHOT_ZONES[2]);
  let current = scorerPos;
  const steps = 4;

  for(let i = 0; i < steps; i += 1){
    const t = (i + 1) / (steps + 1);
    const next = {
      x: Math.max(8, Math.min(92, current.x + (finish.x - current.x) * t + rand(-9, 9))),
      y: current.y + (finish.y - current.y) * (0.38 + i * 0.05),
    };
    // todo o bloco reage, e o mais próximo tenta mesmo o desarme
    defensiveBlock(ctx, next, T(400));
    const beaten = closestDefendersTo(ctx, next, 1)[0];
    if(beaten){
      moveTokenSmooth(beaten.id, board, {
        x: beaten.pos.x + (next.x - beaten.pos.x) * 0.85,
        y: beaten.pos.y + (next.y - beaten.pos.y) * 0.85,
      }, T(340));
    }
    const legMs = Math.max(240, Math.min(520, metersBetween(current, next) * 12));
    await Promise.all([
      moveBallLinearField(next, legMs),
      moveTokenSmooth(scorerId, board, next, legMs),
    ]);
    current = next;
  }

  await Promise.all([
    moveBallLinearField(finish, 320),
    moveTokenSmooth(scorerId, board, finish, 320),
  ]);
  defensiveBlock(ctx, finish, T(360));
  await strikeAtGoal(ctx, finish);
}

// Remate de fora: muita circulação a puxar o bloco de um lado para o
// outro até abrir espaço para o pontapé.
async function seqRemateDeFora(ctx){
  const { board, data, side, scorerId, scorerPos } = ctx;

  const chain = buildUpSquad(ctx, 4);
  chain.push(scorerId);
  const startPos = findLiveTokenPosition(chain[0], side, data) || scorerPos;
  const built = await buildUpChain(ctx, chain, startPos, AREA.EDGE_D + 10);

  const spot = shotSpot(side, SHOT_ZONES[3]);
  moveTokenSmooth(scorerId, board, spot, T(520));
  defensiveBlock(ctx, spot, T(560));
  await moveBallLinearField(spot, 460);

  // alguém sai à pressão, mas tarde
  await attemptTackle(ctx, spot, T(340));
  await wait(T(120));
  await strikeAtGoal(ctx, spot);
}
const GOAL_SEQUENCES = [seqCruzamento, seqContraAtaque, seqTriangulacao, seqSolo, seqRemateDeFora];
let lastGoalSequenceIndex = -1;

function pickGoalSequence(){
  let idx = Math.floor(Math.random() * GOAL_SEQUENCES.length);
  if(GOAL_SEQUENCES.length > 1 && idx === lastGoalSequenceIndex){
    idx = (idx + 1) % GOAL_SEQUENCES.length;
  }
  lastGoalSequenceIndex = idx;
  return GOAL_SEQUENCES[idx];
}

async function playGoalSequence(ev, data){
  const board = el('livePitchTokens');
  const ball = el('livePitchBall');
  if(!board || !ball || !ev.player_id) return;

  const side = ev.side;
  const defendSide = side === 'home' ? 'away' : 'home';
  const teamState = data[side];
  const defendState = data[defendSide];
  const scorerId = ev.player_id;
  const scorerPos = findLiveTokenPosition(scorerId, side, data);
  if(!scorerPos) return;

  const teammateIds = teamState.on_pitch
    .filter((p) => p.category !== 'GR' && p.id !== scorerId && p.id !== ev.assister_id)
    .map((p) => p.id)
    .sort(() => Math.random() - 0.5);
  if(ev.assister_id) teammateIds.unshift(ev.assister_id);
  const defenderIds = defendState.on_pitch.filter((p) => p.category !== 'GR').map((p) => p.id).sort(() => Math.random() - 0.5);
  const keeper = defendState.on_pitch.find((p) => p.category === 'GR');

  const idleBall = el('livePitchIdleBall');
  if(idleBall) idleBall.style.opacity = '0';

  // O GR começa o lance em cima da própria linha, não no slot da
  // formação — é de lá que depois sai à bola em strikeAtGoal.
  if(keeper) moveTokenSmooth(keeper.id, board, keeperHomeSpot(defendSide), 300);

  const ctx = {
    ev, data, board, side, defendSide, teamState, defendState,
    scorerId, assisterId: ev.assister_id || null, teammateIds, defenderIds,
    keeperId: keeper ? keeper.id : null,
    scorerPos, goalMouth: liveGoalMouthFor(side),
  };

  try{
    // O bloco inteiro (10 jogadores de cada lado) reage à jogada como
    // numa fase de ataque real — atacantes sobem, defesas recuam e
    // fecham o centro — enquanto os intervenientes da coreografia
    // sorteada (ver abaixo) fazem o movimento específico por cima.
    // Com a construção a passar por vários jogadores, a jogada é bem mais
    // longa — o bloco tem de aguentar a posição até ao fim, senão os
    // bonecos saltavam de volta à formação a meio do lance.
    playOrganizedMovement(ev, data, scorerPos, ctx.goalMouth, defendSide, T(7000), T(1000));

    const sequence = pickGoalSequence();
    await sequence(ctx);

    const attackerToken = board.querySelector(`.live-token[data-player-id="${scorerId}"]`);
    if(attackerToken){
      attackerToken.classList.remove('kick-pulse');
      void attackerToken.offsetWidth;
      attackerToken.classList.add('kick-pulse');
    }

    await finishGoalOnPitch(ctx);
  } finally {
    ball.style.opacity = '0';
    if(idleBall) idleBall.style.opacity = '.85';
  }
}

/* ---------- Lances sem golo (defesa, corte, para fora, ao poste) ----------
   Usa a mesma geometria real das jogadas de golo: o atacante leva a bola
   ao último terço e remata de uma zona plausível. O que muda é o
   desfecho — o GR defende, um defesa corta, ou a bola sai ao lado. */
async function playLiveChanceAnimation(ev, data){
  const board = el('livePitchTokens');
  const ball = el('livePitchBall');
  if(!board || !ball) return wait(400);

  const side = ev.side;
  const defendSide = side === 'home' ? 'away' : 'home';
  const origin = findLiveTokenPosition(ev.player_id, side, data);
  if(!origin) return wait(200); // jogador já não está em campo — sem animação

  const teamState = data[side];
  const defendState = data[defendSide];
  const ctx = {
    ev, data, board, side, defendSide, teamState, defendState,
    scorerId: ev.player_id, assisterId: ev.assister_id || null,
    keeperId: ev.keeper_id || null,
    scorerPos: origin, goalMouth: liveGoalMouthFor(side),
  };

  const idleBall = el('livePitchIdleBall');
  if(idleBall) idleBall.style.opacity = '0';

  // remates bloqueados nascem tipicamente mais perto; os que saem ao
  // lado, de zonas mais abertas.
  const zone = ev.outcome === 'blocked' ? SHOT_ZONES[1]
    : (ev.outcome === 'saved' ? null : SHOT_ZONES[2]);
  const spot = shotSpot(side, zone);

  playOrganizedMovement(ev, data, origin, spot, defendSide, T(3400), T(900));

  try{
    // construção com vários jogadores também nos lances sem golo
    const chain = buildUpSquad(ctx, 2);
    chain.push(ev.player_id);
    const startPos = findLiveTokenPosition(chain[0], side, data) || origin;
    const built = await buildUpChain(ctx, chain, startPos, AREA.FINAL_THIRD);
    defensiveBlock(ctx, built.ballPos, T(560));
    await advanceToFinalThird(ctx, built.holderId, built.ballPos, spot);
    defensiveBlock(ctx, spot, T(460));
    await attemptTackle(ctx, spot, T(300));

    const attackerToken = board.querySelector(`.live-token[data-player-id="${ev.player_id}"]`);
    if(attackerToken){
      attackerToken.classList.remove('kick-pulse');
      void attackerToken.offsetWidth;
      attackerToken.classList.add('kick-pulse');
    }

    if(ev.outcome === 'blocked'){
      // um defesa atira-se à frente e corta o remate
      const blocker = closestDefendersTo(ctx, spot, 1)[0];
      const blockPoint = blocker
        ? { x: (spot.x + blocker.pos.x) / 2, y: (spot.y + blocker.pos.y) / 2 }
        : { x: spot.x, y: depthY(side, distFromGoal(side, spot.y) - 4) };
      if(blocker) moveTokenSmooth(blocker.id, board, blockPoint, 260);
      await moveBallLinearField(blockPoint, 280);
      // ressalta para fora da área
      await moveBallCurveField(blockPoint,
        { x: blockPoint.x + rand(-14, 14), y: depthY(side, distFromGoal(side, blockPoint.y) + 9) },
        { x: Math.max(6, Math.min(94, blockPoint.x + rand(-22, 22))), y: depthY(side, distFromGoal(side, blockPoint.y) + 17) },
        420);
    } else if(ev.outcome === 'saved'){
      const keeperPos = ev.keeper_id ? findLiveTokenPosition(ev.keeper_id, defendSide, data) : null;
      const target = keeperPos ? keeperRushSpot(side, spot) : goalTarget(side);
      if(ev.keeper_id) moveTokenSmooth(ev.keeper_id, board, target, 320);
      await strikeAtGoal(ctx, spot, { target });
      const keeperToken = board.querySelector(`.live-token[data-player-id="${ev.keeper_id}"]`);
      if(keeperToken){
        keeperToken.classList.remove('save-pulse');
        void keeperToken.offsetWidth;
        keeperToken.classList.add('save-pulse');
      }
      // defesa para canto
      await moveBallCurveField(target,
        { x: target.x + rand(-18, 18), y: depthY(side, 4) },
        { x: rand(0, 1) > 0.5 ? rand(2, 8) : rand(92, 98), y: depthY(side, rand(-2, 2)) },
        380);
    } else {
      // ao lado / à trave: passa perto do poste e sai pela linha de fundo
      const post = 50 + (spot.x >= 50 ? 1 : -1) * rand(HALF_W.GOAL, HALF_W.GOAL + 6);
      await strikeAtGoal(ctx, spot, { target: { x: post, y: depthY(side, rand(-3, 0)) } });
    }
  } finally {
    ball.style.opacity = '0';
    if(idleBall) idleBall.style.opacity = '.85';
    renderLivePitch(data);
  }
}
function playLiveBallAnimation(ev, data){
  if(ev.kind === 'goal') return playGoalSequence(ev, data);
  return playLiveChanceAnimation(ev, data);
}

function queueLiveAnimations(newEvents, data){
  (newEvents || []).forEach((ev) => {
    if((ev.kind === 'goal' || ev.kind === 'chance') && ev.player_id) liveAnimQueue.push({ ev, data });
  });
  playNextLiveAnimation();
}

function playNextLiveAnimation(){
  if(liveAnimPlaying || !liveAnimQueue.length) return;
  liveAnimPlaying = true;
  const { ev, data } = liveAnimQueue.shift();
  Promise.resolve(playLiveBallAnimation(ev, data)).then(() => {
    liveAnimPlaying = false;
    playNextLiveAnimation();
  });
}

/* ---------- Movimento de posse "fantasma" (fora dos golos/lances) ----------
   Fora dos momentos de golo/lance (só aí a bola "real" anima-se — ver
   playLiveBallAnimation), o campo não fica só com os 22 bonecos a balançar
   ao acaso: uma bolinha mais discreta (ver .live-pitch-idle-ball) passeia-se
   pelo relvado como se fosse a bola em jogo normal, e os jogadores reagem
   a ela como numa jogada real:
   - os 3 jogadores de cada equipa mais próximos da zona aproximam-se um
     pouco (o mais próximo mais que os outros — como quem vai apoiar/
     pressionar a jogada);
   - quanto maior a Pressão definida pela equipa, mais forte é essa reação,
     tal como no motor do jogo (ver tacticsAttackMultiplier em
     routes/liveMatch.js).
   Tudo isto é só visual — não altera lances, golos nem o marcador, que
   continuam a ser decididos pelo servidor. */
function startLiveIdleMotion(){
  stopLiveIdleMotion();
  liveIdleTimer = setInterval(() => {
    if(!liveState || liveState.status === 'finished' || liveAnimPlaying) return;
    stepLiveIdleMotion();
  }, 2400);
}
function stopLiveIdleMotion(){
  if(liveIdleTimer) clearInterval(liveIdleTimer);
  liveIdleTimer = null;
}

function stepLiveIdleMotion(){
  const data = liveState;
  const board = el('livePitchTokens');
  const idleBall = el('livePitchIdleBall');
  if(!data || !board || !idleBall) return;

  // Passeio aleatório suave da zona de posse "fantasma", sem se afastar
  // muito das zonas mais centrais do campo.
  liveIdleZone = {
    x: Math.max(14, Math.min(86, liveIdleZone.x + (Math.random() * 30 - 15))),
    y: Math.max(12, Math.min(88, liveIdleZone.y + (Math.random() * 30 - 15))),
  };
  const screenZone = toScreenPct(liveIdleZone);
  idleBall.style.left = `${screenZone.left}%`;
  idleBall.style.top = `${screenZone.top}%`;

  ['home', 'away'].forEach((side) => {
    const teamState = data[side];
    if(!teamState) return;
    const outfield = teamState.on_pitch.filter((p) => p.category !== 'GR');
    const withDist = outfield.map((p) => {
      const pos = findLiveTokenPosition(p.id, side, data);
      if(!pos) return null;
      return { p, pos, dist: Math.hypot(pos.x - liveIdleZone.x, pos.y - liveIdleZone.y) };
    }).filter(Boolean).sort((a, b) => a.dist - b.dist);

    const pressing = (teamState.tactics && teamState.tactics.pressing) ?? 50;
    const pressFactor = 0.4 + (pressing / 100) * 0.9; // 0.4 (passiva) a 1.3 (intensa)
    withDist.slice(0, 3).forEach(({ p, pos, dist }, i) => {
      if(dist < 2) return; // já está mesmo ali, não vale a pena animar
      const pull = i === 0 ? 0.34 : 0.16; // o mais próximo aproxima-se mais que os outros dois
      const targetX = pos.x + (liveIdleZone.x - pos.x) * pull * pressFactor;
      const targetY = pos.y + (liveIdleZone.y - pos.y) * pull * pressFactor;
      moveTokenTemporarily(p.id, board, {
        x: Math.max(4, Math.min(96, targetX)),
        y: Math.max(2, Math.min(98, targetY)),
      }, 2100);
    });
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
  queueLiveAnimations(newEvents, data); // golos e lances de perigo ganham vida no campo
  renderLiveSummary(data);
  renderLivePitch(data);

  const myState = liveMySide ? data[liveMySide] : null;
  renderLiveSubPanel(myState);
  renderLiveTacticPanel(myState);
  renderLiveMentalityPanel(myState);
  renderLiveInstructionsPanel(myState);
  if(!el('liveSubModalOverlay').classList.contains('hidden')) renderSubModalLists(myState); // mantém a janela de subs sincronizada se ficar aberta

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

    // Palestra de pós-jogo: abre-se sozinha assim que o jogo termina,
    // uma única vez (ver postTalkPromptShownFor) e só se ainda não foi dada.
    if(!data.post_talk_given && postTalkPromptShownFor !== liveFriendlyId){
      postTalkPromptShownFor = liveFriendlyId;
      setTimeout(() => openPostMatchTalk(), 900);
    }
  }else{
    playBtn.disabled = liveBusy;
    autoBtn.disabled = false;
    playBtn.textContent = "▶ Avançar 5'";
    if(!liveBusy) hint.textContent = '';
  }
}

/* ==========================================================
   Palestra de Balneário (pré-jogo / pós-jogo)
   ========================================================== */
let teamTalkFriendlyId = null;
let teamTalkPhase = null;      // 'pre' | 'post'
let teamTalkOptions = [];
let teamTalkSelectedKey = null;
let postTalkPromptShownFor = null; // evita reabrir a palestra de pós-jogo sozinha mais do que uma vez por jogo

/* ---------- Heurística visual: cada tom de palestra ganha um ícone e uma
   cor de acento com base nas palavras do próprio label/descrição que já
   vêm da API — não depende de conhecer as chaves exatas no backend. ---------- */
const TEAM_TALK_TONE_RULES = [
  { test: /calm|tranquil|seren|sereno/i, icon: '😌', tone: 'calm' },
  { test: /motiv|incentiv|encoraj|confia|acredit|inspira/i, icon: '💪', tone: 'positive' },
  { test: /elogi|parabén|satisfeit|orgulh|felicit/i, icon: '👏', tone: 'positive' },
  { test: /agress|exig|duro|pressã|press[aã]o|grit|forte/i, icon: '🔥', tone: 'intense' },
  { test: /crític|critic|repreend|zang|irrit|dur[ao]s?/i, icon: '⚠️', tone: 'harsh' },
  { test: /realist|honest|direto|direta|sincer/i, icon: '🎯', tone: 'calm' },
  { test: /humor|engraç|descontra|leve|brinca/i, icon: '😄', tone: 'light' },
  { test: /silên|silenc|nada|ignora|passiv/i, icon: '🤐', tone: 'calm' },
];
function guessTeamTalkVisual(o){
  const text = `${o.label || ''} ${o.description || ''}`;
  const rule = TEAM_TALK_TONE_RULES.find((r) => r.test.test(text));
  return rule || { icon: '🗣️', tone: 'calm' };
}

function renderTeamTalkOptions(options){
  teamTalkOptions = options;
  teamTalkSelectedKey = null;
  el('teamTalkConfirmBtn').disabled = true;

  const box = el('teamTalkOptions');
  box.classList.remove('locked');
  box.innerHTML = options.map((o) => {
    const { icon, tone } = guessTeamTalkVisual(o);
    return `
    <button type="button" class="team-talk-option" data-key="${o.key}" data-tone="${tone}">
      <span class="team-talk-option-icon">${icon}</span>
      <span class="team-talk-option-text">
        <span class="team-talk-option-label">${o.label}</span>
        <span class="team-talk-option-desc">${o.description}</span>
      </span>
      <span class="team-talk-option-radio" aria-hidden="true"></span>
    </button>`;
  }).join('');

  box.querySelectorAll('.team-talk-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      teamTalkSelectedKey = btn.dataset.key;
      box.querySelectorAll('.team-talk-option').forEach((b) => b.classList.toggle('selected', b === btn));
      el('teamTalkConfirmBtn').disabled = false;
    });
  });
}

function renderTeamTalkSkeleton(){
  el('teamTalkOptions').innerHTML = `
    <div class="team-talk-skeleton">
      <div class="team-talk-skeleton-row"></div>
      <div class="team-talk-skeleton-row"></div>
      <div class="team-talk-skeleton-row"></div>
    </div>`;
}

async function renderTeamTalkLineup(){
  const lineupBox = el('teamTalkLineup');
  const namesBox = el('teamTalkLineupNames');
  lineupBox.classList.remove('hidden');
  namesBox.textContent = 'A carregar…';

  try{
    const [tacticsRes, playersRes] = await Promise.all([
      fetch(`/api/tactics/${teamId}`),
      fetch(`/api/players?team_id=${teamId}`),
    ]);
    const tactics = await tacticsRes.json();
    const players = await playersRes.json();

    const names = (tactics.lineup || [])
      .map((entry) => players.find((p) => p.id === (entry.player_id ?? entry))?.name)
      .filter(Boolean);

    namesBox.textContent = names.length
      ? `${tactics.formation} — ${names.join(', ')}`
      : 'Ainda não guardaste um onze inicial — vai ser usado o plantel por ordem.';
  }catch(err){
    namesBox.textContent = 'Não foi possível carregar a escalação.';
  }
}

el('teamTalkEditLineupBtn').addEventListener('click', () => {
  el('teamTalkOverlay').classList.add('hidden');
  document.querySelector('.tab[data-tab="tatica"]')?.click();
});

/* ---------- Abre a palestra de PRÉ-JOGO (botão "Jogar") ---------- */
async function openPreMatchTalk(friendlyId){
  teamTalkFriendlyId = friendlyId;
  teamTalkPhase = 'pre';

  el('teamTalkModal').classList.remove('result-win', 'result-loss', 'result-draw');
  el('teamTalkIcon').textContent = '🎙️';
  el('teamTalkKicker').textContent = 'PRÉ-JOGO';
  el('teamTalkHeadline').textContent = 'Palestra de Pré-Jogo';
  el('teamTalkPrompt').textContent = 'Escolhe o tom da tua palestra antes de entrarem em campo:';
  el('teamTalkResult').classList.add('hidden');
  el('teamTalkConfirmBtn').classList.remove('hidden');
  el('teamTalkConfirmBtn').textContent = 'Começar Jogo';
  el('teamTalkConfirmBtn').disabled = true;
  el('teamTalkContinueBtn').classList.add('hidden');
  el('teamTalkDoneBtn').classList.add('hidden');
  renderTeamTalkSkeleton();
  el('teamTalkOverlay').classList.remove('hidden');

  renderTeamTalkLineup();

  try{
    const res = await fetch(`/api/live-matches/${friendlyId}/team-talk-options`);
    if(!res.ok) throw new Error();
    const data = await res.json();

    if(data.pre_talk_given){
      el('teamTalkPrompt').textContent = 'Já deste a palestra de pré-jogo para este encontro.';
      el('teamTalkOptions').innerHTML = '';
      el('teamTalkConfirmBtn').classList.add('hidden');
      el('teamTalkContinueBtn').classList.remove('hidden');
    }else{
      renderTeamTalkOptions(data.pre);
    }
  }catch(err){
    el('teamTalkOptions').innerHTML = '<p class="placeholder-text">Não foi possível carregar as opções de palestra.</p>';
  }
}

/* ---------- Abre a palestra de PÓS-JOGO (automático ao terminar o jogo ao vivo) ----------
   O ícone e a cor do painel refletem logo o resultado (vitória, derrota ou
   empate) do ponto de vista do clube do treinador. */
async function openPostMatchTalk(){
  teamTalkFriendlyId = liveFriendlyId;
  teamTalkPhase = 'post';

  const us = liveMySide === 'away' ? liveState.away_score : liveState.home_score;
  const them = liveMySide === 'away' ? liveState.home_score : liveState.away_score;
  const resultClass = us > them ? 'result-win' : (us < them ? 'result-loss' : 'result-draw');
  const resultIcon = us > them ? '🏆' : (us < them ? '😞' : '🤝');
  const resultKicker = us > them ? 'VITÓRIA' : (us < them ? 'DERROTA' : 'EMPATE');

  el('teamTalkModal').classList.remove('result-win', 'result-loss', 'result-draw');
  el('teamTalkModal').classList.add(resultClass);
  el('teamTalkIcon').textContent = resultIcon;
  el('teamTalkKicker').textContent = `PÓS-JOGO · ${resultKicker}`;
  el('teamTalkHeadline').textContent = `Resultado Final: ${liveState.home_score} - ${liveState.away_score}`;
  el('teamTalkPrompt').textContent = 'Escolhe o tom da tua palestra depois do apito final:';
  el('teamTalkLineup').classList.add('hidden');
  el('teamTalkResult').classList.add('hidden');
  el('teamTalkConfirmBtn').classList.remove('hidden');
  el('teamTalkConfirmBtn').textContent = 'Dar Palestra';
  el('teamTalkConfirmBtn').disabled = true;
  el('teamTalkContinueBtn').classList.add('hidden');
  el('teamTalkDoneBtn').classList.add('hidden');
  renderTeamTalkSkeleton();
  el('teamTalkOverlay').classList.remove('hidden');

  try{
    const res = await fetch(`/api/live-matches/${teamTalkFriendlyId}/team-talk-options`);
    if(!res.ok) throw new Error();
    const data = await res.json();

    if(data.post_talk_given || !data.post.length){
      el('teamTalkOverlay').classList.add('hidden');
      return;
    }
    renderTeamTalkOptions(data.post);
  }catch(err){
    el('teamTalkOptions').innerHTML = '<p class="placeholder-text">Não foi possível carregar as opções de palestra.</p>';
  }
}

/* ---------- Confirmar palestra escolhida ---------- */
el('teamTalkConfirmBtn').addEventListener('click', async () => {
  if(!teamTalkSelectedKey || !teamTalkFriendlyId) return;
  const btn = el('teamTalkConfirmBtn');
  btn.disabled = true;

  try{
    const res = await fetch(`/api/live-matches/${teamTalkFriendlyId}/team-talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: teamTalkPhase, talk_key: teamTalkSelectedKey }),
    });
    if(!res.ok) throw new Error();
    const summary = await res.json();

    el('teamTalkOptions').classList.add('locked');

    const chips = [];
    if(summary.up) chips.push(`<span class="team-talk-mood-chip mood-up">😊 +${summary.up} motivado${summary.up === 1 ? '' : 's'}</span>`);
    if(summary.down) chips.push(`<span class="team-talk-mood-chip mood-down">☹️ ${summary.down} descontente${summary.down === 1 ? '' : 's'}</span>`);
    if(!chips.length) chips.push('<span class="team-talk-mood-chip mood-neutral">〰️ Sem grande reação</span>');

    const resultText = summary.up || summary.down
      ? 'O balneário reagiu às tuas palavras.'
      : 'A palestra não teve grande impacto imediato no balneário.';

    const resultBox = el('teamTalkResult');
    resultBox.innerHTML = `
      <div class="team-talk-result-mood">${chips.join('')}</div>
      <p class="team-talk-result-text">${resultText}</p>`;
    resultBox.classList.remove('hidden');

    btn.classList.add('hidden');
    if(teamTalkPhase === 'pre'){
      el('teamTalkContinueBtn').classList.remove('hidden');
    }else{
      el('teamTalkDoneBtn').classList.remove('hidden');
    }
    loadSquad();
  }catch(err){
    btn.disabled = false;
    el('teamTalkResult').innerHTML = '<p class="team-talk-result-text">Não foi possível registar a palestra.</p>';
    el('teamTalkResult').classList.remove('hidden');
  }
});

el('teamTalkContinueBtn').addEventListener('click', () => {
  const friendlyId = teamTalkFriendlyId;
  el('teamTalkOverlay').classList.add('hidden');
  openLiveMatch(friendlyId);
});

el('teamTalkDoneBtn').addEventListener('click', () => el('teamTalkOverlay').classList.add('hidden'));
el('teamTalkClose').addEventListener('click', () => el('teamTalkOverlay').classList.add('hidden'));

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

/* ---------- Substituições: painel principal só mostra o estado ----------
   O clique abre sempre a janela dedicada (ver openSubModal) — em campo
   (com o jogador já pré-selecionado para sair) ou pelo botão do painel. */
function renderLiveSubPanel(myState){
  const panel = el('liveSubPanel');
  const hint = el('liveSubHint');
  const openBtn = el('liveOpenSubModalBtn');

  if(!myState || liveState.status === 'finished'){
    panel.classList.add('disabled');
    return;
  }
  panel.classList.remove('disabled');
  el('liveSubsRemaining').textContent = myState.subs_remaining;

  if(myState.subs_remaining <= 0){
    hint.textContent = 'Já não tens substituições disponíveis.';
    openBtn.disabled = true;
  }else if(!myState.bench.length){
    hint.textContent = 'O banco está vazio.';
    openBtn.disabled = true;
  }else{
    hint.textContent = 'Abre a janela de substituições para trocar um jogador.';
    openBtn.disabled = false;
  }
}
el('liveOpenSubModalBtn').addEventListener('click', () => openSubModal(null));

/* ---------- Janela dedicada de substituições ----------
   Abre por cima do jogo ao vivo: escolhe primeiro quem sai (em campo),
   depois quem entra (banco) — a troca acontece de imediato e a janela
   fecha-se sozinha, voltando a mostrar os bonecos já atualizados no
   campo (ver applyLiveState → renderLivePitch). Os dois lados aparecem
   agrupados por posição, com estrelas de qualidade (ver qualityStars) e
   uma sugestão automática — o melhor jogador do banco na mesma posição
   de quem está a sair — para decidir mais depressa a meio de um jogo. */
const LIVE_CATEGORY_ORDER = ['GR', 'DEF', 'MED', 'MO', 'PL'];
const LIVE_CATEGORY_LABELS = { GR: 'Guarda-Redes', DEF: 'Defesas', MED: 'Médios', MO: 'Meio-Ofensivos', PL: 'Avançados' };

function qualityStars(quality){
  const filled = Math.max(1, Math.min(5, Math.round(((quality ?? 1) / 2.2) * 5)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

function groupByCategory(players){
  const groups = {};
  players.forEach((p) => { (groups[p.category] || (groups[p.category] = [])).push(p); });
  return LIVE_CATEGORY_ORDER
    .filter((cat) => groups[cat] && groups[cat].length)
    .map((cat) => ({ cat, label: LIVE_CATEGORY_LABELS[cat] || cat, players: groups[cat] }));
}

function subModalRowHtml(p, { selected, disabled, suggested }){
  return `
    <div class="live-sub-modal-row${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}${suggested ? ' live-sub-modal-suggested' : ''}" data-player-id="${p.id}">
      <div class="live-sub-modal-row-info">
        <span class="live-token-circle">${p.jersey_number || '•'}</span>
        <span class="live-sub-modal-row-name">${p.name}</span>
        ${p.yellow ? '<span class="live-sub-modal-yellow-tag"></span>' : ''}
      </div>
      <span class="live-sub-modal-pos">${p.position_code || ''}</span>
      <span class="live-sub-modal-stars">${qualityStars(p.quality)}</span>
    </div>`;
}

function openSubModal(preselectOutId){
  const myState = liveMySide ? liveState[liveMySide] : null;
  if(!myState || liveState.status === 'finished') return;
  liveSubModalOutId = (preselectOutId && myState.on_pitch.some((p) => p.id === preselectOutId)) ? preselectOutId : null;
  el('liveSubModalResult').classList.add('hidden');
  renderSubModalLists(myState);
  el('liveSubModalOverlay').classList.remove('hidden');
}

function closeSubModal(){
  el('liveSubModalOverlay').classList.add('hidden');
  liveSubModalOutId = null;
}
el('liveSubModalClose').addEventListener('click', closeSubModal);
el('liveSubModalOverlay').addEventListener('click', (e) => {
  if(e.target === el('liveSubModalOverlay')) closeSubModal();
});

function renderSubModalLists(myState){
  const hint = el('liveSubModalHint');
  const remainingBadge = el('liveSubModalRemaining');
  const selectedBar = el('liveSubModalSelectedBar');
  const onPitchList = el('liveSubModalOnPitch');
  const benchList = el('liveSubModalBench');
  if(!myState){ return; }

  const noSubsLeft = myState.subs_remaining <= 0;
  remainingBadge.textContent = `${myState.subs_remaining} restante${myState.subs_remaining === 1 ? '' : 's'}`;
  remainingBadge.classList.toggle('none', noSubsLeft);

  const outPlayer = liveSubModalOutId ? myState.on_pitch.find((p) => p.id === liveSubModalOutId) : null;

  if(noSubsLeft){
    hint.textContent = 'Já não tens substituições disponíveis.';
  }else if(!myState.bench.length){
    hint.textContent = 'O banco está vazio.';
  }else if(outPlayer){
    hint.textContent = 'Escolhe agora quem entra no banco.';
  }else{
    hint.textContent = 'Escolhe primeiro quem sai do campo.';
  }

  if(outPlayer){
    selectedBar.classList.remove('hidden');
    selectedBar.innerHTML = `
      <span class="live-token-circle">${outPlayer.jersey_number || '•'}</span>
      <span>${outPlayer.name} vai sair</span>
      <button type="button" class="live-sub-modal-selected-clear" id="liveSubModalClearBtn" title="Escolher outro jogador">✕</button>`;
    el('liveSubModalClearBtn').addEventListener('click', () => {
      liveSubModalOutId = null;
      renderSubModalLists(myState);
    });
  }else{
    selectedBar.classList.add('hidden');
    selectedBar.innerHTML = '';
  }

  onPitchList.innerHTML = groupByCategory(myState.on_pitch).map(({ label, players }) => `
    <div class="live-sub-modal-group-label">${label}</div>
    ${players.map((p) => subModalRowHtml(p, { selected: liveSubModalOutId === p.id, disabled: noSubsLeft })).join('')}
  `).join('');
  onPitchList.querySelectorAll('.live-sub-modal-row').forEach((row) => {
    if(noSubsLeft) return;
    row.addEventListener('click', () => {
      const id = Number(row.dataset.playerId);
      liveSubModalOutId = liveSubModalOutId === id ? null : id;
      renderSubModalLists(myState);
    });
  });

  const benchDisabled = noSubsLeft || !liveSubModalOutId;
  // Sugestão: o jogador do banco com melhor qualidade na mesma posição de
  // quem está a sair — só um empurrãozinho, a escolha final é sempre livre.
  let suggestedId = null;
  if(outPlayer && myState.bench.length){
    const sameCategory = myState.bench.filter((p) => p.category === outPlayer.category);
    const pool = sameCategory.length ? sameCategory : myState.bench;
    suggestedId = pool.reduce((best, p) => (!best || (p.quality ?? 0) > (best.quality ?? 0) ? p : best), null)?.id ?? null;
  }

  benchList.innerHTML = myState.bench.length
    ? groupByCategory(myState.bench).map(({ label, players }) => `
        <div class="live-sub-modal-group-label">${label}</div>
        ${players.map((p) => subModalRowHtml(p, { selected: false, disabled: benchDisabled, suggested: p.id === suggestedId })).join('')}
      `).join('')
    : '<p class="live-bench-empty">Banco vazio.</p>';
  benchList.querySelectorAll('.live-sub-modal-row').forEach((row) => {
    row.addEventListener('click', () => {
      if(benchDisabled) return;
      completeSubstitution(Number(row.dataset.playerId));
    });
  });
}

async function completeSubstitution(inId){
  const myState = liveMySide ? liveState[liveMySide] : null;
  const resultBox = el('liveSubModalResult');
  if(!myState) return;
  if(!liveSubModalOutId){
    resultBox.textContent = 'Escolhe primeiro quem sai, clicando num jogador em campo.';
    resultBox.classList.remove('hidden');
    return;
  }

  try{
    const res = await fetch(`/api/live-matches/${liveFriendlyId}/substitution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: myState.team_id, player_out_id: liveSubModalOutId, player_in_id: inId }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível fazer a substituição');
    resultBox.classList.add('hidden');
    closeSubModal();
    applyLiveState(data, data.new_events || []); // fecha a janela e mostra já os bonecos atualizados no jogo
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

/* ---------- Postura tática (mentalidade) a meio do jogo ----------
   Atacante: mais golos, mas defesa mais aberta a contra-ataques.
   Contra-Ataque: espera e sai rápido — funciona muito melhor com jogadores
   velozes em campo, principalmente contra um adversário em postura
   Atacante. Defensiva: muito difícil de sofrer golos, mas cria pouco
   perigo lá à frente. */
const MENTALITY_DESCRIPTIONS = {
  equilibrado: 'Abordagem normal, sem exagerar no ataque nem na defesa.',
  atacante: 'Mais jogadores lançados no ataque — mais golos, mas a defesa fica mais aberta a contra-ataques.',
  contra_ataque: 'Espera pelo erro do adversário e sai rápido — funciona muito melhor com jogadores velozes em campo, principalmente contra equipas em postura atacante.',
  defensiva: 'Fecha-se atrás da bola — muito difícil de sofrer golos, mas cria pouco perigo lá à frente.',
};

function renderLiveMentalityPanel(myState){
  const panel = el('liveMentalityPanel');
  if(!myState || liveState.status === 'finished'){
    panel.classList.add('disabled');
    return;
  }
  panel.classList.remove('disabled');
  const current = myState.mentality || 'equilibrado';
  panel.querySelectorAll('.mentality-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mentality === current);
  });
  el('liveMentalityDesc').textContent = MENTALITY_DESCRIPTIONS[current] || '';
}

el('liveMentalityPicker').querySelectorAll('.mentality-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const myState = liveMySide ? liveState[liveMySide] : null;
    const resultBox = el('liveMentalityResult');
    if(!myState || btn.dataset.mentality === (myState.mentality || 'equilibrado')) return;

    try{
      const res = await fetch(`/api/live-matches/${liveFriendlyId}/mentality`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: myState.team_id, mentality: btn.dataset.mentality }),
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Não foi possível mudar a postura tática');
      resultBox.classList.add('hidden');
      applyLiveState(data, data.new_events || []);
    }catch(err){
      resultBox.textContent = err.message;
      resultBox.classList.remove('hidden');
    }
  });
});

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
/* ==========================================================
   Instruções Táticas avançadas (Jogo ao Vivo)
   — linha de defesa, pressão, comprimento, temporização,
   direção de jogo e perder tempo — ver POST
   /api/live-matches/:friendlyId/instructions em routes/liveMatch.js.
   ========================================================== */
const LIVE_TACTIC_SLIDER_KEYS = ['defensive_line', 'pressing', 'width', 'tempo'];

/* ---------- Catálogo de labels/dicas (pedido uma única vez, ver openLiveMatch) ----------
   Se o pedido falhar (ex.: sem rede), cai num catálogo local equivalente,
   para o painel continuar a funcionar na mesma. */
const LIVE_INSTRUCTIONS_FALLBACK = {
  directness: [
    { key: 'equilibrado', label: 'Equilibrado', description: 'Sem preferência marcada — usa o espaço que a defesa adversária deixar.' },
    { key: 'centro', label: 'Jogar Pelo Centro', description: 'Insiste no corredor central — combinações mais diretas, mas mais fácil de fechar por um bloco compacto.' },
    { key: 'flancos', label: 'Jogar Pelos Flancos', description: 'Estica o jogo pelas alas — mais cruzamentos e finalizações de jogadores de faixa, menos presença central na área.' },
  ],
  sliders: {
    defensive_line: { label: 'Linha de Defesa', low: 'Recuada', high: 'Adiantada', hint: 'Alta ganha metros no terreno, mas deixa espaço nas costas contra equipas rápidas.' },
    pressing: { label: 'Pressão', low: 'Passiva', high: 'Intensa', hint: 'Alta recupera a bola mais perto da baliza contrária, mas cansa e arrisca mais cartões.' },
    width: { label: 'Comprimento', low: 'Estreito', high: 'Largo', hint: 'Largo estica o jogo pelas alas; estreito concentra o jogo no corredor central.' },
    tempo: { label: 'Temporização', low: 'Controlar o Jogo', high: 'Jogo Direto', hint: 'Direto cria mais lances mas com menos critério; controlar reduz o risco.' },
  },
  default: { defensive_line: 50, pressing: 50, tempo: 50, width: 50, directness: 'equilibrado', time_wasting: false },
};

async function loadLiveInstructionsMeta(){
  if(liveInstructionsMeta) { renderLiveInstructionsPanel(liveMySide ? liveState?.[liveMySide] : null); return; }
  try{
    const res = await fetch('/api/live-matches/meta/instructions');
    liveInstructionsMeta = await res.json();
  }catch(err){
    liveInstructionsMeta = LIVE_INSTRUCTIONS_FALLBACK;
  }
  renderLiveInstructionsPanel(liveMySide ? liveState?.[liveMySide] : null);
}

function renderLiveInstructionsPanel(myState){
  const panel = el('liveInstructionsPanel');
  const grid = el('liveTacticsGrid');
  if(!panel || !grid) return;

  if(!myState || !liveState || liveState.status === 'finished'){
    panel.classList.add('disabled');
    return;
  }
  panel.classList.remove('disabled');

  const meta = liveInstructionsMeta || LIVE_INSTRUCTIONS_FALLBACK;
  const tactics = { ...meta.default, ...(myState.tactics || {}) };

  // Só desenha a grelha do zero uma vez (e sempre que muda de jogo) — nas
  // atualizações seguintes só sincroniza valores, para não interromper o
  // utilizador a meio de um arrasto do cursor do slider.
  if(grid.dataset.built !== String(liveFriendlyId)){
    grid.dataset.built = String(liveFriendlyId);
    grid.innerHTML = `
      ${LIVE_TACTIC_SLIDER_KEYS.map((key) => {
        const s = meta.sliders[key] || LIVE_INSTRUCTIONS_FALLBACK.sliders[key];
        return `
        <div class="live-tactic-row" data-key="${key}">
          <div class="live-tactic-row-head">
            <span>${s.label}</span>
            <span class="live-tactic-row-value" id="liveTacticVal_${key}"></span>
          </div>
          <input type="range" min="0" max="100" step="5" id="liveTacticSlider_${key}" data-key="${key}">
          <div class="live-tactic-labels"><span>${s.low}</span><span>${s.high}</span></div>
        </div>`;
      }).join('')}
      <div class="live-tactic-row">
        <div class="live-tactic-row-head"><span>Direção de Jogo</span></div>
        <div class="live-tactic-segmented" id="liveDirectnessSeg">
          ${meta.directness.map((o) => `<button type="button" class="live-tactic-seg-btn" data-directness="${o.key}">${o.label}</button>`).join('')}
        </div>
        <p class="live-tactic-hint" id="liveDirectnessHint"></p>
      </div>
      <div class="live-tactic-row">
        <div class="live-tactic-toggle-row">
          <span class="live-tactic-toggle-desc">⏱️ Perder Tempo — atrasa o jogo para gerir o cronómetro (mais risco de cartão amarelo).</span>
          <div class="live-switch" id="liveTimeWastingSwitch"></div>
        </div>
      </div>
    `;

    LIVE_TACTIC_SLIDER_KEYS.forEach((key) => {
      const slider = el(`liveTacticSlider_${key}`);
      slider.addEventListener('input', () => { el(`liveTacticVal_${key}`).textContent = slider.value; });
      slider.addEventListener('change', () => sendLiveInstructions({ [key]: Number(slider.value) }));
    });

    grid.querySelectorAll('.live-tactic-seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if(btn.classList.contains('active')) return;
        sendLiveInstructions({ directness: btn.dataset.directness });
      });
    });

    el('liveTimeWastingSwitch').addEventListener('click', () => {
      const isOn = el('liveTimeWastingSwitch').classList.contains('on');
      sendLiveInstructions({ time_wasting: !isOn });
    });
  }

  // Sincroniza os valores mostrados com o estado atual da equipa.
  LIVE_TACTIC_SLIDER_KEYS.forEach((key) => {
    const slider = el(`liveTacticSlider_${key}`);
    if(document.activeElement !== slider) slider.value = tactics[key]; // não interrompe um arrasto em curso
    el(`liveTacticVal_${key}`).textContent = slider.value;
  });
  grid.querySelectorAll('.live-tactic-seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.directness === tactics.directness);
  });
  const activeDirectness = meta.directness.find((o) => o.key === tactics.directness);
  el('liveDirectnessHint').textContent = activeDirectness ? activeDirectness.description : '';
  el('liveTimeWastingSwitch').classList.toggle('on', !!tactics.time_wasting);
}

async function sendLiveInstructions(patch){
  const myState = liveMySide ? liveState?.[liveMySide] : null;
  const resultBox = el('liveInstructionsResult');
  if(!myState) return;

  try{
    const res = await fetch(`/api/live-matches/${liveFriendlyId}/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: myState.team_id, ...patch }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Não foi possível ajustar as instruções táticas');
    resultBox.classList.add('hidden');
    applyLiveState(data, data.new_events || []);
  }catch(err){
    resultBox.textContent = err.message;
    resultBox.classList.remove('hidden');
  }
}