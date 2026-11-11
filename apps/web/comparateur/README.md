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

**Ce JSON est un exemple de structure, pas une promesse de gains.** Il ne doit pas être publié avec une valeur d'exemple présentée comme réelle. Si les données datent de plus de 2 heures, le site repasse en mode manuel. N'ajoutez jamais de clé API dans `app.js` ou le code public du site. Le fichier livré contient un tableau `devices` vide, pour éviter d'afficher de fausses valeurs.

**Important** : les estimations de revenu brut sur 24 heures sont redimensionnées selon le temps d'utilisation : `brut = brut24h × nombre d'appareils × heures/24`. Électricité : `watts × heures × appareils / 1000 × €/kWh`. Frais de pool : `% du brut`. Le coût d'achat n'est utilisé que pour l'amortissement théorique.

## Installation sans toucher à GPUbnb

Vous pouvez publier ce dossier sur un site séparé. Le dépôt `khemisset18/gpubnb` (branche principale) n'est pas nécessaire pour tester le comparateur. Une fois validé, un simple lien depuis GPUbnb pourra y conduire, mais rien n'est modifié automatiquement.

## Qualité, sécurité et mise en production

Les calculs et la validation de la fraîcheur des données sont isolés dans `model.js`, sans dépendance externe. Exécutez les tests unitaires depuis la racine du dépôt avec :

```bash
node --test apps/web/comparateur/tests/model.test.mjs
```

Critères de contrôle : nombre d'appareils entier, montants et paramètres bornés, frais de pool et coût d'électricité déduits, données de rentabilité en EUR uniquement, rejet d'une source vide, d'une date future de plus de 5 minutes, d'un flux âgé de plus de 2 heures, et d'identifiants matériels inconnus. Les valeurs manquantes ne sont **jamais** remplacées par des profits inventés.

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
