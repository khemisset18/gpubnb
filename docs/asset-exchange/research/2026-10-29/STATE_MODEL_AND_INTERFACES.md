# Lot D — modèle et interfaces hors ligne

Implémentation : asset-exchange/research/src/swap-safety-model.mjs.
Ce module de recherche est appelé uniquement par ses tests. Aucun import dans
le Core, les routes, le wallet-agent ou les workers de production. Il n'a ni
transport, ni accès wallet, ni méthode de signature, ni construction/diffusion
de transaction. Toutes les sorties portent simulationOnly=true et
qualified=false ; executableOperations reste vide, y compris à COMPLETED.

Les assertions validated/fresh/independenceReviewed sont des **hypothèses du
modèle**, pas des preuves cryptographiques implémentées. Les adaptateurs et
validators de preuves réels restent à qualifier. Les tests ne donnent donc ni
PASS D2–D9 ni garantie d'atomicité sur chaîne.

| État proposé | Précondition / preuve | Action permise dans la conception | Interdit / reprise |
| --- | --- | --- | --- |
| Offre créée | offre bornée, identités et montants canoniques | annoncer une offre | aucun lock ; annulation sans pénalité |
| Offre acceptée | acceptation liée au même digest et version de réservation | vérifier préconditions | doublon identique sans nouvel effet ; conflit d'ID rejeté |
| Préconditions vérifiées | profils/risques/frais/UTXO/signer examinés | revue des contrats | pas d'inférence par symbole ou wallet connecté |
| Contrats examinés | scripts, montants, destinations, réseau et expirations concordent | préparer récupération | mutation des termes impose nouvelle revue |
| Récupération préparée | export restauré, indépendant, budget et signer compatibles | intention durable de premier lock, dans une future phase autorisée | modèle ne diffuse rien ; refund fixe insuffisant si financement instable |
| Premier lock intentionné | intention unique persistée avant effet | futur executor autorisé compare consentement exact | après crash rechercher l'effet avant toute nouvelle tentative |
| Premier lock observé / confirmations | preuve de réseau/engagement/bloc fraîche | attendre politique A | conflit/stale → UNKNOWN ; aucune création de lock B |
| Premier lock confirmé | profondeur et indépendance examinées | intention durable B seulement après contrôles répétés | epoch/termes changés ou délai insuffisant → HOLD |
| Deuxième lock observé / confirmations | preuve B correspondant aux termes | attendre politique B | mêmes règles de conflit/reorg |
| Deuxième lock confirmé | les deux jambes satisfont leurs politiques | autoriser un claim dans le modèle | pas de secret révélé par simple message utilisateur |
| Réclamation autorisée | consentement exact et fenêtre encore sûre | futur signer local, puis intention unique | mutation post-signature ou réseau incertain → refus |
| Réclamation observée | dépense et secret/part de clé validés | surveiller et vérifier la contre-dépense | une seule jambe ne termine pas le swap |
| Finalisé | deux claims attendus + rapprochement indépendant | afficher résultat avec politique de finalité | reorg profonde rouvre un incident, ne reste pas un succès irrévocable |
| Refund devenu possible | condition **de chaîne** atteinte | préparer/valider une restitution autorisée | timeout mur seul n'est pas une preuve de remboursement |
| Refund intentionné / diffusé | outpoint/script/frais/signer revalidés et intention durable | surveiller la dépense | pas de changement silencieux de destinataire ni abandon des fonds |
| Refund confirmé | toutes jambes financées résolues et jambe non financée vérifiée | rapprochement puis résultat REFUNDED | issue mixte claim/refund → incident, pas succès complet |
| Annulé sans lock | aucun engagement de financement existant | libérer réservation logique | aucune pénalité punitive ; pas d'annulation qui masque un lock |
| Échoué avant lock | absence de fonds verrouillés établie | arrêt sûr et diagnostic | après lock, préserver la capacité de récupération |
| Indéterminé | observation manquante, stale, contradictoire ou reorg | observation/reconciliation et recovery seulement | aucune confirmation par défaut ; preuves mises en cache invalidées |
| Incident de récupération | issue mixte, export inutilisable ou reorg post-résultat | intervention utilisateur, nouvelles preuves et revue explicite | aucune résolution automatique sur vieilles preuves |

Le modèle exécutable couvre les préconditions, recovery, observations de locks
et dépenses, replay, résolution, hold et reconciliation. Les sous-états
intention/broadcast, l'authentification des événements, l'outbox durable et la
preuve de non-financement restent des **contrats à implémenter**, pas des
fonctionnalités validées par cette simulation.

Idempotence : eventId et digest canonique ; une livraison identique après
sérialisation/restauration ne crée pas d'effet. Un ID réutilisé avec contenu
modifié échoue. Une reconciliation post-reorg exige des preuves fraîches pour
chaque jambe financée ; elle efface les anciennes résolutions. Une incertitude
avant lock ne permet pas de sauter la revue et la récupération.

Interfaces de données proposées :

- ChainEvidence : identité complète de jambe, engagement de termes/output,
  bloc/parent/hauteur, type de spend, sources, fraîcheur, conflit et validateur.
- RecoveryPlan : profil/digest, indépendance backend, résultat de restauration,
  propriété utilisateur du matériel requis, sémantique du financement,
  reconstructibilité et budget. Les booléens du modèle seront remplacés par
  des références de preuves signées/versionnées dans une future implémentation.
- FeeQuote : chaîne, unité explicite, taux entier, tailles/poids bornés,
  quantification, validité du devis, plafonds réseau et commission séparés.
- TimingBudget : domaine de mesure, provenance, budgets d'inclusion/observation/
  signature/reorg/indisponibilité/horloge et date de validité. Le modèle refuse
  les hauteurs inter-chaînes non converties.
- ExecutionIntent futur : identifiant unique, version/epoch, engagement du plan,
  hash des octets approuvés, autorisation de phase et état durable. Aucun
  executor n'est fourni dans ce lot.

Validation réalisée : tests de scénarios et mutations, montants au-delà de la
précision flottante, DOGE octets vs vbytes, BCH frais absolus, XMR quantification,
fenêtres périmées/insuffisantes, refund instable, replay après reprise, refus
réseau/termes erronés, reorg et sorties mixtes. Ce sont des tests de cohérence
et de refus du modèle ; pas une preuve formelle, ni un test d'un protocole XMR.
