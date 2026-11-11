# GPUbnb — Plan de données autonomes sans API payante

Vérifié le 11 novembre 2026. **Aucune donnée de fournisseur externe ne doit être recopiée sans licence vérifiée**.

## Décision

**Notre propre moteur et notre propre base GPU/CPU** est la seule option retrouvée qui minimise réellement les dépendances et les obligations de redevances pour un comparateur public. Elle n'est **pas** intégralement gratuite à opérer (serveurs, stockage, énergie, mesures, maintenance) et ne peut pas fournir instantanément les revenus en EUR de toutes les cryptos sans cours de marché.

## Sources étudiées et limites

- **CoinCalculators** (https://coincalculators.io/api/) : API sans clé, annoncée gratuite, mise à jour ~5 minutes et sans rate limit actuellement. Mais le site déclare utiliser WhatToMine et CoinGecko ; absence de licence publique claire pour réexposer leur donnée dans GPUbnb. **Pas de reprise en production sur cette base.**
- **CoinGecko** (https://support.coingecko.com/articles/1043089972-what-are-the-differences-between-commercial-and-custom-licenses) : l'offre gratuite/keyless ne donne pas les droits commerciaux ; redistribution soumise à licence spécifique. **Ne pas contourner via un proxy gratuit.**
- **D-Central** (https://d-central.tech/data/api/) : vraies données libres sous CC BY 4.0, mais surtout ASIC Bitcoin, **attribution obligatoire** ; hors cible principale GPU/CPU et incompatible avec le souhait « sans aucune obligation ».
- **XMRig** (https://github.com/xmrig/xmrig) : mineur/benchmark CPU RandomX open source (GPL), peut servir de référence de mesure, mais licence logiciel à respecter en cas de distribution/modification. Pas de réutilisation automatique de sa base communautaire sans vérification de droits.
- **Monero** (https://docs.getmonero.org/rpc-library/monerod-rpc/) : difficulté, récompense, horodatage accessibles directement depuis *son propre nœud*. Sans acheter des droits sur une base externe.

## Architecture choisie

1. **GPUbnb Benchmarks** (nous sommes producteurs des données) : matériel, identifiant GPU/CPU, architecture, algorithme, hashrate en H/s, watts mesurés, version outil/driver, date, durée, taille échantillon. Mesurer sur nos machines, puis contributions **expressément consenties**. Conserver la provenance et assurer la transparence. Ne pas publier d'identifiants personnels sans consentement.
2. **GPUbnb Network Observers** : nœuds blockchain auto-hébergés pour un sous-ensemble maîtrisé de coins PoW. Un adaptateur par protocole, révisions, reorgs, récompenses, difficulté et taux d'orphelins. Aucun prix donné automatiquement par ces nœuds.
3. **GPUbnb Calculator** : hashrate mesuré × probabilité de récompense calculée selon le protocole ; valeur en coins/jour, mois/30, an/365. Estimer séparément pool et électricité.
4. **GPUbnb Market Prices** : si nous n'avons pas une source de prix sous licence adéquate, afficher **quantité en coin** et un **cours en EUR saisi par l'utilisateur**. Ne jamais afficher « temps réel EUR » quand le prix est manuel.
5. **Bons indicateurs UX** : « réseau mis à jour », « benchmark observé », « prix manuel », « données manquantes », « estimation théorique ». Jamais de 0 fictif ou de promesse de bénéfice garanti.

## Prototype implémenté

- `lib/monero-direct.mjs` : moteur original XMR/RandomX à partir d'une réponse `get_last_block_header`.
- `tools/monero-local.mjs` : interrogation **loopback** d'un `monerod` local, aucun fournisseur/API payante.
- `tests/monero-direct.test.mjs` : cinq cas vérifiant le calcul théorique, les gains facultatifs en EUR, les erreurs et les données périmées.
- `docs/MINAGE_AUTONOME_MONERO.md` : exécution et limitations.

**Attention :** le prototype n'active pas le flux JSON public, ne modifie pas l'interface validée et n'a pas de nœud Monero déployé. Il n'offre encore aucun chiffre live réel au public.

## Ordre raisonnable des étapes

- **Étape A** : proposer un benchmark manuel H/s + W + durée afin de pouvoir utiliser les observations locales sans rien installer sur les utilisateurs.
- **Étape B** : exécuter un vrai nœud Monero sur une infrastructure autorisée, tester trois snapshots et documenter le vieillissement de la difficulté/récompense.
- **Étape C** : produire, avec consentement, des benchmarks pour les 10 CPU/GPU les plus recherchés, en distinguant le matériel et l'algorithme.
- **Étape D** : ajouter RVN puis ETC / ERG avec adaptateurs propres au protocole et de vrais tests.
- **Étape E** : seulement si nécessaire, accepter des données sous une licence commerciale réellement compatible, ou rester sur conversion EUR manuelle.
- **Étape F** : tests publics, validation et **demande d'autorisation explicite avant fusion**.

## Conclusion juridique et économique

Être libre de frais d'abonnement n'est **pas** être libre de droit, de charges d'exploitation ou d'obligation de licence. Notre production originale est la meilleure façon d'éviter de devoir une redevance de données à autrui. Pour une dépendance totalement nulle, ne pas redistribuer de logiciel sous licence tierce, de bases tierces, ni de prix d'échanges commerciaux. Cette politique limite nécessairement la couverture initiale.
