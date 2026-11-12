# GPUbnb — Comparateur autonome (identité GPUbnb)

Ce comparateur est **isolé dans son propre dossier** et utilise les couleurs de GPUbnb (`#070908`, `#a6ff3f`). Il fonctionne sans framework et ne modifie aucun fichier existant du site principal. La page est intégrable dans un hébergement séparé ou sous un sous-chemin quand son intégration sera validée.

## Voir la page

- Ouvrez `index.html` avec un navigateur pour le mode manuel.
- Ou servez ce dossier avec `python -m http.server 8000`, puis ouvrez `http://localhost:8000`.
- Hébergez le **contenu de ce dossier** sur Netlify, Cloudflare Pages ou n'importe quel hébergeur statique. Vous pouvez plus tard l'installer sous un sous-domaine dédié (ex. `comparateur.votre-domaine.fr`) ou ajouter un lien vers lui depuis GPUbnb.

## Fonctions

- Sélection immédiate du GPU ou CPU avec recherche.
- Coût électrique personnalisable, consommation W, durée d'utilisation, nombre d'appareils et frais de pool.
- Revenu brut manuel (€/24 h par appareil).
- Calcul du profit net **journalier, mensuel (30 j), annuel (365 j)**, y compris pertes.
- Détail des coûts, énergie consommée et amortissement théorique du matériel.
- Tableau de comparaison de modèles, adaptable sur mobile.

## Point important sur les données

**Aucun chiffre de rentabilité réel n'est intégré ou simulé.** La liste de matériel contient des puissances électriques *approximatives*, personnalisables, pas des benchmarks miniers certifiés. Le site est immédiatement utilisable en mode manuel.

Pour activer des données réelles :

1. Obtenir les droits et une clé d'accès auprès d'une source de minage (Minerstat ou hashrate.no, par exemple).
2. Côté **serveur seulement**, récupérer les rendements estimés et convertir les revenus en **EUR / 24 h** avec un taux de change à jour, si nécessaire. Valider les identifiants du matériel, les benchmarks par algorithme et l'horodatage.
3. Écrire un fichier `data/rendements.json` au format suivant :

```json
{
  "source": "Nom de la source autorisée",
  "updatedAt": "2026-11-11T12:00:00Z",
  "currency": "EUR",
  "devices": [
    {
      "id": "nvidia-rtx-3060",
      "coins": [
        { "coin": "EXEMPLE", "algorithm": "Exemple Algo", "grossEur24h": 0.0 }
      ]
    }
  ]
}
```

**Ce JSON est un exemple de structure, pas une promesse de gains.** Il ne doit pas être publié avec une valeur d'exemple présentée comme réelle. Si les données datent de plus de 75 minutes, elles sont signalées comme sauvegardées. Elles restent utilisables 24 heures maximum à compter de la dernière mesure validée, puis le site repasse en mode manuel. N'ajoutez jamais de clé API dans `app.js` ou le code public du site. Le fichier livré contient un tableau `devices` vide, pour éviter d'afficher de fausses valeurs.

**Important** : les estimations de revenu brut sur 24 heures sont redimensionnées selon le temps d'utilisation : `brut = brut24h × nombre d'appareils × heures/24`. Électricité : `watts × heures × appareils / 1000 × €/kWh`. Frais de pool : `% du brut`. Le coût d'achat n'est utilisé que pour l'amortissement théorique.

## Installation sans toucher à GPUbnb

Vous pouvez publier ce dossier sur un site séparé. Le dépôt `khemisset18/gpubnb` (branche principale) n'est pas nécessaire pour tester le comparateur. Une fois validé, un simple lien depuis GPUbnb pourra y conduire, mais rien n'est modifié automatiquement.

## Qualité, sécurité et mise en production

Les calculs et la validation de la fraîcheur des données sont isolés dans `model.js`, sans dépendance externe. Exécutez les tests unitaires depuis la racine du dépôt avec :

```bash
node --test apps/web/comparateur/tests/model.test.mjs
```

Critères de contrôle : nombre d'appareils entier, montants et paramètres bornés, frais de pool et coût d'électricité déduits, données de rentabilité en EUR uniquement, rejet d'une source vide, d'une date future de plus de 5 minutes, d'un flux âgé de plus de 24 heures, et d'identifiants matériels inconnus. Les valeurs manquantes ne sont **jamais** remplacées par des profits inventés.

### Raccordement des données réelles (à effectuer avec une autorisation de fournisseur)

- Source envisageable : Minerstat API (https://minerstat.com/api-docs) ou hashrate.no (https://www.hashrate.no/c/api). **Vérifier les conditions et les quotas du fournisseur**, notamment pour l'usage commercial et la redistribution.
- Faire les appels depuis une tâche serveur / fonction serverless, **jamais depuis le navigateur**.
- Mapper explicitement les identifiants CPU/GPU et les algorithmes, puis fournir un revenu brut `grossEur24h` pour **1 appareil minant 24 h**, sans frais ni électricité déduits. Ne pas réutiliser une valeur de bénéfice net fournie par l'API : cela compterait les coûts deux fois.
- Convertir les montants avec une source de change datée et publier uniquement les valeurs vérifiées au format `data/rendements.json`, avec source et horodatage réel de la collecte.
- Respecter les limites d'appels, les politiques de cache et les autorisations d'affichage. Vérifier un jeu de données réel et son contrat avant de désigner le comparateur comme « temps réel ».

**Aucune intégration fournisseur réelle n'est activée dans cette PR** : le flux d'exemple reste vide, les données non disponibles déclenchent le mode manuel. Ne pas fusionner sans validation explicite du propriétaire.

## Étude des fournisseurs API

Voir [l'évaluation comparative Minerstat / hashrate.no](docs/ETUDE_FOURNISSEURS.md) : endpoints GPU/CPU, quotas, conditions d'utilisation commerciale, risques juridiques, plan de validation, échantillons nécessaires et demandes de licence à envoyer. **Aucune source live n'est activée et aucune demande n'a été envoyée.**

## Option sans fournisseurs de données commerciaux

Une alternative **autonome** (phase de recherche, pas encore connectée à l'interface) est documentée ici :
- [Plan de données autonomes](docs/PLAN_DONNEES_AUTONOMES.md) : benchmarks originaux et états des réseaux obtenus depuis nos propres nœuds.
- [Prototype Monero via nœud local](docs/MINAGE_AUTONOME_MONERO.md) : modèle de rémunération XMR/RandomX, CLI sans clé API, cinq tests unitaires.

La quantité de coins théoriquement minables peut être calculée sans achat de flux de données ; **le taux coin/EUR n'est pas fourni par la blockchain**. À défaut de source de prix utilisable commercialement, la conversion en euros reste manuelle. Le prototype ne change pas le comparateur publié ni le fichier `data/rendements.json` et ne nécessite aucun accès à GPUbnb Host.


## Extension gratuite Monero / RandomX (calcul indépendant)

La page présente désormais une **section Monero/XMR distincte**. Elle reprend le matériel choisi et les paramètres de coût, demande un hashrate **mesuré** sur RandomX, puis calcule les quantités théoriques de XMR par jour, mois (30 j) et an (365 j).

- **Sans fournisseur payant :** moyenne des 30 derniers blocs obtenue depuis **un nœud Monero mainnet GPUbnb synchronisé**, avec validation de la provenance et expiration des données après 20 minutes.
- **Sans nœud :** saisie manuelle de la difficulté et de la récompense réelle par bloc. L'interface précise que ces valeurs ne sont pas du temps réel.
- **Cours XMR/EUR :** uniquement manuel à ce stade ; aucune source de prix commercialement libre n'est intégrée.
- **Aucune valeur inventée :** sans hashrate mesuré ou sans données de réseau, le résultat reste indisponible.
- **Rien ne tourne automatiquement depuis cette PR :** l'opérateur doit installer et synchroniser son nœud puis lancer un outil de génération d'instantanés. Aucun accès à GPUbnb Host n'est nécessaire.

Voir **[le guide de mise en service Monero](docs/MONERO_EN_PROPRE.md)**. Pour vérifier les calculs :

```bash
node --test apps/web/comparateur/tests/*.test.mjs
```

Ne pas fusionner ni déployer sans accord explicite.


## Les cinq monnaies prévues dans GPUbnb

Le comparateur intègre désormais les **cinq cryptomonnaies déjà listées dans le module de configuration de minage du site**, sans modifier ce dernier :

- **XMR / RandomX** : moteur spécialisé ; données du réseau préparées depuis `monerod` local.
- **RVN / KawPoW** et **ETC / Etchash** : nouveau calculateur multichaîne et collecteurs expérimentaux depuis nos propres nœuds, non déployés ni validés contre un daemon live.
- **ERG / Autolykos v2** et **FLUX / FluxHash** : nouveau calculateur multichaîne avec données réseau saisies manuellement ; leurs collecteurs spécifiques restent à développer.
- Revenus affichés **en coins par jour, mois (30 jours) et an (365 jours)**. Les montants en euros restent liés à un cours **saisi manuellement**.
- Aucune valeur, benchmark ou cours de crypto n'est inventé ; les mesures réseau manquantes restent indisponibles.

Voir [la matrice détaillée des cinq cryptomonnaies et les guides d'intégration gratuite](docs/CINQ_CRYPTOS_POW.md).

Tests du moteur autonome et des collecteurs :

```bash
node --test apps/web/comparateur/tests/*.test.mjs
```

Les valeurs du fichier `data/pow-reseaux.json` restent vides avant une collecte vérifiée depuis nos nœuds et une publication autorisée. Aucun de ces outils ne modifie d'autres modules GPUbnb. **Ne pas fusionner sans accord explicite.**


## Audit GitHub et cybersécurité — version gratuite

Voir **[REVUE_GITHUB_SECURITE.md](docs/REVUE_GITHUB_SECURITE.md)** : comparaison de XMRig, kawpowminer, Ravencoin Core, Core-Geth, Ergo, Flux et Miningcore, avec **licences**, possibilités de mesure et frais/dons intégrés. Ces logiciels n'ont **pas** été copiés, installés ou déclenchés par le comparateur.

### Notre base de benchmarks GPUbnb, libre de données tierces

- Schéma original : \`lib/owned-benchmarks.mjs\`.
- Fichier public : \`data/owned-benchmarks.json\` (**vide** jusqu'à la première mesure réelle).
- Tests de sécurité : \`tests/owned-benchmarks.test.mjs\`.
- Publication **uniquement depuis des mesures de laboratoire approuvées**, sur le poste de l'opérateur ; pas d'accès à GPUbnb Host, pas d'aspiration de la base XMRig et pas d'upload public :

\`\`\`bash
cd apps/web/comparateur
npm test
# Après avoir réalisé soi-même des mesures (5 minutes minimum) et examiné la provenance :
node tools/review-owned-benchmarks.mjs /chemin/prive/mesures-approuvees.json
\`\`\`

Format de mesure locale (exemple de **structure**, chiffres inventés pour montrer les champs et **à ne jamais publier comme une vraie performance**) :

\`\`\`json
{
  "schemaVersion": 1,
  "source": "gpubnb-owned-lab",
  "samples": [{
    "deviceId": "nvidia-rtx-3060",
    "coin": "RVN", "algorithm": "KawPoW", "unit": "H/s",
    "hashrate": 1000000, "watts": 150,
    "durationSeconds": 600, "deviceCount": 1,
    "observedAt": "2026-11-11T18:00:00Z",
    "powerScope": "wall-whole-rig",
    "sampleMethod": "operator-measured",
    "consentToPublish": true
  }]
}
\`\`\`

Le programme valide l'algorithme, l'unité, les bornes, le catalogue matériel, la durée, la date, les doublons et l'attestation opérateur. Il ne publie **pas** les autres champs privés, tels qu'un numéro de série, une adresse de wallet, une IP ou un token de mineur. Le booléen \`consentToPublish\` n'est pas une preuve juridique : une preuve du droit de publication doit être conservée séparément par l'opérateur.

**Important** : les mesures en W concernent ici le **rig entier à la prise** pour un seul appareil, alors que le formulaire de calcul possède un W indicatif par appareil. Ne pas mélanger automatiquement ces données sans expliciter le périmètre électrique.

### Pas de nouveau composant payant

La base et les tests utilisent seulement Node.js et son moteur de test natif, **zéro dépendance npm additionnelle**. Aucune donnée tierce, API à clé, facture d'abonnement, intégration GitHub Actions dans le site principal ou automatisme de minage n'est ajoutée.

**La PR reste brouillon. Ne pas fusionner ni déployer sans accord explicite.**


## En-têtes de sécurité HTTP

Le fichier optionnel \`_headers\` de **ce seul dossier comparateur** configure une politique restrictive CSP, \`nosniff\`, \`no-referrer\`, bloque la géolocalisation/caméra/micro et la mise en iframe, et évite la mise en cache des instantanés de minage.

**Attention** : le fichier \`_headers\` s'applique automatiquement seulement lorsque **le contenu de \`apps/web/comparateur/\` est déployé comme racine d'un site statique compatible, par exemple un site Netlify indépendant**. Il n'est pas appliqué automatiquement au site GPUbnb actuel. Pour d'autres hébergeurs, configurer les mêmes en-têtes dans le serveur HTTP. La balise CSP de \`index.html\` apporte une protection côté navigateur mais ne remplace pas \`frame-ancestors\` en en-tête serveur.

Les seuls accès réseau attendus du comparateur sont les fichiers JSON locaux de notre propre hébergement. **Pas de script externe, de publicité, de portefeuille, de mineur lancé ni de clé privée côté navigateur.**


## Sauvegarde automatique 24 heures en cas de panne

**Nouvelle règle validée :** actualisation prévue **toutes les heures** (minute 17 UTC) ; si une source échoue ou renvoie des informations incohérentes, le dernier instantané validé reste disponible **24 heures maximum à partir de sa collecte**, sans réhorodatage. La page indique « Dernier relevé sauvegardé » avec son heure d'origine. Après 24 h, elle masque les valeurs automatiques et affiche « Service indisponible ». Le mode manuel reste disponible.

- Worker Cloudflare isolé : \`edge/worker.mjs\`, \`wrangler.jsonc\` et KV (mise en cache 86 400 secondes).
- Tests : \`tests/backup-24h.test.mjs\` et \`tests/model.test.mjs\`.
- [Documentation du secours 24 h et de ses limites](docs/SECOURS_24_HEURES.md).

**Ce système est codé mais pas déployé** : les sources publiques et les conditions de réutilisation doivent encore être vérifiées avec des réponses réelles. Ni le comparateur ni son Worker ne sont fusionnés avec GPUbnb. Le coût d'infrastructure dépend des limites de l'offre gratuite de l'hébergeur.


## Sources principales et sources de secours automatiques (1 h)

**Lorsque l'API principale est indisponible**, le service planifié essaie une autre source indépendante. **Chaque cycle redémarre par la principale** : dès qu'elle est à nouveau valide, elle reprend la priorité. Tous les résultats sont contrôlés avant publication ; aucun fournisseur commercial ni API payante n'est ajouté.

- **Monero (XMR)** : monero.rs (principale), Nodely (secours), HostingWire (candidat de second secours). Au moins **deux nœuds distincts concordants** nécessaires, sinon conservation de la dernière donnée valide.
- **Ethereum Classic (ETC)** : Blockscout (principale), ETCMC (secours), ETC Desktop (second secours).
- **Ravencoin (RVN)** : une seule API indépendante documentée et implémentée ; **pas de secours secondaire prétendu valide** avant une vérification réelle, mais le dernier bon relevé peut rester 24 h.
- **Ergo / Flux** : calculs manuels, sources automatiques à fiabiliser.
- **Si tous les secours échouent**, dernier relevé validé pendant 24 h maximum, puis « Service indisponible ».

Le navigateur peut afficher **« Source de secours active »** avec le nom de l'opérateur et l'API de diagnostic donne \`fallback: true/false\` lorsque la mesure est disponible.

Voir [les règles de basculement, de sécurité et les sources vérifiées](docs/BASCULEMENT_SOURCES.md).

**Limite** : la liste est codée et testée contre des réponses simulées, **mais aucun service n'est encore déployé** et les autorisations de réutilisation commerciale doivent être confirmées. Nodely demande de prendre contact pour les charges commerciales importantes. Ne pas présenter le basculement comme une garantie de disponibilité.


## Catalogue de rentabilité complet : 14 cryptos

Après recoupement **en lecture seule** avec les catalogues GPUbnb Host et web, le comparateur couvre :

- GPU/CPU existants : **XMR, RVN, ETC, ERG, FLUX**.
- Catalogue GPUbnb Host supplémentaire : **PRL (Pearl), ALPH (Alephium), KAS (Kaspa), CFX (Conflux), NEOX (Neoxa)**.
- Profils natifs additionnels : **BEAM (Beam Mimblewimble) et CTXC (Cortex)**.
- Monnaies ajoutées à la demande : **BTC (Bitcoin) et ZEC (Zcash)**.

Détails exacts : **[COUVERTURE_COMPLETE_CRYPTOS.md](docs/COUVERTURE_COMPLETE_CRYPTOS.md)**, précisant la différence entre « présent dans le catalogue », « lancement approuvé par GPUbnb Host » et « données automatiques réellement connectées ».

**Pearl (PRL) n'est pas calculé comme un hashrate minier standard** : un panneau séparé transforme uniquement les gains PRL *bruts observés dans un pool pour un GPU et une durée réellement mesurée* en projections jour/mois/an. Ces gains historiques ne garantissent pas un futur paiement.

**BTC, ZEC, Kaspa et Alephium** ont un profil d'équipement **ASIC dominant** ; ils demandent un hashrate et une puissance spécifiques de l'ASIC, sans emprunter le wattage d'un GPU. **Neoxa** requiert la *part mineur réelle* (20 % de la subvention de bloc). **Beam / Flux / Zcash / Cortex** affichent leurs unités Sol/s ou Graph/s sans les confondre avec les H/s.

**Important :** seule une partie des réseaux (XMR, RVN, ETC) dispose de collecteurs automatiques expérimentaux. Les autres monnaies restent en **calcul à partir de mesures manuelles**, sans tarif de données, sans rendements ni cours inventés. Leur ajout **ne change pas** les profils exécutables de GPUbnb Host ni le site principal. Aucun service n'est déployé et **aucune fusion n'a été effectuée**.


## Actualisation **toutes les heures** — sans nœud à entretenir

Le calendrier Cloudflare est maintenant \`17 * * * *\` : essai de collecte **à la minute 17 de chaque heure UTC** (24 fois par jour). Un retard de 15 minutes est toléré avant de classer une mesure comme « Dernier relevé sauvegardé ». Les sources primaires sont toujours retentées en premier, puis les secondaires autorisées. En cas de panne généralisée, la dernière valeur valide reste **24 heures maximum**, sans réinitialisation du compteur.

Pour ne pas gaspiller les quotas gratuits : chaque navigateur recharge les flux automatiques toutes les **15 minutes** et contrôle **chaque minute localement** l'âge du relevé ; aucun appel réseau supplémentaire n'est nécessaire pour expirer l'affichage. Les trois monnaies en collecte automatique expérimentale sont **XMR, ETC et RVN**. Les onze autres conservent leur mode manuel / gains réellement observés.

**Attention : configuration et tests uniquement**. Aucun Worker Cloudflare ou espace KV n'a été créé ou déployé dans cette PR. L'usage commercial des RPC publics, leur disponibilité réelle et les limites de l'offre gratuite doivent être vérifiés avant toute activation. Ne pas toucher aux autres modules GPUbnb, ne pas fusionner ni déployer sans autorisation explicite.

Tests du changement : \`tests/hourly-refresh.test.mjs\` et \`tests/backup-24h.test.mjs\`.


## Préparation du déploiement Cloudflare : sécurité et aucune maintenance de nœud

Guide : **[DEPLOIEMENT_AUTONOME_GRATUIT.md](docs/DEPLOIEMENT_AUTONOME_GRATUIT.md)**.

La configuration GitHub est volontairement un **template** : \`wrangler.jsonc\` ne possède pas d'ID KV Cloudflare. Cet \`id\` est obligatoire selon Cloudflare et ne peut pas être inventé dans une PR. Le nouvel outil \`tools/prepare-cloudflare-config.mjs\` prend l'identifiant réel d'un namespace KV créé une seule fois par le propriétaire et produit un fichier \`wrangler.deploy.jsonc\` local, **sans jamais déployer**. Ce fichier est exclu de Git et des fichiers publics.

Une limite de taille de **768 Kio réels décompressés** protège désormais les lectures des RPC publics, même si un serveur malveillant omet ou falsifie l'en-tête \`Content-Length\`. Tests : \`tests/public-fetch-security.test.mjs\` et \`tests/cloudflare-config.test.mjs\`. Aucun fournisseur, benchmark ou profit fictif n'est activé.

**Rappel : la PR reste brouillon, aucun Cloudflare Worker n'est lancé, aucun module GPUbnb extérieur au comparateur n'est modifié.**
