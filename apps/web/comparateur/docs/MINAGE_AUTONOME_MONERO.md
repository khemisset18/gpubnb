# GPUbnb — Première approche totalement autonome : calcul Monero depuis son propre nœud

Le calculateur actuel reste inchangé. Ce prototype ne branche pas encore de données dans la page publique.

## Ce que cette approche permet
- Calculer une estimation de XMR minables par jour à partir de la difficulté et de la récompense du dernier bloc, via *notre propre nœud monerod*.
- Ne demander aucune clé Minerstat, hashrate.no ou CoinCalculators.
- Utiliser un hashrate H/s réellement mesuré sur un processeur, un GPU compatible et un algorithme précis (RandomX), pas une supposition basée sur le modèle de matériel.
- Afficher la quantité théorique par jour, par mois de 30 jours, par an de 365 jours.
- Si un cours XMR/EUR est fourni **manuellement**, estimer les gains en euros après prix de l'électricité et frais de pool.

## Test local

Node.js 22 et un nœud Monero `monerod` synchronisé, avec RPC accessible uniquement sur `127.0.0.1:18081` (ne jamais exposer ce port publiquement).

```bash
node --test apps/web/comparateur/tests/monero-direct.test.mjs
node apps/web/comparateur/tools/monero-local.mjs --hashrate 10000 --watts 120 --electricity 0.20
# Estimation avec prix XMR/EUR fourni MANUELLEMENT (pas « en direct ») :
node apps/web/comparateur/tools/monero-local.mjs --hashrate 10000 --watts 120 --electricity 0.20 --xmr-eur 100
```

**Nombre exemple 10 000 H/s et cours 100 € sont purement des entrées de test, pas de vrais benchmarks ni des prix actuels.** La formule utilise comme approximation les récompenses du dernier bloc qui peuvent inclure des frais ponctuels. Pour améliorer la précision, moyenner plusieurs blocs.

## Ce que cela ne résout PAS

1. Il faut collecter un hashrate fiable par modèle de GPU/CPU et par algorithme. Prévoir des benchmarks consentis par les utilisateurs de GPUbnb Host, avec des règles de contributions et de confidentialité clairement acceptées, ou des essais de laboratoire de GPUbnb. Sans cela, pas de comparatif de tous les GPU.
2. Le cours XMR/EUR n'est **pas** nativement inscrit dans la blockchain Monero. Un flux de prix tiers, même gratuit, garde des conditions d'usage. Sans preuve de droits, garder le cours manuel ou ne montrer que les XMR attendus.
3. Aucun « live » en euro ni classement multi-cryptos n'est possible avec ce prototype seul.
4. Exploiter des nœuds a un coût en stockage, réseau et machines, même si les logiciels et les données du protocole sont libres.
5. La méthode est spécifique à la blockchain Monero. Pour RVN, ETC, ERG, etc., il faudra des adaptateurs réseau distincts et leurs données de récompense, difficulté et hashrate réellement compatibles.

**Autonomie maximale, oui ; gratuité sans aucun coût ni obligation juridique, non garantie.** Pour éviter les droits de tiers, ne jamais copier des bases de benchmarks, des prix tiers ou du code sans licence adaptée. Ne pas fusionner avant accord.

Source officielle : https://docs.getmonero.org/rpc-library/monerod-rpc/ (RPC `get_last_block_header` et unités atomiques 1 XMR = 1e12).