# PC2 — navigateur uniquement, test réservé à l'utilisateur

## URL vérifiées le 18 octobre 2026

- Connexion : https://gpubnb-stage3-private.onrender.com/auth.html
- Entrée privée : https://gpubnb-stage3-private.onrender.com/stage3-windows-native.html
- Bureau : https://gpubnb-stage3-private.onrender.com/windows-native-desktop.html — l'identifiant et l'accès sont attribués par l'API après une qualification autorisée, jamais inventés.
- API : https://gpubnb-stage3-private.onrender.com
- Santé WebSocket : wss://gpubnb-stage3-private.onrender.com/ws-health — upgrade et message `gpubnb-ws-ok` vérifiés.
- Flux privé défini dans le code : `/workspace-gateway/<sessionId>/native-stream` à la même origine WSS, authentifié et binaire. Aucune session réelle n'a été ouverte pour le vérifier.

Le service live annonce encore le SHA Stage 3 `6b655614d3b9c3fda7912742b539601ba22598f1`. Sa page bureau n'a pas le compteur Stage 4 et le préflight Stage 4 absent renvoie du HTML : **ne pas démarrer le test sur ce déploiement**. `https://gpubnb.netlify.app/config.js` annonce `16c13e0` et `https://gpubnb.onrender.com` ; ne pas utiliser ce parcours public pour le test privé.

## Prérequis préparés

Après déploiement manuel autorisé du SHA exact retenu, `/release` et le `releaseCommit` de `/config.js` doivent correspondre au paquet et à l'Agent. Le frontend privé partage l'origine HTTPS de l'API ; la politique CSP autorise explicitement son hôte WSS. Aucun logiciel à installer sur PC2.

Le script opérateur `qualification-preflight-pc-b.ps1 -PrivateSameOrigin` contrôle en lecture seule cette origine, le SHA exact, les réponses JSON, les pages, le compteur effectivement déployé, le refus du préflight anonyme et WSS santé. Utiliser la même origine privée pour ses trois paramètres et le SHA complet pour `-ExpectedReleaseCommit`. Ce script peut être exécuté depuis un poste opérateur ; il n'est pas une dépendance de PC2 et ne démarre aucune session.

## Déroulé utilisateur après autorisations PC1 et Render

1. Ouvrir l'URL privée d'entrée puis s'authentifier avec le compte prévu (Google/e-mail). Le client vérifie `/auth/me`, puis effectue le GET authentifié `/qualification/windows-native/preflight`. Il doit recevoir du JSON avec `privateNoPaymentMode=true` ET `allowed=true`. Aucune demande de paiement, signature wallet, dépôt escrow ou publication publique n'est admise. Le POST privé revérifie les préconditions ; un ancien GET positif n'autorise pas un Host devenu indisponible.
2. Cliquer une seule fois sur « Démarrer le test Windows ». Cette action crée uniquement la réservation bêta privée prévue par le code, sans paiement réel. Le navigateur attend les états serveur avant d'obtenir son accès. Une session expirée renvoie à la connexion ; aucune erreur ne doit être contournée par une réservation publique.
3. Observer le bureau locataire, jamais le bureau fournisseur. Tester souris et clavier sur une application locale dans le compte locataire. Le compteur ne progresse que sur de nouvelles images H.264 réellement décodées et rendues. Il faut 300 secondes entre ces observations ; une actualisation d'interface, des paquets reçus seuls, un rejeu ou une image figée ne suffisent pas. Une coupure, un nouvel epoch, un dépassement du délai de trame ou une reconnexion remet la continuité à zéro, y compris après un résultat déjà affiché.
4. Relever les identifiants de session/réservation, SHA et horodatages sans conserver les cookies, tokens ou images privées. Le résultat vidéo ne prouve pas l'effet clavier/souris ni l'isolation matérielle : ces points sont à confirmer manuellement.
5. « Fermer la vidéo » ferme le transport et libère l'état des entrées ; il ne prétend pas terminer la location. Utiliser « Gérer la session », puis le bouton d'arrêt existant. Attendre la fin serveur et la confirmation Agent du nettoyage (worker, autorité, display virtuel de session, entrées et ressources). Ne pas déclarer PASS si la session reste active, QUARANTINED ou si le nettoyage n'est pas confirmé. Aucune facturation réelle ne doit apparaître.

Les tests automatiques simulent DOM, réseau et sessions ou utilisent des pairs WebSocket locaux. Ils couvrent refus et expiration d'authentification, préflight désactivé, escrow réel, Host devenu indisponible, reconnexion, binaire contre texte, révocation de flux ouverts et continuité décodée. Ils ne constituent pas le test PC1 → PC2. **Celui-ci n'a pas été effectué par Codex.**
