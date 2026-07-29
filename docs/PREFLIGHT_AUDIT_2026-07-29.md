# Audit pré-lancement GPUbnb — 2026-07-29

## Verdict

Le dépôt compile et les workflows de la PR #31 passent, mais le parcours Host Windows n'est pas encore fonctionnel de bout en bout. Le premier test réel est utile, mais il ne faut pas présenter la version actuelle comme prête à la production.

## Bloquants critiques

### 1. Le Host ne peut jamais devenir prêt avec l'implémentation actuelle

`Readiness` démarre avec `isolation_certified`, `storage_protected` et `network_filtered` à `false`. Aucun code de production ne rend ces trois états vrais. Les actions correspondantes renvoient seulement `automatic_setup_pending`.

Conséquence : `Readiness::is_ready()` reste faux, `request_publish()` renvoie `host_not_certified`, et la machine ne peut pas passer réellement en ligne.

Action requise : implémenter des vérifications natives réelles et persistantes pour l'isolation, le stockage et le réseau. Ne jamais remplacer ce blocage par un succès simulé.

### 2. Le bouton d'installation ne peut pas installer un agent absent

Le desktop appelle `gpubnb-agent setup`, mais `run_agent()` exige que `gpubnb-agent` ou le module Python `gpubnb_agent` soit déjà installé. L'installateur Tauri actuel construit uniquement l'application desktop et ne prépare pas explicitement un binaire ou un paquet agent Windows dans le workflow.

Conséquence : sur un PC neuf, l'action « Installer automatiquement » peut échouer avec `agent_not_installed`.

Action requise : produire un agent Windows autonome, l'embarquer comme sidecar signé, l'installer dans un chemin contrôlé et lancer le service avec les permissions adaptées.

### 3. Les installateurs de développement ne sont pas des releases publiques

Le workflow `host-desktop-dev-installers` génère des artefacts non signés et indique explicitement qu'ils ne doivent pas être distribués comme release de production. Il est déclenché sur pull request ou manuellement, pas automatiquement sur chaque fusion dans `main`.

Action requise : ajouter un workflow de release approuvé avec signature Windows, provenance, checksums, conservation durable et publication contrôlée.

### 4. L'ouverture du navigateur n'est pas garantie par une API native

Le frontend utilise un lien HTML masqué avec `target=_blank`. Le fallback manuel est correct, mais l'ouverture automatique dépend encore du comportement du WebView et de la configuration Tauri.

Action requise : utiliser une commande native ou le plugin Tauri officiel d'ouverture d'URL, avec liste stricte d'origines HTTPS autorisées et fallback visible.

## Risques élevés

### 5. État Host uniquement en mémoire

`AppState` et l'état d'orchestration sont gérés en mémoire. Un redémarrage de l'application réinitialise la progression locale et le cycle de vie.

Action requise : persister seulement des preuves vérifiables, jamais des drapeaux de succès arbitraires. Recalculer les protections au démarrage.

### 6. Détection de l'agent fragile sous Windows

La recherche dépend du `PATH` et de Python (`python`, `python3`, `py`). Un installateur grand public ne doit pas dépendre d'une installation Python globale ni d'un PATH modifié.

Action requise : chemin absolu du sidecar, version contrôlée, vérification de hash/signature et messages d'erreur spécifiques.

### 7. Détection de processus par PID insuffisante

L'agent considère qu'il fonctionne si le PID enregistré existe. Un PID peut être réutilisé par un autre processus après un crash.

Action requise : vérifier l'identité du processus, utiliser un service Windows ou un canal IPC authentifié, et nettoyer les PID obsolètes.

### 8. Timeout fixe de dix secondes

Les commandes agent sont tuées après dix secondes. Une installation, un démarrage de service ou un premier diagnostic peut dépasser ce délai sur certaines machines.

Action requise : timeouts distincts par commande, retour de progression et annulation contrôlée.

## Points positifs vérifiés

- Validation stricte du code de liaison à dix caractères hexadécimaux.
- Validation des identifiants machine et GPU avant création d'URL.
- Liste fermée d'origines GPUbnb en HTTPS.
- Échappement HTML des données affichées.
- Limites sur la taille du fichier de configuration et la sortie des commandes agent.
- Timeout et arrêt du processus enfant.
- Blocage fail-closed : aucune protection absente n'est considérée comme réussie.
- CI desktop : type-check, build frontend, tests Rust, clippy et création d'installateurs sur Windows/Linux/macOS.

## Plan avant test réel

1. Construire et embarquer un sidecar agent Windows autonome.
2. Implémenter les trois contrôles réels : isolation, stockage, réseau.
3. Remplacer l'ouverture WebView par une ouverture native sécurisée.
4. Ajouter des tests d'intégration qui démarrent un faux agent et vérifient setup, link, start, status et erreurs.
5. Ajouter un test garantissant qu'un Host ne peut être publié sans preuves réelles.
6. Créer un workflow de release Windows signé.
7. Ensuite seulement, exécuter le test sur une machine NVIDIA réelle : installation propre, liaison, GPU, Docker, runtime NVIDIA, heartbeat, publication, réservation, lancement et nettoyage.

## Critère de sortie

La version est considérée prête uniquement lorsque :

- toutes les vérifications automatiques sont vertes ;
- l'installateur contient réellement l'agent ;
- les protections sont vérifiées, pas simulées ;
- le test de bout en bout sur une installation Windows propre réussit ;
- les journaux prouvent la réception du heartbeat et le nettoyage complet d'une session.
