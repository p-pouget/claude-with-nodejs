const express = require('express');
const authMiddleware = require('./middleware/auth.middleware');

const server = express();
server.use(express.json({ limit: '2mb' }));
server.use(authMiddleware);

const healthRoute = require('./routes/health.route');
server.use('/health', healthRoute);

const runRoute = require('./routes/run.route');
server.use('/run', runRoute);

const clearRoute = require('./routes/clear.route');
server.use('/clear', clearRoute);

// ── 404 catch-all (toujours en dernier) ──────────────────
server.use((req, res) => {
  res.status(404).json({ error: 'introuvable' });
});

// ── Handler d'erreurs ────────────────────────────────────
// 4 arguments obligatoires, sinon Express le prend pour un middleware
// ordinaire. Sans lui, un body JSON malforme (qui echoue dans express.json,
// donc avant l'auth) renvoie la stack trace en HTML au client.
server.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'requete invalide' });
});

const PORT = process.env.PORT || 8787;

server.listen(PORT, () => {
  console.log(`Serveur demarre sur le port http://localhost:${PORT}`);
});
