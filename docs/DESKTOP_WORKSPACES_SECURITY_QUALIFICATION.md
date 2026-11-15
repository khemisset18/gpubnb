# GPUbnb — Qualification sécurité des quatre bureaux GPU (NO-GO)

**Périmètre :** Cloud Desktop, Creator, CAD, Gaming ; préparation du parcours Windows PC1 (fournisseur) → site GPUbnb → PC2 (locataire). **Cette PR est préparatoire et non déployable.** Aucune activation de réservation, fusion, installation PC1/PC2, Render, secret ou sortie de quarantaine n'est autorisée.

## Résultats de l'audit statique (non équivalents à des tests d'exécution)

- Les quatre Dockerfiles partagent la même image `linuxserver/webtop` épinglée par digest. Creator installe Blender, CAD FreeCAD, Gaming Steam ; Cloud Desktop utilise la base.
- `apps/api/src/machine-workspace-catalog.ts` exclut les quatre slugs de `executableWorkspaceSlugs` ; `agent/gpubnb_agent/workspace_gateway.py` les exclut aussi de `GATEWAY_WORKSPACE_SLUGS`. **Ne pas retirer ces deux verrous.**
- `platform_info.desktop_gpu_rendering_available()` teste Linux non-WSL, un nœud `/dev/dri/render*` et le runtime NVIDIA. C'est un signal préalable, **pas une preuve** OpenGL/EGL accéléré dans le conteneur sur le GPU loué.
- Les quatre `healthcheck.sh` vérifient HTTP et, selon le cas, l'exécutable. Ils ne prouvent ni GPU ni streaming ni isolation.
- Le profil Webtop est moins restrictif que les autres Workspaces : pas de `--read-only` ni `--cap-drop=ALL` car la base ne démarre pas avec ces options. La liste minimale de capacités et la surface d'écriture restent à qualifier.
- **Décalage de ressources :** manifestes Cloud Desktop 8 Gio RAM minimum, Creator/CAD/Gaming 16 Gio ; branche Docker correspondante `--memory=4g` et `--memory=8g`. Vérifier les plafonds d'allocation et la concurrence avant tout changement.
- La branche Docker utilise `NVIDIA_DRIVER_CAPABILITIES=graphics,display,utility,compute` ; l'accès au moteur vidéo matériel doit être vérifié selon le codec réellement choisi (ne pas présumer que `video` est requis ou suffisant).
- Gaming : le lancement Steam ne prouve ni jeu accéléré, ni entrée manette navigateur, ni audio bidirectionnel, ni latence acceptable.
- Le script `preflight-linux-gpu-desktop.sh` nécessite un vrai hôte compatible. Son test `glxinfo` en conteneur Ubuntu minimal peut échouer faute de contexte d'affichage ; remplacer ou compléter par une preuve EGL/OpenGL headless explicite, avec contrôle du renderer, et un test d'encodage matériel réellement exploitable.

## Matrice de risque et corrections proposées (non appliquées)

| Niveau | Risque | Correction proposée | Preuve exigée |
| --- | --- | --- | --- |
| P0 | Bureau privé du fournisseur visible sur PC2 | Session Windows isolée, fenêtre/desktop explicitement autorisé, fail-closed et tests écran fournisseur | Capture contrôlée montrant absence de pixels privés |
| P0 | STOP/révocation tardive, flux ou commandes encore actifs | Contrôle de génération/epoch sur vidéo et entrées, révocation atomique, purge des files et fermeture | Tests concurrence + STOP physique + aucun nouvel input/frame après coupure (buffers en vol documentés) |
| P0 | Webtop démarré avec privilèges excessifs | Préparer une image durcie, isoler chemins écrits, limiter les capacités et valider les droits du volume | Tests de démarrage et de résistance à l'évasion |
| P0 | Faux positif GPU | Vérification dans l'image finale du GPU exact, OpenGL/EGL matériel et encodage matériel | Logs renderer NVIDIA, identifiant GPU, mesure vidéo |
| P1 | Limites mémoire plus basses que les minima annoncés | Définir une politique cohérente de ressources garanties/limites et tests OOM | Tests 8/16 Gio selon Workspace |
| P1 | Streaming navigateur non qualifié | Essais 300 s avec images décodées, clavier/souris, audio, manette Gaming, latence et reconnexion | Mesures réelles et journal des pertes |
| P1 | Nettoyage de session incomplet | Tests de volumes, réseaux, conteneurs, credentials et reconnexions refusées | Inventaire avant/après, tests de rejeu |
| P1 | Windows natif PR #333 non qualifié | Revue indépendante, paquet signé lié au SHA final, rollback après crash, STOP WTS et quarantaine | APPROVED formel + qualification physique distincte |
| P2 | Provenance FreeCAD via PPA xtradeb | Inventaire de provenance, versions, SBOM et politique de mises à jour | Revue dépendances et licences |

## Exécution locale sans effet sur la production

```sh
python -m unittest discover -s agent/tests -p 'test_desktop_workspace_security_gates.py' -v
```

Ces tests **statiques** vérifient des invariants de sécurité du dépôt. Ils ne créent aucun conteneur et ne doivent pas être présentés comme une qualification runtime.

## Conditions de passage vers PC1 → PC2

1. Revue de sécurité indépendante de la PR Windows et du SHA définitif ; paquet 4/4 signé et vérifiable.
2. Tests automatiques sur code exact, y compris Redis/PostgreSQL isolés, révo­cation, récupération après panne et isolation fournisseur.
3. Accord explicite du propriétaire pour une installation de **test** sur PC1, avec rollback et arrêt d'urgence préparés.
4. Premier essai hors production et sans paiement réel, avec compte locataire distinct ; puis vérification Gaming image, son, clavier/souris, manette, STOP.
5. Aucun changement de réservation publique ou de quarantaine sur la seule base d'un test réussi.

**NO-GO tant que ces conditions ne sont pas attestées.** Cette PR n'autorise pas de streaming Windows.

## Résultats CI à conserver sans les masquer (15 novembre 2026)

- Premier HEAD de cette PR : les tests du Gateway sont exécutés en CI, mais un test de lecture ajoutait un faux échec à cause de la casse `Does NOT` / `does NOT`. Il est corrigé dans la révision suivante.
- La branche `main` échoue déjà sur des audits de dépendances et de vulnérabilités. Les rapports CI indiquent notamment des alertes npm HIGH et des détections Trivy HIGH. **Ne pas désactiver, ignorer ou requalifier ces contrôles pour afficher un feu vert.** Leur traitement est un chantier de sécurité séparé avant toute mise en service.
- La PR #333 est une autre branche/PR (streaming Windows natif) : ses tests API, Windows, Python et Rust n'attestent pas de la confidentialité des pixels lors d'une vraie session PC1 → PC2. La présence de validations GitHub ne remplace pas une revue indépendante de sécurité qualifiée.
- Les tests source-contract et les tests mockés de lancement de cette PR sont **préparatoires** ; ils ne prouvent pas le rendu GPU matériel, l'absence d'évasion conteneur ni l'arrêt physique du flux Windows.
