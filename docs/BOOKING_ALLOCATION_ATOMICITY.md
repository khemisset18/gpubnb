# Atomicité réservation ↔ allocation

## Problème identifié

Plusieurs composants peuvent changer le statut d’une réservation : API HTTP, worker de livraison, métriques Agent, règlement et tâches de maintenance. Une synchronisation réalisée uniquement dans un service TypeScript peut être oubliée par l’un de ces chemins.

Conséquences possibles avant cette correction :

- réservation `FUNDED` avec allocation encore `HELD` ;
- réservation `ACTIVE` sans allocation `ACTIVE` ;
- réservation terminée avec GPU ou machine encore verrouillé ;
- conflits artificiels et ressources orphelines.

## Garantie retenue

La synchronisation est imposée au niveau PostgreSQL par le trigger `Booking_resource_allocation_sync`. Toute modification de `Booking.status`, quelle que soit son origine, entraîne dans la même transaction la transition des allocations associées.

| Booking | Allocation |
|---|---|
| `AWAITING_DEPOSIT` | `HELD` |
| `FUNDED`, `STARTING` | `CONFIRMED` |
| `ACTIVE`, `DEGRADED` | `ACTIVE` |
| `COMPLETED`, `SETTLED`, `REFUNDED` | `RELEASED` |
| `CANCELLED` | `CANCELLED` |

## Sécurité et concurrence

- verrou transactionnel PostgreSQL par machine ;
- mise à jour machine et GPU dans la transaction qui change la réservation ;
- transitions terminales horodatées avec `releasedAt` ;
- répétition sans effet secondaire dangereux ;
- aucune résurrection d’une allocation terminale si un statut est déplacé en arrière ;
- les contraintes d’exclusion PostgreSQL continuent d’empêcher les chevauchements.

L’allocation initiale reste créée explicitement lors de l’acceptation de la réservation. Le trigger synchronise ensuite son cycle de vie et protège tous les écrivains présents et futurs.
