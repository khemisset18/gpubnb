# GPUbnb — modèle de menace pour les Workspaces Windows natifs

**Étude, 19 novembre 2026. Aucune autorisation de déploiement ni de streaming.**

## 1. Frontières de confiance

Un locataire GPUbnb peut être hostile, même s'il a payé. Une capture vidéo qui fonctionne ne démontre pas une isolation suffisante pour lui louer un bureau Windows. Protéger :
- le **propriétaire** (bureau personnel, documents, portefeuille, comptes, notifications, réseau local, sessions et autres GPU) ;
- le **locataire** (identité, espace de travail, données et périphériques attribués) ;
- le **plan de contrôle** (auth, réservation, durée, licence commerciale, autorité matérielle, STOP et facturation) ;
- l'**Agent Windows et son helper** (identité contrôlée, signature binaire, capture de la seule source locataire, ports médias locaux) ;
- le **transport** (WebRTC, TURN, Gateway), qui chiffre/transporte mais ne constitue ni une VM ni un système d'autorisation suffisant.

Un compte Windows sans droit administrateur n'est **pas équivalent** à une frontière VM sûre pour un inconnu autorisé à exécuter n'importe quel code. Un GPU NVENC, un RDP ou un canal WebRTC chiffré n'empêche pas une capture du mauvais bureau.

## 2. Menaces et garde-fous à préserver

| Menace | Risque | Garantie nécessaire |
| --- | --- | --- |
| Capture du **bureau du propriétaire** | Secrets, notifications, portefeuille, autres sessions | Source d'écran attachée uniquement à l'identité du locataire et à la VM/écran virtuel autorisé ; refus de toute ambiguïté |
| Injection de souris, clavier, manette sur le mauvais bureau | Prise de contrôle et actions non voulues | Ciblage exact de la session locataire, entrée bornée et révoquée lors du STOP |
| Serveur média ou protocole RDP/VNC accessible sans gateway | Contournement de la réservation et des jetons | Média/helper en 127.0.0.1, pare-feu entrant fermé, accès unique par Gateway GPUbnb |
| Jeton réutilisable après expiration, STOP, changement de locataire | Accès non payé ou fuite | Jeton court, spécifique à utilisateur/booking/session/génération, revocation linéarisée et fermeture des canaux |
| Mauvais GPU affecté ou GPU encore occupé par le mining | Mauvaise facturation, conflits physiques | GPU UUID exact, autorité signée, allocation exclusivement propriétaire du leasing |
| Crash de l'Agent pendant start/stop/nettoyage | Worker, écran et input orphelins | Journal durable, reprise fail-closed, preuve de suppression ou quarantaine |
| Billing suspendu pendant que le GPU exécute encore le programme | Usage gratuit ou litige | Pause physique vérifiée de la capture, de l'input et du calcul rentable avant suspension commerciale |
| Locataire admin, fichiers du fournisseur ou réseau LAN visible | Exfiltration et mouvement latéral | Identité sans admin, VM ou machine dédiée, ressources séparées, filtrage réseau et aucune donnée personnelle hôte |
| Helper/pilote non signé, chargé avec privilèges | Compromission hôte/noyau | Signature, hash et versions épinglées, processus au privilège minimum, pilote IddCx approuvé |
| Vidéo READY sans frame réellement reçue | Facturation d'un écran inutilisable | Activation seulement après preuve de média et d'accès locataire, débit/codec et liveness suffisants |
| TURN ouvert, identifiants statiques ou fuite de jetons | Bande passante abusive, usurpation | TURN authentifié avec identifiants éphémères, quotas, aucune clé dans les URL/logs |
| Gaming avec accès réseau propriétaire ou pilotes de manette douteux | Accès NAS, injection noyau, fuite LAN | Politique réseau application par application ; pilote de manette approuvé ; anti-triche incompatible = refus |
| Location du Workspace A et ouverture automatique de B | Facturation trompeuse | Identité immuable du Workspace sélectionné ; jamais de fallback silencieux |
| Licence d'application ou Windows inadéquate à un service commercial | Rupture de droits / service | Vérification des Product Terms Windows, de Steam, des pilotes et des licences GPL avant publication |

## 3. État réel du code sur la base de la PR #333

La base GitHub examinée est le HEAD exact **bae49d951c7801c4c8bf3dbf3a80295e2ce49e8a** de la [PR #333](https://github.com/khemisset18/gpubnb/pull/333).

- **agent/gpubnb_agent/windows_native_workspace.py** : profils existants cloud-desktop, creator, cad, gaming. Le contrat prévoit une vraie session locataire, un moniteur virtuel GPUbnb, un frame source prouvé, un encodeur matériel et un média loopback. Sa documentation précise que cela ne rend pas la machine réservable.
- **agent/gpubnb_agent/windows_native_runtime.py** : démarrage via helper natif, préflight de capture/encodage, UUID GPU exact, application attendue, média local. Le mode console-dedicated est explicitement privé.
- **agent/gpubnb_agent/workspace_gateway_v10.py** : intégration de la source Windows-native avec STOP, reconnexion et autorité ; **WINDOWS_NATIVE_INITIAL_WORKSPACE_SLUGS contient seulement cloud-desktop** et le module se dit dormant tant que le helper physique ne satisfait pas le contrat.
- **apps/api/src/windows-native-capability.ts** : lie les capacités Windows natives à l'UUID d'une carte NVIDIA effectivement déclarée.
- **apps/api/src/desktop-workspace-routes.ts** : chemin de qualification privée séparé des réservations commerciales ; ne constitue pas une autorisation d'activation publique.
- **apps/api/src/workspace-gateway.ts / workspace-session-stop.ts** : contraintes d'autorisation et STOP à réutiliser, sans ouvrir de transport alternatif non filtré.

**Conséquence :** les profils quatre Workspaces et les briques de contrôle ont une base logicielle. **Aucun des quatre Workspaces Windows n'est certifié louable en production par ce document.** Un simple ajout des trois slugs à la liste d'acceptation serait dangereux.

## 4. Architecture de sécurité proposée

    Locataire navigateur GPUbnb
      | Identité, réservation, session, grant court
      v
    API GPUbnb + PostgreSQL/Redis (autorité et STOP)
      | Décision d'accès par session précise
      v
    Gateway GPUbnb (seul point exposé)
      | Flux média chiffré / DataChannel borné
      v
    Agent Windows + helper signé (média 127.0.0.1)
      | Session locataire / VM et GPU UUID vérifiés
      v
    Capture dédiée (IddCx ou sortie VM) → NVENC → WebRTC
    Audio WASAPI associé au locataire, input sur sa session uniquement

    BUREAU PROPRIÉTAIRE : aucun flux, aucune entrée, aucun secret partagé

**Une location à la fois sur une machine physique réellement dédiée :** potentiellement réalisable avec un Windows autorisé, mais nécessite des mesures d'isolation et de nettoyage. Cela n'autorise pas la diffusion de la session personnelle du propriétaire. Ne pas supposer qu'une séparation par comptes utilisateurs équivaut à une isolation contre des locataires exécutant un logiciel hostile.

**Plusieurs locations simultanées ou code arbitraire (Developer, API, Security Lab) :** VM isolée recommandée. L'option GPU-P documentée concerne des configurations Windows Server 2025, GPU/pilotes validés et droits spécifiques ; elle n'est pas un accélérateur gratuit universel pour tous les Windows 11. Voir [Microsoft GPU-P](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/gpu-partitioning) et [NVIDIA validated platforms](https://docs.nvidia.com/vgpu/latest/grid-vgpu-release-notes-microsoft-windows-server/validated-platforms.html).

## 5. Approches sans sécurité : visibles dans la recherche, interdites à la location

À documenter pour comparaison mais à **ne jamais brancher à GPUbnb** : partage direct du bureau quotidien ; comptes administrateurs partagés ; port RDP/VNC/WebSocket ouvert publiquement ; endpoints d'input qui acceptent toute connexion ; contrôle d'écran virtuel par pilote non approuvé ; contournement de la licence RDP ; antivirus/pare-feu désactivés ; tokens de contrôle permanents ; lecture de la console physique privée ; accès réseau LAN complet ; absence de cleanup après STOP.

Pour une preuve de concept académique sur une machine **sans données sensibles et sans tiers**, quelques bibliothèques permettent de produire une image. Cela n'équivaut pas à une solution commercialisable.

## 6. Portée et décisions explicites

- **La PR actuelle est une revue documentaire.** Pas de code d'Agent, de helper, d'encodeur, de pilote ni de configuration en production.
- **Ne pas modifier le statut d'une machine, la quarantaine, le champ de disponibilité ou la liste de slugs autorisés.**
- **Ne pas installer ni lancer de composants PC1/PC2, Render, relay, Steam ou streaming.**
- **Ne pas lancer de tests ni créer de plan de test utilisateur** : les essais réels restent du ressort de l'utilisateur ; une validation de sécurité indépendante reste néanmoins exigée avant toute commercialisation.
- **Une CI verte et un commentaire informel ne sont pas une revue de sécurité.** Une approbation GitHub formelle indépendante sur le HEAD exact, non révoquée et non invalidée, reste distincte de la permission de déployer.

## Sources

[Windows capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) · [DXGI](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api) · [IddCx](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview) · [NVIDIA Video Codec SDK](https://developer.nvidia.com/video-codec-sdk) · [WebRTC DTLS](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels) · [Windows licenses](https://www.microsoft.com/licensing/terms/en-US/product/WindowsDesktopOperatingSystem/all) · [Windows Server GPU-P](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/gpu-partitioning) · [Guacamole TOTP](https://guacamole.apache.org/doc/gug/totp-auth.html) · [coturn](https://github.com/coturn/coturn).
