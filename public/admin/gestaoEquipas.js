/* ==========================================================
   FMcriol — Gestão de Equipas (interface gráfica)
   ========================================================== */

const API_BASE = window.location.origin.includes('3000')
  ? window.location.origin
  : 'http://localhost:3000';

let allTeams = [];
let activeTeamIdForUpload = null;

const el = (id) => document.getElementById(id);

/* ---------- Utilidades ---------- */
function fmtMoney(v){
  return '£' + Number(v || 0).toLocaleString('pt-PT');
}

function tierClass(tier){
  return 'tag-tier-' + String(tier).toLowerCase().replace(/\s+/g, '');
}

function showToast(message, type = 'ok'){
  const toast = el('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 3200);
}

/* ---------- Estado do servidor ---------- */
async function checkApiStatus(){
  const pill = el('apiStatus');
  try{
    const res = await fetch(`${API_BASE}/api/health`);
    if(!res.ok) throw new Error();
    pill.textContent = 'servidor ligado';
    pill.className = 'status-pill status-ok';
    return true;
  }catch(err){
    pill.textContent = 'servidor offline — corre "npm start" em /server';
    pill.className = 'status-pill status-error';
    return false;
  }
}

/* ---------- Carregar e desenhar equipas ---------- */
async function loadTeams(){
  try{
    const res = await fetch(`${API_BASE}/api/teams`);
    if(!res.ok) throw new Error('Falha ao obter equipas');
    allTeams = await res.json();
    renderTeams(allTeams);
  }catch(err){
    showToast('Não foi possível carregar as equipas. Verifica se o servidor está a correr.', 'err');
  }
}

function renderTeams(teams){
  const grid = el('teamGrid');
  const empty = el('emptyState');
  el('teamCount').textContent = teams.length;

  grid.innerHTML = '';
  if(teams.length === 0){
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  teams.forEach((team) => {
    const card = document.createElement('div');
    card.className = 'team-card';

    const shieldInner = team.shield_path
      ? `<img src="${API_BASE}${team.shield_path}" alt="Escudo ${team.name}">`
      : `<span class="plus">+ escudo</span>`;

    card.innerHTML = `
      <div class="card-top">
        <div class="shield-slot" data-team-id="${team.id}" title="Clica para carregar o escudo">
          ${shieldInner}
        </div>
        <div>
          <div class="card-name">${team.name}</div>
          <div class="card-division">${team.division === 2 ? '2ª Divisão' : '1ª Divisão'}${team.location ? ' · ' + team.location : ''}</div>
        </div>
      </div>
      <div class="card-tags">
        <span class="tag-mini tag-stars">${'★'.repeat(Math.round(team.reputation_stars))}${'☆'.repeat(5 - Math.round(team.reputation_stars))} ${team.reputation_stars}</span>
        <span class="tag-mini ${tierClass(team.financial_tier)}">${team.financial_tier}</span>
      </div>
      <div class="card-budgets">
        <span>Salários: <b>${fmtMoney(team.wage_budget)}</b>/sem</span>
        <span>Transf.: <b>${fmtMoney(team.transfer_budget)}</b></span>
      </div>
    `;

    card.querySelector('.shield-slot').addEventListener('click', () => {
      activeTeamIdForUpload = team.id;
      el('shieldFileInput').click();
    });

    grid.appendChild(card);
  });
}

/* ---------- Upload de escudo ---------- */
el('shieldFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if(!file || !activeTeamIdForUpload) return;

  const slot = document.querySelector(`.shield-slot[data-team-id="${activeTeamIdForUpload}"]`);
  if(slot) slot.classList.add('uploading');

  const formData = new FormData();
  formData.append('shield', file);

  try{
    const res = await fetch(`${API_BASE}/api/teams/${activeTeamIdForUpload}/shield`, {
      method: 'POST',
      body: formData,
    });
    if(!res.ok){
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Falha no upload');
    }
    showToast('Escudo atualizado com sucesso.', 'ok');
    await loadTeams();
  }catch(err){
    showToast(err.message, 'err');
    if(slot) slot.classList.remove('uploading');
  }
});

/* ---------- Criar nova equipa ---------- */
el('teamForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = el('formMsg');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  const payload = {
    name: el('f_name').value.trim(),
    reputation_stars: parseFloat(el('f_reputation').value),
    financial_tier: el('f_financial').value,
    division: parseInt(el('f_division').value, 10),
    location: el('f_location').value.trim() || null,
  };

  if(!payload.name){
    msg.textContent = 'O nome é obrigatório.';
    msg.className = 'form-msg err';
    return;
  }

  submitBtn.disabled = true;
  msg.textContent = '';

  try{
    const res = await fetch(`${API_BASE}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Erro ao criar equipa');

    msg.textContent = `"${data.name}" criada com sucesso.`;
    msg.className = 'form-msg ok';
    e.target.reset();
    el('f_reputation').value = 2.5;
    await loadTeams();
    showToast(`Equipa "${data.name}" adicionada.`, 'ok');
  }catch(err){
    msg.textContent = err.message;
    msg.className = 'form-msg err';
  }finally{
    submitBtn.disabled = false;
  }
});

/* ---------- Pesquisa local na grelha ---------- */
el('searchBox').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const filtered = q
    ? allTeams.filter((t) => t.name.toLowerCase().includes(q))
    : allTeams;
  renderTeams(filtered);
});

/* ---------- Arranque ---------- */
(async function init(){
  const ok = await checkApiStatus();
  if(ok) await loadTeams();
})();
