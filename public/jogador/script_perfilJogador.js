/* ==========================================================
   PAINEL DE JOGADOR — lógica de interface + ligação à API
   ========================================================== */

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const playerId = params.get('id');

let player = null;              // dados atuais do jogador (quando ligado à BD)
let currentMode = 'possession'; // 'possession' | 'nopossession'
let gameCurrentDate = null;     // data do calendário do jogo (não a data real do dispositivo)

/* A idade do jogador (e qualquer outra conta de datas nesta página) tem de
   se basear na data do CALENDÁRIO DO JOGO, não na data real do computador —
   senão a idade fica errada assim que a carreira avança para lá da data
   real (ver bug do calendário). */
async function loadGameCurrentDate(){
  try{
    const res = await fetch('/api/game/state');
    if(!res.ok) throw new Error();
    const state = await res.json();
    gameCurrentDate = state.current_date;
  }catch(err){
    // se falhar, calcAge() usa a data real do dispositivo como recurso
  }
}
loadGameCurrentDate();

/* Só é possível editar atributos quando se chega aqui a partir da parte admin
   (ex: /jogador/perfilJogador.html?id=12&mode=admin). Fora do admin, é só consulta. */
const isAdmin = params.get('mode') === 'admin';

/* ---------- Catálogo oficial de posições (usado na criação de jogadores E no campo do perfil) ----------
   Esta lista é a fonte única de verdade para posições em toda a app. */
const POSITION_CATALOG = [
  { code: 'GR',  label: 'Guarda-Redes',              x: 150, y: 186 },
  { code: 'L',   label: 'Defesa Líbero',              x: 150, y: 164 },
  { code: 'DE',  label: 'Defesa Esquerdo',            x: 50,  y: 150 },
  { code: 'DC',  label: 'Defesa Central',             x: 150, y: 150 },
  { code: 'DD',  label: 'Defesa Direita',             x: 250, y: 150 },
  { code: 'AE',  label: 'Ala Esquerda',               x: 25,  y: 115 },
  { code: 'AD',  label: 'Ala Direita',                x: 275, y: 115 },
  { code: 'MCD', label: 'Médio Centro Defensivo',     x: 150, y: 120 },
  { code: 'ME',  label: 'Médio Esquerdo',             x: 60,  y: 90 },
  { code: 'MC',  label: 'Médio Centro',               x: 150, y: 90 },
  { code: 'MD',  label: 'Médio Direito',              x: 240, y: 90 },
  { code: 'MOE', label: 'Médio Ofensivo Esquerdo',    x: 55,  y: 55 },
  { code: 'MCO', label: 'Médio Centro Ofensivo',      x: 150, y: 52 },
  { code: 'MOD', label: 'Médio Ofensivo Direito',     x: 245, y: 55 },
  { code: 'EE',  label: 'Extremo Esquerdo',           x: 40,  y: 22 },
  { code: 'PL',  label: 'Ponta de Lança',             x: 150, y: 15 },
  { code: 'ED',  label: 'Extremo Direito',            x: 260, y: 22 },
];
const POSITION_LABELS = Object.fromEntries(POSITION_CATALOG.map((p) => [p.code, p.label]));

/* Mapa de compatibilidade: códigos antigos (usados antes desta lista existir) -> códigos novos.
   Usado para "traduzir" automaticamente jogadores criados antes desta alteração. */
const LEGACY_CODE_ALIASES = {
  GR: 'GR', DE: 'DE', DC: 'DC', DD: 'DD',
  LE: 'AE', LD: 'AD',
  MDC: 'MCD', MCD: 'MCD',
  ME: 'ME', MC: 'MC', MD: 'MD',
  MOE: 'MOE', MOC: 'MCO', MCO: 'MCO', MOD: 'MOD',
  PLE: 'EE', PLD: 'ED', PL: 'PL',
  L: 'L', AD: 'AD', AE: 'AE', ED: 'ED', EE: 'EE',
};

/* Recebe a posições já gravadas (positions_json) e garante que só usam os códigos novos. */
function normalizeStoredPositions(list){
  const out = [];
  (list || []).forEach((entry) => {
    const code = LEGACY_CODE_ALIASES[String(entry.code || '').toUpperCase()];
    if(!code) return;
    const existing = out.find((e) => e.code === code);
    if(existing){
      existing.rating = Math.max(existing.rating, entry.rating || 0);
      existing.isMain = existing.isMain || !!entry.isMain;
    }else{
      out.push({ code, label: POSITION_LABELS[code] || entry.label, rating: entry.rating || 0, isMain: !!entry.isMain });
    }
  });
  return out;
}

/* Quando um jogador antigo só tem texto livre (position_code tipo "DC/DD/MCD"), tenta
   reconstruir uma lista de posições a partir desse texto. */
function derivePositionsFromLegacyText(positionCode){
  const tokens = String(positionCode || '').split(/[\/,]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  tokens.forEach((tok, i) => {
    const key = tok.toUpperCase().replace(/[^A-Z]/g, '');
    const code = LEGACY_CODE_ALIASES[key];
    if(!code || out.find((e) => e.code === code)) return;
    out.push({ code, label: POSITION_LABELS[code], rating: i === 0 ? 5 : 3, isMain: i === 0 });
  });
  return out;
}

/* ---------- Utilidades ---------- */
function starString(rating){
  const full = Math.floor(rating);
  const half = rating % 1 !== 0;
  let s = '★'.repeat(full);
  if(half) s += '½';
  s += '☆'.repeat(Math.max(0, 5 - Math.ceil(rating)));
  return s;
}

function tierClass(value){
  if(value <= 5) return 'v-low';
  if(value <= 10) return 'v-mid';
  if(value <= 14) return 'v-good';
  return 'v-high';
}

function ratingTierClass(r){
  if(r >= 5) return 'r5';
  if(r >= 4) return 'r4';
  if(r >= 3) return 'r3';
  if(r >= 2) return 'r2';
  return '';
}

/* ---------- 1. Upload de imagens (foto, bandeira, logo) ---------- */
function wireImageUpload(inputId, imgId, hintSelector, uploadKind){
  const input = el(inputId);
  const img = el(imgId);
  input.addEventListener('change', (e) => {
    if(!isAdmin) return;
    const file = e.target.files[0];
    if(!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      img.src = ev.target.result;
      img.classList.remove('hidden');
      const hint = img.parentElement.querySelector(hintSelector);
      if(hint) hint.classList.add('hidden');
    };
    reader.readAsDataURL(file);

    if(playerId && uploadKind){
      const formData = new FormData();
      formData.append('image', file);
      setSaveStatus('saving');
      fetch(`/api/players/${playerId}/${uploadKind}`, { method: 'POST', body: formData })
        .then((res) => res.ok ? res.json() : Promise.reject())
        .then(() => setSaveStatus('saved'))
        .catch(() => setSaveStatus('error'));
    }
  });
}

wireImageUpload('playerPhotoInput', 'playerPhoto', '.upload-hint', 'photo');
wireImageUpload('flagInput', 'flagImg', '.flag-placeholder', 'flag');
wireImageUpload('clubLogoInput', 'clubLogo', '.upload-hint', 'club-logo');

/* ---------- 2. Dados de atributos por omissão (usados só em modo demonstração, sem ?id=) ---------- */
const demoTechnical = [
  ['Cruzamento', 11], ['Drible', 17], ['Finalização', 12], ['Primeiro Toque', 12],
  ['Cabeceamento', 6], ['Remates de Longe', 12], ['Marcação', 7], ['Passe', 12],
  ['Desarme', 8], ['Técnica', 13],
];
const demoSetPieces = [['Cantos', 12], ['Livres', 12], ['Lançamentos Longos', 6], ['Grandes Penalidades', 10]];
const demoMental = [
  ['Agressividade', 13], ['Antecipação', 11], ['Coragem', 13], ['Compostura', 11],
  ['Concentração', 10], ['Decisões', 11], ['Determinação', 15], ['Classe', 16],
  ['Liderança', 3], ['Fora de Bola', 12], ['Posicionamento', 7], ['Trabalho de Equipa', 12],
  ['Visão', 11], ['Ritmo de Jogo', 13],
];
const demoPhysical = [
  ['Aceleração', 17], ['Agilidade', 15], ['Equilíbrio', 12], ['Alcance de Cabeceamento', 10],
  ['Condição Natural', 15], ['Velocidade', 17], ['Resistência', 12], ['Força', 12],
];
/* Guarda-redes: conjunto de atributos diferente (mesmo critério usado no servidor ao criar o jogador) */
const demoGoalkeeping = [
  ['Alcance Aéreo', 12], ['Comando de Área', 12], ['Comunicação', 12], ['Excentricidade', 8],
  ['Primeiro Toque', 10], ['Manejo', 12], ['Pontapé', 11], ['Um Contra Um', 12],
  ['Passe', 10], ['Soco (Tendência)', 10], ['Reflexos', 13], ['Saída da Baliza (Tendência)', 9],
  ['Lançamento', 12],
];
const demoTechnicalGK = [['Cobrança de Livres', 3], ['Cobrança de Grandes Penalidades', 3], ['Técnica', 10]];

/* Determina se a posição principal do jogador é Guarda-Redes (GR) */
function isGoalkeeperPlayer(p){
  const mainPos = (p.positions_json || []).find((pos) => pos.isMain);
  if(mainPos) return mainPos.code === 'GR';
  return String(p.position_code || '').split('/')[0].trim().toUpperCase() === 'GR';
}

/* ---------- 3. Listas de atributos (Técnica / Bolas Paradas / Mental / Físico) ---------- */
function renderAttrList(containerId, data, jsonField){
  const container = el(containerId);
  container.innerHTML = '';
  data.forEach(([name, value], idx) => {
    const row = document.createElement('div');
    row.className = `attr-row ${tierClass(value)}`;
    row.innerHTML = `
      <span class="attr-name" contenteditable="${isAdmin}">${name}</span>
      <span class="attr-val" contenteditable="${isAdmin}">${value}</span>
    `;
    if(jsonField){
      row.dataset.jsonField = jsonField;
      row.dataset.idx = idx;
    }
    container.appendChild(row);
  });
}

/* Recolorir + gravar quando um atributo é editado */
document.addEventListener('input', (e) => {
  if(e.target.classList.contains('attr-val')){
    const row = e.target.closest('.attr-row');
    const num = parseInt(e.target.textContent.trim(), 10);
    row.classList.remove('v-low','v-mid','v-good','v-high');
    if(!isNaN(num)) row.classList.add(tierClass(num));
  }
});
document.addEventListener('blur', (e) => {
  if(!e.target.classList) return;
  if(e.target.classList.contains('attr-val') || e.target.classList.contains('attr-name')){
    saveAttrGroup(e.target.closest('.attr-list'));
  }
}, true);

function saveAttrGroup(listEl){
  if(!playerId || !listEl) return;
  const rows = [...listEl.querySelectorAll('.attr-row')];
  if(rows.length === 0 || !rows[0].dataset.jsonField) return;
  const jsonField = rows[0].dataset.jsonField;
  const data = rows.map((row) => {
    const name = row.querySelector('.attr-name').textContent.trim();
    const value = parseFloat(row.querySelector('.attr-val').textContent.trim()) || 0;
    return [name, value];
  });
  queueSave({ [jsonField]: data });
}

/* ---------- 4. Posições no campo ---------- */
function renderPositions(){
  const layer = el('posDotsLayer');
  layer.innerHTML = '';
  const positions = player ? player.positions_json : [];

  POSITION_CATALOG.forEach((pos) => {
    const found = positions.find((p) => p.code === pos.code);
    const rating = found ? found.rating : 0;
    const isMain = found ? !!found.isMain : false;

    const dot = document.createElement('div');
    dot.className = `pos-dot ${ratingTierClass(rating)}${isMain ? ' main-pos' : ''}`;
    dot.style.left = `${(pos.x / 300) * 100}%`;
    dot.style.top = `${(pos.y / 200) * 100}%`;
    dot.title = `${pos.label} — clique para ajustar, duplo-clique para definir como principal`;
    dot.dataset.code = pos.code;

    if(isAdmin){
      dot.addEventListener('click', () => cyclePositionRating(pos));
      dot.addEventListener('dblclick', (e) => { e.stopPropagation(); setMainPosition(pos); });
    }else{
      dot.style.cursor = 'default';
    }

    layer.appendChild(dot);
  });
}

function cyclePositionRating(pos){
  if(!isAdmin) return;
  if(!player) player = { positions_json: [] };
  const tiers = [0, 2, 3, 4, 5];
  const list = player.positions_json;
  let entry = list.find((p) => p.code === pos.code);
  if(!entry){
    entry = { code: pos.code, label: pos.label, rating: 0, isMain: false };
    list.push(entry);
  }
  const nextIdx = (tiers.indexOf(entry.rating) + 1) % tiers.length;
  entry.rating = tiers[nextIdx];
  if(entry.rating === 0) entry.isMain = false;

  player.positions_json = list.filter((p) => p.rating > 0 || p.isMain);
  renderPositions();
  queueSave({ positions_json: player.positions_json });
}

function setMainPosition(pos){
  if(!isAdmin) return;
  if(!player) player = { positions_json: [] };
  const list = player.positions_json;
  list.forEach((p) => { p.isMain = false; });
  let entry = list.find((p) => p.code === pos.code);
  if(!entry){
    entry = { code: pos.code, label: pos.label, rating: 3, isMain: true };
    list.push(entry);
  }else{
    entry.isMain = true;
    if(entry.rating === 0) entry.rating = 3;
  }
  player.positions_json = list;
  renderPositions();

  const captionEl = el('posCaption');
  captionEl.textContent = pos.label;

  const codeEl = el('positionCode');
  if(!codeEl.textContent.trim() || codeEl.textContent === 'M/MO (E,D)'){
    codeEl.textContent = pos.code;
  }

  queueSave({
    positions_json: player.positions_json,
    position_caption: pos.label,
  });
}

/* ---------- 5. Funções (roles) por modo (Com Bola / Sem Bola) ---------- */
function currentRoleList(){
  if(!player) return [];
  return currentMode === 'possession' ? player.roles_possession_json : player.roles_nopossession_json;
}

function renderRoles(){
  const list = el('roleList');
  list.innerHTML = '';
  const roles = currentRoleList();

  roles.forEach((role, i) => {
    const item = document.createElement('div');
    item.className = 'role-item' + (role.selected ? ' selected' : '');
    item.innerHTML = `
      <span class="role-stars" contenteditable="${isAdmin}">${starString(role.rating)}</span>
      <span class="role-name" contenteditable="${isAdmin}">${role.name}</span>
      <button class="role-remove${isAdmin ? '' : ' hidden'}" title="Remover">×</button>
    `;

    item.addEventListener('click', (e) => {
      if(!isAdmin) return;
      if(e.target.classList.contains('role-remove')) return;
      if(e.target.isContentEditable && document.activeElement === e.target) return;
      roles.forEach((r) => { r.selected = false; });
      role.selected = true;
      list.querySelectorAll('.role-item').forEach((c) => c.classList.remove('selected'));
      item.classList.add('selected');
      saveCurrentRoles();
    });

    item.querySelector('.role-name').addEventListener('blur', () => {
      if(!isAdmin) return;
      role.name = item.querySelector('.role-name').textContent.trim();
      saveCurrentRoles();
    });
    item.querySelector('.role-stars').addEventListener('blur', () => {
      if(!isAdmin) return;
      const text = item.querySelector('.role-stars').textContent;
      const full = (text.match(/★/g) || []).length;
      const half = text.includes('½') ? 0.5 : 0;
      role.rating = full + half;
      saveCurrentRoles();
    });
    item.querySelector('.role-remove').addEventListener('click', () => {
      if(!isAdmin) return;
      roles.splice(i, 1);
      renderRoles();
      saveCurrentRoles();
    });

    list.appendChild(item);
  });
}

function saveCurrentRoles(){
  if(!playerId || !player) return;
  const field = currentMode === 'possession' ? 'roles_possession_json' : 'roles_nopossession_json';
  queueSave({ [field]: currentRoleList() });
}

if(!isAdmin) el('addRoleBtn').classList.add('hidden');
el('addRoleBtn').addEventListener('click', () => {
  if(!isAdmin) return;
  if(!player) player = { roles_possession_json: [], roles_nopossession_json: [] };
  currentRoleList().push({ name: 'Nova Função', rating: 3, selected: false });
  renderRoles();
  saveCurrentRoles();
});

/* ---------- 6. Separadores (tabs) ---------- */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    const panel = document.getElementById(`panel-${tab.dataset.tab}`);
    (panel || el('panel-overview')).classList.remove('hidden');
  });
});

/* ---------- 7. Alternância Com Bola / Sem Bola ---------- */
document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    renderRoles();
  });
});

/* ---------- 8. Estatísticas da época ---------- */
function renderSeasonStats(){
  const body = el('seasonStatsBody');
  body.innerHTML = '';
  const rows = (player && player.season_stats_json) || [];

  rows.forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td contenteditable="${isAdmin}" data-key="competition">${r.competition ?? ''}</td>
      <td contenteditable="${isAdmin}" data-key="j">${r.j ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="g">${r.g ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="a">${r.a ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="xg">${r.xg ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="pen">${r.pen ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="mdp">${r.mdp ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="am">${r.am ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="verm">${r.verm ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="tk">${r.tk ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="dr">${r.dr ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="ps">${r.ps ?? 0}</td>
      <td contenteditable="${isAdmin}" data-key="pp">${r.pp ?? '-'}</td>
      <td contenteditable="${isAdmin}" data-key="media" class="rating">${r.media ?? '-'}</td>
      <td>${isAdmin ? '<button class="row-remove" title="Remover linha">×</button>' : ''}</td>
    `;
    tr.querySelectorAll('[contenteditable]').forEach((cell) => {
      cell.addEventListener('blur', () => { if(isAdmin) saveSeasonStats(); });
    });
    tr.querySelector('.row-remove')?.addEventListener('click', () => {
      rows.splice(idx, 1);
      renderSeasonStats();
      saveSeasonStats();
    });
    body.appendChild(tr);
  });

  renderPerformanceRadar();
}

function saveSeasonStats(){
  if(!playerId || !player) return;
  const body = el('seasonStatsBody');
  const rows = [...body.querySelectorAll('tr')].map((tr) => {
    const out = {};
    tr.querySelectorAll('[data-key]').forEach((cell) => {
      const key = cell.dataset.key;
      const raw = cell.textContent.trim();
      out[key] = key === 'competition' || key === 'media' || key === 'pp' ? raw : (parseFloat(raw) || 0);
    });
    return out;
  });
  player.season_stats_json = rows;
  queueSave({ season_stats_json: rows });
  renderPerformanceRadar();
}

if(!isAdmin) el('addStatRowBtn').classList.add('hidden');
el('addStatRowBtn').addEventListener('click', () => {
  if(!isAdmin) return;
  if(!player) player = { season_stats_json: [] };
  if(!player.season_stats_json) player.season_stats_json = [];
  player.season_stats_json.push({ competition: 'Nova Competição', j:0, g:0, a:0, xg:0, pen:0, mdp:0, am:0, verm:0, tk:0, dr:0, ps:0, pp:'-', media:'-' });
  renderSeasonStats();
  saveSeasonStats();
});

/* ---------- 8b. Radar de Desempenho (aba "Desempenho") ----------
   Junta todas as linhas de season_stats_json (uma por competição) e tira
   a média por jogo em cada uma das seis dimensões — "média de todos os
   jogos" da época, como pedido, e não só da última competição. Os "cap"
   definem o que conta como 100% em cada eixo do radar (um valor bom/muito
   bom para essa estatística), para o gráfico ficar legível em vez de os
   pontos ficarem todos encostados ao centro ou ao limite. */
const RADAR_AXES = [
  { key: 'goals', label: 'Golos/Jogo', icon: '⚽', cap: 1.2, decimals: 2 },
  { key: 'assists', label: 'Assist./Jogo', icon: '🎯', cap: 0.8, decimals: 2 },
  { key: 'tackles', label: 'Cortes/Jogo', icon: '🛡️', cap: 5, decimals: 1 },
  { key: 'dribbles', label: 'Dribles/Jogo', icon: '⚡', cap: 4, decimals: 1 },
  { key: 'passes', label: 'Passes/Jogo', icon: '🔀', cap: 70, decimals: 0 },
  { key: 'passAccuracy', label: '% Passe', icon: '📊', cap: 100, decimals: 0 },
];

function computePerformanceAverages(seasonStatsJson){
  const rows = Array.isArray(seasonStatsJson) ? seasonStatsJson : [];
  let totalGames = 0, goals = 0, assists = 0, tackles = 0, dribbles = 0, passes = 0;
  let ppWeightedSum = 0, ppWeight = 0;

  rows.forEach((r) => {
    const j = Number(r.j) || 0;
    totalGames += j;
    goals += Number(r.g) || 0;
    assists += Number(r.a) || 0;
    tackles += Number(r.tk) || 0;
    dribbles += Number(r.dr) || 0;
    passes += Number(r.ps) || 0;
    const pp = parseFloat(r.pp);
    if(Number.isFinite(pp) && j){ ppWeightedSum += pp * j; ppWeight += j; }
  });

  const perGame = (total) => (totalGames ? total / totalGames : 0);
  return {
    totalGames,
    goals: perGame(goals),
    assists: perGame(assists),
    tackles: perGame(tackles),
    dribbles: perGame(dribbles),
    passes: perGame(passes),
    passAccuracy: ppWeight ? ppWeightedSum / ppWeight : 0,
  };
}

function renderPerformanceRadar(){
  const wrap = el('performanceRadarWrap');
  const legend = el('performanceLegend');
  if(!wrap || !legend) return;

  const avg = computePerformanceAverages(player && player.season_stats_json);
  const n = RADAR_AXES.length;
  const cx = 160, cy = 160, r = 118;
  const angleFor = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pointFor = (i, frac) => {
    const a = angleFor(i);
    return [cx + Math.cos(a) * r * frac, cy + Math.sin(a) * r * frac];
  };

  const rings = [0.25, 0.5, 0.75, 1].map((frac) => {
    const pts = RADAR_AXES.map((_, i) => pointFor(i, frac).join(',')).join(' ');
    return `<polygon points="${pts}" class="radar-ring" />`;
  }).join('');

  const axesLines = RADAR_AXES.map((_, i) => {
    const [x, y] = pointFor(i, 1);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="radar-axis" />`;
  }).join('');

  const values = RADAR_AXES.map((axis) => Math.max(0.02, Math.min(1, (avg[axis.key] || 0) / axis.cap)));
  const polyPoints = values.map((v, i) => pointFor(i, v).join(',')).join(' ');
  const dots = values.map((v, i) => {
    const [x, y] = pointFor(i, v);
    const axis = RADAR_AXES[i];
    return `<circle cx="${x}" cy="${y}" r="4.5" class="radar-dot"><title>${axis.label}: ${(avg[axis.key] || 0).toFixed(axis.decimals)}</title></circle>`;
  }).join('');

  const labels = RADAR_AXES.map((axis, i) => {
    const [x, y] = pointFor(i, 1.24);
    const anchor = Math.abs(x - cx) < 6 ? 'middle' : (x > cx ? 'start' : 'end');
    return `<text x="${x}" y="${y}" class="radar-label" text-anchor="${anchor}">${axis.icon} ${axis.label}</text>`;
  }).join('');

  wrap.innerHTML = `
    <svg viewBox="0 0 320 320" class="radar-svg">
      ${rings}
      ${axesLines}
      <polygon points="${polyPoints}" class="radar-shape" />
      ${dots}
      ${labels}
    </svg>
    <p class="radar-note">${avg.totalGames} jogo${avg.totalGames === 1 ? '' : 's'} disputado${avg.totalGames === 1 ? '' : 's'} esta época, em todas as competições.</p>
  `;

  legend.innerHTML = RADAR_AXES.map((axis) => `
    <div class="perf-legend-row">
      <span class="perf-legend-icon">${axis.icon}</span>
      <span class="perf-legend-label">${axis.label}</span>
      <span class="perf-legend-value">${(avg[axis.key] || 0).toFixed(axis.decimals)}</span>
    </div>`).join('');
}

/* ---------- 9. Gravação automática (autosave) ---------- */
let saveQueue = {};
let saveTimer = null;

function setSaveStatus(state){
  const status = el('saveStatus');
  status.className = `save-status ${state}`;
  status.textContent = state === 'saving' ? 'A guardar…' : state === 'saved' ? 'Guardado ✓' : state === 'error' ? 'Erro ao guardar' : '';
  if(state === 'saved') setTimeout(() => { if(status.textContent === 'Guardado ✓') status.textContent = ''; }, 2000);
}

function queueSave(patch){
  if(!playerId) return; // modo demonstração — nada é gravado
  if(!isAdmin) return;  // fora do admin, o perfil é só de consulta
  Object.assign(saveQueue, patch);
  clearTimeout(saveTimer);
  setSaveStatus('saving');
  saveTimer = setTimeout(flushSave, 500);
}

const ATTRIBUTE_JSON_FIELDS = ['technical_json', 'set_pieces_json', 'mental_json', 'physical_json', 'goalkeeping_json'];

async function flushSave(){
  if(!playerId || Object.keys(saveQueue).length === 0) return;
  const payload = saveQueue;
  saveQueue = {};
  try{
    const res = await fetch(`/api/players/${playerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if(!res.ok) throw new Error('Falha ao gravar');
    setSaveStatus('saved');

    /* Um atributo individual (Técnica/Bolas Paradas/Mental/Físico/GR) foi
       editado à mão nesta gravação — o valor de mercado e o salário têm de
       subir/descer na mesma proporção, usando a mesma fórmula do botão
       "Gerar Atributos" (ver refreshMarketValue() / PUT
       /api/players/:id/generate-value), em vez de ficarem "presos" no
       valor calculado da última vez que o Nível Geral foi usado. Só corre
       DEPOIS de a gravação do atributo ter sido confirmada, para nunca
       recalcular a partir de um valor ainda por gravar. */
    const touchedAttributes = Object.keys(payload).some((key) => ATTRIBUTE_JSON_FIELDS.includes(key));
    if(touchedAttributes) await refreshMarketValue();
  }catch(err){
    setSaveStatus('error');
  }
}

/* Campos de texto simples: elemento -> coluna na BD */
const SIMPLE_FIELD_MAP = {
  playerName: 'name',
  jerseyNumber: 'jersey_number',
  positionTag: 'position_tag',
  nationCode: 'nationality_code',
  clubName: 'club_name_override',
  clubStatus: 'club_status',
  marketValue: 'market_value_text',
  salaryValue: 'wage_text',
  caps: 'caps',
  intGoals: 'international_goals',
  wage: 'wage_text',
  contractEnd: 'contract_end',
  positionCode: 'position_code',
  posCaption: 'position_caption',
  height: 'height_cm',
  reputation: 'reputation_text',
  leftFoot: 'left_foot',
  rightFoot: 'right_foot',
  traitsList: 'traits',
  gkRating: 'gk_rating',
  happiness: 'happiness',
  posCount: 'positive_count',
  negCount: 'negative_count',
  fitness: 'fitness_status',
  fitnessNote: 'fitness_note',
  form: 'form_text',
  discipline: 'discipline_text',
  disciplineNote: 'discipline_note',
  training: 'training_status',
  trainingRating: 'training_rating',
  careerClubs: 'career_clubs',
  careerApps: 'career_apps',
  careerGoals: 'career_goals',
};
const NUMERIC_FIELDS = new Set(['caps', 'international_goals', 'height_cm', 'positive_count', 'negative_count', 'training_rating', 'career_clubs', 'career_apps', 'career_goals']);

/* Alguns campos aparecem duas vezes na página — ex: Valor de Mercado e
   Salário têm uma versão resumida no topo ("pill") e outra na secção de
   contrato ("wage") — e os dois elementos partilham a MESMA coluna na BD.
   Isto causava o bug do "às vezes o VM e o Salário não ficam guardados":
   ao editar só um dos dois, o outro continuava a mostrar o texto antigo; e
   se esse outro alguma vez perdesse o foco mais tarde (mesmo sem o
   utilizador o editar — basta ter clicado lá dentro por engano), o seu
   "blur" disparava na mesma e reenviava o valor ANTIGO, apagando a edição
   recente. A correção: manter todos os elementos com a mesma coluna sempre
   sincronizados entre si, e só gravar quando o texto realmente mudar. */
const lastSavedValue = {}; // coluna -> último valor gravado (evita reenvios de texto por gravar)
const fieldsByColumn = {}; // coluna -> [ids de todos os elementos que a mostram]
Object.entries(SIMPLE_FIELD_MAP).forEach(([elementId, column]) => {
  (fieldsByColumn[column] = fieldsByColumn[column] || []).push(elementId);
});

Object.entries(SIMPLE_FIELD_MAP).forEach(([elementId, column]) => {
  const node = el(elementId);
  if(!node) return;
  node.addEventListener('blur', () => {
    const raw = node.textContent.trim();
    const value = NUMERIC_FIELDS.has(column) ? (parseFloat(raw) || 0) : raw;

    // Nada mudou desde a última gravação — não reenvia. Isto é o que impede
    // um campo espelhado e não editado de apagar, por acidente, uma edição
    // feita entretanto no outro campo com a mesma coluna.
    if(lastSavedValue[column] !== undefined && String(lastSavedValue[column]) === String(value)) return;
    lastSavedValue[column] = value;

    // Espelha o novo valor em todos os outros elementos da mesma coluna,
    // para nunca ficarem desatualizados um em relação ao outro.
    (fieldsByColumn[column] || []).forEach((otherId) => {
      if(otherId === elementId) return;
      const other = el(otherId);
      if(other && other.textContent.trim() !== raw) other.textContent = raw;
    });

    queueSave({ [column]: value });
  });
});

/* Personalidade — passou a um menu fixo de 5 níveis (Muito Fiel … Muito
   Problemático), em vez de texto livre, para os eventos de balneário
   (brigas, birras, boost de moral — ver routes/morale.js) poderem confiar
   no valor. Por isso tem o seu próprio listener em vez de entrar no
   SIMPLE_FIELD_MAP genérico acima (feito para campos de texto). */
{
  const personalitySelect = el('personality');
  if(personalitySelect){
    personalitySelect.addEventListener('change', () => {
      queueSave({ personality: personalitySelect.value });
    });
  }
}

/* Especialização (Goleador/Garçom/Patrão) — pesa a favor do jogador na
   hora de escolher quem marca/assiste/segura a baliza nos jogos simulados
   automaticamente (ver routes/game.js, routes/competitionStats.js,
   routes/league.js, routes/cup.js). */
{
  const focusSelect = el('focusRole');
  if(focusSelect){
    focusSelect.addEventListener('change', () => {
      queueSave({ focus_role: focusSelect.value || null });
    });
  }
}

/* Nível atual / potencial (estrelas editáveis por clique) */
function wireAbilityStars(elementId, column){
  const node = el(elementId);
  node.addEventListener('click', (e) => {
    if(!isAdmin) return;
    if(document.activeElement === node) return; // já em edição de texto
    const rect = node.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    let raw = Math.max(0.5, Math.min(5, Math.round(ratio * 5 * 2) / 2));
    node.dataset.raw = raw;
    node.textContent = starString(raw);
    queueSave({ [column]: raw });
  });
}
wireAbilityStars('currentAbility', 'current_ability_stars');
wireAbilityStars('potentialAbility', 'potential_ability_stars');

/* ---------- 10. Carregar jogador da API (ou manter dados de demonstração) ---------- */
function calcAge(birthDateStr){
  if(!birthDateStr) return '';
  const birth = new Date(birthDateStr);
  if(isNaN(birth)) return '';
  // Usa a data do calendário do jogo; só recorre à data real do dispositivo
  // se, por algum motivo, o /api/game/state ainda não tiver respondido.
  const today = gameCurrentDate ? new Date(`${gameCurrentDate}T00:00:00`) : new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if(m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}
function fmtDatePt(birthDateStr){
  if(!birthDateStr) return '';
  const d = new Date(birthDateStr);
  if(isNaN(d)) return '';
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

async function loadPlayer(){
  try{
    await loadGameCurrentDate();
    const res = await fetch(`/api/players/${playerId}`);
    if(!res.ok) throw new Error('Jogador não encontrado');
    player = await res.json();
    fillFromPlayer(player);
  }catch(err){
    document.querySelector('.panel').innerHTML = `<p style="color:#e2495b;padding:40px;">
      Jogador não encontrado. <a href="/admin/gestaoJogadores.html" style="color:#7c5cff">Voltar à gestão de jogadores</a>.
    </p>`;
  }
}

function fillFromPlayer(p){
  document.title = `${p.name} — FMcriol`;

  el('playerName').textContent = p.name || '';
  const captainBadge = p.is_captain ? ' 🎖️ (Capitão)' : (p.is_vice_captain ? ' 🎖️ (Sub-capitão)' : '');
  if (captainBadge) el('playerName').textContent += captainBadge;
  el('jerseyNumber').textContent = p.jersey_number || '00';
  el('positionTag').textContent = p.position_tag || '';
  el('nationCode').textContent = p.nationality_code || '';
  el('playerAge').textContent = p.birth_date ? `${calcAge(p.birth_date)} anos` : '';
  el('playerBirth').textContent = fmtDatePt(p.birth_date);

  el('clubName').textContent = p.club_name_override || (p.team ? p.team.name : 'Sem clube');
  el('clubStatus').textContent = p.club_status || '';
  const clubLogoSrc = p.club_logo_path || (p.team && p.team.shield_path) || null;
  if(clubLogoSrc){
    el('clubLogo').src = clubLogoSrc;
    el('clubLogo').classList.remove('hidden');
    el('clubLogo').closest('.upload-slot').querySelector('.upload-hint')?.classList.add('hidden');
  }

  el('marketValue').textContent = p.market_value_text || '—';
  el('salaryValue').textContent = p.wage_text || '—';
  el('caps').textContent = p.caps ?? 0;
  el('intGoals').textContent = p.international_goals ?? 0;

  const curStars = p.current_ability_stars ?? 2.5;
  const potStars = p.potential_ability_stars ?? 3;
  el('currentAbility').textContent = starString(curStars);
  el('currentAbility').dataset.raw = curStars;
  el('potentialAbility').textContent = starString(potStars);
  el('potentialAbility').dataset.raw = potStars;

  el('wage').textContent = p.wage_text || '';
  el('contractEnd').textContent = p.contract_end || '';

  if(p.photo_path){ el('playerPhoto').src = p.photo_path; el('playerPhoto').classList.remove('hidden'); el('playerPhoto').closest('.upload-slot').querySelector('.upload-hint')?.classList.add('hidden'); }
  if(p.flag_path){ el('flagImg').src = p.flag_path; el('flagImg').classList.remove('hidden'); el('flagImg').closest('.flag-upload').querySelector('.flag-placeholder')?.classList.add('hidden'); }

  el('positionCode').textContent = p.position_code || '';
  el('posCaption').textContent = p.position_caption || '';

  // Traduz posições de jogadores criados antes da lista oficial existir.
  const rawPositions = Array.isArray(p.positions_json) ? p.positions_json : [];
  let normalized = normalizeStoredPositions(rawPositions);
  if(normalized.length === 0 && (p.position_code || p.position_tag)){
    normalized = derivePositionsFromLegacyText(p.position_code || p.position_tag);
  }
  const changed = JSON.stringify(normalized) !== JSON.stringify(rawPositions);
  player.positions_json = normalized;
  if(changed && isAdmin && normalized.length){
    queueSave({ positions_json: normalized });
  }

  renderPositions();
  renderRoles();

  const isGK = isGoalkeeperPlayer(p);
  if(isGK){
    el('technicalCardTitle').textContent = 'Guarda-Redes';
    el('setPiecesCardTitle').textContent = 'Técnica';
    el('gkRatingLabel').textContent = 'Nota de Jogador de Campo';
    renderAttrList('technicalList', p.goalkeeping_json?.length ? p.goalkeeping_json : demoGoalkeeping, 'goalkeeping_json');
    renderAttrList('setPiecesList', p.technical_json?.length ? p.technical_json : demoTechnicalGK, 'technical_json');
  }else{
    el('technicalCardTitle').textContent = 'Técnica';
    el('setPiecesCardTitle').textContent = 'Bolas Paradas';
    el('gkRatingLabel').textContent = 'Nível de Guarda-Redes';
    renderAttrList('technicalList', p.technical_json?.length ? p.technical_json : demoTechnical, 'technical_json');
    renderAttrList('setPiecesList', p.set_pieces_json?.length ? p.set_pieces_json : demoSetPieces, 'set_pieces_json');
  }
  renderAttrList('mentalList', p.mental_json?.length ? p.mental_json : demoMental, 'mental_json');
  renderAttrList('physicalList', p.physical_json?.length ? p.physical_json : demoPhysical, 'physical_json');

  el('height').textContent = p.height_cm ? `${p.height_cm} cm` : '';
  el('reputation').textContent = p.reputation_text || '';
  el('personality').value = p.personality || 'Normal';
  if(el('focusRole')) el('focusRole').value = p.focus_role || '';
  el('leftFoot').textContent = p.left_foot || '';
  el('rightFoot').textContent = p.right_foot || '';
  el('traitsList').textContent = p.traits || '';
  el('gkRating').textContent = p.gk_rating || '';

  el('happiness').textContent = p.happiness || '';
  el('posCount').textContent = p.positive_count ?? 0;
  el('negCount').textContent = p.negative_count ?? 0;
  el('fitness').textContent = p.fitness_status || '';
  el('fitnessNote').textContent = p.fitness_note || '';
  el('form').textContent = p.form_text || '';
  el('discipline').textContent = p.discipline_text || '';
  el('disciplineNote').textContent = p.discipline_note || '';
  el('training').textContent = p.training_status || '';
  el('trainingRating').textContent = (p.training_rating ?? 0).toFixed(2);

  renderSeasonStats();

  el('careerClubs').textContent = p.career_clubs ?? 1;
  el('careerApps').textContent = p.career_apps ?? 0;
  el('careerGoals').textContent = p.career_goals ?? 0;

  renderBadges(p.awards || []);
  renderBadges(p.awards || [], 'careerBadgesList');
  renderCareerHistory(p.season_history || []);
  renderCollectiveTrophies(p.trophies || []);

  setupNegotiateTab(p);
  setupOriginClubField(p);
}

/* ---------- Prémios / badges ---------- */
const AWARD_LABELS = {
  best_player: 'Melhor Jogador',
  top_scorer: 'Melhor Marcador',
  best_defender: 'Melhor Defesa',
  best_assist: 'Melhor Assistente',
  best_goalkeeper: 'Melhor Guarda-Redes',
  cup_top_scorer: 'Melhor Marcador da Taça',
  cup_best_assist: 'Melhor Assistente da Taça',
  cup_best_defender: 'Melhor Defesa da Taça',
};
/* Prémios da Taça São Vicente usam o mesmo ícone-base do prémio equivalente
   do Campeonato (para se perceber logo do que se trata), sem o empilhar
   com um segundo emoji de troféu — a distinção visual passa a ser feita
   pelo estilo do badge em si (fita dourada + moldura), ver renderBadges. */
const AWARD_ICONS = {
  best_player: '👑',
  top_scorer: '⚽',
  best_defender: '🛡️',
  best_assist: '🎯',
  best_goalkeeper: '🧤',
  cup_top_scorer: '⚽',
  cup_best_assist: '🎯',
  cup_best_defender: '🛡️',
};
const CUP_AWARD_KEYS = new Set(['cup_top_scorer', 'cup_best_assist', 'cup_best_defender']);

function fmtAwardDate(isoDate){
  if(!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

function renderBadges(awards, targetId = 'badgesList'){
  const box = el(targetId);
  if(!box) return;
  if(!awards.length){
    box.innerHTML = '<p class="placeholder-text">Sem prémios ganhos ainda.</p>';
    return;
  }
  box.innerHTML = awards.map((a) => {
    const isCup = CUP_AWARD_KEYS.has(a.award_key);
    return `
    <div class="badge-item${isCup ? ' badge-item-cup' : ''}">
      ${isCup ? '<span class="badge-cup-ribbon">🏆 Taça São Vicente</span>' : ''}
      <div class="badge-icon${isCup ? ' badge-icon-cup' : ''}">${AWARD_ICONS[a.award_key] || '🏅'}</div>
      <div class="badge-info">
        <span class="badge-label">${AWARD_LABELS[a.award_key] || a.award_key}</span>
        <span class="badge-meta">${a.season_label} · ${fmtAwardDate(a.won_date)}</span>
      </div>
    </div>`;
  }).join('');
}

/* ---------- Aba Carreira: histórico ano a ano + títulos coletivos ----------
   season_history vem já arquivado por época (ver runSeasonRolloverIfDue em
   routes/league.js) — uma linha por competição (Campeonato/Taça) por época
   em que o jogador realmente jogou. trophies são os títulos de equipa que
   o jogador ajudou a conquistar (creditado a todo o plantel da equipa
   campeã no momento em que a época fechou). */
function renderCareerHistory(rows){
  const body = el('careerHistoryBody');
  const empty = el('careerHistoryEmpty');
  if(!body) return;
  if(!rows.length){
    body.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  body.innerHTML = rows.map((r) => `
    <tr>
      <td class="career-season-label">${r.season_label}</td>
      <td>${r.team_name || '—'}</td>
      <td>${r.competition}</td>
      <td>${r.games ?? 0}</td>
      <td>${r.goals ?? 0}</td>
      <td>${r.assists ?? 0}</td>
      <td>${r.yellow_cards ?? 0}</td>
      <td>${r.red_cards ?? 0}</td>
      <td>${r.tackles ?? 0}</td>
      <td>${r.pass_pct != null ? `${r.pass_pct}%` : '-'}</td>
      <td class="rating">${r.rating != null ? Number(r.rating).toFixed(2) : '-'}</td>
    </tr>`).join('');
}

const TROPHY_LABELS = { league: 'Campeão do Campeonato', cup: 'Campeão da Taça São Vicente' };
const TROPHY_ICONS = { league: '🏆', cup: '🏆⚔️' };

function renderCollectiveTrophies(trophies){
  const box = el('collectiveTrophiesList');
  if(!box) return;
  if(!trophies.length){
    box.innerHTML = '<p class="placeholder-text">Sem títulos coletivos ainda.</p>';
    return;
  }
  box.innerHTML = trophies.map((t) => `
    <div class="trophy-item">
      <div class="trophy-icon">${TROPHY_ICONS[t.competition] || '🏆'}</div>
      <div class="trophy-info">
        <span class="trophy-label">${TROPHY_LABELS[t.competition] || t.competition} · ${t.team_name || ''}</span>
        <span class="trophy-meta">${t.season_label} · ${fmtAwardDate(t.won_date)}</span>
      </div>
    </div>`).join('');
}

/* ---------- 10a-bis. Clube de Origem (admin) ----------
   Corrige de onde um jogador começa sempre que o jogo é reiniciado. É a única
   forma de acertar isto manualmente se o jogador tiver sido transferido antes
   de o "clube de origem" existir/ser gravado corretamente (ex: histórico antigo). */
async function setupOriginClubField(p){
  const row = el('originClubRow');
  const select = el('originClubSelect');

  if(!isAdmin){
    row.classList.add('hidden');
    return;
  }

  row.classList.remove('hidden');
  select.disabled = true;
  select.innerHTML = '<option>A carregar…</option>';

  try{
    const res = await fetch('/api/teams');
    if(!res.ok) throw new Error();

    const teams = await res.json();

    select.innerHTML = `
      <option value="">-- Jogador Livre --</option>
      ${teams.map(t => `
        <option value="${t.id}">${t.name}</option>
      `).join('')}
    `;

    // Se não tiver clube, fica selecionada a opção "Jogador Livre"
    select.value = p.original_team_id ?? p.team_id ?? '';

    select.disabled = false;

    select.addEventListener('change', () => {
      queueSave({
        original_team_id: select.value === '' ? null : Number(select.value)
      });
    });

  }catch(err){
    select.innerHTML = '<option>Não foi possível carregar as equipas</option>';
  }
}

/* ---------- 10b. Modo de consulta (fora do admin): trava tudo o resto ---------- */
function applyViewOnlyMode(){
  document.body.classList.add('view-mode');

  // Todos os campos "estáticos" do cabeçalho e cartões que já vêm com contenteditable no HTML
  document.querySelectorAll('[contenteditable="true"]').forEach((elm) => { elm.contentEditable = 'false'; });

  // Uploads de imagem: impede abrir o seletor de ficheiro
  ['playerPhotoInput', 'flagInput', 'clubLogoInput'].forEach((id) => { el(id).disabled = true; });
  document.querySelectorAll('.upload-slot, .flag-upload').forEach((slot) => { slot.style.pointerEvents = 'none'; });

  // Gerador automático de atributos: só faz sentido no modo admin
  el('attrGeneratorBar')?.classList.add('hidden');

  // Esconde o indicador de gravação (nada é gravado fora do admin)
  el('saveStatus')?.classList.add('hidden');
}
if(isAdmin === false) applyViewOnlyMode();

/* ---------- Gerador automático de atributos (Nível Geral 0-100 + posição) ---------- */
el('generateAttrsBtn')?.addEventListener('click', async () => {
  if(!isAdmin || !playerId) return;

  const input = el('overallInput');
  const overall = Number(input.value);
  if(!Number.isFinite(overall) || overall < 0 || overall > 100){
    input.focus();
    return;
  }

  const btn = el('generateAttrsBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'A gerar...';

  try{
    const res = await fetch(`/api/players/${playerId}/generate-attributes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overall }),
    });
    if(!res.ok) throw new Error();
    const updated = await res.json();

    // Volta a desenhar as quatro listas de atributos com os valores novos
    if(updated.goalkeeping_json?.length){
      renderAttrList('technicalList', updated.goalkeeping_json, 'goalkeeping_json');
      renderAttrList('setPiecesList', updated.technical_json, 'technical_json');
    }else{
      renderAttrList('technicalList', updated.technical_json, 'technical_json');
      renderAttrList('setPiecesList', updated.set_pieces_json, 'set_pieces_json');
    }
    renderAttrList('mentalList', updated.mental_json, 'mental_json');
    renderAttrList('physicalList', updated.physical_json, 'physical_json');

    // Depois de gerar os atributos, atualiza logo o valor de mercado e o
    // salário (ver PUT /api/players/:id/generate-value) — assim os dois
    // ficam sempre coerentes um com o outro, sem passo extra manual.
    await refreshMarketValue();
  }catch(err){
    input.focus();
  }finally{
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

/* Recalcula o valor de mercado e o salário a partir dos atributos ATUAIS do
   jogador na base de dados (mesma fórmula do botão "Gerar Atributos" — ver
   computePlayerValuation em routes/players.js). Chamado depois de gerar o
   Nível Geral, e também sempre que um atributo é editado manualmente (ver
   saveAttrGroup mais abaixo) — assim subir um atributo à mão sobe o preço e
   o salário na mesma proporção, sem precisar de carregar outra vez em
   "Gerar Atributos". */
async function refreshMarketValue(){
  if(!playerId) return;
  try{
    const valueRes = await fetch(`/api/players/${playerId}/generate-value`, { method: 'PUT' });
    if(!valueRes.ok) return;
    const withValue = await valueRes.json();
    if(el('marketValue')) el('marketValue').textContent = withValue.market_value_text || '—';
    if(el('salaryValue')) el('salaryValue').textContent = withValue.wage_text || '—';
    if(el('wage')) el('wage').textContent = withValue.wage_text || '';
    if(player){
      player.market_value_text = withValue.market_value_text;
      player.wage_text = withValue.wage_text;
    }
  }catch(valueErr){
    // não crítico — o(s) atributo(s) já ficaram gravados na mesma
  }
}

/* ---------- 10c. Negociar: proposta de transferência + contrato ---------- */
function fmtMoneyNegotiate(v){
  return '£' + Number(v || 0).toLocaleString('pt-PT');
}

/* Lê um número aproximado de um texto de salário tipo "£41.5K p/s" ou "£3.000 p/s".
   Só se trata como casa decimal o que vem antes de um sufixo K/M — sem
   sufixo, o texto é sempre um valor inteiro já por extenso (ex: "3.000" ou
   "3 000" = três mil), e o "." ou espaço é separador de milhar, não vírgula
   decimal. Antes disto, "£3.000 p/s" lia-se como "3" (quase zero), fazendo
   esta dica de negociação mostrar salários muito abaixo do real. */
function parseWageText(text){
  const str = String(text || '');
  const suffixMatch = str.match(/([\d]+(?:[.,]\d+)?)\s*(K|M)/i);
  if(suffixMatch){
    const num = parseFloat(suffixMatch[1].replace(',', '.'));
    const mult = /M/i.test(suffixMatch[2]) ? 1_000_000 : 1_000;
    return Number.isFinite(num) && num > 0 ? num * mult : 0;
  }
  const digitsOnly = str.replace(/[^\d]/g, '');
  const value = digitsOnly ? parseInt(digitsOnly, 10) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function setupNegotiateTab(p){
  const tabBtn = el('tabNegotiateBtn');
  const myId = localStorage.getItem('fmcriol_teamId');

  if(isAdmin || !myId){
    tabBtn.classList.add('hidden');
    return;
  }

  const isFreeAgent = !p.team_id;
  const isMine = !isFreeAgent && String(p.team_id) === String(myId);

  tabBtn.textContent = isMine ? 'Mercado' : (isFreeAgent ? 'Assinar' : 'Negociar');
  tabBtn.classList.remove('hidden');
  el('negotiateBuySection').classList.toggle('hidden', isMine || isFreeAgent);
  el('negotiateListSection').classList.toggle('hidden', !isMine);
  el('negotiateFreeAgentSection').classList.toggle('hidden', !isFreeAgent);

  if(isMine) setupListingSection(p);
  else if(isFreeAgent) setupFreeAgentSection(p, myId);
  else setupBuySection(p, myId);
}

/* ---------- Jogador é teu: colocar/tirar da lista de transferências ---------- */
function setupListingSection(p){
  const form = el('listingForm');
  const toggle = el('listingToggle');
  const priceInput = el('askingPrice');
  const priceField = el('askingPriceField');
  const hint = el('listingStatusHint');
  const result = el('listingResult');

  toggle.checked = !!p.is_listed;
  priceInput.value = p.asking_price || '';
  priceField.classList.toggle('hidden', !toggle.checked);
  hint.textContent = p.is_listed
    ? `Listado — aceitas propostas a partir de ${fmtMoneyNegotiate(p.asking_price)}.`
    : 'Este jogador não está listado para transferência.';

  toggle.addEventListener('change', () => {
    priceField.classList.toggle('hidden', !toggle.checked);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const isListed = toggle.checked;
    const askingPrice = parseFloat(priceInput.value);
    if(isListed && (!askingPrice || askingPrice <= 0)) return;

    const btn = form.querySelector('button');
    btn.disabled = true;
    result.textContent = 'A guardar…';
    result.className = 'negotiate-result';

    try{
      const res = await fetch(`/api/players/${p.id}/transfer-list`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_listed: isListed, asking_price: isListed ? askingPrice : null }),
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Erro ao guardar');

      hint.textContent = isListed
        ? `Listado — aceitas propostas a partir de ${fmtMoneyNegotiate(askingPrice)}.`
        : 'Este jogador não está listado para transferência.';
      result.textContent = 'Guardado.';
      result.classList.add('ok');
    }catch(err){
      result.textContent = err.message;
      result.classList.add('err');
    }finally{
      btn.disabled = false;
    }
  });
}

/* ---------- Jogador de outro clube: proposta de transferência + contrato ---------- */
async function setupBuySection(p, myId){
  let myTeam;
  try{
    const res = await fetch(`/api/teams/${myId}`);
    if(!res.ok) throw new Error();
    myTeam = await res.json();
  }catch(err){
    el('negotiateBudgetHint').textContent = 'Não foi possível carregar o orçamento do teu clube.';
    return;
  }

  el('negotiateBudgetHint').textContent =
    `Orçamento de transferências disponível: ${fmtMoneyNegotiate(myTeam.transfer_budget)} · Orçamento salarial: ${fmtMoneyNegotiate(myTeam.wage_budget)}/semana`;

  const offerForm = el('offerForm');
  const contractForm = el('contractForm');
  const offerResult = el('offerResult');
  const contractResult = el('contractResult');

  const currentWage = parseWageText(p.wage_text);
  el('wageExpectationHint').textContent = currentWage
    ? `${p.name} recebe atualmente ${fmtMoneyNegotiate(currentWage)}/semana — normalmente só aceita um salário igual ou um pouco melhor do que esse.`
    : `Não sabemos o salário atual de ${p.name} — propõe um valor competitivo para o nível dele.`;

  offerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseFloat(el('offerAmount').value);
    if(!amount || amount <= 0) return;

    const btn = offerForm.querySelector('button');
    btn.disabled = true;
    offerResult.textContent = 'A enviar proposta…';
    offerResult.className = 'negotiate-result';

    try{
      const res = await fetch('/api/transfers/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: p.id, buyer_team_id: myId, offer_amount: amount }),
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Erro ao enviar proposta');

      if(data.status === 'accepted'){
        offerResult.textContent = 'Proposta aceite! Agora propõe um contrato ao jogador.';
        offerResult.classList.add('ok');
        offerForm.classList.add('hidden');
        contractForm.classList.remove('hidden');
        contractForm.dataset.transferOfferId = data.id;
      }else{
        offerResult.textContent = 'O clube recusou a proposta. Consulta a caixa de entrada e tenta um valor mais alto.';
        offerResult.classList.add('err');
      }
    }catch(err){
      offerResult.textContent = err.message;
      offerResult.classList.add('err');
    }finally{
      btn.disabled = false;
    }
  });

  contractForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const transferOfferId = contractForm.dataset.transferOfferId;
    const payload = {
      wage_offer: parseFloat(el('wageOffer').value),
      signing_bonus: parseFloat(el('signingBonus').value) || 0,
      promised_role: el('promisedRole').value,
    };
    if(!payload.wage_offer || payload.wage_offer <= 0) return;

    const btn = contractForm.querySelector('button');
    btn.disabled = true;
    contractResult.textContent = 'A negociar com o jogador…';
    contractResult.className = 'negotiate-result';

    try{
      const res = await fetch(`/api/transfers/${transferOfferId}/contract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Erro ao propor contrato');

      if(data.status === 'accepted'){
        contractResult.textContent = `${p.name} assinou e é agora jogador do teu clube! Consulta a caixa de entrada para os detalhes.`;
        contractResult.classList.add('ok');
        contractForm.classList.add('hidden');
      }else{
        contractResult.textContent = 'O jogador recusou a proposta de contrato. Consulta a caixa de entrada.';
        contractResult.classList.add('err');
      }
    }catch(err){
      contractResult.textContent = err.message;
      contractResult.classList.add('err');
    }finally{
      btn.disabled = false;
    }
  });
}

/* ---------- Jogador livre (sem clube): assinar diretamente, sem custo de transferência ---------- */
async function setupFreeAgentSection(p, myId){
  let myTeam;
  try{
    const res = await fetch(`/api/teams/${myId}`);
    if(!res.ok) throw new Error();
    myTeam = await res.json();
  }catch(err){
    el('freeAgentBudgetHint').textContent = 'Não foi possível carregar o orçamento do teu clube.';
    return;
  }

  el('freeAgentBudgetHint').textContent = `Orçamento salarial disponível: ${fmtMoneyNegotiate(myTeam.wage_budget)}/semana`;
  el('freeAgentWageHint').textContent = `${p.name} está livre — sem clube nem salário atual. Propõe um salário competitivo para o nível dele.`;

  const form = el('freeAgentForm');
  const result = el('freeAgentResult');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const wageOffer = parseFloat(el('faWageOffer').value);
    if(!wageOffer || wageOffer <= 0) return;

    const btn = form.querySelector('button');
    btn.disabled = true;
    result.textContent = 'A negociar com o jogador…';
    result.className = 'negotiate-result';

    try{
      const offerRes = await fetch('/api/transfers/free-agent-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: p.id, buyer_team_id: myId }),
      });
      const offerData = await offerRes.json();
      if(!offerRes.ok) throw new Error(offerData.error || 'Erro ao iniciar a assinatura');

      const contractRes = await fetch(`/api/transfers/${offerData.id}/contract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wage_offer: wageOffer,
          signing_bonus: parseFloat(el('faSigningBonus').value) || 0,
          promised_role: el('faPromisedRole').value,
        }),
      });
      const contractData = await contractRes.json();
      if(!contractRes.ok) throw new Error(contractData.error || 'Erro ao propor contrato');

      if(contractData.status === 'accepted'){
        result.textContent = `${p.name} assinou e é agora jogador livre de custos do teu clube!`;
        result.classList.add('ok');
        form.classList.add('hidden');
      }else{
        result.textContent = 'O jogador recusou os termos do contrato. Tenta um salário melhor.';
        result.classList.add('err');
      }
    }catch(err){
      result.textContent = err.message;
      result.classList.add('err');
    }finally{
      btn.disabled = false;
    }
  });
}

/* ---------- 11. Ligação com o resto da app ---------- */
const myTeamId = localStorage.getItem('fmcriol_teamId');
el('backLink').href = myTeamId ? '/dashboard/dashboard.html' : '/admin/gestaoJogadores.html';

if(playerId){
  loadPlayer();
}else{
  // Modo demonstração: sem ?id= na URL, mantém os dados fixos originais e não grava nada
  el('saveStatus').textContent = 'Modo demonstração (sem gravação)';
  renderAttrList('technicalList', demoTechnical);
  renderAttrList('setPiecesList', demoSetPieces);
  renderAttrList('mentalList', demoMental);
  renderAttrList('physicalList', demoPhysical);
  renderPositions();
  player = {
    roles_possession_json: [
      { name: 'Extremo', rating: 4, selected: true },
      { name: 'Avançado pelo Corredor', rating: 4, selected: false },
      { name: 'Extremo Interior', rating: 4, selected: false },
      { name: 'Interior Ofensivo', rating: 4, selected: false },
      { name: 'Extremo Criativo', rating: 3.5, selected: false },
    ],
    roles_nopossession_json: [],
    season_stats_json: [
      { competition: 'Não Competitivo', j:2, g:1, a:0, xg:0.2, pen:0, mdp:0, am:0, verm:0, tk:3, dr:5, ps:62, pp:'81', media:'7.55' },
      { competition: 'Geral (Clube)', j:0, g:0, a:0, xg:0.0, pen:0, mdp:0, am:0, verm:0, tk:0, dr:0, ps:0, pp:'-', media:'-' },
    ],
  };
  renderRoles();
  renderSeasonStats();
}