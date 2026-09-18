# claude-with-nodejs

## Objectif

Container qui expose Claude Code CLI via un serveur Node.js/Express, pour
etre appele en HTTP par n'importe quel client, sans passer par des commandes
manuelles dans un terminal.

**Le service n'est lie a aucun appelant particulier.** n8n est le premier cas
d'usage prevu, mais rien dans le code ne lui est specifique : c'est une
requete HTTP avec un header. Ne pas introduire de dependance ou de
vocabulaire propre a n8n — parler de « l'appelant » ou « le client », et ne
citer n8n qu'a titre d'exemple.

## Regle de validation (imperative)

**Aucune validation finale sans l'aval explicite de l'utilisateur.** Ni
Claude Code (agent principal), ni les sub-agents definis dans
`.claude/agents/` (`security-reviewer`, `api-smoke-tester`) n'ont
l'autorite pour declarer un changement "safe", "valide", "pret pour la
prod" ou "deployable". Leur role s'arrete a rapporter des faits (risques
trouves, tests passes/echoues) ; la decision de merger, deployer ou
continuer revient toujours a l'utilisateur, explicitement, dans le chat.
Cette regle s'applique en particulier car ce projet a vocation a tourner
sur un vrai serveur, pas seulement en local.

**Invocation manuelle uniquement.** `security-reviewer` et
`api-smoke-tester` ne doivent jamais etre invoques de sa propre initiative
par l'agent principal (meme apres un changement touchant auth/reseau/
secrets/Docker). C'est l'utilisateur qui decide quand les lancer, en le
demandant explicitement.

## Decisions d'architecture (et pourquoi)

- **Pas de persistance, sur les DEUX emplacements** : `/workspace` (repertoire
  de travail du CLI) et `/root` (`$HOME`) sont montes en `tmpfs` dans
  `docker-compose.yml`, pas en volumes relies au disque. Ce que Claude y ecrit
  ne touche pas le disque de l'hote, et un `docker compose restart` les remet
  a zero. C'est un choix deliberement plus strict qu'un simple nettoyage
  applicatif.
  **Portee exacte** : le reste du systeme de fichiers (`/tmp`, `/var/tmp`,
  `/app`...) reste inscriptible et va sur la couche du container, donc sur le
  disque. Un `cp -r /workspace /tmp/stash` survit a `clear` comme a `/clear`.
  Ces montages cloisonnent les espaces de travail, ils ne garantissent pas
  que rien ne s'ecrit nulle part — ne pas les presenter comme tels.
  `$HOME` compte autant que `/workspace` : c'est la que le CLI ecrit les
  **transcripts complets** des conversations (`.claude/projects/*.jsonl` —
  chaque prompt, chaque reponse, le contenu de chaque fichier lu ou ecrit),
  l'etat des sessions, et `.claude.json` (email, nom, organisation du compte).
  Sans ce montage, les donnees metier de chaque job finissaient sur le disque
  du serveur et grossissaient sans limite.
  Aucun secret d'authentification n'y est stocke en revanche (verifie) : le
  token vient de `CLAUDE_CODE_OAUTH_TOKEN` a chaque `spawn`, donc nettoyer ne
  deconnecte pas.
- **Deux isolations distinctes, a ne pas confondre.** Le tmpfs protege contre
  la persistance sur le disque de l'hote (entre deux vies du container). Il ne
  donne aucune isolation _entre deux requetes_ : les tmpfs sont montes a la
  creation du container, pas par appel. C'est le champ `clear` de `/run`
  (defaut `true`) qui vide les deux emplacements en fin de requete. Avec
  `"clear": false`, tout ce qu'un appel ecrit reste lisible par le suivant —
  c'est le mode a utiliser pour enchainer plusieurs taches sur un meme espace,
  puis appeler `/clear` a la fin.
- **Le CLI est lance en `detached: true` et tue par groupe de process**
  (`killGroup` dans `run.route.js`), pas par son seul PID. Claude a Bash : il
  peut laisser tourner des taches en arriere-plan qui survivraient a la mort
  du process principal et reecriraient dans `/workspace` **apres** le
  nettoyage. Le balayage a lieu au timeout **et** en fin d'appel normale, et
  toujours avant `clearAll()`. Ne pas "simplifier" en revenant a
  `child.kill()` : ca rouvrirait un canal entre deux requetes.
- **Un seul container qui tourne en continu.** L'option alternative envisagee
  (le serveur lance un nouveau container jetable a chaque requete via le
  socket Docker) a ete ecartee pour rester simple.
- **Authentification via `CLAUDE_CODE_OAUTH_TOKEN` uniquement**, genere en
  local avec `claude setup-token` (lie a l'abonnement Claude Pro/Max).
  Volontairement pas de `ANTHROPIC_API_KEY` : ce n'etait pas demande, a ne
  pas rajouter sans en parler d'abord.
- **Un seul appel a la fois** : impose par un verrou en memoire
  (`server/state/lock.js`), aucune gestion de requetes concurrentes cote
  serveur. Une deuxieme requete `/run` ou `/clear` pendant qu'une premiere
  tourne recoit un `409`. Choix explicite, ne pas ajouter de logique de
  files d'attente ou d'isolation par requete sans demande claire.
  Attention, le verrou serialise les appels _simultanes_ ; il n'empeche pas
  deux appelants differents de s'enchainer dans le temps sur le meme
  espace de travail — c'est le role du champ `clear`.
- **`allowedTools` (Read/Edit/Bash/Grep/Glob) ne sandbox pas vraiment ce que
  Bash peut faire** une fois autorise : la vraie protection vient du
  container jetable + tmpfs, pas de la liste de permissions. Ne pas
  presenter cette liste comme une garantie de securite forte. La liste par
  defaut vient de `CLAUDE_ALLOWED_TOOLS`, **fail-closed** comme
  `SERVICE_TOKEN_HASH` : pas de liste en dur dans `run.route.js`, le serveur
  refuse de demarrer si la variable est absente ou vide. Le champ
  `allowedTools` du body `/run` reste prioritaire et est transmis tel quel
  au CLI, sans liste blanche.
- **Le secret partage n'existe que sous forme d'empreinte cote serveur**
  (`SERVICE_TOKEN_HASH`, `server/middleware/auth.middleware.js`). Le serveur
  n'a besoin que de _verifier_ le token presente dans `x-service-token`,
  jamais de le prouver a un tiers : il n'a donc aucune raison de le detenir
  en clair. Raison concrete : le process Node est PID 1 et le CLI tourne sous
  le meme UID, donc une session claude peut lire tout son environnement via
  `cat /proc/1/environ`. Avec l'empreinte, cette lecture ne rend rien
  d'exploitable. **Ne jamais remettre le secret en clair dans
  l'environnement.** Corollaire operationnel : le secret n'est recuperable
  nulle part cote serveur, il vit dans la configuration de l'appelant et le
  gestionnaire de mots de passe de l'utilisateur.
  **Fail-closed** : le serveur refuse de demarrer si la variable est absente
  ou mal formee (un sha256 hex de 64 caracteres est exige — ca attrape
  l'erreur frequente qui consiste a y coller le secret de 128 caracteres).
  Ne jamais reintroduire de fallback "pas de token -> pas de check".
  Le middleware est monte globalement et **n'exempte que `/health`** : toute
  nouvelle route est donc protegee par defaut, ce qui est le bon sens de
  l'oubli.
- **Durcissement du container** (`docker-compose.yml`) : `cap_drop: [ALL]`,
  `no-new-privileges`, `pids_limit: 512`. Motivation : Claude a Bash, et le
  projet est destine a recevoir du contenu non fiable (articles scrapes) dans
  ses prompts. Ces reglages n'affectent pas l'usage normal — le port est au
  dessus de 1024 et git/python/pip/node n'ont besoin d'aucune capability —
  mais un `apt-get install` a chaud cesse de fonctionner (les dependances
  vont dans le Dockerfile, ce qui etait deja la regle). Pas de limite CPU
  posee a ce stade, a rouvrir si un script lance par Claude sature l'hote.
- **Pas de port publie vers l'hote** (`docker-compose.yml`) : aucun bloc
  `ports:`. Le service n'est joignable que par d'autres containers sur le
  meme reseau Docker (`DOCKER_NETWORK`, via `claude-with-nodejs:8787`) —
  meme pas depuis l'hote lui-meme (ni `127.0.0.1`, ni l'IP publique). Ne
  pas rajouter de `ports:` sans en discuter — ca exposerait `/run`
  (execution shell) au-dela du reseau Docker interne.
- **Les capacites de Claude ne sont volontairement PAS restreintes.** Choix
  explicite de l'utilisateur, a ne pas "corriger" sans en parler d'abord.
  Ce qui n'est deliberement pas fait, et ne doit pas etre propose comme un
  durcissement evident : retirer `Bash` de `allowedTools`, bloquer la sortie
  reseau du container, passer le rootfs en lecture seule.
  Raisons :
  - **C'est le produit.** Bash est ce qui permet a Claude de lancer des
    scripts, manipuler des fichiers et enchainer des traitements. Le retirer
    ne durcit pas le service, ca le vide.
  - **Le calcul cout/benefice est mauvais.** Ces restrictions couteraient
    beaucoup pour un gain partiel : le canal de reponse resterait une sortie
    ouverte de toute facon (voir la decision suivante).
  - **Les restrictions en place, elles, ne coutent rien.** `cap_drop`,
    `no-new-privileges` et `pids_limit` ne retirent aucune capacite utilisee
    en pratique — seul `apt-get` a chaud disparait, ce qui etait deja sans
    objet avec le tmpfs.
    Le risque n'est pas la puissance de Claude, c'est **du texte non fiable qui
    atteint un agent puissant**. Il se traite donc aux extremites, sans rien
    retirer a l'agent : cadrage de ce qu'on met dans le `prompt`, prudence sur
    ce qu'on fait de la reponse, et perimetre reseau.
- **Reseau dedie et isole, prevu au niveau infrastructure.** Le container ne
  doit pas partager un reseau plat avec l'appelant et les autres services.
  Raison : le durcissement en place protege contre l'evasion du container, pas
  contre l'usage _normal_ du reseau. Une injection de prompt (contenu scrape
  contenant des consignes cachees) donne un shell qui peut joindre tout ce
  qui est accessible — et un orchestrateur comme n8n detient les credentials
  de tout ce qui y est connecte (bases, API, comptes mail). Ce butin-la vaut
  probablement plus que le token Claude. Cible : l'appelant peut joindre
  `claude-with-nodejs:8787`, mais le container ne peut pas initier de
  connexion vers lui ni vers les autres services.
  **Le repo ne peut pas garantir cette propriete** : il rejoint un reseau
  externe designe par `DOCKER_NETWORK`, la topologie est definie a la
  creation du reseau, cote infrastructure. Si le service est deploye sur un
  reseau partage, la protection n'existe pas — ne pas supposer qu'elle est
  acquise en lisant `docker-compose.yml`.
- **Le canal de reponse est une sortie non fiable, et il est indeboulonnable.**
  Meme sans acces internet, une injection peut faire terminer la reponse de
  Claude par la valeur d'une variable d'environnement : le secret part alors
  dans les donnees du workflow appelant, ses logs, et tout ce qu'il en fait
  ensuite. Couper la sortie reseau ne ferme donc pas le probleme, et la
  consequence est cote appelant : **ne jamais injecter la sortie de `/run`
  telle quelle dans une etape qui execute, requete ou envoie quelque chose.**
  Un filtre remplace les secrets du serveur par `[REDACTED]` dans `stdout` et
  `stderr` (`redact()` dans `run.route.js`). C'est un **filet contre la fuite
  accidentelle, pas une protection** : il ne resiste a aucune transformation
  demandee par une consigne hostile (base64, caracteres espaces, decoupage).
  Ne jamais s'en servir pour justifier un relachement ailleurs, et ne jamais
  le presenter comme un assainissement de la sortie.
- **Environnement du process `claude` reduit a une whitelist**
  (`server/routes/run.route.js`, `CHILD_ENV_KEYS`) : seules `PATH`, `HOME`,
  `LANG` et `CLAUDE_CODE_OAUTH_TOKEN` sont transmises au CLI. C'est une liste
  d'autorisation, donc toute variable ajoutee au serveur en est exclue par
  defaut.
  **Portee exacte — ne pas la surestimer** : c'est de la defense en
  profondeur, pas une barriere. Elle ferme le chemin evident (`env` dans une
  session claude), mais pas `cat /proc/1/environ`, puisque le serveur est
  PID 1 et que le CLI tourne sous le meme UID root. C'est le hachage de
  `SERVICE_TOKEN_HASH` qui traite reellement ce vecteur, pas cette liste.
  Rendre `/proc` inaccessible demanderait de lancer le CLI sous un UID
  distinct — envisage, pas fait (voir "En suspens").
- **`CLAUDE_CODE_OAUTH_TOKEN` est expose au CLI, par construction.** Il lui
  est transmis volontairement : le CLI en a besoin pour s'authentifier, a
  chaque appel, et un hachage ne conviendrait pas puisqu'il doit envoyer la
  vraie valeur a l'API Anthropic. Un `echo` suffit donc a le lire depuis une
  session. Aucun durcissement ne change ca — le traiter comme expose. Seule
  une architecture a proxy (le CLI pointe vers un composant local qui detient
  le token et signe les requetes) le retirerait de sa portee ; non verifie,
  voir "En suspens".
- **API compatible OpenAI : ecartee.** Plusieurs projets equivalents exposent
  un `/v1/chat/completions` pour que n'importe quel client parlant le dialecte
  OpenAI fonctionne sans adaptateur. Pas retenu ici : **le format ne
  correspond pas a ce que fait le service.** Ce n'est pas une completion de
  chat mais « execute un agent dans un espace de travail, avec ces outils, et
  nettoie apres ». Le schema OpenAI n'a de place ni pour `allowedTools`, ni
  pour `clear`, ni pour la notion d'espace de travail — il faudrait les faire
  passer dans des champs non standard, ce qui detruit la compatibilite
  recherchee. `/clear` n'a aucun equivalent. Et aplatir la reponse du CLI en
  un simple `content` jetterait l'usage des outils, le cout et l'identifiant
  de session.
  Raison de fond : un point d'acces compatible OpenAI **ressemble a un modele
  de chat**, alors qu'il y a un shell complet derriere — le dernier signal a
  envoyer vu le reste des decisions de ce fichier.
  Si un besoin concret apparait un jour (interface de chat, outil qui ne parle
  qu'OpenAI), ajouter un `/v1/chat/completions` mince **en plus** de `/run`,
  jamais a la place.
- **`DOCKER_NETWORK`** (variable d'env, voir `.env.example`) remplace un nom
  de reseau externe en dur : le projet est destine a un vrai serveur, ne pas
  exposer le nom de l'infrastructure reelle dans le repo.
  **Le reseau est declare `external: true`, donc il doit preexister** — il est
  partage entre plusieurs projets compose, et un reseau partage doit
  appartenir a quelqu'un : si ce projet le creait, un `docker compose down`
  ici pourrait le supprimer et casser l'appelant. Ce n'est pas une contrainte
  gratuite, c'est le schema standard des setups multi-compose. Le creer se
  fait une fois, avec `docker network create <nom>` — commande documentee
  dans le README, son absence etait un vrai manque.
  L'inverse (ce projet declare le reseau, l'appelant le rejoint en `external`)
  marcherait aussi ; le critere est de savoir lequel des deux est le plus
  susceptible d'etre detruit et reconstruit — et c'est ce container.

## Structure

Convention du projet : un dossier `server/` qui contient tout le backend,
routes montees directement dans `server/server.js` (`server.use('/x', ...)`),
pas de couche d'assemblage separee de type `app.js`. Meme si le projet est
simple aujourd'hui (3 routes), cette structure est gardee prete a accueillir
de la vraie logique metier (ex. plusieurs ressources) sans reorganisation.

- `server/server.js` — point d'entree : instance Express, middlewares,
  montage des routes, 404 catch-all, `listen`
- `server/middleware/auth.middleware.js` — verification du header
  `x-service-token`
- `server/routes/health.route.js` — `GET /health` (renvoie aussi si une
  requete claude est en cours)
- `server/routes/run.route.js` — `POST /run` : spawn du CLI claude, timeout
  configurable (`CLAUDE_TIMEOUT_MS`), modele choisissable par appel (champ
  `model`, defaut `CLAUDE_DEFAULT_MODEL`), nettoyage des repertoires
  ephemeres en fin d'appel (champ `clear`, defaut `true`), pose/liberation
  du verrou
- `server/routes/clear.route.js` — `POST /clear` : vide `/workspace` et
  `$HOME` sans lancer claude, pour repartir propre apres une serie d'appels
  en `"clear": false`
- `server/state/lock.js` — verrou "une requete a la fois" partage entre les
  routes `/run`, `/clear` et `/health`
- `server/state/storage.js` — chemins `/workspace` et `/root`, et `clearAll()`,
  partages par `/run` et `/clear`. **Ces chemins sont figes en dur et doivent
  correspondre exactement aux montages `tmpfs` de `docker-compose.yml`** :
  nettoyer a cote reviendrait a ecrire sur le disque sans s'en rendre compte.
  La fonction vide le **contenu** des repertoires, jamais les repertoires
  eux-memes : ce sont des points de montage, un `rmSync` dessus echoue en
  `EBUSY`, et les recreer donnerait des dossiers ordinaires sur la couche
  inscriptible du container — donc une persistance sur disque silencieuse.
  Ne pas "corriger" ca en un `rm -rf` suivi d'un `mkdir`.
- `claude-code.dockerfile` — image Node 20 + Claude Code CLI (version figee,
  ex. `2.1.273` — a monter volontairement, verifier le changelog avant) +
  git + Python 3 / pip (requests, pandas, numpy preinstalles) + ripgrep + jq
  - curl. **Ne rien installer dans `/root`** : il est monte en tmpfs, tout
    ce qui y serait cuit au build serait masque a l'execution. Tourne en root
    (pas de directive `USER`), donc `HOME=/root`.
- `docker-compose.yml` — service unique, reseau externe designe par
  `DOCKER_NETWORK`, `/workspace` (`size=512m`) et `/root` (`size=128m`) en
  tmpfs, `mem_limit: 1g`. Attention, les tmpfs sont de la RAM et comptent
  dans `mem_limit` : la somme des deux plus les process `node` et `claude`
  doit tenir dans la limite, en tenir compte avant d'agrandir un montage.
  Toute variable lue par le serveur doit etre listee dans le bloc
  `environment:` du service pour etre transmise au container — ne pas se
  contenter de l'ajouter a `.env.example`, docker compose ne propage pas
  automatiquement tout le `.env` au process du container. Le bloc
  `environment:` est un simple passe-plat : toujours `${VAR}` nu, jamais une
  valeur en dur (elle ecraserait silencieusement le `.env`) et pas non plus
  de `${VAR:-defaut}` (ca dupliquerait un defaut deja porte par le code).
  Repartition : `.env` = les valeurs, `docker-compose.yml` = la
  transmission, le code = le dernier recours si la variable est absente.
- `.env.example` — source de verite des variables configurables :
  `CLAUDE_CODE_OAUTH_TOKEN`, `SERVICE_TOKEN_HASH`, `DOCKER_NETWORK` et
  `CLAUDE_ALLOWED_TOOLS` obligatoires (le serveur refuse de demarrer sans) ;
  `CLAUDE_TIMEOUT_MS` a un defaut en dur dans le code (10 min) ;
  `CLAUDE_DEFAULT_MODEL` peut rester vide, le CLI choisit alors lui-meme —
  garder la ligne vide plutot que la commenter, sinon docker compose emet un
  warning au demarrage.
- `TEST.md` — journal des campagnes de test : date, modalites, tests executes
  et resultats. Des faits, pas une validation. Y ajouter une section par
  campagne plutot que d'ecraser la precedente.
- `.claude/agents/security-reviewer.md` — sub-agent de revue de securite
  (lecture seule), a invoquer avant tout changement touchant auth/reseau/
  secrets/Docker
- `.claude/agents/api-smoke-tester.md` — sub-agent qui lance le container et
  teste `/health` + `/run` (verrou, timeout, auth), a invoquer apres un
  changement dans `server/` ou la config Docker

## En suspens / a faire

- **Campagnes de test : voir `TEST.md`**, qui tient le journal (dates,
  modalites, resultats). Le point qui restait ouvert depuis le premier test
  manuel du 2026-09-17 — un `/run` juste apres un `/clear`, pour verifier que
  le CLI repart avec un `$HOME` vide sous lui — a ete execute le 2026-09-18 par
  `api-smoke-tester` et passe. Reste non couvert : le timeout et le `killGroup`
  associe, `redact()`, et le handler d'erreurs ajoute le 2026-09-18 (posterieur
  a la campagne).
- **A se souvenir si un bug de remplissage apparait : le tmpfs de `/root`
  (128 Mo) peut etre plus juste qu'il n'y parait.** Mesure reelle du
  2026-09-17 : **un seul appel trivial produit un transcript de 168 Ko**, soit
  228 Ko dans `$HOME` au total — bien plus que l'estimation faite a la
  conception. Sans consequence avec `clear: true` (defaut), qui remet a zero a
  chaque appel. Mais en enchainant des appels en `"clear": false`, les 128 Mo
  se remplissent en quelques centaines d'appels, et bien plus vite si les
  prompts manipulent de gros fichiers. Symptome attendu : echecs d'ecriture
  `ENOSPC` en milieu de chaine, sans avertissement prealable. Piste si ca
  arrive : agrandir le montage (en tenant compte de `mem_limit`, les tmpfs
  comptent dedans) ou intercaler des `/clear`.

- Avant de se fier a un flag de permission precis en production (ex.
  `--dangerously-skip-permissions`, `--permission-mode`), verifier ses noms
  exacts avec `docker compose exec claude-with-nodejs claude -p --help` :
  une recherche documentaire faite pendant la conception a remonte des
  informations contradictoires sur ces flags.
- **Lancer le CLI sous un UID distinct du serveur** (l'image `node:20-slim`
  fournit deja un utilisateur `node`, uid 1000 ; le serveur resterait root en
  PID 1, seul l'enfant changerait d'UID via les options `uid`/`gid` de
  `spawn`). Gains : `/proc/1/environ` devient illisible pour le CLI, Claude ne
  peut plus reecrire le code du serveur dans `/app` ni tuer PID 1. Coup :
  `$HOME` ne peut plus etre `/root`, il faut le deplacer (ex. `/home/node`),
  donner les bons `uid=` aux montages tmpfs, et ajuster `HOMEDIR` dans
  `storage.js`. Reporte volontairement : ca touche des chemins tout juste
  stabilises et demande un container qui tourne pour retester.
- **Retirer `CLAUDE_CODE_OAUTH_TOKEN` de la portee du CLI via un proxy** qui
  detiendrait le token et signerait les requetes (`ANTHROPIC_BASE_URL`
  pointant vers un composant local). **Non verifie** : on ne sait pas si un
  token OAuth d'abonnement fonctionne a travers une base URL personnalisee,
  et ca ajoute un composant a maintenir. A creuser avant toute decision.
- **Points du rapport de securite non traites**, a arbitrer :
  - `stdout` est accumule en memoire sans plafond : une sortie volumineuse
    (provoquable depuis le prompt) pese sur les ~380 Mo restants apres les
    tmpfs et peut declencher l'OOM killer.
- **Handler d'erreur Express : traite le 2026-09-18.** `server.js` se termine
  par un handler a 4 arguments qui loggue la trace cote serveur et ne renvoie
  qu'un JSON sobre. Motivation : `express.json()` est monte **avant** l'auth
  (il le faut, les routes ont besoin de `req.body`), et un body JSON malforme
  y leve une `SyntaxError` passee a `next(err)` — ce qui saute toute la chaine
  restante, donc le middleware d'auth. Le chemin etait donc atteignable **sans
  token** (reproduit a l'execution, voir `TEST.md`), et le handler par defaut
  d'Express joint `err.stack` tant que `NODE_ENV !== 'production'`, variable
  definie nulle part ici. Ce qui fuyait etait mineur (l'arborescence `/app`,
  jamais un secret ni le contenu de `/workspace`) mais c'etait le seul chemin
  ou la propriete « le middleware est global, donc tout est protege par
  defaut » ne tenait pas. Corrige dans le code plutot que par `NODE_ENV`, pour
  ne pas dependre d'une variable d'environnement qu'un autre deploiement
  pourrait oublier.
- **Evaluer le Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) a la place
  du `spawn` du CLI.** C'est la bibliotheque officielle : Claude Code
  empaquete en dependance, au lieu de lancer le binaire et de parler avec lui
  par tuyaux. A creuser **avant** d'attaquer l'item session ci-dessous : les
  deux se resolvent probablement ensemble.
  _Avantages attendus_ — rendrait inutiles plusieurs correctifs actuels
  plutot que necessaires : plus de construction de tableau d'arguments (donc
  la question de l'injection d'arguments disparait), plus de `stdin` a
  fermer, plus de `stdout` accumule a la main, plus de groupe de process a
  tuer, gestion de session native. Erreurs typees au lieu d'un code de sortie
  et de `stderr` a parser.
  _Inconvenients et inconnues_ — c'est une reecriture du coeur de
  `run.route.js`, a ne pas lancer avant que le service ait tourne au moins
  une fois ; la version se fige-t-elle aussi proprement que
  `@anthropic-ai/claude-code@2.1.273` ? le verrou et le nettoyage
  `/workspace` + `$HOME` restent-ils pertinents tels quels ? le SDK
  expose-t-il un equivalent de `allowedTools` et du `cwd` ?
  _Ce qui est deja verifie_ (recherche documentaire, septembre 2026) :
  `arktnld/claude-code-api` fait exactement ca — wrapper HTTP bati sur le
  SDK — et son README indique qu'il fonctionne **avec l'abonnement Pro/Max
  sans cle API**, et qu'il gere des **sessions nommees avec reprise
  automatique**. Donc ni la contrainte d'authentification ni la reprise de
  session ne sont des obstacles. README lu, code non audite.
  Autres projets comparables reperes, utiles comme points de comparaison :
  `nomadictuba2005/claude-code-api`, `bethington/claude-code-api`,
  `csdwd/claude-code-server` (wrappers CLI comme ici),
  `johnlindquist/n8n-nodes-claudecode` (noeud n8n direct, sans couche HTTP ni
  container : approche inverse de celle retenue ici).
- **Rester sur une meme session d'un appel a l'autre.** Objectif : enchainer
  plusieurs `/run` dans la meme conversation, au lieu d'une session neuve a
  chaque fois. Etat de la reflexion :
  - _Mecanisme_ : la sortie `--output-format json` du CLI contient un
    identifiant de session, qu'on repasserait au CLI via un flag de reprise.
  - _Faisabilite_ : plus une inconnue. **Verifie a l'execution le 2026-09-17** :
    un `/run` reel renvoie bien un champ `session_id` dans le JSON du CLI, donc
    la brique de base existe cote sortie. Par ailleurs
    `arktnld/claude-code-api` fait de la reprise de session en headless (voir
    l'item SDK ci-dessus). Reste a savoir sous quelle forme on la redonne au
    CLI en entree.
  - _A verifier avant tout code_ : le nom exact du flag et surtout s'il
    fonctionne en mode `-p` (headless) — la reprise est peut-etre reservee au
    mode interactif. Voir le point precedent sur les flags.
  - _Couplage_ : les fichiers de session vivent dans `$HOME`, que
    `clear: true` (le defaut) efface. Une session ne survit donc qu'entre des
    appels faits avec `"clear": false`.
  - _Forme envisagee_ : un champ `session` dans le body de `/run` plutot
    qu'une nouvelle route, et l'identifiant **porte par l'appelant** (il est
    deja dans la reponse que recoit l'appelant) plutot qu'un etat global cote
    serveur. Une session unique cote serveur ferait heriter silencieusement
    au workflow B le contexte du workflow A — pas un plantage, des reponses
    contaminees, bien pires a deboguer.

## Utilisation

**Voir `README.md`** : installation, variables obligatoires, champs du body
de `/run`, routes et codes de reponse y sont documentes en detail.

Ce fichier-ci ne repete pas le mode d'emploi : il porte les _decisions_ et
leurs raisons. Quand le comportement change, mettre a jour les deux — le
README pour le "comment l'utiliser", CLAUDE.md pour le "pourquoi c'est
comme ca".
