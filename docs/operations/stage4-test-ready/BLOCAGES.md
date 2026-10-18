# Blocages encore ouverts (18 octobre 2026)
1. Archives CI non inspectées au niveau binaire; quatre composants AMD64 au même HEAD, hashes, versions, dépendances et signatures non attestés.
2. Script de signature privée épinglé au commit `2b055992...`; reconstruire et repinner les quatre composants avec une identité réelle, sans supprimer de contrôle.
3. Certificat local PC1 (expiration annoncée 21/10/2026): statut réel inaccessible, vérifier EKU, clé, dates et confiance en lecture seule.
4. GTX1650/NVENC, IddCx, SID/session isolée, Agent, backup/rollback PC1 non vérifiés physiquement.
5. Frontend PC2 et gateway WSS URLs publiques exactes inconnues, login/préflight authentifié non vérifiés.
6. Render Stage 3 non déployé Stage 4; test de 300 secondes non exécuté.
