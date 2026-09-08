/* ==========================================================
   FMcriol — Seleção de Equipa
   ========================================================== */
let allTeams = [];
let selectedTeam = null;

const el = (id) => document.getElementById(id);

function tierColor(tier){
  if (['Muito Rico', 'Rico'].includes(tier)) return 'style="color:var(--green)"';
  if (tier === 'Medio') return 'style="color:var(--amber)"';
  return 'style="color:var(--red)"';
}

function renderTeams(teams){
  const grid = el('teamGrid');
  grid.innerHTML = '';

  teams.forEach((team) => {
    const card = document.createElement('div');
    card.className = 'team-option' + (selectedTeam?.id === team.id ? ' selected' : '');
    card.dataset.id = team.id;

    const shieldInner = team.shield_path
      ? `<img src="${team.shield_path}" alt="${team.name}">`
      : '⚽';

    card.innerHTML = `
      <div class="team-shield">${shieldInner}</div>
      <div class="team-option-name">${team.name}</div>
      <div class="team-option-stars">${'★'.repeat(Math.round(team.reputation_stars))}${'☆'.repeat(5 - Math.round(team.reputation_stars))}</div>
      <div class="team-option-tier" ${tierColor(team.financial_tier)}>${team.financial_tier}</div>
    `;

    card.addEventListener('click', () => {
      selectedTeam = team;
      document.querySelectorAll('.team-option').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      validate();
    });

    grid.appendChild(card);
  });
}

function validate(){
  const nameOk = el('managerName').value.trim().length > 0;
  const btn = el('startBtn');
  btn.disabled = !(selectedTeam && nameOk);
  el('hint').textContent = !selectedTeam
    ? 'Escolhe um clube para continuar.'
    : !nameOk
      ? 'Falta o teu nome de treinador.'
      : `Pronto para começar como treinador do ${selectedTeam.name}.`;
}

async function loadTeams(){
  try{
    const res = await fetch('/api/teams');
    allTeams = await res.json();
    renderTeams(allTeams);
    validate();
  }catch(err){
    el('teamGrid').innerHTML = '<p style="color:var(--red)">Não foi possível carregar as equipas. Verifica se o servidor está a correr.</p>';
  }
}

el('filterBox').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderTeams(q ? allTeams.filter((t) => t.name.toLowerCase().includes(q)) : allTeams);
});

el('managerName').addEventListener('input', validate);

/* ---------- Continuar Jogo Guardado ----------
   O jogador escolhe um ficheiro .db (exportado antes em "Guardar Jogo",
   no dashboard). É enviado tal como está para o servidor, que substitui
   o save do dispositivo atual por ele — ver POST /api/save/import. */
async function handleSaveFileChosen(file){
  const label = el('continueLabel');
  const errorBox = el('continueError');
  const originalLabel = label.textContent;

  errorBox.classList.add('hidden');
  label.classList.add('is-loading');
  label.textContent = 'A carregar…';

  try{
    const buffer = await file.arrayBuffer();
    const res = await fetch('/api/save/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Não foi possível carregar este save.');
    if (!data.team_id) throw new Error('Este save ainda não tem nenhuma equipa escolhida.');

    localStorage.setItem('fmcriol_teamId', data.team_id);
    localStorage.setItem('fmcriol_managerName', data.manager_name || '');
    window.location.href = '/dashboard/dashboard.html';
  }catch(err){
    errorBox.textContent = err.message || 'Não foi possível carregar este save.';
    errorBox.classList.remove('hidden');
    label.classList.remove('is-loading');
    label.textContent = originalLabel;
  }
}

el('saveFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // permite escolher o mesmo ficheiro outra vez, se preciso
  if (file) handleSaveFileChosen(file);
});

el('startBtn').addEventListener('click', () => {
  if (!selectedTeam) return;
  localStorage.setItem('fmcriol_teamId', selectedTeam.id);
  localStorage.setItem('fmcriol_managerName', el('managerName').value.trim());
  window.location.href = '/dashboard/dashboard.html';
});

loadTeams();