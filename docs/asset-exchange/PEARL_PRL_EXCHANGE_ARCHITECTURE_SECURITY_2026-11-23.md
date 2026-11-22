# Architecture de sécurité — Pearl PRL dans Asset Exchange (2026-11-23)

**Périmètre strict : Asset Exchange uniquement. Aucune modification hors Exchange, aucun déploiement, aucune activation financière.**

Branche : experiment/pearl-prl-architecture-hardening-20261123
Base : experiment/pearl-prl-marketplace-draft-security-20261123 (PR #392).

## 1. Architecture réellement présente

Les README G5 sont historiques : le code d'Asset Exchange possède déjà des frontières concrètes.

- asset-exchange/api/src/routes.mjs : routes de consultation des actifs, sessions, offres, annulations, acceptations et administration.
- asset-exchange/api/src/session.mjs : authentification par cookie de session et CSRF.
- asset-exchange/api/src/offer-service.mjs : validation de termes, identité d'acteur, vérificateur externe de signature puis dépôt.
- asset-exchange/api/src/postgres-offer-repository.mjs : opérations PostgreSQL transactionnelles.
- asset-exchange/db/migrations/002_atomic_offer_operations.sql et 003_atomic_offer_publish.sql : fonctions atomiques.
- asset-exchange/core/src/asset-registry.mjs : identité des actifs et capacités.

La présence de code n'est PAS une preuve de déploiement, d'authentification réelle, d'audit indépendant ou d'activation.

## 2. Corrections proposées

**A1 — Confusion du ticker PRL (moyen).** Le registre Exchange associait Pearl à « PEARL ». Le ticker natif est PRL. Correction dans le registre Exchange uniquement, sans alias MTN. L'identifiant pearl-mainnet-native reste inchangé.

**A2 — Capacités excessives par défaut (élevé).** La fonction générique de catalogue marketplace() donnait newOffersEnabled=true à l'actif Pearl malgré identityReady=false. Le constructeur reçoit une option ciblée conservant le comportement des autres actifs ; Pearl est maintenant newOffersEnabled=false, tandis que marketplaceEnabled=true permet encore la consultation des métadonnées.

**A3 — Pas de garde PRL à la limite du service d'offres (élevé).** Le vrai offer-service.mjs a reçu assertPearlOfferExposureGate : dans les deux positions giveAsset/wantAsset, toute identité de la chaîne pearl doit correspondre exactement à un enregistrement qualifié pour les offres, sans trade/settlement automatique. Dans l'état présent l'enregistrement Pearl n'est pas qualifié, donc toute publication PRL échoue AVANT vérification de signature et avant écriture au dépôt. Aucune signature, transaction ou serveur n'est nécessaire pour le test.

## 3. Tests et preuve attendue

Le fichier asset-exchange/qualification/pearl/test_prl_exchange_gate.mjs contient **10 tests Node.js** de politique : ticker, statut/permissions PRL, non-régression BTC, refus des variantes de réseau et de famille, rejet dans les deux sens de l'offre, absence d'appel au vérificateur ou dépôt et invariance des données.

Les **94 tests Python PRL précédents sont confirmés sur Ubuntu WSL2** au commit 9c685cc. Les **10 nouveaux tests Node.js sont ajoutés mais PAS ENCORE exécutés sur le poste de l'opérateur**.

Commande sans réseau, depuis le dépôt Exchange PRL isolé :

    PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net python3 -m unittest discover -s asset-exchange/qualification/pearl -p 'test_*.py' -q
    unshare --user --map-root-user --net node --test asset-exchange/qualification/pearl/test_prl_exchange_gate.mjs
    unshare --user --map-root-user --net node --test asset-exchange/core/test/asset-registry.test.mjs

Il n'y a pas eu d'exécution Node attestée à cette étape. Ne PAS afficher 104 PASS sans résultat.

## 4. Risques résiduels (bloquants)

- **CRITIQUE : acceptation d'offres historiques.** Le chemin acceptOfferAtomic PostgreSQL référence l'offre stockée par ID/hash/epoch. Les éventuelles offres Pearl préexistantes ne sont PAS qualifiées par le nouveau garde de publication. Une future politique d'acceptation doit vérifier l'identité exacte et les capacités des deux actifs dans une opération atomique, y compris pour les anciennes lignes, avant toute activation.
- **ÉLEVÉ : identité de chaîne Pearl.** Le HRP rprl est partagé entre regtest et simnet. Ni ticker ni adresse seule ne prouvent l'identité réseau.
- **ÉLEVÉ : authentification, stockage et exposition.** Sessions/CSRF et fonctions PostgreSQL existent dans les sources, mais leur déploiement, leurs permissions réelles, les migrations et l'indépendance de l'infrastructure ne sont pas certifiés par cette revue.
- **ÉLEVÉ : spoofing et ambiguïtés.** Les actifs inconnus/imitant PRL et les règles d'affichage doivent faire l'objet d'une validation de l'identité canonique, et jamais d'un match par symbole.
- **BLOQUÉ :** consensus natif, frais, escrow, récupération indépendante, signer matériel, revue externe et toute opération financière.

Le modèle de brouillons Python antérieur reste NON DÉPLOYABLE (identifiants d'acteurs fictifs et horloge contrôlée par l'appelant). Ne pas créer de deuxième API d'offres parallèle : sécuriser d'abord le code Exchange réel et ses frontières.

**Décision : PRL MARKETPLACE_ONLY / RESTRICTED ; identityReady=false ; newOffersEnabled=false ; newTradesEnabled=false ; automaticSettlementSupported=false ; route de règlement nulle. PR brouillon, sans fusion ni activation.**
