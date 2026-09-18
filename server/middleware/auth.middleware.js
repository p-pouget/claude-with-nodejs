const crypto = require('crypto');

// Seule l'empreinte est stockee : le serveur verifie un token, il n'a jamais
// besoin de le detenir en clair. Une lecture de son environnement ne rend donc
// rien d'exploitable. Ne jamais y remettre le secret en clair.
const SERVICE_TOKEN_HASH = (process.env.SERVICE_TOKEN_HASH || '').trim().toLowerCase();

// Fail-closed. Le controle de format attrape l'erreur frequente : coller le
// secret (128 caracteres) au lieu de son empreinte (64).
if (!/^[0-9a-f]{64}$/.test(SERVICE_TOKEN_HASH)) {
  console.error(
    'SERVICE_TOKEN_HASH absent ou mal forme : impossible de demarrer. '
    + 'Attendu : un sha256 en hexadecimal (64 caracteres). '
    + 'Erreur frequente : y coller le secret lui-meme (128 caracteres) au lieu de son empreinte. '
    + 'Voir .env.example.'
  );
  process.exit(1);
}

// Monte globalement : n'exempte que /health, donc toute nouvelle route est
// protegee par defaut.
module.exports = function auth(req, res, next) {
  if (req.path === '/health') return next();

  const presented = req.get('x-service-token') || '';
  const presentedHash = crypto.createHash('sha256').update(presented).digest('hex');

  // Deux sha256, donc toujours 32 octets : timingSafeEqual ne peut pas lever,
  // et la longueur du token presente ne fuit pas.
  const ok = crypto.timingSafeEqual(
    Buffer.from(presentedHash, 'hex'),
    Buffer.from(SERVICE_TOKEN_HASH, 'hex')
  );

  if (!ok) {
    return res.status(401).json({ error: 'x-service-token invalide ou manquant' });
  }
  next();
};
