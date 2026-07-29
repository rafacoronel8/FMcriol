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

el('startBtn').addEventListener('click', () => {
  if (!selectedTeam) return;
  localStorage.setItem('fmcriol_teamId', selectedTeam.id);
  localStorage.setItem('fmcriol_managerName', el('managerName').value.trim());
  window.location.href = '/dashboard/dashboard.html';
});

loadTeams();
