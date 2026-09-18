const fs = require('fs');
const path = require('path');

// Les deux emplacements ephemeres du container, tous deux montes en tmpfs
// dans docker-compose.yml. Figes en dur et non configurables : ces chemins
// doivent correspondre EXACTEMENT aux montages declares la-bas, sinon on
// nettoierait a cote et on ecrirait sur le disque sans s'en rendre compte.
const WORKDIR = '/workspace';   // repertoire de travail du CLI claude
const HOMEDIR = '/root';        // $HOME : transcripts, sessions, .claude.json

// Vide le CONTENU des deux repertoires, jamais les repertoires eux-memes :
// ce sont des points de montage, et rmSync dessus echouerait en EBUSY (le
// noyau refuse de supprimer un repertoire sur lequel un systeme de fichiers
// est monte). Les recreer donnerait de simples dossiers sur la couche
// inscriptible du container, sans tmpfs derriere, donc une persistance sur
// disque silencieuse.
// Chaque repertoire et chaque entree sont isoles : un echec ne doit jamais
// empecher le nettoyage du reste. Sans ca, une seule entree recalcitrante dans
// /workspace suffisait a ce que /root — qui contient les transcripts complets
// des conversations, la donnee la plus sensible — ne soit jamais vide.
// La fonction fait donc au mieux, puis signale ce qui a echoue : l'appelant
// doit pouvoir savoir que l'isolation n'est pas garantie.
function clearAll() {
  const errors = [];

  for (const dir of [WORKDIR, HOMEDIR]) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      errors.push(`${dir} illisible (${err.message})`);
      continue;
    }

    for (const entry of entries) {
      try {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      } catch (err) {
        errors.push(`${path.join(dir, entry)} (${err.message})`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`nettoyage incomplet : ${errors.join(' ; ')}`);
  }
}

module.exports = { WORKDIR, HOMEDIR, clearAll };
