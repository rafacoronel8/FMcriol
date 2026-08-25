/* ==========================================================
   FMcriol — Perfil de Clube
   ========================================================== */
const el = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const teamId = params.get('id');

const myTeamId = localStorage.getItem('fmcriol_teamId');
el('backLink').href = myTeamId ? '/dashboard/dashboard.html' : '/inicio/selecaoClube.html';

function fmtMoney(v){
  return '£' + Number(v || 0).toLocaleString('pt-PT');
}

async function loadClub(){
  if (!teamId) {
    document.body.innerHTML = '<p style="color:#e2495b;padding:40px;font-family:sans-serif">Nenhum clube especificado.</p>';
    return;
  }

  try{
    const res = await fetch(`/api/teams/${teamId}`);
    if (!res.ok) throw new Error('Clube não encontrado');
    const team = await res.json();
    fill(team);
  }catch(err){
    document.body.innerHTML = `<p style="color:#e2495b;padding:40px;font-family:sans-serif">
      Clube não encontrado. <a href="/inicio/selecaoClube.html" style="color:#7c5cff">Ver todos os clubes</a>.
    </p>`;
  }
}

function fill(team){
  document.title = `${team.name} — FMcriol`;
  el('clubName').textContent = team.name;
  el('clubMeta').textContent = `${team.division === 2 ? '2ª Divisão' : '1ª Divisão'}${team.location ? ' · ' + team.location : ''}`;

  if (team.shield_path) {
    el('shieldLg').innerHTML = `<img src="${team.shield_path}" alt="${team.name}">`;
  }

  el('reputation').textContent = '★'.repeat(Math.round(team.reputation_stars)) + '☆'.repeat(5 - Math.round(team.reputation_stars)) + ` (${team.reputation_stars})`;
  el('tier').textContent = team.financial_tier;
  el('balance').textContent = fmtMoney(team.balance);
  el('wage').textContent = fmtMoney(team.wage_budget) + ' / semana';
  el('transfer').textContent = fmtMoney(team.transfer_budget);

  el('division').textContent = team.division === 2 ? '2ª Divisão' : '1ª Divisão';
  el('location').textContent = team.location || 'Não definida';
  el('stadium').textContent = team.stadium_name || 'Não definido';
  el('founded').textContent = team.founded_year || 'Não definido';

  const trophies = team.trophies || [];
  if(trophies.length){
    el('trophyCard').classList.remove('hidden');
    el('trophyCount').textContent = trophies.length;
    el('trophyCabinet').innerHTML = trophies.map((t) => {
      const isLeague = t.competition === 'league';
      return `
        <div class="trophy-item">
          <span class="trophy-icon">${isLeague ? '🏆' : '🎖️'}</span>
          <div class="trophy-info">
            <span class="trophy-label">${isLeague ? 'Campeão do Campeonato' : 'Campeão da Taça São Vicente'}</span>
            <span class="trophy-season">Época ${t.season_label}</span>
          </div>
        </div>`;
    }).join('');
  }

  const players = team.players || [];
  el('playerCount').textContent = players.length;

  if (players.length === 0) {
    el('emptyPlayers').classList.remove('hidden');
  } else {
    const list = el('playersList');
    players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'player-row';
      const avatar = p.photo_path ? `<img src="${p.photo_path}" alt="">` : '🧑';
      const badge = p.is_captain ? ' <span title="Capitão">🎖️</span>' : (p.is_vice_captain ? ' <span title="Sub-capitão" style="opacity:.6">🎖️</span>' : '');
      row.innerHTML = `
        <div class="player-avatar">${avatar}</div>
        <div class="player-name-wrap">
          <div class="player-name">${p.name}${badge}</div>
          <div class="player-position">${p.position_tag || 'Posição não definida'}</div>
        </div>`;
      row.addEventListener('click', () => window.location.href = `/jogador/perfilJogador.html?id=${p.id}`);
      list.appendChild(row);
    });
  }
}

loadClub();