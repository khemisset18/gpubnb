# GPUbnb RC4 — Security Hardened

## Corrections intégrées
- Sessions opaques stockées sous HMAC dans Redis, expiration absolue et expiration d’inactivité.
- Nonces wallet liés au domaine, wallet et cluster, consommés une seule fois.
- Contrôle d’origine sur les requêtes navigateur mutatives.
- Taille maximale des corps, proxy de confiance désactivé par défaut et secrets masqués dans les logs.
- Comparaison en temps constant du token de service interne.
- Challenge agent inaccessible sans signature Ed25519 fraîche et anti-rejeu.
- Rejet de télémétrie incohérente et quarantaine automatique après signatures invalides répétées.
- Correction de l’initialisation de l’agent, refus du root en production, CA personnalisable, compteur atomique 0600 et backoff exponentiel.
- Sandbox : digest obligatoire, utilisateur non-root, réseau coupé, rootfs lecture seule, capacités supprimées, limites PID/CPU/RAM/ulimit, IPC/UTS privés, timeout, seccomp/AppArmor optionnels et nettoyage dédié.
- CI : tests, TypeScript, audit npm, Gitleaks, Trivy, validation Python et scripts shell.
- Périmètre et checklist de pentest formalisés.

## Limites honnêtes
Cette version est préparée pour un pentest, mais elle n’est pas certifiée pentestée. Docker partage toujours le noyau hôte : pour des workloads hostiles, privilégier des microVM dédiées, un nœud GPU jetable par niveau de risque et une politique réseau externe. Un prestataire indépendant doit tester l’environnement réellement déployé.
