/* ==========================================================
   FMcriol — Diagnóstico v2: qual save tem mesmo dados?
   Corre com: node check-saves2.js  (dentro da pasta server/, com o
   servidor PARADO)
   ========================================================== */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const candidates = [
  path.join(__dirname, 'data', 'fmcriol.db'),
  path.join(__dirname, 'data', 'saves', 'default.db'),
  path.join(__dirname, 'data', 'saves', 'adf419e0526781280e0bfa38682ba2f5.db'),
];

candidates.forEach((dbPath) => {
  console.log('\n=========================================');
  console.log('Ficheiro:', dbPath);

  if (!fs.existsSync(dbPath)) {
    console.log('  -> não existe.');
    return;
  }

  const walPath = `${dbPath}-wal`;
  if (fs.existsSync(walPath)) {
    console.log('  Tamanho do -wal:', fs.statSync(walPath).size, 'bytes');
  }

  let db;
  try {
    // SEM readonly desta vez — força o SQLite a processar o WAL como deve ser.
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    const teamCount = db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;
    console.log('  Equipas:', teamCount);

    if (teamCount > 0) {
      const teams = db.prepare('SELECT name, is_user_controlled FROM teams ORDER BY is_user_controlled DESC LIMIT 20').all();
      teams.forEach((t) => console.log(`   - ${t.name}${t.is_user_controlled ? '  <-- O TEU CLUBE' : ''}`));

      const playerCount = db.prepare('SELECT COUNT(*) AS n FROM players').get().n;
      console.log('  Jogadores:', playerCount);

      const state = db.prepare('SELECT current_date FROM game_state WHERE id = 1').get();
      console.log('  Data do jogo:', state ? state.current_date : '(sem game_state)');
    } else {
      // Mesmo sem tabela teams preenchida, vamos ver se HÁ alguma tabela com linhas,
      // para perceber se este ficheiro tem qualquer atividade.
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      tables.forEach((t) => {
        try {
          const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n;
          if (n > 0) console.log(`   (tabela "${t.name}" tem ${n} linha(s))`);
        } catch (e) { /* ignora tabelas especiais */ }
      });
    }

    // Força um checkpoint — isto grava o conteúdo do -wal para o ficheiro
    // principal, para o diagnóstico (e futuras leituras) ficarem corretos.
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.log('  -> erro ao ler:', err.message);
  } finally {
    if (db) db.close();
  }
});

console.log('\n=========================================');
console.log('Copia e cola aqui o resultado todo.');