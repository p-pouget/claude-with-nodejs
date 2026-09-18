# claude-with-nodejs

Container Node.js qui expose Claude Code CLI en HTTP, pour l'appeler depuis
n'importe quel client — n8n, un script, un autre service — sans passer par des
commandes manuelles dans un terminal. Rien dans le code n'est specifique a un
appelant : c'est une requete HTTP avec un header.

Le repertoire de travail (`/workspace`) **et** le `$HOME` du CLI vivent en RAM
(`tmpfs`) : ce que Claude y ecrit ne touche jamais le disque de l'hote et
disparait a l'arret du container. Le reste du systeme de fichiers reste
inscriptible en revanche, et ce qui y serait ecrit persiste.

## 1. Obtenir le token

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token
```

Un lien s'ouvre dans le navigateur, se connecter avec le compte Claude
(abonnement Pro/Max), le token s'affiche dans le terminal, le coller dans
`.env`. Valable 1 an, pas de renouvellement automatique. Le CLI peut etre
desinstalle en local ensuite, seul le token compte.

## 2. Configurer

```bash
cp .env.example .env
```

Quatre variables sont **obligatoires** — le serveur refuse de demarrer si
`SERVICE_TOKEN_HASH` ou `CLAUDE_ALLOWED_TOOLS` manque :

| Variable                  | Role                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `CLAUDE_CODE_OAUTH_TOKEN` | authentification du CLI (etape 1)                            |
| `SERVICE_TOKEN_HASH`      | **empreinte** du secret partage exige sur chaque appel       |
| `CLAUDE_ALLOWED_TOOLS`    | outils autorises par defaut (ex. `Read,Edit,Bash,Grep,Glob`) |
| `DOCKER_NETWORK`          | nom du reseau docker externe                                 |

Deux variables optionnelles : `CLAUDE_TIMEOUT_MS` (defaut 10 min) et
`CLAUDE_DEFAULT_MODEL` (laisser vide = le CLI choisit lui-meme, mais garder
la ligne, sinon docker compose emet un warning au demarrage).

### Le secret partage : generer le hash

Le serveur ne stocke que l'**empreinte** du secret, jamais le secret lui-meme :
il n'a besoin que de _verifier_ le token qu'on lui presente. Une lecture de son
environnement ne rend donc rien d'exploitable.

Une seule commande genere les deux valeurs (pas de risque de desynchronisation) :

```bash
node -e "const c=require('crypto'),t=c.randomBytes(64).toString('hex');console.log('secret (a garder !) :',t);console.log('SERVICE_TOKEN_HASH  :',c.createHash('sha256').update(t).digest('hex'))"
```

Sortie :

```
secret (a garder !) : 4f2a9c...e71b    <- 128 caracteres
SERVICE_TOKEN_HASH  : 8b1e07...3d4a    <- 64 caracteres
```

Les deux valeurs ne vont **pas** au meme endroit :

| Valeur      | Taille   | Destination                                                                                       |
| ----------- | -------- | ------------------------------------------------------------------------------------------------- |
| l'empreinte | 64 car.  | ligne `SERVICE_TOKEN_HASH=` du `.env`                                                             |
| le secret   | 128 car. | la configuration de l'appelant (header `x-service-token`) **et** un gestionnaire de mots de passe |

Le secret ne va **jamais** dans le `.env` : c'est precisement ce qui fait qu'on
ne peut pas le voler au serveur. Il n'est stocke nulle part cote serveur, donc
perdu = a regenerer (et a remplacer des deux cotes).

Coller le secret de 128 caracteres dans `SERVICE_TOKEN_HASH` par erreur fait
refuser le demarrage, avec un message qui nomme cette confusion — pas d'auth
cassee silencieusement.

Verifier plus tard qu'un secret correspond bien a l'empreinte du `.env` :

```bash
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" LE_SECRET
```

### Le reseau docker

Le reseau designe par `DOCKER_NETWORK` doit **deja exister** : il est partage
entre plusieurs projets compose (celui-ci et celui de l'appelant), et un
reseau partage doit appartenir a quelqu'un. Si ce projet le creait, un
`docker compose down` ici pourrait le supprimer et casser l'appelant. D'ou le
`external: true` dans `docker-compose.yml` : « ce reseau est gere ailleurs, je
m'y branche ».

Le creer une fois :

```bash
docker network create XXX
```

Puis renseigner `DOCKER_NETWORK=XXX` dans `.env`. L'appelant peut alors
joindre le container par son nom : `http://claude-with-nodejs:8787`.

Le nom est en variable d'environnement, et non en dur dans le repo, pour ne pas
y exposer le nom de l'infrastructure reelle.

**Ce reseau doit etre dedie**, pas le reseau plat ou tournent les autres
services — voir « Isolation reseau » plus bas. C'est un prerequis
d'infrastructure : le repo ne peut pas l'imposer.

## 3. Lancer

```bash
docker compose up -d --build
```

Apres toute modification du `.env`, un `docker compose restart` ne suffit
pas : les variables sont fixees a la creation du container.

```bash
docker compose up -d
```

## 4. Appeler le service

POST `http://claude-with-nodejs:8787/run`

Headers :

```
x-service-token: <le secret en clair, pas son empreinte>
Content-Type: application/json
```

Body :

```json
{
  "prompt": "Ecris un script Python qui liste les nombres premiers < 100",
  "allowedTools": "Read,Edit,Bash",
  "model": "sonnet",
  "clear": true
}
```

| Champ          | Obligatoire | Defaut                 | Role                                           |
| -------------- | ----------- | ---------------------- | ---------------------------------------------- |
| `prompt`       | oui         | —                      | la consigne envoyee au CLI                     |
| `allowedTools` | non         | `CLAUDE_ALLOWED_TOOLS` | outils autorises pour cet appel                |
| `model`        | non         | `CLAUDE_DEFAULT_MODEL` | ex. `sonnet`, `opus`, `haiku`, ou un ID precis |
| `outputFormat` | non         | `json`                 | format de sortie du CLI                        |
| `clear`        | non         | `true`                 | vider les repertoires ephemeres en fin d'appel |

La reponse est le JSON brut du CLI, transmis tel quel.

### Le champ `clear`

C'est lui qui decide si un appel repart d'un espace vierge ou herite du
precedent.

- **`true` (defaut)** — apres la reponse, le contenu de `/workspace` et de
  `$HOME` est supprime. L'appel suivant repart d'un espace de travail vide et
  d'un CLI sans historique.
- **`false`** — tout est conserve. A utiliser pour **enchainer plusieurs
  appels sur un meme espace de travail** (un appel prepare des fichiers, le
  suivant les exploite), puis appeler `/clear` a la fin.

Le nettoyage a lieu avant la liberation du verrou, donc un appel concurrent
ne peut pas se faire supprimer ses fichiers en cours de route. Les process
laisses en arriere-plan par le CLI sont tues avant le nettoyage, pour qu'ils
ne puissent pas reecrire dans un espace qu'on vient de vider.

**Portee exacte** — a lire avant de compter dessus comme cloisonnement :
`clear` vide ces **deux repertoires uniquement**. Tout ce qui est ecrit
ailleurs dans le container (`/tmp`, `/var/tmp`, `/app`...) survit au
nettoyage, n'est pas en tmpfs, et atterrit donc sur le disque de l'hote.
Ce n'est pas une frontiere etanche entre deux appels : c'est un nettoyage des
emplacements de travail. Si le nettoyage echoue partiellement, l'appel
renvoie quand meme le resultat du CLI et l'echec part dans les logs du
container (`docker compose logs`).

## 5. Les autres routes

**POST `/clear`** — vide `/workspace` et `$HOME` sans lancer le CLI. Sert a
repartir propre apres une serie d'appels en `"clear": false`. Exige le meme
header `x-service-token`. Pas de body. Renvoie `{"cleared": true}`.

**GET `/health`** — **seule route sans authentification**. Renvoie
`{"ok": true, "busy": false}`, `busy` indiquant si un appel au CLI est en
cours.

## Codes de reponse

| Code  | Quand                                                            |
| ----- | ---------------------------------------------------------------- |
| `400` | champ `prompt` absent ou non-string, ou champ optionnel mal type |
| `401` | header `x-service-token` absent ou invalide                      |
| `409` | un appel au CLI est deja en cours (un seul a la fois)            |
| `500` | le CLI a echoue, ou n'a pas pu etre lance                        |
| `404` | route inconnue                                                   |

Un `409` n'est pas une erreur a corriger : c'est le comportement normal du
verrou. Prevoir un retry cote appelant.

## Stack incluse dans l'image

Node.js (CLI Claude Code, version figee), git, Python 3 + pip avec
requests/pandas/numpy preinstalles, ripgrep, jq, curl. Comme rien ne
persiste, toute dependance dont Claude aurait besoin doit etre ajoutee ici,
dans le Dockerfile, avant le build. Un `pip install` fait pendant une
session fonctionne mais disparait avec le container a la fin, comme tout le
reste.

## Restrictions du container

Claude dispose de Bash dans sa session. La question n'est donc pas « est-ce
qu'on lui fait confiance » mais **« d'ou viennent ses instructions »** : du
contenu scrape, c'est du texte ecrit par des inconnus, qui peut contenir des
consignes cachees. Les reglages ci-dessous limitent ce qu'une telle consigne
permettrait d'obtenir.

| Reglage              | Ce que ca empeche                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cap_drop: [ALL]`    | retire tous les pouvoirs speciaux de root (sockets brutes pour ecouter le trafic, changement de proprietaire, montages). Reduit surtout la surface des failles d'evasion de container, qui en dependent presque toutes |
| `no-new-privileges`  | empeche de gagner des droits via un binaire setuid (`su`, `sudo`)                                                                                                                                                      |
| `pids_limit: 512`    | arrete une bombe a fork, qui saturerait la table des PID et pourrait deborder sur l'hote                                                                                                                               |
| `mem_limit: 1g`      | plafonne la memoire, tmpfs inclus                                                                                                                                                                                      |
| `cpus: "2"`          | empeche un script lance par Claude de saturer les coeurs de l'hote                                                                                                                                                     |
| pas de `ports:`      | le service n'est joignable que depuis le reseau docker interne                                                                                                                                                         |
| `SERVICE_TOKEN_HASH` | le secret n'existe nulle part dans le container : lire son environnement ne rend qu'une empreinte inexploitable                                                                                                        |

Aucun de ces reglages n'affecte l'usage normal — le port 8787 est au-dessus
de 1024, et git, python, pip et node n'ont besoin d'aucune capability. En
revanche un `apt-get install` a chaud ne fonctionnera pas : les dependances se
mettent dans le Dockerfile, avant le build.

### Ce qui n'est volontairement pas restreint

Choix assume, a ne pas « corriger » sans y avoir reflechi : **les capacites de
Claude restent entieres.** Bash n'est pas retire de `allowedTools`, la sortie
reseau du container n'est pas bloquee, le rootfs n'est pas en lecture seule.

Pourquoi : Bash est ce qui rend le service utile — lancer des scripts,
manipuler des fichiers, enchainer des traitements. Le retirer ne durcirait pas
le service, ca le viderait. Et le gain serait partiel de toute facon, puisque
le canal de reponse resterait ouvert (voir plus bas).

Le risque n'est pas la puissance de Claude, c'est **du texte non fiable qui
atteint un agent puissant**. Il se traite donc aux extremites, sans rien lui
retirer :

- **en entree** — encadrer clairement le contenu scrape comme une donnee a
  traiter, plutot que le coller brut au milieu des instructions
- **en sortie** — ne pas rebrancher la reponse dans une etape qui execute ou
  envoie
- **en perimetre** — l'isolation reseau ci-dessous, qui limite les degats

**Ce qui reste expose, et qu'aucun de ces reglages ne corrige :**
`CLAUDE_CODE_OAUTH_TOKEN` est transmis au CLI **volontairement** — il en a
besoin pour s'authentifier, a chaque appel, et un hash ne conviendrait pas
puisqu'il doit envoyer la vraie valeur a l'API. Un `echo` suffit donc a le
lire depuis une session. Le considerer comme expose : utiliser si possible un
token dedie a ce container, sachant qu'il se revoque et se regenere avec
`claude setup-token`.

### Isolation reseau (prerequis de deploiement)

Les reglages du tableau protegent contre l'**evasion** du container. Ils ne
protegent pas contre l'usage _normal_ du reseau : une injection de prompt
donne un shell qui peut joindre tout ce qui est accessible depuis le
container. Or un orchestrateur comme n8n detient les credentials de tout ce
qui y est connecte (bases, API, comptes mail) — un butin qui vaut
probablement plus que le token Claude.

Le reseau `DOCKER_NETWORK` doit donc etre **dedie** : l'appelant peut joindre
`claude-with-nodejs:8787`, mais le container ne doit pas pouvoir initier de
connexion vers lui ni vers les autres services. Cela se definit a la creation
du reseau, cote infrastructure — `docker-compose.yml` rejoint un reseau
existant et ne peut pas imposer sa topologie.

### La reponse est aussi un canal de fuite

Meme sans acces internet, une consigne cachee peut faire terminer la reponse
de Claude par le contenu d'une variable d'environnement. Le secret part alors
dans les donnees du workflow appelant et dans ses logs.

Couper la sortie reseau ne suffit donc pas, et la consequence est cote
appelant : **ne jamais injecter la sortie de `/run` telle quelle dans une
etape qui execute, requete ou envoie quelque chose.** La traiter comme une
saisie utilisateur non fiable, parce que c'est exactement ce qu'elle est des
lors que le prompt contient du contenu scrape.

### Filtrage de la sortie (filet, pas protection)

Avant de repondre, le serveur remplace par `[REDACTED]` les secrets du serveur
s'ils apparaissent **tels quels** dans la sortie du CLI — sur `stdout` comme
sur `stderr`, y compris dans les reponses d'erreur.

|                   |                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Attrape**       | la fuite accidentelle : le CLI lance `env` pour deboguer et recopie la sortie                                             |
| **N'attrape pas** | toute transformation : un tiret entre chaque caractere, du base64, la chaine inversee, un decoupage en plusieurs morceaux |

Une correspondance exacte tombe des qu'on la transforme, et transformer du
texte est precisement ce que le CLI sait faire le mieux. **Ce filtre ne doit
donc rien changer a l'evaluation du risque** : il ne rend pas la sortie
assainie, et il ne remplace ni l'isolation reseau, ni la regle ci-dessus sur
la facon de rebrancher la reponse.

## A savoir

- **Un seul appel a la fois**, impose par un verrou en memoire. Pas de file
  d'attente : une deuxieme requete pendant qu'une premiere tourne recoit un
  `409`.
- **`/run` peut executer des commandes shell arbitraires** via l'outil Bash :
  ne jamais exposer ce endpoint sans authentification, ni hors du reseau
  docker interne. Aucun port n'est publie vers l'hote, c'est volontaire.
- **Les tmpfs consomment de la RAM** et comptent dans `mem_limit` (1 Go) :
  `/workspace` (512 Mo) et `/root` (128 Mo) partagent ce budget avec les
  process `node` et `claude`. En tenir compte avant d'agrandir un montage.
- **`allowedTools` n'est pas un bac a sable.** Une fois Bash autorise, la
  liste ne limite pas ce qu'il peut faire ; la vraie protection vient du
  container et des tmpfs.
- Verifier les noms exacts des flags de permission avec
  `docker compose exec claude-with-nodejs claude -p --help` avant de se fier
  a un flag en production.

---

<sub>**API compatible OpenAI : ecartee.** Plusieurs projets equivalents
exposent un `/v1/chat/completions`. Pas retenu ici : le service n'est pas une
completion de chat mais l'execution d'un agent dans un espace de travail. Le
schema OpenAI n'a de place ni pour `allowedTools`, ni pour `clear`, ni pour
`/clear` ; et il ferait passer pour un modele de chat un point d'acces qui a
un shell complet derriere. A reconsiderer seulement si un client ne parlant
qu'OpenAI devient necessaire — en ajout de `/run`, pas a sa place.</sub>
