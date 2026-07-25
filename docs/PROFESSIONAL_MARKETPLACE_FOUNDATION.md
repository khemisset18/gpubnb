# Fondation marketplace professionnelle GPUbnb

## Objectif

Le marketplace doit représenter les ressources physiques réellement louables, et non réduire une machine à un seul GPU. La hiérarchie produit est :

- un Host possède une ou plusieurs machines ;
- chaque machine possède zéro, un ou plusieurs accélérateurs ;
- une offre peut porter sur la machine complète, sur un sous-ensemble précis de GPU, ou sur un pool de calcul déclaré ;
- une réservation verrouille les ressources physiques exactes utilisées pendant sa période.

## Modèle cible

### Host

Le Host gère son identité, ses machines, ses offres, ses disponibilités et ses réservations.

### Machine

Une machine décrit le système hôte : CPU, RAM, stockage, système d’exploitation, connectivité, état opérationnel et capacités d’isolation.

### Accélérateur

Chaque GPU ou accélérateur est une ressource indépendante avec :

- identifiant stable ;
- UUID matériel ;
- modèle et constructeur ;
- VRAM totale ;
- pilote et version CUDA ;
- état de sécurité ;
- état de disponibilité ;
- historique des changements matériels.

### Offre

Une offre commerciale ne doit pas être confondue avec l’inventaire physique. Elle référence une machine et définit un mode de ressource :

1. `FULL_MACHINE` : toute la machine et tous ses accélérateurs louables ;
2. `SELECTED_ACCELERATORS` : un ou plusieurs GPU physiques explicitement sélectionnés ;
3. `COMPUTE_POOL` : une capacité déclarée avec minimum et maximum d’accélérateurs, soumise à allocation au moment de la réservation.

### Allocation de réservation

Une allocation enregistre les GPU physiques exacts affectés à une réservation, avec début, fin et éventuelle libération anticipée. Deux allocations actives du même GPU ne peuvent jamais se chevaucher.

## Contraintes obligatoires

- Une offre ne peut sélectionner que des GPU appartenant à sa machine.
- Un GPU en quarantaine, absent ou non vérifié ne peut pas être publié.
- Une réservation de machine complète verrouille tous les GPU publiables de la machine.
- Une réservation partielle verrouille uniquement les GPU alloués.
- Le verrouillage doit être garanti par PostgreSQL, pas uniquement par le code applicatif.
- Les allocations sont conservées pour l’audit même si l’offre est modifiée plus tard.
- Toute mutation d’offre ou d’allocation doit vérifier que l’utilisateur est propriétaire de la machine.
- Les migrations doivent rester additives tant que l’ancien modèle est encore exploité.

## API cible

### Inventaire Host

- `GET /machines/:machineId/accelerators/manage`
- `GET /dashboard/host/resources`

### Offres

- `POST /marketplace/offers`
- `PATCH /marketplace/offers/:offerId`
- `POST /marketplace/offers/:offerId/publish`
- `POST /marketplace/offers/:offerId/unpublish`
- `GET /marketplace/offers`
- `GET /marketplace/offers/:offerId`

### Disponibilité et allocation

- `POST /marketplace/offers/:offerId/quote`
- `POST /bookings/:bookingId/allocate`
- `POST /bookings/:bookingId/release`

## Tableau de bord Host

Le tableau de bord doit afficher par machine :

- état en ligne ou hors ligne ;
- CPU, RAM et stockage ;
- liste des GPU ;
- VRAM totale et disponible ;
- GPU libres, réservés, loués ou bloqués ;
- offres utilisant chaque GPU ;
- prochaine réservation ;
- alertes de pilote, Docker, runtime NVIDIA ou changement matériel.

## Tests d’acceptation

- création d’une offre machine complète ;
- création d’une offre avec un seul GPU ;
- création d’une offre avec plusieurs GPU ;
- refus d’un GPU appartenant à une autre machine ;
- refus d’un GPU non vérifié ;
- prévention de deux réservations qui se chevauchent sur le même GPU ;
- autorisation de réservations simultanées sur deux GPU différents de la même machine ;
- verrouillage de tous les GPU lors d’une réservation complète ;
- libération anticipée sans perte de l’historique ;
- concurrence réelle avec deux transactions PostgreSQL simultanées ;
- migration réussie sur une base vide et sur une base contenant des offres historiques.

## Découpage recommandé

1. Schéma Prisma et migration additive.
2. Service d’allocation transactionnel et tests PostgreSQL.
3. API Host de création et gestion des offres.
4. API publique de recherche et devis.
5. Tableau de bord Host par machine et GPU.
6. Parcours de réservation et règlement par ressources allouées.

## Règle de livraison

Aucune migration marketplace ne doit entrer dans `main` tant que `prisma migrate deploy`, les tests de concurrence et le rollback documenté ne sont pas validés par la CI.
