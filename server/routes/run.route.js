const router = require('express').Router();
const { spawn } = require('child_process');
const lock = require('../state/lock');
const { WORKDIR, clearAll } = require('../state/storage');

const DEFAULT_ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS || '';
const DEFAULT_MODEL = process.env.CLAUDE_DEFAULT_MODEL || '';
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 10 * 60 * 1000;

// Fail-closed : pas de liste d'outils par defaut en dur.
if (!DEFAULT_ALLOWED_TOOLS) {
  console.error('CLAUDE_ALLOWED_TOOLS manquant : impossible de demarrer (voir .env.example)');
  process.exit(1);
}

// Liste d'autorisation. Defense en profondeur seulement : le CLI tourne sous
// le meme UID que le serveur, donc /proc/1/environ la contourne.
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'CLAUDE_CODE_OAUTH_TOKEN'];
const CHILD_ENV = {};
for (const key of CHILD_ENV_KEYS) {
  if (process.env[key] !== undefined) CHILD_ENV[key] = process.env[key];
}

// Filet contre la fuite accidentelle, PAS une protection : ne resiste a aucune
// transformation (base64, caracteres espaces...). Voir CLAUDE.md.
const SECRET_VALUES = ['CLAUDE_CODE_OAUTH_TOKEN', 'SERVICE_TOKEN_HASH']
  .map((key) => process.env[key])
  // Sans ce seuil, une valeur vide exploserait la sortie caractere par caractere.
  .filter((value) => value && value.length >= 16);

function redact(text) {
  let out = text;
  for (const secret of SECRET_VALUES) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

// Tue le groupe de process, pas seulement le PID direct : une tache laissee en
// arriere-plan par le CLI reecrirait dans /workspace apres le nettoyage.
function killGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // ESRCH : groupe deja vide, cas nominal.
  }
}

// Nettoyer AVANT de liberer le verrou, sinon la requete suivante peut demarrer
// pendant le vidage. Un echec est logue sans faire echouer la reponse.
function clearAndRelease(shouldClear) {
  if (shouldClear) {
    try {
      clearAll();
    } catch (err) {
      console.error('nettoyage des repertoires ephemeres echoue :', err.message);
    }
  }
  lock.release();
}

router.post('/', (req, res) => {
  const { prompt, allowedTools, outputFormat, model, clear } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'champ "prompt" (string) requis' });
  }

  // Ces champs partent dans les arguments de spawn, qui leve une exception
  // synchrone sur autre chose qu'une string.
  for (const [name, value] of [['allowedTools', allowedTools], ['outputFormat', outputFormat], ['model', model]]) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return res.status(400).json({ error: `champ "${name}" doit etre une string` });
    }
  }

  // Il faut un false booleen explicite pour conserver l'espace de travail.
  const shouldClear = clear !== false;

  if (!lock.acquire()) {
    return res.status(409).json({ error: 'une requete claude est deja en cours, reessayer plus tard' });
  }

  const args = [
    '-p', prompt,
    '--output-format', outputFormat || 'json',
    '--allowedTools', allowedTools || DEFAULT_ALLOWED_TOOLS,
  ];

  const chosenModel = model || DEFAULT_MODEL;
  if (chosenModel) {
    args.push('--model', chosenModel);
  }

  // Le verrou est pose : une exception ici le laisserait pose pour toujours.
  let child;
  try {
    child = spawn('claude', args, {
      cwd: WORKDIR,
      env: CHILD_ENV,
      detached: true, // groupe de process dedie, voir killGroup
    });
  } catch (err) {
    lock.release();
    return res.status(500).json({ error: err.message });
  }

  // Fin de fichier immediate : si le CLI lit son entree, il echoue au lieu de
  // pendre jusqu'au timeout en gardant le verrou.
  child.stdin.end();

  const timer = setTimeout(() => killGroup(child), TIMEOUT_MS);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  // Node peut emettre 'error' PUIS 'close' pour le meme process : sans ce
  // garde, le verrou serait libere deux fois et la reponse envoyee deux fois.
  let settled = false;

  child.on('close', (code) => {
    if (settled) return;
    settled = true;

    clearTimeout(timer);
    killGroup(child); // balayer les survivants avant de vider
    clearAndRelease(shouldClear);

    const safeStdout = redact(stdout);
    const safeStderr = redact(stderr);

    if (code !== 0) {
      return res.status(500).json({ error: 'claude a echoue', code, stderr: safeStderr, stdout: safeStdout });
    }
    try {
      return res.json(JSON.parse(safeStdout));
    } catch {
      return res.type('text/plain').send(safeStdout);
    }
  });

  child.on('error', (err) => {
    if (settled) return;
    settled = true;

    clearTimeout(timer);
    killGroup(child);
    clearAndRelease(shouldClear);
    res.status(500).json({ error: err.message });
  });
});

module.exports = router;
