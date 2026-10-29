# Lot C — récupération, menaces, frais et temporisation

État : spécification proposée et modèle hors ligne ; aucune opération de chaîne.
Complète les documents existants THREAT_MODEL, G3_RECOVERY_SPEC et le RFC UTXO.
Aucune promesse de remboursement inconditionnel : disponibilité du réseau,
capacité de signer à temps, frais relayables et règles du profil restent des
hypothèses nécessaires.

## Récupération avant verrouillage

Pour DOGE, étudier un P2SH/CLTV dédié : branche de claim liée au hash du secret et
au bénéficiaire ; branche de refund liée à l'expiration et au propriétaire.
Le template exact n'est pas approuvé par cette étude. L'absence de SegWit rend
critique la malléabilité du financement : un refund pré-signé dépendant d'un
ancien txid peut devenir inutilisable. Un engagement de script/montant/outpoint
et une capacité indépendante de reconstruire/re-signer après identification du
financement confirmé sont alors nécessaires. Un fichier contenant uniquement
le refund pré-signé n'est pas une preuve suffisante pour autoriser un lock.

Un remplacement de financement impose une nouvelle validation de tous les
engagements et de tous ses descendants. Ne jamais annoncer que RBF conserve
les droits d'un refund ancien. Un signer matériel qui ne sait pas reconstruire
le script choisi peut rendre ce plan impossible : garder le profil bloqué.
Après confirmation, une reorg peut encore modifier l'identité de financement.

Pour XMR, ne pas encoder un faux HTLC : utiliser seulement un protocole séparé
éprouvé et audité de clés partagées/signatures adaptatives. Tester preuves
inter-courbes, validation de points, scalar ranges, extraction de part de clé et
transcripts non rejouables. Les chemins cancel/refund/swipe/mercy doivent être
expliqués par propriétaire, moment et conditions. Une aide coopérative tardive
n'est pas une récupération indépendante. Aucun protocole examiné n'autorise
une garantie de remboursement à un utilisateur absent indéfiniment.

Export de récupération proposé, versionné et restaurable sans backend :
identité réseau/genesis et profil ; termes/digests approuvés ; scripts et clés
publiques ; engagements d'outputs/montants ; transactions publiques observées ;
templates de dépenses et règles de reconstruction ; conditions de locktime ;
réserve de frais, type de signer et instructions de restauration ; versions des
outils et preuves d'intégrité. Les données secrètes indispensables sont dans
un compartiment local chiffré sous contrôle exclusif de l'utilisateur. Pas de
seed ni part de dépense côté GPUbnb. Les adresses/montants publics peuvent
quand même révéler une relation privée : export et journaux doivent être
minimisés. Tester sauvegarde/restauration sur une autre machine avant validation.

## Matrice d'attaques et réponses

| ID / acteur | Précondition et impact | Prévention / détection | Reprise et test obligatoire | Risque résiduel |
| --- | --- | --- | --- | --- |
| R01 contrepartie | financement malléable, refund orphelin | engagements de script/montant ; pas de fixe-txid seul | restaurer/reconstruire avec vrai outpoint ; mutation de txid | signer absent ou frais impossibles |
| R02 worker | crash après broadcast avant commit | intention durable et identifiant unique avant effet | rejouer/rechercher l'effet ; crash à chaque frontière | RPC peut mentir ou manquer un effet |
| R03 oracle | faux nombre de confirmations | preuve fraîche liée au réseau/bloc ; indépendance sources | UNKNOWN/HOLD sur conflit ; observer reconvergence | collusion, partition, reorg profonde |
| R04 réseau | reorg après révélation du secret | ne révéler qu'après politiques par jambe ; budget reorg | réviser dépenses et états ; fork avant/après claim | le secret publié ne peut pas redevenir secret |
| R05 mempool | pinning ou forte hausse des frais | plafond explicite et réserve ; mesurer politique par chaîne | refund alternatif seulement après revalidation | inclusion non garantie à prix borné |
| R06 partenaire | disparition, lock B absent | ordre de locks et timelock A plus long | refund éligible sans backend ; disparition à chaque étape | utilisateur/watchtower doit agir à temps |
| R07 logiciel wallet | mutation de destination/fee/chaîne | consentement lié aux octets effectivement signés | refuser la mutation et auditer ; faux signer | appareil compromis / affichage trompeur |
| R08 attaquant | replay inter-chaînes ou autre trade | domaine + version + réseau + genesis + trade + epoch | rejets croisés et restauration de session | erreurs dans le serializer du profil |
| R09 stockage | export corrompu, clé locale perdue | export vérifié/restauré, intégrité et chiffrement local | incident de récupération ; test clean-room | pas de remplacement magique d'une clé perdue |
| R10 client | deux notifications ou deux commandes concurrentes | eventId+digest, CAS et outbox unique | mêmes effets/digests après replay ; ID conflictuel rejeté | intégration durable encore à qualifier |
| R11 environnement | arrêt du backend ou kill switch | recovery tool autonome et données utilisateur complètes | essai backend absent ; recovery ne dépend pas d'une session GPUbnb | chaîne et signer restent nécessaires |
| R12 XMR | point/preuve/adaptor invalide, clé partagée incohérente | primitives auditées et contrôles inter-courbes exacts | vecteurs externes et perturbation de chaque champ | audit crypto et procédure de secours manquants |

Un administrateur ne peut pas modifier les termes d'un trade en cours sous
prétexte de remédier à un incident. Quarantine bloque de nouveaux locks mais
conserve les outils de restitution déjà autorisés. Une annulation avant lock
ne crée aucune pénalité punitive. Après lock, seuls frais réseau réels et
commission déjà consentie selon sa politique explicite sont considérés ; une
commission d'un swap échoué n'est pas réputée automatiquement acquise.

## Frais : types exacts et refus des conversions implicites

| Actif | Unité monétaire | Unité de devis à étiqueter | Mesure indispensable |
| --- | --- | --- | --- |
| BTC | 10^8 satoshis/BTC | sat/vB pour le profil witness ; serialized bytes sinon | taille/weight exacte de lock/claim/refund |
| DOGE | 10^8 koinu/DOGE | DOGE/kB RPC → koinu/1000 octets | P2SH et taille sérialisée, jamais vB par héritage |
| LTC | 10^8 litoshis/LTC | litoshi/vB ou /1000 octets selon interface | profil transparent seulement ; pas de MWEB |
| BCH | 10^8 unités/BCH | rate atomique explicite ou frais absolus de covenant | ne pas multiplier deux fois des frais absolus BasicSwap |
| XMR | 10^12 piconero/XMR | prix par poids + priorité et masque de quantification | taille/poids du profil exact, pas sat/vB |

Les seuils/frais BTC/LTC/BCH/XMR restent non qualifiés chez GPUbnb. Les valeurs
DOGE lues dans le code sont dans DOGE_V1149_SOURCE_RULES.md ; elles ne sont pas
des devis réseau actuels. Aucun minimum économique universel n'est ajouté.

Pour chaque jambe, calculer en entiers :
`ceil(rateAtomicPerUnit * sizeUnits / unitScale)` puis l'arrondi/quantification
propre à la chaîne. Réserver lock, claim et refund possibles ainsi qu'un nombre
borné d'essais/reconstructions ; appliquer le dust par sortie réelle. La
commission GPUbnb est un champ séparé de la somme des frais réseau. Rejeter les
floats, unités absentes, taux périmés et tailles non bornées. Un plafond protège
le consentement ; il ne peut garantir l'inclusion sous n'importe quelle hausse.
Un échange économiquement viable doit couvrir les scénarios provisionnés et
laisser les outputs au-dessus des seuils du profil. Le calcul dépend du devis,
du type de transaction et du montant ; sans eux la réponse est BLOCKED.

## Confirmations et budgets de temps

Les cibles de blocs lues dans les profils de référence (BTC/BCH 600 s, DOGE 60 s,
LTC 150 s, XMR 120 s) ne sont ni des maxima ni des délais de sécurité approuvés.
Les confirmations requises dépendent du montant, reorg budget, état de chaîne,
qualité/indépendance d'observation et capacité de recovery. Aucun nombre unique
n'est fixé pour les cinq chaînes.

Conception à mesurer : budget d'inclusion/confirmation de B + observation de B
+ signature et inclusion du claim A + marge de reorg + indisponibilité tolérée
+ imprécision des horloges. L'expiration de A doit laisser ce budget après celle
de B, avec conversion explicite des hauteurs/temps selon le consensus de chaque
jambe. Ne pas comparer directement deux hauteurs de chaînes différentes.
Rejeter une mesure périmée ou sans provenance. Quantiles empiriques et tests de
stress documentent un niveau de risque, pas une borne contre un adversaire
illimité. Les modèles hors ligne testent les inégalités ; ils ne mesurent pas
les réseaux.

Une expiration de refund ne ferme pas nécessairement la branche claim d'un
HTLC. Un secret déjà connu et un refund peuvent donc être concurrents. Seule
une observation de dépense validée et suffisamment confirmée résout l'issue ;
une interface ne doit pas afficher « remboursé » au seul instant du timeout.
