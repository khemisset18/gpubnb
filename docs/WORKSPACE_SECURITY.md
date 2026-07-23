# Sécurité des Workspaces

## Invariants

- aucun accès au bureau ou aux fichiers personnels du propriétaire ;
- aucune clé privée agent transmise au serveur ;
- aucune commande shell arbitraire provenant d’un locataire ;
- image OCI épinglée par digest et politique d’isolation propre à chaque type ;
- quotas CPU, RAM, GPU, disque, réseau, PID et durée ;
- arrêt d’urgence, nettoyage vérifié et journal d’audit avant session publique ;
- licences commerciales jamais présentées comme incluses sans preuve.

## Risques techniques

- évasion de conteneur ou de VM et attaque du noyau hôte ;
- fuite entre sessions, résidus disque ou secrets dans les logs ;
- exposition réseau, SSRF, minage et abus de ressources ;
- usurpation d’agent, rejeu, machine compromise et télémétrie falsifiée ;
- arrêt brutal, incohérence facturation/session et perte d’artefacts ;
- streaming distant donnant accidentellement accès à la session personnelle.

## Portes obligatoires

Un espace ne passe à `BETA` exécutable qu’avec runner typé, installation
consentie, test réel, arrêt, nettoyage, quotas, tests de panne et documentation.
Cloud Desktop, Gaming et Security Lab exigent une isolation et une revue
spécifiques ; un simple conteneur ne suffit pas.
