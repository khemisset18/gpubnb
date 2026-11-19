# GPUbnb — panorama des méthodes de streaming Windows sans Linux

**Recherche documentaire datée du 19 novembre 2026 — aucune activation de production.**

## Objectif et précision sur le mot « gratuit »

Comparer les méthodes réellement disponibles pour faire fonctionner Cloud Desktop, Creator (Blender), CAD (FreeCAD), Gaming et d'autres Workspaces **sur un hôte Windows natif**, avec image, audio, clavier, souris et éventuellement manette dans GPUbnb. Inclure les voies sécurisables et celles **sans isolation ou sécurité adéquate** afin de rendre le choix transparent. Cette dernière catégorie est **à étudier, pas à déployer**.

Un dépôt logiciel sans coût de licence ne garantit **ni** une exploitation commerciale gratuite, **ni** la gratuité de Windows, des licences applicatives, de NVIDIA vGPU, du réseau/TURN, des GPU et de l'hébergement. Les obligations Microsoft, NVIDIA, Steam et celles des autres applications doivent être vérifiées pour le scénario précis : **location payante à des tiers non apparentés**. Le statut « réalisable » ci-dessous n'est pas une preuve physique, ni une sécurité approuvée sur GPUbnb.

**Terminologie :**
- **Navigateur natif** : le locataire n'installe pas de client.
- **Client requis** : application desktop/mobile à installer.
- **Transport fonctionnel** : le projet amont sait transporter du bureau/des médias. Cela ne prouve jamais le parcours commercial GPUbnb.
- **Isolement fournisseur/locataire** : propriété du système de sessions / de la VM, **jamais** une propriété déduite de WebRTC, RDP, NVENC, d'un compte Windows ou d'une capture écran.
- **Sans sécurité** : accès sans contrôle suffisant, capture du bureau propriétaire, ou absence d'isolation forte ; pas « option à débloquer » par un flag.

## 1. Méthodes complètes de prise en main

| Méthode | Logiciel gratuit / licence | Navigateur sans client | Audio / manette | Adéquation | Blocage principal |
| --- | --- | --- | --- | --- | --- |
| **Windows capture + NVENC + WebRTC maison** (WGC ou DXGI, Media Foundation/GStreamer, Pion ou libwebrtc, coturn) | Composants open source possibles ; NVIDIA Video Codec SDK avec conditions distinctes | **Oui** | Audio réalisable ; manette via Gamepad API + protocole d'entrée vérifié | **Meilleur chemin produit**, demande de développement | Il faut construire et auditer capture dédiée, serveur de signalisation, identité, entrée, STOP, nettoyage et isolation |
| **Sunshine + Moonlight** | Sunshine **GPL-3.0-only** ; Moonlight open source | **Non, pas de client Web officiel** | Oui, très orienté jeu ; compatibilité matérielle à vérifier | Excellent candidat pour client natif / référence performance | Intégration Web GPUbnb non directe, licences GPL, bureau propriétaire à protéger ; pas une frontière d'isolation |
| **Apache Guacamole + RDP Windows** | Guacamole Apache-2.0, gratuit | **Oui** | Clavier/souris, possibilités audio RDP ; manette/gaming limité | Bureau, CAD léger, administration | Windows hôte RDP Pro/Enterprise/Server, licence commerciale et sessions à examiner ; ne pas exposer RDP |
| **Apache Guacamole + VNC Windows** | Guacamole gratuit ; serveur VNC selon licence | **Oui** | Audio/manette non natifs, variable selon serveur | Bureau simple, dépannage | Capture parfois bureau console partagé, sécurité VNC dépend fortement du serveur |
| **noVNC + serveur VNC + websockify** | noVNC **MPL-2.0** ; serveur VNC à choisir | **Oui** | Souvent pas audio/manette ; latence et qualité variables | Solution minimale de navigateur | VNC brut et affichage console potentiellement dangereux sans isolat ni gateway |
| **MeshCentral** | **Apache-2.0**, auto-hébergeable | **Oui** | Contrôle clavier/souris ; pas une plate-forme gaming | Administration interne / dépannage | Fonctionnalités RMM puissantes ; ne pas exposer les fonctions agent/fichiers/terminal au locataire |
| **RustDesk Server OSS + clients RustDesk** | Serveur OSS gratuit | **Non pour un client Web auto-hébergé OSS garanti** | Bureau, audio possible selon client ; pas gaming Web | Support distant / contrôle via application | Web self-host et contrôles d'entreprise documentés côté **Server Pro**, payant |
| **RDP classique + client natif (mstsc / FreeRDP)** | Client FreeRDP **Apache-2.0** ; droits Windows séparés | **Non** | Audio selon configuration ; faible adéquation jeu | Bureautique sur Windows Pro/Server | Licence OS/session, pas navigateur et aucune isolation locataire garantie |
| **OBS Studio + sortie vidéo** | OBS **GPL-2.0** | Selon récepteur choisi | Image/son surtout en sens unique | Démonstration, vidéo non interactive | Il faut ajouter une entrée authentifiée et une session isolée ; pas un Workspace louable seul |
| **Steam Remote Play** | Fonctionnalité du produit Steam ; logiciel propriétaire | **Non, client Steam** | Oui pour le jeu compatible | Usage personnel/jeu selon droits | Conditions d'utilisation, comptes et distribution commerciale de sessions à vérifier ; aucune isolation GPUbnb |
| **Parsec / Chrome Remote Desktop / outils commerciaux de prise en main** | Certaines offres gratuites, **non open source et licences restrictives/variables** | Variable | Bonnes performances possibles | Référence ergonomie seulement | Ne jamais assimiler gratuit « usage personnel » et droit de revendre des locations |

Sources de projet : [Sunshine](https://github.com/LizardByte/Sunshine), [Moonlight FAQ](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions), [Guacamole](https://guacamole.apache.org/), [noVNC](https://github.com/novnc/noVNC), [MeshCentral](https://github.com/Ylianst/MeshCentral), [RustDesk OSS / Pro](https://rustdesk.com/docs/en/self-host/), [FreeRDP](https://github.com/FreeRDP/FreeRDP), [OBS](https://github.com/obsproject/obs-studio).

**Points confirmés** : Moonlight indique qu'il **n'existe pas de client purement Web officiel** ; RustDesk distingue bien **Server OSS** et **Server Pro** pour l'hébergement de son client Web et l'administration avancée. Sunshine supporte Windows et l'encodage GPU, sans assurer l'isolation d'un locataire. [FAQ Moonlight](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions), [RustDesk](https://rustdesk.com/docs/en/self-host/), [Sunshine](https://docs.lizardbyte.dev/projects/sunshine/latest/).

## 2. Bibliothèques, protocoles et briques gratuites (pas des Workspaces complets)

| Brique | Fonction | Limite |
| --- | --- | --- |
| [Windows.Graphics.Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) | Capturer une fenêtre/un écran avec consentement système ; API de capture Windows | Ne crée ni un bureau locataire, ni une session indépendante, ni l'authentification |
| [DXGI Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api) | Capture rapide d'une sortie DirectX Windows | Pas de séparation entre utilisateur propriétaire et locataire ; comportement bureaux protégés à traiter explicitement |
| [IddCx / indirect display driver](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview) | Créer un moniteur virtuel détenu par le chemin Windows natif | Pilote, chaîne de confiance, signature et contrôle de la source nécessaires ; un moniteur virtuel n'est pas une VM |
| [NVIDIA Video Codec SDK / NVENC](https://developer.nvidia.com/video-codec-sdk) | Encodeur GPU à faible charge CPU | GPU/pilote et conditions NVIDIA compatibles ; ne transporte pas le flux |
| [GStreamer](https://gstreamer.freedesktop.org/features/) | Capture, audio WASAPI, NVCODEC, pipeline multimédia, WebRTC selon modules | Pipeline applicatif à développer et durcir |
| [Pion WebRTC](https://github.com/pion/webrtc) | Stack WebRTC en Go, **MIT** | Ne capture pas un bureau et ne crée pas d'isolation de sessions |
| [coturn](https://github.com/coturn/coturn) | Serveur STUN/TURN gratuit open source | Bande passante/serveur à financer ; identifiants éphémères impératifs |
| [LiveKit auto-hébergé](https://github.com/livekit/livekit) | SFU WebRTC **Apache-2.0** | Évite de construire un SFU, mais ne capture/contrôle pas le bureau Windows |
| [MediaMTX](https://github.com/bluenviron/mediamtx) | Media server WebRTC / RTSP et autres | Médias essentiellement ; entrée souris/manette/autorisation à développer |
| [OvenMediaEngine](https://github.com/OvenMediaLabs/OvenMediaEngine) | Diffusion WebRTC basse latence | Broadcasting ≠ prise en main sécurisée ; vérifier conditions de licence et distribution |
| [Apache Guacamole](https://guacamole.apache.org/) | Passerelle RDP/VNC/SSH + client HTML5 | Son protocole n'apporte pas de VM ni de GPU dédié |
| [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API) | Lire les boutons et axes depuis le navigateur | Injection côté Agent à implémenter avec bornes, autorisations et révocation |

### Intégrations documentées mais **non retenues telles quelles**

Des prototypes publics montrent une chaîne Windows + GStreamer + NVENC + WebRTC, par exemple [Fabi-SPL/remote-desktop](https://github.com/Fabi-SPL/remote-desktop) et [ModernInteractiveTransmission](https://github.com/PabloDeGroot/ModernInteractiveTransmission). Le premier avertit lui-même que quiconque accède au port de commande peut contrôler la machine. Ces dépôts prouvent la faisabilité technique de la capture/streaming, **pas** le contrôle d'accès et la qualité de sécurité GPUbnb ; ne pas les installer sur PC1 ni publier leurs ports.

[Chrome Remote Desktop](https://remotedesktop.google.com/), [Parsec](https://parsec.app/) et [Steam Remote Play](https://store.steampowered.com/remoteplay/) sont pertinents pour une comparaison fonctionnelle, pas comme fondement « libre commercial » sans accord et droits explicites.

## 3. Quatre familles d'isolement sous Windows (distinctes du streaming)

| Modèle | Possibilité réelle | Isolation contre un locataire hostile | Coût/droits |
| --- | --- | --- | --- |
| **PC physique dédié à un seul locataire, un à la fois**, session Windows locataire distincte et privilèges minimaux, source capture exclusivement locataire | Techniquement envisageable avec helper signé | **Conditionnelle / pas équivalente à une VM** ; aucun bureau du propriétaire sur le même PC durant la location ; effacement/identité à prouver | Matériel + licence Windows/accès distant + app |
| **Une VM Windows par locataire avec GPU attribué** (Hyper-V DDA, passthrough adapté) | Oui sur hôte/accélérateur/OS compatibles ; disponibilité GPU par VM | Potentiellement forte si VM, périphérique et réseau correctement isolés | Windows Server/VM/licence et GPU compatibles ; pas « tout gratuit » |
| **GPU-P sur Windows Server 2025 et GPU validé** | Microsoft documente le partage d'un GPU entre plusieurs VM | Meilleure architecture pour multi-locataires si validée et supportée | Compatibilité GPU NVIDIA, pilotes vGPU, licences et serveur ; **coûts possibles** |
| **Même session console Windows partagée** (RDP/streamer/Sunshine/VNC) | Image et entrées peuvent fonctionner vite | **NON** : écran, secrets, données, privilèges ou sessions du propriétaire exposables | Logiciel éventuellement gratuit ; usage locatif inadmissible sans autre cloisonnement |
| **Windows Sandbox / conteneurs Windows** | Sandbox/containers possibles pour certains usages | **N'en fait pas automatiquement** un bureau 3D/audio/manette locatif GPU isolé et persistant | Limites GUI, virtualisation et licences ; pas une réponse clé en main |

Références : [Microsoft — GPU-P Windows Server 2025](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/gpu-partitioning), [GPU-P assignation](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/partition-assign-vm-gpu), [NVIDIA — plates-formes validées](https://docs.nvidia.com/vgpu/latest/grid-vgpu-release-notes-microsoft-windows-server/validated-platforms.html), [Windows containers GUI limits](https://learn.microsoft.com/en-us/virtualization/windowscontainers/quick-start/lift-shift-to-containers).

**Licences** : Windows 11 Home n'est pas hôte RDP ; Windows Pro/Enterprise/Server ont des capacités différentes. Les [Product Terms Windows](https://www.microsoft.com/licensing/terms/en-US/product/WindowsDesktopOperatingSystem/all) encadrent les droits d'accès distant, de virtualisation et de tiers. [RDS CAL](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/rds-client-access-license) peut être nécessaire pour des hôtes RDS. **Ne jamais promouvoir une location commerciale au seul motif qu'un RDP ou une capture fonctionne**. Validation juridique/licences requise avant vente.

## 4. Approches « sans sécurité » / raccourcis : inventaire des risques, pas des solutions livrables

| Raccourci observé dans l'écosystème | Ce qui paraît fonctionner | Risque majeur / statut GPUbnb |
| --- | --- | --- |
| Sunshine/OBS/VNC sur le **bureau quotidien du propriétaire** | Vidéo et contrôle à distance | Capture de secrets, presse-papiers, fenêtres, fichiers et notifications du propriétaire : **rejeté** |
| Exposer RDP 3389, VNC 5900 ou endpoint de commande sur Internet | Connexion directe | Brute force, intrusion, session déconnectée non révoquée : **rejeté** |
| Un serveur WebRTC qui accepte toute offre SDP sans session GPUbnb authentifiée | Vidéo/entrée depuis le navigateur | Le chiffrement n'est **pas** une autorisation : contrôle non consenti : **rejeté** |
| Utiliser un compte Windows administrateur ou partagé avec mot de passe constant | Applications démarrent facilement | Élévation et persistance entre locataires : **rejeté** |
| Contourner limites RDP Windows 11 via wrappers/patch de sessions | Plusieurs connexions apparentes | Rupture support/licences et surface d'attaque OS : **rejeté** |
| Installer un pilote écran virtuel non signé ou désactiver protections Windows | Écran virtuel semble disponible | Chaîne de confiance rompue, escalade et pannes : **rejeté** |
| Port média/helper accessible hors **127.0.0.1** | Débogage plus facile | Contournement de la gateway et des jetons GPUbnb : **rejeté** |
| Redis/grants réutilisables après STOP ou après expiration | Reconnexion marche | Locataire reprend le contrôle sans paiement : **rejeté** |
| Réutiliser un GPU physique sans preuve exacte du GPU loué | Performance apparente | GPU propriétaire/locataire croisés, conflit avec mining : **rejeté** |
| Désactiver pare-feu, Defender, UAC, Secure Boot pour gagner du temps | Moins d'erreurs visibles | Suppression des défenses et absence d'auditabilité : **rejeté** |
| Donner accès complet au réseau local depuis le Workspace | Steam ou téléchargements marchent | Accès aux NAS, caméras, autres PC ou wallets du propriétaire : **rejeté** |
| Déclarer READY sur « helper lancé », sans image réellement vue par le locataire | Statut vert | Facturation sans service et faux positif : **rejeté** |
| Rediriger un Workspace indisponible vers Cloud Desktop/Developer | Le bouton « ouvrir » marche | Produit livré différent de la commande : **rejeté** |

Dans des démonstrations isolées, certaines voies sont simples et utiles pour comprendre les protocoles. Dans **une place de marché payante avec locataires inconnus**, elles ne satisfont pas aux exigences de sécurité.

## 5. Comparatif Windows par catégorie de Workspace

| Produit | Logiciels natifs Windows potentiels | Média / entrée | Isolement nécessaire |
| --- | --- | --- | --- |
| Cloud Desktop | Bureau dédié | WebRTC H.264/AV1 selon GPU, son, clavier/souris | Session isolée ou VM |
| Creator | Blender, Krita (licences à vérifier) | Vidéo graphique et périphériques de pointage | Session/VM, GPU exact |
| CAD | FreeCAD, autres outils selon droits | Dessin 3D, souris précise, raccourcis | Session/VM, GPU exact |
| Gaming | Steam / jeux du locataire ; compatibilité et CGU variables | Faible latence, audio, Gamepad API + contrôleur virtuel borné | Session/VM, filtrage réseau par application ; anti-triche potentiellement incompatible |
| Developer / API | VS Code, Node, Python, outils libres | Bureau/RDP ou terminal Web ; pas forcément capture vidéo GPU | **VM recommandée** si locataire peut exécuter du code arbitraire |
| Data / IA | Python, Jupyter, CUDA, PyTorch | Navigateur Jupyter, parfois bureau | VM ou conteneur durci *dans* VM pour utilisateurs non fiables |
| Mobile | Android Studio, émulateur selon hyperviseur | Bureau et périphériques | VM/virtualisation imbriquée et droits logiciels à vérifier |
| Video / Audio | Blender/DaVinci selon licence, OBS, Audacity, FFmpeg | Audio synchronisé, montage, codec matériel | Session/VM avec périphériques dédiés |
| Security Lab | Analyse de fichiers potentiellement malveillants | Bureau ou UI web | **VM jetable à forte isolation obligatoire**, jamais session Windows partagée |

## 6. Conclusion de la comparaison

**Voie produit privilégiée pour GPUbnb (navigateur)** : source graphique locataire isolée (IddCx ou VM), Windows capture DXGI/WGC selon preuve de session, encodeur matériel NVENC/AMF/QuickSync selon GPU et licences, WebRTC DTLS-SRTP pour médias et DataChannel pour clavier/souris/manette, **gateway GPUbnb existante** pour session commerciale et révocation, TURN auto-hébergé si nécessaire. Les éléments open source ne suppriment pas le développement ni le coût d'hébergement.

**Voie plus rapide pour bureautique** : Guacamole+RDP uniquement vers une cible Windows autorisée et réellement isolée, sous réserve des droits Microsoft. **Voie plus rapide avec client natif pour gaming** : Sunshine+Moonlight, mais pas de promesse « dans le navigateur » et pas d'accès au bureau du propriétaire.

**Aucune voie « sans sécurité » ne devient réservable.** Seule une revue indépendante de la nouvelle architecture et la qualification réelle de la frontière Windows locataire/fournisseur peuvent changer cette décision. Les méthodes source sont réelles, mais **aucune n'a été prouvée intégrée à GPUbnb ici**.

## Sources primaires consultées (19/11/2026)

- Microsoft — capture [WGC](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture), [DXGI](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api), [IddCx](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview).
- NVIDIA — [Video Codec SDK/NVENC](https://developer.nvidia.com/video-codec-sdk), [vGPU validated platforms](https://docs.nvidia.com/vgpu/latest/grid-vgpu-release-notes-microsoft-windows-server/validated-platforms.html).
- Microsoft — [GPU-P Hyper-V](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/gpu-partitioning), [Windows licence](https://www.microsoft.com/licensing/terms/en-US/product/WindowsDesktopOperatingSystem/all), [RDS CAL](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/rds-client-access-license), [RDP host editions](https://learn.microsoft.com/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access), [Windows containers/GUI](https://learn.microsoft.com/en-us/virtualization/windowscontainers/quick-start/lift-shift-to-containers).
- Mozilla MDN — [WebRTC DataChannels chiffrés DTLS](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels), [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API).
- Projets open source — [Sunshine GPL-3](https://github.com/LizardByte/Sunshine), [Moonlight FAQ](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions), [Guacamole](https://guacamole.apache.org/), [noVNC MPL-2](https://github.com/novnc/noVNC), [MeshCentral Apache-2](https://github.com/Ylianst/MeshCentral), [RustDesk OSS/Pro](https://rustdesk.com/docs/en/self-host/), [Pion MIT](https://github.com/pion/webrtc), [coturn](https://github.com/coturn/coturn), [LiveKit Apache-2](https://github.com/livekit/livekit), [GStreamer](https://gstreamer.freedesktop.org/features/), [MediaMTX](https://github.com/bluenviron/mediamtx), [OvenMediaEngine](https://github.com/OvenMediaLabs/OvenMediaEngine), [OBS](https://github.com/obsproject/obs-studio).
