# Évaluation des sources de rentabilité GPU/CPU — GPUbnb

Date de vérification : 11 novembre 2026. **Statut : exploration uniquement ; intégration commerciale non autorisée à ce stade.** 
Ce document appartient exclusivement au comparateur autonome. Il ne change ni la marketplace ni son API.

## Résultat

Les deux fournisseurs ont un accès API utilisable *techniquement* pour des données de minage GPU/CPU. En revanche, la publication de chiffres tirés de ces APIs sur GPUbnb nécessite un abonnement/licence appropriés et, par précaution, une confirmation écrite couvrant l'affichage public d'un **comparateur concurrent**. **Ne pas présenter les données comme temps réel tant que l'accès n'est pas activé, validé et horodaté.**

| Critère | Minerstat | hashrate.no |
|---|---|---|
| Docs officielles | https://minerstat.com/api-docs | https://hashrate.no/c/api |
| GPU et CPU | Benchmarks matériels, algorithmes, coins, profits | Endpoints dédiés \`/api/v2/gpuEstimates\`, \`/api/v2/cpuEstimates\` et \`/api/v2/benchmarks\` |
| Fraîcheur publiée | Coins mis à jour toutes les 5 min ; métadonnées de fraîcheur | Fréquence / timestamp exacts à confirmer sur réponses authentifiées |
| Échelle publiée (indicative, variable) | ~971 matériels, ~10,74 k benchmarks annoncés sur la page API ; chiffre variable | Inventaire total et couverture des versions GPU/CPU à mesurer par API ; non public dans les docs consultées |
| Authentification | Clé obligatoire selon CGU, création de clé gratuite avec email | Clé obligatoire sous \`?apiKey=...\` |
| Essai | Free 100 requêtes/mois, 20 résultats maximum par réponse | Compte nécessaire ; quotas d'essai et format détaillé non vérifiés |
| Quotas annoncés | Free 100/mois, Developer 5 000/mois, Enterprise 100 000/mois | À consulter après connexion / obtenir par écrit |
| Usage commercial | Enterprise ; les autres offres ne l'autorisent pas selon les CGU | Plan commercial requis selon la doc API |
| Droit de redistribution / comparaison | **Attention** : redistribution massive et service de données concurrent interdits sans accord écrit, même avec un plan payant | Droits de stockage, redistribution/affichage comparatif et attribution à confirmer par écrit |
| Attribution | Afficher une attribution et un lien Minerstat visibles | Conditions d'attribution à obtenir |
| Prix mensuel commercial | Non visible sans accès au portail facturation | Non vérifiable sur page publique |
| Preuve sans clé | Docs et CGU publiques, pas de réponse live authentifiée | \`GET /api/v2/gpuEstimates\` sans clé -> \`{"title":"An error occurred","detail":"Invalid credentials."}\` |

Sources : 
- https://minerstat.com/api-docs
- https://minerstat.com/terms (CGU mises à jour le 30 août 2026, sections 5 et 6)
- https://minerstat.com/methodology
- https://minerstat.com/widgets
- https://hashrate.no/c/api

### Points de vigilance pour comparer les chiffres

Un même GPU peut avoir plusieurs algorithmes / monnaies et profils de puissance. Il serait trompeur de comparer simplement la meilleure valeur nette publiée par chaque site. Pour comparer proprement, il faut utiliser **même GPU, même monnaie, même algorithme, même fenêtre de collecte, même devise et même coût énergétique**, et documenter le hashrate, les watts et les frais.

- **Sortie canonique GPUbnb** : \`{id, coin, algorithm, grossEur24h}\` = **revenu brut estimé pour UN appareil pendant 24 heures, sans retrait d'électricité ni frais de pool**.
- Si la source renvoie le **profit net**, ne pas le traiter comme un revenu brut : cela compterait l'électricité et/ou les frais deux fois. Préférer les champs de revenus bruts ou reconstituer à partir des hashrates/rewards documentés.
- hashrate.no expose \`powerCost\` sur les routes d'estimation, avec valeur par défaut **0.10** selon ses docs. Pour normaliser les données en bénéfice brut GPUbnb, ne pas comparer les chiffres nets calculés avec ce coût par défaut à des revenus avant énergie.
- Coûts d'électricité GPUbnb en **EUR/kWh**, taux FX horodaté si le fournisseur répond en USD. Les watts doivent représenter la configuration testée ; ne pas mélanger TDP, GPU seulement et puissance de la prise murale.
- Les profils atypiquement rentables doivent être vérifiés contre profondeur/volume du marché et plusieurs sources. Une rentabilité affichée peut être théorique et impossible à convertir en monnaie fiat à grande échelle.
- Ajouter un champ « source », un horodatage, un éventuel « estimé », et afficher un signal clair quand les données sont périmées ou indisponibles.
- **Ne pas extraire ni parser les pages HTML ou widgets pour contourner les limites de l'API.**

### Option d'affichage immédiat très limitée

Minerstat propose des widgets **gratuits à intégrer** avec logo et lien obligatoires : https://minerstat.com/widgets. Les widgets publiés portent sur une carte de coin ou un Top ASIC, **pas sur la sélection individuelle GPU/CPU avec coûts personnalisés**. Ils ne remplacent donc pas le fournisseur de données nécessaire à GPUbnb. Ne pas retirer l'attribution ni réinterpréter les chiffres des widgets.

## Benchmark comparatif à effectuer après accès autorisé

1. Demander à chacun un échantillon sous licence / clé d'essai, prix, quotas, règles de cache et de présentation.
2. Échantillon minimum : RTX 3060, RTX 4070, RTX 4090, RX 6800, RX 7800 XT, Ryzen 9 5900X, Ryzen 9 7950X, Intel i9-14900K. Confirmer qu'ils existent réellement côté fournisseur (les IDs/versions sont inconnus).
3. Pour un même instant, capturer : identifiant source et nom, algorithme, coin, hashrate + unité, watts, revenu brut en devise et date, coût éventuel calculé, confidence / liquidité.
4. Déterminer la couverture sur **tous les IDs GPUbnb** avant une promesse de catalogue « temps réel ».
5. Comparer les écarts à conditions identiques, signaler explicitement les matériels sans benchmark et conserver les 2 dernières snapshots valides *seulement si la licence autorise la rétention*.
6. Vérifier l'utilisation API côté serveur, robustesse des taux FX, timeouts, 429, 500, quota mensuel, caching, granularité du rafraîchissement, attribution et contact de secours.
7. Activer seulement après contrat/licence, test du format réel et échantillonnage vérifié ; laisser \`data/rendements.json\` vide entre-temps.

### Estimation de volume (sans affirmer le droit d'utilisation)

- Refresh unique **toutes les 5 minutes** : ~8 640 requêtes / 30 jours **par endpoint**.
- GPU et CPU séparés : ~17 280 requêtes / 30 jours, hors retry, monnaie/FX et catalogue, si chaque appel donne toutes les données nécessaires.
- Free Minerstat = 100/mois, non adapté à cette cadence ; Developer = 5 000/mois, non commercial ; Enterprise = 100 000/mois, théoriquement suffisant en quota seul **mais le droit de construire un comparateur reste à contractualiser**.
- Récupération côté serveur uniquement, puis snapshot pour tous les visiteurs — pas une requête fournisseur par visiteur. Quotas par minute et par réponse à confirmer.

## Demandes commerciales à adresser aux fournisseurs

**Minerstat** : https://minerstat.com/contact

> Subject: Commercial API licensing for GPUbnb GPU/CPU mining profitability comparison
>
> Hello, we are developing GPUbnb, a public GPU/CPU mining profitability calculator and hardware comparison page. We would like permission to display your data in our own interface to our visitors (with full attribution), not to resell your API keys or bulk dataset.
> Could you confirm **in writing** whether Enterprise permits this use as a public profitability comparison service, or whether a separate agreement is needed under your competing-data-service clause?
> Please send current commercial pricing, monthly/burst quotas, cache and redisplay rights, required attribution, supported GPU/CPU coverage and the API response schema/sample for **gross revenue per device/day**, benchmarks and update timestamps.
> We will not publish or fetch commercial data without an appropriate agreement.
> Thank you.

**hashrate.no** : adresse de contact affichée publiquement sur le site : info@hashrate.no (https://hashrate.no/c/api)

> Subject: Commercial API enquiry: GPUbnb GPU/CPU mining yield calculator
>
> Hello, GPUbnb is building a public comparison calculator for GPU and CPU mining profitability, with user-adjustable electricity costs, 1-day/30-day/365-day projections and clear attribution.
> Can your commercial API plan cover public display of GPU and CPU profitability estimates and retention of short-lived server-side snapshots? What is the pricing, rate limit, refresh schedule and attribution requirement?
> We need the schema for /api/v2/gpuEstimates, /api/v2/cpuEstimates and /api/v2/benchmarks, especially **gross vs net income**, USD units, power consumption and timestamp. Can we obtain a limited test key and a written licence covering a comparison website?
> Thank you.

**Ces messages sont uniquement des brouillons : rien n'a été envoyé.**

## Décision recommandée

**Court terme :** conserver le mode manuel et le design premium déjà validé, développer un adaptateur neutre seulement après réception d'un échantillon autorisé.

**Priorité 1 :** demander à hashrate.no un échantillon / offre commerciale (endpoints explicites GPU et CPU). 
**Priorité 2 :** négocier avec Minerstat le **droit explicite** de présenter sa donnée dans un comparateur public. Minerstat paraît plus riche en métadonnées et garanties de fraîcheur, mais le risque de restriction contractuelle pour un comparateur est plus élevé.

**NO-GO production à ce stade.** Ne pas publier d'estimations prétendument live, ne pas créer ni renseigner de clé dans le navigateur, **ne pas fusionner la PR sans accord explicite**.
