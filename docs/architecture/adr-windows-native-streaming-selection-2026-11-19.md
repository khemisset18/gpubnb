# ADR — streaming Windows natif gratuit, sécurisé, sans Linux : choix pour GPUbnb

**Statut : PROPOSÉ, non approuvé, non implémenté, non réservable. Date : 2026-11-19.**

Documents compagnons :
- [Inventaire des méthodes, y compris les approches non sécurisées](./windows-native-streaming-options-2026-11-19.md)
- [Modèle de menace et frontières indispensables](../security/windows-native-streaming-threat-model-2026-11-19.md)

## 1. Que signifie « sans Linux » ?

**Deux cas légitimes :**
1. **Pas de Linux sur le PC loué** : tous les logiciels de l'espace de travail tournent dans Windows natif ; un éventuel serveur de signalisation Web pourrait tourner ailleurs sous Linux. Cette restriction est facile à satisfaire par plusieurs stacks.
2. **Aucun Linux nulle part, ni sur PC hôte ni sur les serveurs GPUbnb** : privilégier des composants dont l'exécution **native Windows** est documentée. La pile WebRTC peut être réalisée avec [Windows capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) ou [DXGI](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api), [GStreamer Windows](https://gstreamer.freedesktop.org/documentation/installing/on-windows.html) ou [NVENC](https://developer.nvidia.com/video-codec-sdk), [Pion WebRTC](https://github.com/pion/webrtc) sur Windows, [MediaMTX Windows](https://mediamtx.org/docs/kickoff/introduction) si un relay média est souhaité et [coturn](https://github.com/coturn/coturn) (port Windows natif déclaré, à valider pour la configuration précise). [LiveKit local](https://docs.livekit.io/transport/self-hosting/local/) documente également Windows. Le navigateur fonctionne de manière native sur PC, mobile/tablette selon fonctionnalités et performances.

**Apache Guacamole** est une solution de navigateur intéressante, mais ses déploiements officiellement décrits reposent sur guacd + servlet/Tomcat ou des conteneurs ; **ne pas la présenter comme une solution sans Linux totalement packagée et prête sous Windows**. [Installation officielle](https://guacamole.apache.org/doc/gug/installing-guacamole).

## 2. Décision technique

### Choix A — produit GPUbnb navigateur

Sélection architecturale **Windows Graphics Capture ou DXGI / écran IddCx locataire → encodeur GPU matériel → transport WebRTC chiffré** ; Gateway GPUbnb reste l'autorité commerciale et STOP, tandis que le navigateur utilise WebRTC media + DataChannel pour clavier/souris/manette. Éléments recommandés :

| Couche | Choix gratuit envisageable | Justification / condition |
| --- | --- | --- |
| Capture Windows | WGC ou DXGI lié à la **source locataire** | Natif ; la propriété du moniteur doit être attestée ; éviter tout fallback sur la console privée |
| Écran virtuel | Windows IddCx avec driver signed + provenance | Source d'affichage locataire ; ne suffit pas à créer une session OS sécurisée |
| Vidéo | NVENC via SDK NVIDIA ou GStreamer Windows | H.264/HEVC/AV1 dépend du GPU, du navigateur et des droits codecs |
| Audio | WASAPI lié à la session locataire + codec Opus | Synchronisation et aucune capture du microphone / des sons du fournisseur |
| Streaming et input | WebRTC + Pion (MIT) ou libwebrtc | Chiffrement natif ; autorisation GPUbnb obligatoire en plus |
| Signalisation | API GPUbnb existante (auth, booking, session) | Ne pas créer de second plan d'autorisation |
| NAT / relay | coturn auto-hébergé avec identifiants courts ; P2P si possible | Pas de service SaaS obligatoire ; la bande passante reste payante |
| SFU optionnel | LiveKit OSS, sinon P2P direct | Un locataire par session n'exige pas automatiquement un SFU |
| Client | HTML5 GPUbnb + Gamepad API | Aucun logiciel côté locataire, entrée strictement bornée |
| Isolement | **VM Windows dédiée** si code arbitraire ; ou hôte physiquement dédié et réinitialisé selon le risque | Le transport ne suffit pas ; droits Windows et GPU à vérifier |

**Précision :** ce choix constitue une architecture à construire, **pas** un installateur ou une fonctionnalité prête. La possibilité de l'exécuter sur Windows natif sans Linux n'apporte pas une licence commerciale Windows gratuite.

### Choix B — gaming client natif

**Sunshine (GPL-3.0-only) + Moonlight** est un candidat sérieux pour une meilleure expérience gaming en **client natif**, avec manettes et encodeur GPU. Le manque de client Moonlight Web officiel empêche d'en faire la solution « 100 % navigateur GPUbnb » sans développement spécifique. Son existence ne dispense ni l'auth GPUbnb, ni l'isolement Windows, ni la preuve de STOP et de nettoyage. [Sunshine](https://github.com/LizardByte/Sunshine), [Moonlight FAQ](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions).

### Choix C — bureau Windows HTML5, sans Gaming haute performance

**Guacamole + RDP** reste une bonne voie pour du bureau professionnel, sur une cible licite et isolée. Le déploiement Guacamole classique peut employer un serveur non Windows, et RDP exige les éditions/permissions Microsoft adaptées. Cette voie ne résout **pas** la manette ou la latence gaming. [Guacamole](https://guacamole.apache.org/), [RDP hosting editions](https://learn.microsoft.com/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access).

## 3. Gammes de Workspaces possibles avec moteur commun

| Workspace | Logiciels ou rôle Windows | Difficulté spécifique |
| --- | --- | --- |
| Cloud Desktop | Bureau locataire isolé | Écran virtuel fiable, identité différente du fournisseur |
| Creator | Blender, Krita et outils créatifs autorisés | Rendu GPU, souris précise, licence des plugins |
| CAD | FreeCAD et outils CAD | Précision graphique, persistance et import/export stricts |
| Gaming | Steam et jeux autorisés appartenant au locataire | Audio, manettes, anti-triche, réseau sortant filtré, licences jeu |
| Video | FFmpeg, logiciels de montage selon droits | NVENC, audio synchronisé, quotas stockage |
| Audio | Audacity, Reaper (licence séparée), FFmpeg | Flux bidirectionnel, périphériques audio dédiés |
| Developer | Éditeurs et SDK Windows | Code non fiable : **VM recommandée** |
| API | Node / Python / serveurs de développement | Port local reverse proxy, risque d'exécution arbitraire |
| AI / Data | Python, Jupyter, CUDA, PyTorch | GPU exact, mémoire, accès réseau et modèle |
| Mobile | Android Studio, émulateurs | GPU et virtualisation imbriquée, limites VM/hyperviseur |
| Security Lab | Analyse et outillage de sécurité | **VM jetable indispensable**, jamais le Windows personnel |
| Unreal / Unity 3D | Moteurs de jeux sur Windows | Matériel, licences, GPU et cache volumineux |
| Architecture / BIM | Logiciels BIM selon droits | Licences souvent non gratuites, compatibilité GPU |
| 3D / animation | Blender et outils libres | Optimisation de streaming et sauvegarde dédiée |

Pour tous ces produits, **un nom dans le catalogue n'est pas un statut READY**. Les capacités et droits de chaque profil doivent être déterminés séparément.

## 4. Coût réel, même avec des logiciels gratuits

- **Gratuit logiciel** : Pion MIT, coturn OSS, MediaMTX OSS, Guacamole Apache-2.0, Sunshine GPL-3.0, certains outils de création.
- **Pas gratuitement garanti** : licence Windows/serveur/VM, droits de location commerciale, NVIDIA vGPU/GPU-P et pilotes, bande passante TURN, électricité, GPU, encodage logiciel tiers, licences de jeux, Steam et outils propriétaires.
- **Aucun coût de licence de streaming** ne signifie **pas** « location commerciale légale sans frais ». Faire examiner les [Windows Product Terms](https://www.microsoft.com/licensing/terms/en-US/product/WindowsDesktopOperatingSystem/all), les [CAL RDS](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/rds-client-access-license) et les conditions de chaque application.

## 5. Sécurité et statut de mise à disposition

| Décision | État |
| --- | --- |
| Étudier les voies gratuites, sécurisées et non sécurisées | **Autorisé en lecture/documentation** |
| Choisir WebRTC sur Windows natif comme piste principale | **ADR proposée uniquement** |
| Réutiliser les contrats du helper Windows existant de PR #333 | **Oui en conception**, aucune activation |
| Ajouter Creator/CAD/Gaming aux slugs Windows natifs autorisés | **NON** sans helper, licence, preuve physique et revue de sécurité |
| Déployer des composants, créer un tunnel média ou lancer PC1 | **NON** |
| Lever la quarantaine ou faire PC1 → PC2 | **NON** |
| Certifier READY ou facturer des locations de ce nouveau backend | **NON** |
| Utiliser une approche sans authentification ou bureau partagé pour une location | **NON** |
| Déclarer la CI comme revue de sécurité | **NON** |

Cette nouvelle PR est volontairement **documentaire et en brouillon**. Elle ne demande **aucun test automatisé ou préparation de test au propriétaire** ; les futurs essais des Workspaces sur le site sont de son choix. Ils ne remplacent pas la preuve de séparation propriétaire/locataire, les droits logiciels ni une revue indépendante sur le HEAD exact.

## 6. Pourquoi une PR séparée

La [PR #333](https://github.com/khemisset18/gpubnb/pull/333) contient le développement existant de l'autorité de sécurité Windows. La [PR #378](https://github.com/khemisset18/gpubnb/pull/378) porte une initiative différente centrée sur la pile **Linux/Selkies** pour quatre bureaux. Cette ADR Windows est **indépendante de #378**, basée sur le HEAD de #333 et ne réécrit aucun de leurs commits. Elle évite de confondre étude des logiciels, correction du code, validation de sécurité, et autorisation de déploiement.

**Suite envisageable, dans une autre PR de code après décision architecturale :** mettre en place un helper natif Windows à capture prouvée, des grants temporaires et du contrôle d'input, toujours sans activer une machine réelle tant que les garanties de sécurité et les droits commerciaux ne sont pas établis.
