# Journal de test — `claude-with-nodejs`

Ce fichier consigne les campagnes de test executees sur le service. Il rapporte
des **faits** (commandes lancees, codes HTTP, sorties observees). Conformement a
la regle de validation de `CLAUDE.md`, aucune campagne ne vaut validation : la
decision de deployer revient a l'utilisateur, explicitement.

---

## Campagne du 2026-09-18

### Modalites

|                    |                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Date**           | 2026-09-18                                                                                                                                                                                |
| **Execute par**    | Sub-agent Claude Code `api-smoke-tester` (`.claude/agents/api-smoke-tester.md`), invoque manuellement depuis le chat                                                                      |
| **Environnement**  | Windows 11, Docker 29.7.2, Docker Compose v5.4.0                                                                                                                                          |
| **Duree**          | ~6 min, 18 tests du scenario                                                                                                                                                              |
| **Secret utilise** | Empreinte de **test jetable**, generee pour la session. Le `SERVICE_TOKEN_HASH` de production n'a jamais ete lu ni utilise ; le fichier du secret de test a ete efface en fin de campagne |
| **Reseau**         | Reseau externe `DOCKER_NETWORK` deja existant, non recree par le test, et verifie toujours present apres le `down`                                                                        |
| **Cloture**        | `docker compose down --rmi local --remove-orphans` — container supprime, image `claude-with-nodejs:dev` supprimee, reseau externe intact (0 container attache)                            |

### Demarrage

| #   | Test                                       | Resultat                                                                                                                                                                                                                       |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `.env` : les 4 variables obligatoires      | **OK** — `CLAUDE_CODE_OAUTH_TOKEN`, `SERVICE_TOKEN_HASH` (64 car.), `CLAUDE_ALLOWED_TOOLS`, `DOCKER_NETWORK` presentes et non vides. `CLAUDE_DEFAULT_MODEL` presente et vide, conforme a `.env.example`                        |
| 2   | Build + `up -d` avec le durcissement actif | **OK** — build passe, etat `Up`, 0 restart, `OOMKilled=false`. Log : `Serveur demarre sur le port http://localhost:8787`. `cap_drop: ALL`, `no-new-privileges` et `pids_limit: 512` n'ont gene ni le demarrage ni aucun `/run` |
| 3   | `GET /health` sans auth                    | **OK** — `{"ok":true,"busy":false}` `[200]`                                                                                                                                                                                    |

### Authentification

| #   | Test                                              | Attendu | Obtenu                                                           |
| --- | ------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| 4   | `/run` sans header `x-service-token`              | 401     | **401**                                                          |
| 5   | `/run` avec un mauvais secret                     | 401     | **401**                                                          |
| 6   | `/run` en presentant l'**empreinte** comme secret | 401     | **401** — connaitre `SERVICE_TOKEN_HASH` ne permet pas d'appeler |
| 7   | `/clear` sans header                              | 401     | **401**                                                          |
| 8   | `GET /chemin-inconnu` sans token                  | 404     | **401** — voir ecart ci-dessous                                  |

**Ecart T8 — comportement, pas defaut.** Le middleware d'auth est monte
globalement et n'exempte que `/health` : il repond donc avant le catch-all 404.
Avec un token valide, `GET /chemin-inconnu` renvoie bien
`{"error":"introuvable"}` `[404]`. C'est conforme a la decision documentee dans
`CLAUDE.md` ; c'est l'attendu du scenario de test qui etait a corriger, pas le
code.

### Joignabilite reseau

Testee **depuis un autre container** du reseau (`docker run --rm --network
<DOCKER_NETWORK> curlimages/curl`), sur le nom de service
`claude-with-nodejs:8787` — donc pas seulement en loopback interne :

- `GET /health` -> `{"ok":true,"busy":false}` `[200]`
- `POST /run` -> `[200]`, `result: "CREE"`
- `POST /run` pendant un verrou -> `[409]`

Resolution DNS du nom de service et appartenance au reseau verifiees.

### Fonctionnement nominal

| #   | Test                          | Resultat                                                                                                 |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| 9   | `/run` avec un prompt trivial | **OK** — `[200]` en 2,7 s, `is_error:false`, `subtype:"success"`, `result:"PONG."`, `session_id` present |
| 10  | `/clear` avec le bon secret   | **OK** — `{"cleared":true}` `[200]`, `/workspace` et `/root` a 0 entree                                  |

### Point prioritaire : `/run` juste apres `/clear`

Ce cas etait signale dans `CLAUDE.md` comme **jamais teste** — le premier point
a controler. **Il passe.**

Sequence : `/clear` -> verification directe dans le container que `/workspace`
et `$HOME` contiennent **0 entree** -> `POST /run`.

Resultat : `[200]` en 3,5 s, `is_error:false`, `subtype:"success"`,
`num_turns:1`, `result:"REPART-OK."`, `session_id` present. Rien en `stderr`,
rien dans les logs du container. Le CLI recree bien son etat sous un `$HOME`
vide.

**Mesure au passage** : apres cet appel unique, `/root` contient `.claude` et
`.claude.json` pour **216 Ko** — coherent avec les 228 Ko notes dans
`CLAUDE.md`, et donc avec l'alerte sur le remplissage des 128 Mo en chaine
`"clear": false`.

### Verrou

| #   | Test                       | Attendu | Obtenu                                                              |
| --- | -------------------------- | ------- | ------------------------------------------------------------------- |
| 11  | 2e `/run` concurrent       | 409     | **409** `{"error":"une requete claude est deja en cours..."}`       |
| 12  | `/clear` pendant un `/run` | 409     | **409**                                                             |
| 13  | `busy` apres la fin        | `false` | **`{"ok":true,"busy":false}`**, le 1er `/run` ayant fini en `[200]` |

`/health` signalait bien `busy:true` pendant l'appel long.

### Champ `clear`

| #   | Test                                                                                       | Resultat                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 14  | `clear:false` cree `MARQUEUR-A.txt`, puis 2e `/run` en `clear:false` qui liste             | **OK** — le CLI liste `MARQUEUR-A.txt`, confirme par un `ls` direct dans le container                                        |
| 15  | `/clear` puis `/run` qui liste                                                             | **OK** — `ls` direct : `[]`, le CLI repond `VIDE`                                                                            |
| 16  | `/run` **sans** champ `clear` (defaut `true`) cree `MARQUEUR-B.txt`, puis `/run` qui liste | **OK** — verification directe juste apres l'appel : `/workspace -> []` **et** `/root -> []`. Le `/run` suivant repond `VIDE` |

Montages confirmes en tmpfs, tailles conformes a `docker-compose.yml` :
`tmpfs on /root ... size=131072k,mode=700` et
`tmpfs on /workspace ... size=524288k`.

### Robustesse — regression connue du verrou

| #   | Test                                      | Attendu | Obtenu                                                                                                          |
| --- | ----------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| 17a | `{"prompt":"ok","model":123}`             | 400     | **400** `champ "model" doit etre une string` — puis `busy:false`, et le `/run` suivant repond `[200]` `"A-OK."` |
| 17b | `{"prompt":"ok","allowedTools":["Bash"]}` | 400     | **400** `champ "allowedTools" doit etre une string` — puis `busy:false`, `/run` suivant `[200]` `"B-OK."`       |
| 18  | `/run` sans `prompt`                      | 400     | **400** `champ "prompt" (string) requis` — puis `busy:false`, `/run` suivant `[200]` `"C-OK."`                  |

La regression « le verrou reste pose apres un `400` » **ne se reproduit pas**.

### Verifications hors scenario

**Gardes fail-closed** — les deux declenchent, le process refuse de demarrer :

- `SERVICE_TOKEN_HASH` = un secret de 128 car. -> `SERVICE_TOKEN_HASH absent ou
mal forme : impossible de demarrer. Attendu : un sha256 en hexadecimal (64
caracteres)...`
- `CLAUDE_ALLOWED_TOOLS` vide -> `CLAUDE_ALLOWED_TOOLS manquant : impossible de
demarrer (voir .env.example)`

**Stack trace Express, reproduite sans authentification.** `POST /run` avec un
JSON tronque (`{"prompt":`) et **sans aucun token** renvoyait `[400]` avec une
page HTML contenant la trace complete :

```
SyntaxError: Unexpected end of JSON input
    at parse (/app/node_modules/body-parser/lib/types/json.js:96:19)
    at /app/node_modules/body-parser/lib/read.js:128:18
    at invokeCallback (/app/node_modules/raw-body/index.js:238:16)
```

Cause : `express.json()` est monte avant l'auth (il le faut, les routes ont
besoin de `req.body`) ; un body malforme y leve une `SyntaxError` passee a
`next(err)`, ce qui saute toute la chaine restante — donc le middleware d'auth —
et atterrit sur le handler par defaut d'Express, qui joint `err.stack` tant que
`NODE_ENV !== 'production'`. Aucun secret ni contenu de `/workspace` n'etait
expose, et aucune route n'etait executee : la fuite se limitait a l'arborescence
`/app`.

**Corrige le meme jour**, apres la campagne : `server/server.js` se termine
desormais par un handler d'erreurs a 4 arguments qui loggue la trace cote
serveur et ne renvoie qu'un JSON sobre. **Ce correctif n'a pas ete reteste** :
il est posterieur a l'execution ci-dessus, et le container a ete detruit a la
cloture. A couvrir a la prochaine campagne.

### Non teste

- Le correctif du handler d'erreurs ci-dessus.
- Le timeout `CLAUDE_TIMEOUT_MS` et le `killGroup` sur timeout — aucun appel
  n'a atteint la limite.
- Le champ `model` avec une valeur **valide**, et `allowedTools` avec une
  chaine **valide** — seuls les cas invalides figuraient au scenario.
- La fonction `redact()` sur `stdout`/`stderr`.
- Le comportement en charge et le remplissage des tmpfs.
- La topologie reseau reelle (le container ne doit pas pouvoir initier une
  connexion vers l'appelant) : propriete de l'infrastructure, pas verifiable
  depuis le repo.

### Bilan factuel

18 tests du scenario executes : **17 conformes a l'attendu**, 1 ecart de
comportement (T8, coherent avec la conception documentee). Le point prioritaire
`/run` apres `/clear` passe. Deux observations reproduites relevaient d'items
deja connus de `CLAUDE.md` — la stack trace non authentifiee (depuis corrigee,
non retestee) et la taille des transcripts dans `$HOME`.
