# FMcriol — Servidor + Base de Dados (Tarefa 1)

Base de dados (SQLite) ligada a um servidor Node.js/Express. Nesta primeira
tarefa, a base de dados guarda as **equipas** (escudo, nome, reputação,
financeiro, jogadores associados). A tabela `players` já existe como
placeholder, ligada a `teams` por `team_id`, pronta para ser expandida na
Tarefa 4.

## Estrutura do projeto

```
fmcriol-server/
├── server.js           # servidor Express principal
├── db/
│   ├── database.js      # ligação ao SQLite + criação das tabelas
│   └── seed.js           # popula as 15 equipas da Primeira Divisão
├── routes/
│   └── teams.js          # rotas da API para equipas
├── uploads/shields/     # imagens dos escudos carregadas
└── data/                # ficheiro fmcriol.db (criado automaticamente)
```

## Como correr

```bash
npm install       # instala as dependências
npm run seed       # cria a base de dados e insere as 15 equipas
npm start          # arranca o servidor em http://localhost:3000
```

Durante o desenvolvimento, `npm run dev` reinicia o servidor automaticamente
quando editas ficheiros.

## Endpoints disponíveis

| Método | Rota                     | Descrição                                    |
|--------|---------------------------|-----------------------------------------------|
| GET    | `/api/health`             | Verifica se o servidor e a BD estão a funcionar |
| GET    | `/api/teams`               | Lista todas as equipas (filtros: `?division=1`, `?q=nome`) |
| GET    | `/api/teams/:id`           | Detalhe de uma equipa + jogadores associados  |
| POST   | `/api/teams`               | Cria uma nova equipa (JSON: `name` obrigatório) |
| PUT    | `/api/teams/:id`           | Atualiza dados de uma equipa                  |
| POST   | `/api/teams/:id/shield`    | Faz upload do escudo (form-data, campo `shield`) |
| DELETE | `/api/teams/:id`           | Remove uma equipa                             |

### Exemplo — criar equipa
```bash
curl -X POST http://localhost:3000/api/teams \
  -H "Content-Type: application/json" \
  -d '{"name":"Palmeira","reputation_stars":2.8,"financial_tier":"Pobre"}'
```

### Exemplo — upload de escudo
```bash
curl -X POST http://localhost:3000/api/teams/1/shield \
  -F "shield=@caminho/para/escudo.png"
```

## Dados das equipas (Primeira Divisão)

As 15 equipas do documento do projeto são inseridas automaticamente pelo
`npm run seed`, com `reputation_stars` e `financial_tier` conforme o
documento. Os campos `wage_budget`, `transfer_budget` e `balance` são
**calculados automaticamente** a partir da reputação e do tier financeiro
(fórmula em `db/seed.js`, `FINANCIAL_MULTIPLIER` — ajusta os valores base
quando quiseres afinar o equilíbrio económico do jogo).

O `seed.js` usa `INSERT ... ON CONFLICT` — podes correr `npm run seed` várias
vezes sem duplicar equipas; ele apenas atualiza os valores.

## Próximos passos (tarefas seguintes do projeto)

- Tarefa 2: ecrã inicial do clube escolhido (mensagens, finanças, jogadores, calendário).
- Tarefa 3: barra de pesquisa global (equipas + jogadores).
- Tarefa 4: base de dados completa de jogadores (o teu `perfilJogador.html` já
  dá o layout — falta ligar os campos aos dados reais da tabela `players`,
  que será expandida com atributos técnicos/mentais/físicos, posições,
  personalidade, playstyles, etc.)
- Segunda divisão: o documento só define as equipas da Primeira Divisão;
  quando tiveres a lista da Segunda, basta acrescentá-la a `db/seed.js`.
