# GPUbnb — Gaming : pilote graphique privé, pas encore un workspace réservable

**État : prototype de qualification Windows, NO-GO public.**
**Base :** Stage 4 privé `23a7a2950ecf365866f3531ddbf76920d9fcb295` et interface en revue dans la PR #368.
**Portée :** frontend privé uniquement, zéro changement agent/helper/serveur/driver et zéro déploiement.

## Pourquoi ce pilote existe

La qualification manuelle PC1 → PC2 du 15 novembre 2026 a montré un écran Windows H.264 visible, avec souris/clavier pilotables depuis le navigateur, sur le compte standard dédié `gpubnb-renter-qual`. Une session `WorkspaceSession.COMPLETED` puis une réservation `SETTLED`, une allocation GPU `RELEASED` et un Host `AVAILABLE` ont été observés. Ce résultat n'est pas une certification gameplay ou une preuve formelle de zéro fuite inter-session.

Le catalogue `Gaming` était préparé mais **ne pouvait pas encore exécuter Steam via le runtime Windows natif**. Le Helper actuel refuse `gaming` au niveau autorité, même si le parseur accepte une application Steam de la liste blanche. La sortie de `--self-test-console` annonce `audioAvailable:false`; `--start-console` annonce `audioReady:false`, `controllerReady:false`. L'Agent exige l'audio et la manette pour Gaming. Ne jamais forcer ces booléens à `true`, ni retirer l'interdiction pour présenter un module fictivement fonctionnel.

## Chemin permis (preuve graphique seulement)

- Le propriétaire authentifié arrive sur `workspaces.html?machine=<son-machine-id>` depuis `Mes machines`.
- Le frontend requiert le succès du endpoint owner-only `/machines/:id/workspaces/manage`, puis `/auth/me` et le préflight privé strict (`privateNoPaymentMode:true`, `allowed:true`, code exact `PRIVATE_WINDOWS_TEST_ATTEMPT_ALLOWED`).
- La carte Gaming reste **désactivée** pour le workspace officiel ; seul le lien **« Essai graphique de jeu (via Cloud Desktop) »** peut apparaître.
- La page de pilote revérifie indépendamment le propriétaire et le préflight (uniquement GET, aucun effet de réservation), puis propose le lien vers la page de démarrage **Cloud Desktop** existante. Cette dernière revérifie encore l'autorisation **avant tout POST**.
- Une fois dans le Cloud Desktop, l'opérateur peut **manuellement** ouvrir un jeu déjà installé et autorisé dans le compte Windows locataire. Aucun lancement automatique de Steam, aucun partage de compte personnel, aucune élévation, aucune installation de pilote et aucune promesse audio/manette.
- Arrêter par la commande STOP de session déjà prévue, sans arrêter le service GPUbnbAgent. La réservation reste active jusqu'à son échéance normale ; confirmer ensuite `SETTLED`/`RELEASED` et `Machine.AVAILABLE`.

## Conditions de sécurité / stop immédiat

- Un seul compte Windows loueur standard actif sur la console PC1 ; compte propriétaire déconnecté, aucun fichier ou secret propriétaire sur ce profil.
- Ni bureau personnel capturé, ni prise de contrôle admin, ni RDP, ni port média publiquement exposé.
- Aucun client inconnu ou annonce publique ; uniquement l'environnement de qualification sans paiement.
- En cas de pixels propriétaire, changement WTS, verrouillage, comportement anormal ou fuite de données : **STOP immédiat** et documenter sans captures de données personnelles.
- Le masquage UI n'est pas une frontière d'autorisation. Les contrôles du serveur et de l'Agent signé restent obligatoires ; le manque de vérification propriétaire côté GET préflight est suivi dans #369.

## Poursuite du vrai Gaming natif (à ne pas annoncer comme faite)

1. **Lancement applicatif isolé** : définir un mécanisme signé qui résout Steam de façon canonique, vérifie signature/éditeur ou identité de fichier, lance uniquement sous le token locataire, lie les enfants à une autorité révoquable et prouve leur STOP/cleanup. Aucun processus propriétaire, `cmd.exe`, URI Steam arbitraire ou argument joueur libre.
2. **Audio** : implémenter un chemin audio capturé, chiffré, session-bound et muté/fermé à la révocation ; déclarer `audioReady:true` uniquement sur preuve physique positive et vérifier le client navigateur.
3. **Manette** : définir un protocole d'entrée borné, autorisé au même lease que clavier/souris, contrôle de la rétention des boutons et arrêt sûr ; tester matériel et épuisement réseau. Ne pas réutiliser aveuglément les paquets clavier pour simuler une manette.
4. **Précision et isolation** : mesurer images rendues et décodées, fps/latence, découpage 300 s, limites CPU/GPU, suspension/reconnexion, verrouillage/fast-switch WTS, révocation et retour à AVAILABLE ; tester comptes et jeux non sensibles.
5. **Preuves de signature/release** : soumettre le nouvel Agent/Helper/Worker/Media aux pinning SHA40/Authenticode, CI, revue et rollback **avant** une nouvelle installation PC1. Aucun changement automatique du Render privé actuel.
6. **Publication** : seulement après succès des tests négatifs et de la revue indépendante, définir conformité jeux/licences et conditions commerciales. `Gaming` demeure non bookable pendant tout ce pilote.

## Tests automatisés

- `node --test apps/web/windows-native-gaming-pilot.test.js`
- `node --test apps/web/windows-native-workspaces-private-ui.test.js`
- `node --test apps/web/windows-native-*.test.js`

Ces tests sont **des tests navigateur simulés**. Ils ne remplacent ni l'attestation du Host ni les mesures physiques d'un jeu.
