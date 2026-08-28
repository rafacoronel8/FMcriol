/* ==========================================================
   FMcriol — Gestão de Comissão Técnica
   ========================================================== */
const el = (id) => document.getElementById(id);
let allTeams = [];
let allStaff = [];

const ROLE_CLASS = {
  'Adjunto': 'role-adjunto',
  'Fisioterapeuta': 'role-fisioterapeuta',
  'Preparador Físico': 'role-preparador',
  'Olheiro': 'role-olheiro',
};
const ROLE_ICON = {
  'Adjunto': '🧠',
  'Fisioterapeuta': '💉',
  'Preparador Físico': '🏋️',
  'Olheiro': '🔎',
};

function showToast(message, type = 'ok'){
  const toast = el('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 3200);
}

async function checkApiStatus(){
  const pill = el('apiStatus');
  try{
    const res = await fetch('/api/health');
    if(!res.ok) throw new Error();
    pill.textContent = 'servidor ligado';
    pill.className = 'status-pill status-ok';
    return true;
  }catch(err){
    pill.textContent = 'servidor offline';
    pill.className = 'status-pill status-error';
    return false;
  }
}

async function loadTeams(){
  const res = await fetch('/api/teams');
  allTeams = await res.json();

  el('f_team').innerHTML =
    '<option value="">Sem clube (disponível)</option>' +
    allTeams.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');

  el('filterTeam').innerHTML =
    '<option value="">Todas as equipas</option>' +
    '<option value="FREE">Sem clube (disponível)</option>' +
    allTeams.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
}

async function loadStaff(){
  const teamFilter = el('filterTeam').value;
  const url = teamFilter === 'FREE' ? '/api/staff?available=1'
    : teamFilter ? `/api/staff?team_id=${teamFilter}`
    : '/api/staff';

  // sem filtro nenhum, junta disponíveis + todas as equipas (uma chamada por equipa seria lento;
  // como o plantel de staff é pequeno, mais simples pedir tudo por equipa + disponíveis)
  let staff = [];
  if(!teamFilter){
    const [availableRes, ...teamResList] = await Promise.all([
      fetch('/api/staff?available=1'),
      ...allTeams.map((t) => fetch(`/api/staff?team_id=${t.id}`)),
    ]);
    const available = await availableRes.json();
    const perTeam = await Promise.all(teamResList.map((r) => r.json()));
    staff = [available, ...perTeam].flat();
  }else{
    const res = await fetch(url);
    staff = await res.json();
  }

  allStaff = staff;
  renderStaff(staff);
}

function renderStaff(staff){
  el('staffCount').textContent = staff.length;
  const list = el('staffList');
  const empty = el('emptyState');

  list.innerHTML = '';
  if(!staff.length){
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  staff.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'staff-row';
    row.innerHTML = `
      <div class="staff-avatar">${ROLE_ICON[s.role] || '🧑'}</div>
      <div class="staff-info">
        <div class="staff-name">${s.name}</div>
        <div class="staff-meta">${s.team_name ? s.team_name : 'Sem clube (disponível)'}${s.hire_fee ? ` · custo: £${Number(s.hire_fee).toLocaleString('pt-PT')}` : ''}</div>
      </div>
      <span class="staff-stars">${'★'.repeat(Math.round(s.quality_stars))}${'☆'.repeat(5 - Math.round(s.quality_stars))}</span>
      <span class="staff-role-pill ${ROLE_CLASS[s.role] || ''}">${s.role}</span>
      <button class="btn-delete" data-id="${s.id}">Apagar</button>
    `;
    row.querySelector('.btn-delete').addEventListener('click', () => deleteStaff(s.id, s.name));
    list.appendChild(row);
  });
}

async function deleteStaff(id, name){
  if(!confirm(`Apagar "${name}"? Esta ação não pode ser revertida.`)) return;
  try{
    const res = await fetch(`/api/staff/${id}`, { method: 'DELETE' });
    if(!res.ok && res.status !== 204) throw new Error();
    showToast(`"${name}" removido.`, 'ok');
    loadStaff();
  }catch(err){
    showToast('Não foi possível apagar.', 'err');
  }
}

el('filterTeam').addEventListener('change', loadStaff);

el('staffForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = el('formMsg');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  const payload = {
    name: el('f_name').value.trim(),
    role: el('f_role').value,
    team_id: el('f_team').value ? Number(el('f_team').value) : null,
    quality_stars: parseFloat(el('f_quality').value),
    nationality_code: el('f_nationality').value.trim().toUpperCase(),
    wage_text: el('f_wage').value.trim(),
    hire_fee: Number(el('f_fee').value) || 0,
  };

  if(!payload.name){
    msg.textContent = 'O nome é obrigatório.';
    msg.className = 'form-msg err';
    return;
  }

  submitBtn.disabled = true;
  msg.textContent = '';

  try{
    const res = await fetch('/api/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Erro ao criar membro');

    msg.textContent = `"${data.name}" criado com sucesso.`;
    msg.className = 'form-msg ok';
    e.target.reset();
    el('f_quality').value = 2.5;
    el('f_nationality').value = 'CPV';
    el('f_fee').value = 0;
    showToast(`"${data.name}" adicionado à comissão técnica.`, 'ok');
    await loadStaff();
  }catch(err){
    msg.textContent = err.message;
    msg.className = 'form-msg err';
  }finally{
    submitBtn.disabled = false;
  }
});

(async function init(){
  const ok = await checkApiStatus();
  if(!ok) return;
  await loadTeams();
  await loadStaff();
})();