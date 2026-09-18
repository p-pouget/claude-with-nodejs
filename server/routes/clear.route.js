const router = require('express').Router();
const lock = require('../state/lock');
const { clearAll } = require('../state/storage');

// Vide les repertoires ephemeres (/workspace et $HOME) sans lancer claude,
// pour repartir propre apres une serie d'appels /run faits avec "clear": false.
router.post('/', (req, res) => {
  // Meme verrou que /run : sans ca, on viderait les repertoires sous les pieds
  // d'un claude en cours d'execution.
  if (!lock.acquire()) {
    return res.status(409).json({ error: 'une requete claude est deja en cours, reessayer plus tard' });
  }

  try {
    clearAll();
    return res.json({ cleared: true });
  } catch (err) {
    // Contrairement a /run, le nettoyage est la seule chose que cette route
    // promet : s'il echoue, l'appel echoue.
    return res.status(500).json({ error: err.message });
  } finally {
    lock.release();
  }
});

module.exports = router;
