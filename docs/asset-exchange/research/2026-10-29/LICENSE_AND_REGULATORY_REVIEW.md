# Licences et préparation réglementaire — revue à poursuivre

État : inventaire direct et questions de conseil préparés. Aucun code tiers
n'est incorporé au runtime ; aucun avis juridique définitif, agrément ou droit
d'exploiter n'est revendiqué. Date de vérification : 29 octobre 2026.

## Inventaire et décision d'import

| Référence | Licence examinée | Traitement avant redistribution |
| --- | --- | --- |
| DCRDEX v1.0.5 + master épinglé | Blue Oak Model License 1.0.0, LICENSE.md | Texte ou lien requis selon licence ; conserver origine et modifications ; compléter BOM Go |
| BasicSwap v0.19.1 | MIT, LICENSE et en-têtes | Conserver copyright/texte ; vérifier chaque composant contrib et fork natif avant copie |
| Dogecoin v1.14.9 | MIT, COPYING | Référence de source seulement ; garder notices de tout futur composant redistribué |
| BIP65/112/125 | PD | Attribution technique conservée ; pas une licence sur toute implémentation |
| BIP199 | BSD-3-Clause OR CC0-1.0 | Sélection documentée et obligations appropriées si reprise de contenu/code |
| COMIT 1.0.0-rc.1 | GPL v3 dans LICENSE | Pas d'import prévu ; étude des obligations de source/code lié et distribution par juriste |
| KDF archivé | Avis copyright/accord spécifique + GPL v3 + THIRDPARTY-LICENSES | Ne pas le résumer à MIT ; pas de moteur retenu sans clarification juridique |
| Fork coincurve BasicSwap + DLEAG/OtVES natifs | Source déclarée dans requirements, licence/transitives non entièrement auditées ici | **BLOQUÉ pour import** tant que version, provenance, ABI, notices et licences transitives ne sont pas inventoriées |
| Bibliothèques Go/Rust/Monero/GTK potentielles | Inventaire transitive incomplet | **BLOQUÉ pour redistribution/intégration** ; aucune absence de licence présumée permissive |

Les URLs, commits et hashes des textes examinés sont dans SOURCE_INVENTORY.json.
Ne pas copier un dépôt entier. Pour chaque import futur : identifier les fichiers
utiles ; produire un SPDX/CycloneDX transitive résolu ; vérifier textes et notices
par version ; établir obligations de source/offre/attribution/build scripts et
compatibilité commerciale ; conserver modifications et validation ; faire
approuver le diff et la distribution. Une frontière de processus ne supprime
pas automatiquement des obligations de copyleft.

## Qualification de l'activité à soumettre au juriste

MiCA distingue des services professionnels tels que plateforme de négociation,
échange, réception/transmission/exécution d'ordres, conservation et transfert.
Le rôle réel de GPUbnb doit être analysé selon qui contrôle carnet, règles de
matching, commissions, accès, interface, autorisation et transactions. L'absence
de conservation n'exclut pas, à elle seule, ces autres services.
Source : règlement UE 2023/1114, articles 3 et 59 ; page MiCA de l'AMF.

Le considérant 22 vise un cas totalement décentralisé sans intermédiaire ;
l'ESMA précise que l'appréciation dépend des faits et des autorités compétentes.
Une interface ou un matching contrôlé ne reçoit donc aucune exemption par
simple usage d'atomic swaps. L'AMF indique que la transition française s'est
achevée le 1er juillet 2026 : elle ne peut pas être utilisée comme permission
future de lancer ce projet.

L'article 76(3) impose une condition spécifique sur l'admission d'actifs à fonction
d'anonymisation intégrée : identification des détenteurs et de l'historique par
l'opérateur concerné. C'est un blocage d'analyse prioritaire pour une offre XMR
si GPUbnb relève de l'exploitation d'une plateforme ; ni une prohibition
universelle de XMR ni une dérogation automatique ne sont conclues ici.

Le règlement UE 2023/1113 doit être examiné séparément lorsque des PSCA
interviennent dans un transfert, y compris vers des adresses auto-hébergées.
Ses exclusions et obligations de collecte/vérification ne se déduisent pas de
l'architecture cryptographique seule. Prévoir également avis LCB/FT, sanctions,
protection des données, conservation, sous-traitance et résilience applicables.
Aucune collecte KYC ni mesure de surveillance réelle n'est mise en œuvre ici.

| Question de conseil / décision requise | Pièce technique à fournir |
| --- | --- |
| Quelle entité fournit quels services, dans quels pays ? | organigramme, flux UI/matching/commissions et contrôle opérationnel |
| Logiciel seul ou prestation professionnelle exploitée ? | distribution, support, hébergement, pouvoir de modifier/fermer le marché |
| Plateforme multilatérale, échange propre, RTO ou exécution ? | règles exactes de formation/exécution des ordres et contreparties |
| Conservation ou transfert pour compte de tiers, même indirect ? | clés/parts de clés, RPC, consentement et droits d'intervention de chaque processus |
| XMR et condition d'identification de l'article 76(3) ? | limites de données disponibles et analyse privacy ; aucune promesse d'admission |
| Quels agréments/notifications/obligations AMF/ACPR ? | modèle d'affaires et services qualifiés, gouvernance et fonds propres à évaluer |
| Quelles règles LCB/FT/TFR/sanctions et données à traiter ? | minimisation et séparation du dossier juridique/KYC du moteur de recovery |
| Quelles obligations de marché/résilience/externalisation ? | matching, abus, continuité, incidents, fournisseurs et droit de récupération |
| Distribution commerciale et licences natives/copy-left ? | BOM complet, notices, modalités de livraison et diff des composants |

## Sources officielles vérifiées

- AMF MiCA : https://www.amf-france.org/fr/actualites-publications/dossiers-thematiques/mica
- AMF fin de transition : https://www.amf-france.org/fr/actualites-publications/actualites/fin-de-la-periode-transitoire-mica-lesma-precise-ses-attentes-envers-les-professionnels-et-alerte
- MiCA : https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32023R1114 ; lecture des articles pertinents via les rendus/index officiels (le rendu direct a présenté un contrôle JavaScript).
- ESMA Q&A 2671 : https://www.esma.europa.eu/publications-data/questions-answers/2671
- ESMA Q&A 2552, réponse du 18 février 2026 : https://www.esma.europa.eu/publications-data/questions-answers/2552
- TFR : https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32023R1113

Cette note prépare une revue juridique spécialisée. Elle ne prouve pas la
conformité, ne remplace pas les textes consolidés applicables et n'autorise
aucune activité régulée ou mise en production.
