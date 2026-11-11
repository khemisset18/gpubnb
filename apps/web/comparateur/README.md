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