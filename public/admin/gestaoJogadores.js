/* ==========================================================
   FMcriol — Gestão de Jogadores
   ========================================================== */
const el = (id) => document.getElementById(id);
let allTeams = [];

/* Lista oficial de posições — tem de ficar igual à usada em script_perfilJogador.js */
const POSITION_CATALOG = [
  { code: 'GR',  label: 'Guarda-Redes' },
  { code: 'DD',  label: 'Defesa Direita' },
  { code: 'DE',  label: 'Defesa Esquerdo' },
  { code: 'DC',  label: 'Defesa Central' },
  { code: 'L',   label: 'Defesa Líbero' },
  { code: 'MCD', label: 'Médio Centro Defensivo' },
  { code: 'MC',  label: 'Médio Centro' },
  { code: 'MCO', label: 'Médio Centro Ofensivo' },
  { code: 'MOD', label: 'Médio Ofensivo Direito' },
  { code: 'MOE', label: 'Médio Ofensivo Esquerdo' },
  { code: 'ME',  label: 'Médio Esquerdo' },
  { code: 'MD',  label: 'Médio Direito' },
  { code: 'PL',  label: 'Ponta de Lança' },
  { code: 'AD',  label: 'Ala Direita' },
  { code: 'AE',  label: 'Ala Esquerdo' },
  { code: 'ED',  label: 'Extremo Direito' },
  { code: 'EE',  label: 'Extremo Esquerdo' },
];

function renderPositionPicker(){
  const primaryGroup = el('positionPrimaryGroup');
  const secondaryGroup = el('positionSecondaryGroup');

  primaryGroup.innerHTML = POSITION_CATALOG.map((p, i) => `
    <label class="position-option">
      <input type="radio" name="positionPrimary" value="${p.code}" ${i === 0 ? 'checked' : ''}>
      ${p.label} (${p.code})
    </label>
  `).join('');

  secondaryGroup.innerHTML = POSITION_CATALOG.map((p) => `
    <label class="position-option" data-code="${p.code}">
      <input type="checkbox" name="positionSecondary" value="${p.code}">
      ${p.label} (${p.code})
    </label>
  `).join('');

  syncSecondaryOptions();
  primaryGroup.querySelectorAll('input[name="positionPrimary"]').forEach((radio) => {
    radio.addEventListener('change', syncSecondaryOptions);
  });
}

/* A posição escolhida como principal não pode também ser secundária */
function syncSecondaryOptions(){
  const primaryCode = document.querySelector('input[name="positionPrimary"]:checked')?.value;
  el('positionSecondaryGroup').querySelectorAll('.position-option').forEach((label) => {
    const isPrimary = label.dataset.code === primaryCode;
    label.classList.toggle('disabled', isPrimary);
    const input = label.querySelector('input');
    if(isPrimary) input.checked = false;
  });
}

function getSelectedPositions(){
  const primaryCode = document.querySelector('input[name="positionPrimary"]:checked')?.value;
  const secondaryCodes = [...document.querySelectorAll('input[name="positionSecondary"]:checked')].map((i) => i.value);
  const byCode = (code) => POSITION_CATALOG.find((p) => p.code === code);

  const positions_json = [];
  if(primaryCode) positions_json.push({ code: primaryCode, label: byCode(primaryCode)?.label, rating: 5, isMain: true });
  secondaryCodes.forEach((code) => positions_json.push({ code, label: byCode(code)?.label, rating: 3, isMain: false }));

  const position_code = positions_json.map((p) => p.code).join('/');
  const position_tag = positions_json.map((p) => p.label).join(' / ');
  const position_caption = byCode(primaryCode)?.label || '';

  return { positions_json, position_code, position_tag, position_caption };
}

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

/* ---------- Carregar equipas nos dois selects ---------- */
async function loadTeams(){
  const res = await fetch('/api/teams');
  allTeams = await res.json();

  // Select do formulário
el('f_team').innerHTML =
  '<option value="FREE">Jogador Livre</option>' +
  allTeams.map((t) =>
    `<option value="${t.id}">${t.name}</option>`
  ).join('');

// Select do filtro
el('filterTeam').innerHTML =
  allTeams.map((t) =>
    `<option value="${t.id}">${t.name}</option>`
  ).join('');
}

/* ---------- Carregar jogadores da equipa selecionada no filtro ---------- */
async function loadPlayers(){
  const teamId = el('filterTeam').value;
  if(!teamId) return;

  const res = await fetch(`/api/players?team_id=${teamId}`);
  const players = await res.json();

  el('playerCount').textContent = players.length;
  const list = el('playerList');
  const empty = el('emptyState');

  list.innerHTML = '';
  if(players.length === 0){
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const avatar = p.photo_path ? `<img src="${p.photo_path}" alt="">` : '🧑';
    row.innerHTML = `
      <div class="player-avatar">${avatar}</div>
      <div class="player-info">
        <div class="player-name">${p.name}</div>
        <div class="player-position">${p.position_tag || 'Posição não definida'}</div>
      </div>
      <span class="player-jersey">#${p.jersey_number || '00'}</span>
      <div class="player-actions">
        <a class="btn-edit" href="/jogador/perfilJogador.html?id=${p.id}&mode=admin">Editar perfil</a>
        <button class="btn-delete" data-id="${p.id}">Apagar</button>
      </div>
    `;
    row.querySelector('.btn-delete').addEventListener('click', () => deletePlayer(p.id, p.name));
    list.appendChild(row);
  });
}

async function deletePlayer(id, name){
  if(!confirm(`Apagar "${name}"? Esta ação não pode ser revertida.`)) return;
  try{
    const res = await fetch(`/api/players/${id}`, { method: 'DELETE' });
    if(!res.ok && res.status !== 204) throw new Error('Falha ao apagar');
    showToast(`"${name}" removido.`, 'ok');
    loadPlayers();
  }catch(err){
    showToast('Não foi possível apagar o jogador.', 'err');
  }
}

el('filterTeam').addEventListener('change', loadPlayers);

/* ---------- Criar jogador ---------- */
el('playerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = el('formMsg');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  const { positions_json, position_code, position_tag, position_caption } = getSelectedPositions();

  if(positions_json.length === 0){
    msg.textContent = 'Escolhe uma posição principal.';
    msg.className = 'form-msg err';
    return;
  }

  const payload = {
  team_id: el('f_team').value === 'FREE'
      ? null
      : Number(el('f_team').value),
  name: el('f_name').value.trim(),
  jersey_number: el('f_jersey').value.trim() || '00',
  position_tag,
  position_code,
  nationality_code: el('f_nationality').value.trim().toUpperCase(),
  birth_date: el('f_birth').value || null,
};

  if(!payload.name){
    msg.textContent = 'O nome é obrigatório.';
    msg.className = 'form-msg err';
    return;
  }

  submitBtn.disabled = true;
  msg.textContent = '';

  try{
    const res = await fetch('/api/players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Erro ao criar jogador');

    // O endpoint de criação guarda o resumo em texto (position_tag/position_code);
    // aqui gravamos também a estrutura completa (posição principal + secundárias)
    // usando o mesmo PUT que o perfil do jogador já utiliza para gravar posições.
    try{
      await fetch(`/api/players/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions_json, position_caption }),
      });
    }catch(err){
      // não bloqueia a criação do jogador se isto falhar — pode ser ajustado depois no perfil
    }

    showToast(`"${data.name}" criado. A abrir o perfil…`, 'ok');
    setTimeout(() => {
      window.location.href = `/jogador/perfilJogador.html?id=${data.id}&mode=admin`;
    }, 700);
  }catch(err){
    msg.textContent = err.message;
    msg.className = 'form-msg err';
    submitBtn.disabled = false;
  }
});

/* ---------- Arranque ---------- */
(async function init(){
  renderPositionPicker();
  const ok = await checkApiStatus();
  if(!ok) return;
  await loadTeams();
  if(allTeams.length > 0) await loadPlayers();
})();