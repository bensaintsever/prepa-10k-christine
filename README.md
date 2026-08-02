# Préparation 10 km · Christine · Octobre Rose 2026

Objectif : **10 km en moins d'une heure** le dimanche 4 octobre 2026 (cible 59'30, repli 1 h 02).
Plan sur 11 semaines, construit à partir de l'analyse de foulée (zebris) et des données Pixel Watch 4.

## Contenu

| Fichier | Rôle |
|---|---|
| `Christine_10K_Tracker.html` | Le **tracker** : 11 semaines à cocher (cases mémorisées dans le navigateur). |
| `Christine_10K_Carnet.html` | Le **carnet** : le pourquoi du plan, allures, muscu, foulée, sécurité. |
| `Christine_10K_Tracker.pdf` | Tracker imprimable (1 page, à afficher). |
| `Christine_10K_Carnet.pdf` | Carnet imprimable (4 pages). |
| `index.html` | Page d'accueil (liens vers tracker + carnet), sert de landing GitHub Pages. |
| `sync.js` | Synchronisation Supabase du tracker (hors-ligne d'abord). |
| `sw.js` | Service worker : c'est lui qui rend la PWA réellement utilisable hors ligne. |
| `supabase/migrations/0001_sessions.sql` | Schéma de la table `sessions` + policies RLS (placeholders). |
| `supabase/policies.local.sql` | Policies avec les vraies adresses — **hors dépôt** (`.gitignore`). |
| `supabase/migrations/0005_sessions_annotations.sql` | Note, distance réalisée, date de report. |
| `tests/sync.test.js` | Tests de la réconciliation local/distant (`node tests/sync.test.js`). |
| `tests/dates.test.js` | Tests de la dérivation des dates de séance. |
| `tests/state.test.js` | Tests de la migration d'état et de la saisie (distance, report). |
| `data/2026-07-23_5k.tcx` | Trace du test 5 km du 23 juillet. |
| `data/zebris_bilan_2025-08-20.pdf` | Bilan podologique (analyse de pression, Posturosports). |

## Consulter

- En local : ouvre `index.html` dans un navigateur.
- En ligne : active **GitHub Pages** (Settings → Pages → branche `main`, dossier `/root`).
  L'URL affichera automatiquement `index.html`.

## Synchronisation entre appareils (Supabase)

Le tracker mémorise la progression dans le navigateur (`localStorage`) et la synchronise
via Supabase, pour que les cases cochées sur le téléphone de Christine remontent sur les
autres appareils. Le compte Claude et le compte Supabase sont partagés entre Benjamin et
Christine — c'est ce qui rend une base commune pertinente.

### État au 2 août 2026

| Étape | Statut |
|---|---|
| Schéma `sessions` + index + trigger + RLS écrits | fait (`0001_sessions.sql`) |
| Couche de synchro hors-ligne d'abord | fait (`sync.js`) |
| Câblage dans le tracker (pastille, panneau de connexion) | fait |
| Tests de réconciliation (5 scénarios, 10 assertions) | fait, verts |
| Migration appliquée dans Supabase | fait (table, index, trigger, RLS) |
| Policies appliquées (variante B, adresses réelles) | fait |
| Table publiée dans `supabase_realtime` (synchro en direct) | fait |
| Site URL + Redirect URL déclarées dans le dashboard | fait |
| `CONFIG` rempli dans `sync.js` | fait (URL + clé publique) |
| RLS vérifiée par appel REST réel | fait — voir ci-dessous |
| Rendu vérifié dans un vrai navigateur | fait (Chrome, panneau + pastille) |
| **Comptes créés dans Authentication → Users** | **à faire** |
| **Aller-retour authentifié entre deux appareils** | **jamais fait** |

Vérification RLS du 2 août 2026, avec la clé publique et sans authentification :
`GET /rest/v1/sessions` renvoie `[]` en HTTP 200, et `POST` est rejeté en HTTP 401
avec le code `42501` (« new row violates row-level security policy »). Autrement dit,
quelqu'un qui trouve le dépôt et récupère la clé ne peut ni lire ni écrire.
C'est bien l'authentification qui ouvre l'accès, pas la clé.

Ce qui reste non vérifié est le comportement en conditions réelles : le rendu de la
pastille et du panneau de connexion dans un navigateur, et surtout le canal Realtime —
que les événements arrivent vraiment d'un appareil à l'autre ne se constatera qu'avec
deux sessions authentifiées ouvertes en parallèle.

### Ce qu'il reste à faire

1. ~~**SQL Editor** → exécuter `supabase/migrations/0001_sessions.sql`, puis
   `supabase/policies.local.sql`~~ — fait le 2 août 2026 via le serveur MCP,
   en quatre migrations : `0001_sessions`, `0002_sessions_policies`,
   `0003_touch_updated_at_search_path`, `0004_sessions_realtime`.
   La variante A reste commentée.
2. ~~**Authentication → URL Configuration**~~ — Site URL et Redirect URL déclarées
   le 2 août 2026. Devenues sans objet depuis le passage au mot de passe :
   `signInWithPassword` ne redirige pas. Laissées en place, elles ne gênent rien.
3. ~~**Settings → API** → remplir `CONFIG` en tête de `sync.js`~~ — fait le 2 août 2026.
   Clé retenue : la `sb_publishable_…` plutôt que l'ancien JWT `anon`, toujours valide
   mais en voie de remplacement. Ces deux valeurs sont publiques par conception : elles
   sont livrées au navigateur de quiconque ouvre la page, et rendre le dépôt privé n'y
   changerait rien. Ce qui protège la table, c'est la RLS.

4. **Authentication → Users → Add user** → créer les deux comptes avec
   **« Auto Confirm User » coché**, sinon `signInWithPassword` renvoie
   « Email not confirmed ». Les adresses doivent correspondre exactement à celles
   des policies, l'allowlist compare la chaîne du JWT.

**Il ne reste ensuite que la vérification en conditions réelles** : ouvrir le tracker
dans deux navigateurs authentifiés et confirmer qu'une case cochée d'un côté apparaît
de l'autre. Tant que ce n'est pas fait, ne pas donner le lien à Christine.

### Annotations de séance

Depuis le 2 août 2026, une séance n'est plus un booléen. Christine peut y attacher
une **note**, corriger la **distance réalisée** (le prévu et le réalisé diffèrent
souvent) et **reporter la séance** à un autre jour.

- Côté base : `note`, `distance_km`, `scheduled_on`, toutes nullables
  (`0005_sessions_annotations.sql`). `null` signifie « conforme au plan ».
- Côté client : l'état est passé de `{ "3_2": 1 }` à
  `{ "3_2": { done, note, km, date } }`. Le `localStorage` existant est migré au
  chargement — sans ça une progression déjà saisie serait relue comme vide.
- **Les dates sont déduites, pas saisies.** Le plan n'écrit qu'un jour de semaine
  (`"Mar."`, `"Jeu. 23"`) : `plannedDate()` en dérive une date réelle à partir de
  `WEEK_STARTS`. Les 17 étiquettes qui portent déjà un quantième servent d'oracle
  dans `tests/dates.test.js`.
- **Une séance reportée reste dans sa carte de semaine**, avec sa nouvelle date en
  rose et le prévu rappelé en infobulle. Le tracker suit un plan ; le faire migrer
  entre semaines rendrait les totaux hebdomadaires mouvants. En revanche les lignes
  sont **triées par date effective** à l'intérieur de la carte : sans ça une séance
  décalée du mardi au samedi resterait affichée avant le jeudi.
- **L'en-tête de semaine affiche le réalisé quand il diffère du prévu** (« 10,4 / 22 km »).
  Une séance faite compte sa distance corrigée si elle en a une, sinon celle du plan ;
  une séance non faite ne compte pas. C'est l'écart au plan qui est parlant.
- **Une note écrasée par l'autre appareil est signalée.** La réconciliation reste
  « dernier écrivain gagne », mais perdre un texte rédigé sans le dire n'est pas la
  même chose que perdre une case cochée. L'avertissement ne se déclenche que sur le
  cas réellement perdant : une note locale encore en attente d'envoi que le serveur
  remplace — pas une mise à jour distante ordinaire.
- **Décocher n'efface pas les annotations**, et « Réinitialiser » non plus : ce sont
  les seuls contenus écrits à la main, les perdre via un bouton intitulé « décocher »
  serait une destruction que rien n'annonce.

Deux pièges rencontrés, à ne pas réintroduire :

- Le champ distance est un `type="text"` avec `inputmode="decimal"`, **jamais un
  `type="number"`** : un input number rejette « 7,2 » et vide le champ en silence,
  alors que c'est ce que produit un clavier français. La virgule est convertie à
  l'enregistrement, et une saisie invalide est signalée au lieu d'être escamotée.
- L'ouverture de la feuille force un reflow au lieu d'utiliser
  `requestAnimationFrame`, que le navigateur bride quand l'onglet n'est pas rendu —
  la feuille resterait alors invisible.

### Hors-ligne : le service worker

Le manifeste rendait la PWA installable, mais **rien ne la rendait utilisable sans
réseau** : sans service worker, Christine obtenait la page d'erreur du navigateur.
Le stockage local de `sync.js` ne sert à rien si la page elle-même ne se charge pas.
Corrigé le 2 août 2026 (`sw.js`).

- **Les fichiers du site passent par le réseau d'abord**, le cache ne servant que de
  filet. Un « cache d'abord » servirait une logique périmée avec un chargement de
  retard et obligerait à bumper `CACHE` à chaque correction — inacceptable pour du
  code de synchronisation. Bumper `CACHE` ne sert plus qu'à évincer d'anciennes
  entrées.
- **Le client Supabase du CDN est mis en cache** en réponse opaque, sinon le tracker
  se chargerait hors ligne sans sa couche de synchronisation.
- **L'API Supabase n'est jamais mise en cache** : rejouer une réponse ferait croire à
  une synchronisation qui n'a pas eu lieu.
- Cycle vérifié de bout en bout : hors ligne la page se charge, une séance cochée
  part en file d'attente, et elle est poussée au retour du réseau.

Le `background_color` du manifeste est passé de `#F4F1F6` à `#0F0814` : l'écran de
démarrage flashait en blanc à chaque lancement depuis l'écran d'accueil.

### Navigation mobile

Le plan complet représentait **5,2 écrans de défilement** sur un téléphone.

- **Une semaine passée et terminée se replie d'office** sur son en-tête, qui porte
  déjà le code, le focus et le cumul — un résumé suffisant. Une semaine passée mais
  incomplète reste ouverte : c'est justement ce qu'il y a à voir. La semaine en cours
  n'est jamais repliée d'office. En fin de plan, dix semaines repliées ramènent la
  page de 5,2 à **2,6 écrans**.
- L'en-tête reste cliquable pour plier ou déplier à la main, et la dérogation est
  mémorisée dans `…_ui` — **volontairement hors de Supabase** : plier une semaine est
  un choix propre à l'appareil qu'on a en main, pas une donnée d'entraînement.
- Le défilement automatique vers la semaine en cours existait déjà et fonctionne
  (`scrollIntoView` au chargement) ; c'est la hauteur du contenu qui posait problème,
  pas le positionnement.

Deux défauts d'en-tête corrigés au passage, tous deux préexistants :

- `--shell-h` déclarait 56 px quand l'en-tête en mesurait 61 — et 83 px sous 400 px,
  où « 10K CHRISTINE » passait sur deux lignes. La barre de progression collante,
  calée sur cette variable, était donc **masquée sur 27 px** : le compteur de Christine
  était amputé. La hauteur est désormais contrainte à `--shell-h` plutôt que déduite
  du contenu, pour que la variable ne puisse plus mentir.
- Les onglets sont resserrés sous 720 px : marque et navigation réclamaient 396 px
  pour 390 disponibles, « Carnet » sortait de l'écran. La cible tactile reste à 36 px.

### Volume et jalons

- **La jauge compare le réalisé au prévu *à ce stade du plan***, pas au total des
  11 semaines — sinon l'écart serait toujours énorme en début de préparation et
  n'apprendrait rien. Une séance faite compte sa distance corrigée si elle en a une.
- Un ratio unique contre une cible est **une jauge, pas un graphique**. La figure
  héro de la page reste « OBJECTIF 59'30 » : la jauge est délibérément secondaire,
  et son chiffre porte l'encre de texte, pas la couleur de marque.
- **Le prochain jalon** est la prochaine séance clé non faite : test S4, 4 × 1000 m
  de la S7, verdict de la S9, puis la course.

### Décisions prises, et pourquoi

- **Une ligne par séance**, pas un blob JSON unique. Si Christine coche une case sur son
  téléphone pendant que Benjamin en coche une autre, un blob ferait perdre l'une des deux.
  Clé composite `(plan_id, session_id)`, `session_id` au format `"3_2"` = semaine S3,
  3ᵉ séance — exactement les identifiants déjà générés par le tracker.
- **Hors-ligne d'abord.** `localStorage` reste la source d'affichage, Supabase est une
  couche par-dessus. Sans ça, une séance cochée dans un parc sans réseau serait perdue —
  et la PWA installée sur l'écran d'accueil perdrait son intérêt.
- **Réconciliation : dernier écrivain gagne, séance par séance.** Chaque mutation locale
  est horodatée (`…_meta` dans `localStorage`) et comparée à `updated_at` côté serveur.
  Une séance en file d'attente dont la mutation locale est plus récente n'est jamais
  écrasée par une valeur serveur périmée.
- **Auth obligatoire** plutôt qu'accès anonyme. Le dépôt est public, donc la clé publique
  est visible : sans auth, la table serait ouverte en écriture à qui trouve le dépôt.
- **Mot de passe plutôt que magic link.** Le magic link avait été retenu d'abord, puis
  abandonné le 2 août 2026 : le SMTP partagé de Supabase plafonne à **2 mails par heure**,
  et ce plafond n'est déverrouillable qu'en configurant un SMTP personnalisé. Dépendre
  d'un service tiers à maintenir, pour deux utilisateurs qui se connectent une fois
  chacun, coûtait plus que ça ne rapportait. `signInWithPassword` n'envoie aucun mail :
  ni quota, ni SMTP, ni lien à cliquer. Les policies n'ont pas bougé — le JWT porte
  toujours `email`, donc l'allowlist des deux adresses fonctionne à l'identique.

### Pièges à connaître

- **Le dépôt est public.** Aucune adresse mail, clé secrète ou token ne doit y entrer.
  Les policies avec les vraies adresses vivent dans `supabase/policies.local.sql`,
  exclu par `.gitignore` (`*.local.sql`). Le fichier de migration committé ne contient
  que des placeholders.
- **Ne jamais lancer `supabase db pull` ici.** Les policies appliquées contiennent
  les vraies adresses : un `db pull` les réécrirait dans `supabase/migrations/`,
  suivi par git, donc publiées. La base est la référence pour les policies ;
  `policies.local.sql` sert à les rejouer.
- **La clé `service_role` / `secret key` ne doit jamais toucher ce projet** : elle
  contourne la RLS, et tout ce qui est dans `sync.js` finit dans un dépôt public.
- **Plan gratuit : projet mis en pause après 1 semaine sans activité.** Sans effet
  pendant la prépa (3-4 séances/semaine), mais le projet s'endormira après le 4 octobre.
  Réactivation en un clic, sans perte de données.
- **Realtime tient à deux réglages qui doivent rester d'accord** : `CONFIG.realtime`
  côté client, et l'appartenance de la table à la publication `supabase_realtime`
  côté base (dernière ligne de `0001_sessions.sql`, appliquée le 2 août 2026).
  Si l'un des deux saute, le canal se souscrit sans jamais rien recevoir, en
  silence — la synchro continue de marcher, mais seulement au chargement de la
  page. Pour couper le temps réel, couper les deux :
  `alter publication supabase_realtime drop table public.sessions;`

### Outillage

Serveur MCP Supabase configuré en scope `user` dans `~/.claude.json` :
`npx -y @supabase/mcp-server-supabase@latest --project-ref=hdrjoyrpczutjihnbbui`,
avec le token personnel en variable d'environnement. Il permet d'appliquer les migrations
et d'inspecter la base directement, sans passer par le dashboard.

Tests de la logique de réconciliation — la seule partie capable de corrompre
silencieusement la progression :

```bash
node tests/sync.test.js
```

## Journal des tests

| Date | Séance | Résultat | Cadence | Notes |
|---|---|---|---|---|
| 2026-07-03 | 10 km | 65'00 (6'32/km) | 160 | Allure très régulière. FC moy. 167, dérive 162→171. |
| 2026-07-23 | 5 km (test S0) | 30'40 (6'08/km), fin à 5'48/km | 167 | FC 164. Contact 314 ms, oscillation 9,9 cm, foulée 99 cm. Déjà plus rapide que l'allure objectif. |
| 2026-08-22 | 5 km (test S4) | … | … | Prochain jalon : recaler les allures. |
| 2026-09-08 | 4 × 1000 m à 6'00 (S7) | … | … | Métriques à l'allure de course, jambes fraîches. |
| 2026-09-24 | 5 × 1000 m à 6'00 (S9) | … | … | Séance verdict : 5/5 = sous-1h validé. |

## Idée directrice

La cadence est le fil rouge : passer les jambes de 160 vers ~171 pas/min en gardant la longueur
de foulée donne 6'00/km (59'59 sur 10 km), et c'est le même réglage qui protège l'aponévrose
plantaire et la bandelette (TFL, depuis mai 2026). Détails dans le carnet.

## À faire ensuite

- [ ] Reformuler la cible « cadence » : le test du 23/07 montre 167 pas/min à l'allure de course,
      donc la mécanique est déjà presque en place à vitesse, le vrai levier restant est la
      cadence *en endurance* + le temps de contact au sol + la base aérobie.
- [ ] Test S4 (22 août) → mettre à jour le journal et les allures.
- [ ] Finir la mise en route Supabase : migration + policies + `CONFIG` + Redirect URL
      (voir « Synchronisation entre appareils »), puis vérifier un aller-retour réel
      entre deux appareils avant de donner le lien à Christine.
