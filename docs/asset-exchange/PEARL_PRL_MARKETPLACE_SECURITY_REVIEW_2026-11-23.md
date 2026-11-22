# Pearl PRL — audit de sécurité des brouillons d'offres (23 novembre 2026)

**Statut :** QUALIFICATION LOGICIELLE PARTIELLE / NON DÉPLOYABLE / MARKETPLACE_ONLY / RESTRICTED  
**Dépôt :** `khemisset18/gpubnb`  
**Branche :** `experiment/pearl-prl-marketplace-draft-security-20261123`  
**Base :** `experiment/pearl-prl-offline-preflight-20261122` (PR Pearl n° 391)

## Décision de sécurité

Ce lot ajoute **uniquement un laboratoire local de brouillons PRL/DOGE en mémoire**. Il simule la création, l'affichage privé, l'annulation et l'expiration de **données publiques fictives**. **Il n'implémente ni une API d'offres, ni une publication réelle, ni une transaction, ni une fonctionnalité de règlement.**

Toutes les sorties gardent `actorAuthenticated=false`, `networkIdentityVerified=false`, `realExchangeListingCreated=false`, `qualified=false`, `canPostOffer=false`, `canTakeOffer=false`, `canFund=false`, `canSign=false`, `canBroadcast=false`, `canSettle=false`, `automaticSettlementSupported=false`.

Aucun module du registre de capacités, aucune route de production, aucun code DOGE/LTC et aucun portefeuille n'a été modifié.

## Périmètre vérifié

- `asset-exchange/qualification/pearl/marketplace_draft_lab.py` : `SyntheticDraftLedger`, objet par processus, verrou `RLock`, données immuables internes, JSON PRL précédemment contrôlé et exact, séparation de domaine.
- `test_marketplace_draft_lab.py` : **47 méthodes adversariales nouvelles**, vérifiées dans le sandbox local du développeur et dans un `unshare --user --map-root-user --net`, sans processus blockchain ni réseau.
- `demo_marketplace_drafts.py` : demonstration locale utilisant **uniquement la fixture publique**, sortie JSON du brouillon et de son annulation, sans service ni offre postée.
- Les **47 tests Pearl précédents** ont déjà été confirmés sur Ubuntu WSL2 au commit `a4f66faf45de253c7ed1067fbc041b4c6792301a`.
- **Total combiné attendu sur le PC après récupération de cette branche : 94 méthodes.** Le nouveau total **n'est pas encore confirmé sur l'Ubuntu de l'opérateur**. Aucun chiffre de couverture de lignes n'est revendiqué.

### Commandes de test hors ligne

Depuis la racine du clone isolé de cette branche, dans Ubuntu WSL2 :

```sh
PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net \
  python3 -m unittest discover -s asset-exchange/qualification/pearl -p 'test_*.py' -v
PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net \
  python3 asset-exchange/qualification/pearl/demo_marketplace_drafts.py
```

Résultats attendus : **94 tests puis OK**, démonstration avec `DRAFT_PREVIEW_ONLY` et `CANCELLED_PREVIEW_ONLY`, et toutes autorisations financières à `false`.

### Provenance du code testé localement

Empreintes de blobs Git comparées après publication :

- `marketplace_draft_lab.py` : `51d1525d8658c5a02af96a2c2b28138adb35cc43`
- `test_marketplace_draft_lab.py` : `f7eaa26ac9700ced8db519fcb5d727d722806ead`
- `demo_marketplace_drafts.py` : `b94da2f0fa890a3226e314346e69f3f8b57afe48`

**Cette correspondance ne remplace pas une revue de code indépendante, une CI signée ou un test sur la machine de l'opérateur.**

## Modèle de menace et limites (STRIDE)

| Menace | Mesure du laboratoire | Blocage réel avant toute API |
|---|---|---|
| **S — Usurpation** | `actor_label` de démonstration validé au format ASCII ; opérations restreintes au même label | **CRITIQUE : le label provient de l'appelant et ne prouve PAS l'identité**. Une vraie API devrait déduire l'identité exclusivement d'une session authentifiée et autorisée côté serveur. |
| **T — Altération** | Schéma JSON exact, refus des doublons, bornes des montants, checksum canonique de l'intention, révision obligatoire pour annuler | **ÉLEVÉ :** SHA-256 non authentifiant, absence de signature de termes et d'ancrage fiable ; aucun mécanisme financier n'est qualifié. |
| **R — Répudiation** | Clés de commande idempotentes et révisions pour rejouements de test | **ÉLEVÉ :** absence de journal d'audit durable, horodaté et infalsifiable ; aucune preuve d'acceptation par l'utilisateur. |
| **I — Divulgation** | Consultation et annulation refusées à un autre label, erreur `draft unavailable` identique pour absent/étranger, copies de résultats | **CRITIQUE si exposé :** sans authentification réelle, le label peut être usurpé. Ne pas brancher sur une API publique. |
| **D — Déni de service** | Quota 4 brouillons par label, 128 globalement, durée de vie fictive bornée, format/tailles refusés | **ÉLEVÉ :** quotas par processus, absence de rate limiting distribué, purge durable et anti-Sybil. Le quota retient aussi les brouillons annulés. |
| **E — Élévation de privilège** | Aucun point d'entrée publier/acheter/financer/signer/diffuser ; tous indicateurs financiers `false` | **CRITIQUE :** ne jamais brancher ce composant au routeur financier sans audit, autorisations par action et contrôle de la matrice d'activation. |

## Contrôles adversariaux testés

- PRL et réseau `regtest` fixés par `offline_preflight`; MTN, mainnet, mauvais domaine et nouveaux champs refusés.
- JSON UTF-8 malformé, doublons de clés, montants faux ou trop grands, valeurs booléennes à la place des entiers et permissions activées refusés.
- Pas d'accès à un brouillon d'un autre label ; erreur uniforme même lorsqu'il n'existe pas.
- Rejeu d'une commande identique sans nouveau brouillon ; rejeu avec montants ou expiration différents refusé.
- Annulation avec numéro de révision ; ancienne révision, double annulation différente et autre propriétaire refusés.
- Horloge logique de test : création à expiration impossible ; expiration représentée sans publication ; retour avant la création refusé.
- Quotas par propriétaire et globaux ; tests de concurrence sur création et annulation.
- Résultats rendus sous forme de copies ; une mutation du dictionnaire retourné n'accorde aucun droit.
- Test d'absence d'I/O pendant les opérations ; aucun nœud, socket, wallet, émission ou signature.

## Risques résiduels à corriger avant une vraie marketplace

1. **Authenticator / session Exchange** (P0 pour l'offre réelle) : session à identité vérifiée, MFA selon politique, liaison serveur identifiant de l'acteur, autorisation par objet et par action, lutte contre le vol de session. `actor_label` fictif INTERDIT sur une route publique.
2. **Horloge et révisions** : horloge serveur fiable, délais métiers bornés, contrôle atomique transactionnel de version, rejeux inter-processus et après redémarrage.
3. **Persistance/contrôle de charge** : base Exchange indépendante de Core, migrations, transactions ACID, contraintes uniques d'idempotence, quotas globaux et rate limit distribués, journal d'audit rétentif.
4. **Identité des actifs** : référence exacte `pearl-mainnet-native` et quote-chain, pas seulement `PRL` ou `DOGE` ; preuve indépendante d'appartenance du réseau. L'adresse `rprl` désigne **regtest ou simnet**, et ne prouve pas un réseau.
5. **Montants et prix** : confirmation indépendante de l'unité atomique PRL, précision par actif, règles d'arrondi, absence de taux inventé, politiques anti-manipulation d'offres.
6. **Publication et interface** : API non financière réellement authentifiée et autorisée, validation côté serveur, protection CSRF/CORS/XSS/CSP, confidentialité, contrôles de spam et modération, UI indiquant que **le règlement n'est pas pris en charge**.
7. **Chaîne, récupération et règlement** : tous les gates Pearl P0–P9 nécessitant provenance, consensus natif, frais, récupérabilité, sources indépendantes, signer et audit restent **BLOQUÉS/DIFFÉRÉS** et ne peuvent être remplacés par les tests de ce module.

## Verdict

**Laboratoire de brouillons PRL : contrôles de sécurité logiciels locaux PASS (47 nouvelles méthodes), soumis à vérification WSL2.**  
**Marketplace PRL en production : NON IMPLEMENTÉE / NON AUTORISÉE.**  
**Règlement et fonds : NON QUALIFIÉS ; `MARKETPLACE_ONLY` et `automaticSettlementSupported=false` maintenus.**

Ce lot doit rester en **PR brouillon**, sans activation ni fusion vers un runtime financier. L'objectif est d'obtenir d'abord une base de code testable et un inventaire transparent des blocages, pas de créer une fausse garantie de production.
