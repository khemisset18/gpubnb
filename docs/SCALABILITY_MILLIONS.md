# Architecture GPUbnb pour une montée à l'échelle massive

## Cible

La plateforme doit pouvoir évoluer progressivement de quelques milliers à plusieurs millions de comptes sans réécriture brutale. Le nombre d'utilisateurs inscrits n'est pas la seule mesure importante : il faut dimensionner séparément les connexions simultanées, les machines en ligne, les réservations actives, les événements de télémétrie par seconde et les opérations financières.

## Principes obligatoires

1. Les API HTTP restent stateless et peuvent être répliquées horizontalement.
2. PostgreSQL reste la source de vérité transactionnelle pour les utilisateurs, réservations, paiements et états de sécurité.
3. Redis ne contient que des données reconstructibles : limitation de débit, verrous courts, sessions temporaires et caches.
4. Les traitements lourds et les commandes destinées aux hôtes passent par une file durable, avec accusé de réception et nouvelle tentative bornée.
5. Toute opération financière ou de réservation est idempotente.
6. Les listes utilisent une pagination par curseur, jamais un offset profond.
7. Les télémétries volumineuses ont une rétention bornée et sont agrégées avant archivage.
8. Aucun service ne dépend d'une mémoire locale pour une donnée métier indispensable.
9. Une panne régionale ne doit jamais provoquer un double paiement, une double réservation ou la perte d'une preuve d'usage.

## Domaines de services

### Identité et comptes

- authentification, sessions, appareils et récupération de compte ;
- limitation de débit par compte, adresse IP et empreinte d'appareil ;
- stockage séparé des secrets et rotation des clés.

### Catalogue GPU

- lectures fortement mises en cache ;
- index de recherche séparé du système transactionnel ;
- invalidation par événements après modification d'une annonce.

### Réservations

- transaction sérialisée par annonce et fenêtre temporelle ;
- clé d'idempotence obligatoire ;
- verrou distribué court uniquement comme optimisation, jamais comme seule protection ;
- contrainte en base contre les doubles réservations.

### Paiements et règlement

- journal append-only des changements financiers ;
- aucun calcul monétaire en virgule flottante ;
- outbox transactionnelle pour publier les événements après validation en base ;
- consommateurs idempotents ;
- rapprochement périodique avec le réseau de paiement.

### Contrôle des machines

- partitionnement logique par `machineId` ;
- une seule commande active par machine ;
- ordre garanti par machine, mais parallélisme entre machines ;
- commandes signées, expirables et protégées contre le rejeu.

### Télémétrie

- ingestion asynchrone par lots bornés ;
- partitionnement temporel de `Heartbeat`, `WorkspaceMetric` et `UsageSample` ;
- conservation courte des métriques brutes ;
- conservation longue des preuves de facturation agrégées ;
- export vers stockage objet pour les audits historiques.

## Étapes de capacité

### Palier 1 — Jusqu'à 100 000 comptes

- API stateless derrière un répartiteur de charge ;
- PostgreSQL haute disponibilité avec réplicas de lecture ;
- Redis redondé ;
- file de messages durable ;
- stockage objet pour logs et artefacts ;
- tableaux de bord de saturation et alertes SLO.

### Palier 2 — Jusqu'à 1 million de comptes

- séparation des déploiements API, workers et ingestion ;
- partitionnement des grosses tables de télémétrie ;
- cache distribué du catalogue ;
- lecture du catalogue sur réplicas ;
- autoscaling sur débit et profondeur de file ;
- tests de charge réguliers avec scénarios de panne.

### Palier 3 — Plusieurs millions de comptes

- routage régional ;
- données personnelles localisées selon les obligations réglementaires ;
- partitionnement des domaines volumineux par région ou clé stable ;
- catalogue et télémétrie multi-régions ;
- réservations et paiements conservant une autorité transactionnelle clairement définie ;
- reprise après sinistre testée et documentée.

## Budgets de protection

- pages API : 50 éléments par défaut, 200 maximum ;
- traitements par lot : 500 éléments maximum ;
- télémétrie brute heartbeat : 14 jours ;
- métriques workspace brutes : 30 jours ;
- preuves de facturation : au moins 400 jours ;
- événements d'audit : au moins 730 jours ;
- délais, nouvelles tentatives et coupe-circuits obligatoires pour tous les appels externes.

## Critères avant une annonce de capacité

GPUbnb ne doit jamais annoncer pouvoir supporter un million d'utilisateurs uniquement parce que la CI est verte. Il faut disposer de mesures reproductibles :

- débit soutenu et débit de pointe ;
- latence p50, p95 et p99 ;
- taux d'erreur ;
- profondeur maximale des files ;
- temps de reprise après panne ;
- absence de double réservation et de double paiement ;
- coût par utilisateur actif et par machine connectée ;
- test de charge avec au moins dix fois la charge quotidienne moyenne attendue.
