// Verrou "une requete a la fois" : /run refuse une nouvelle requete tant
// qu'un process claude est deja en cours (voir decisions dans CLAUDE.md).
let busy = false;

function isBusy() {
  return busy;
}

function acquire() {
  if (busy) return false;
  busy = true;
  return true;
}

function release() {
  busy = false;
}

module.exports = { isBusy, acquire, release };
