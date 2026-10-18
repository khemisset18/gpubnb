# Blocages encore ouverts (18 octobre 2026)
1. Archives CI non inspectées au niveau binaire; quatre composants AMD64 au même HEAD, hashes, versions, dépendances et signatures non attestés.
2. Script de signature privée épinglé au commit `2b055992...`; reconstruire et repinner les quatre composants avec une identité réelle, sans supprimer de contrôle.
3. Certificat local PC1 (expiration annoncée 21/10/2026): statut réel inaccessible, vérifier EKU, clé, dates et confiance en lecture seule.
4. GTX1650/NVENC, IddCx, SID/session isolée, Agent, backup/rollback PC1 non vérifiés physiquement.
5. Frontend PC2 et gateway WSS URLs publiques exactes inconnues, login/préflight authentifié non vérifiés.
6. Render Stage 3 non déployé Stage 4; test de 300 secondes non exécuté.


## Preuves PC1 reçues le 18 octobre 2026 (observations utilisateur, aucun changement machine)
- NVIDIA GTX 1650, pilote 592.82; périphérique `GPUbnb Isolated Virtual Display` `ROOT\\DISPLAY\\0000` état OK.
- Compte `gpubnb-renter-qual` activé, SID distinct de celui de l'utilisateur fournisseur, **pas de session locataire interactive confirmée**.
- Service `GPUbnbAgent` déclaré Stopped; deux processus distincts `gpubnb-agent.exe` dans `Program Files\\GPUbnb` (session 0) et `Program Files\\GPUbnb Host` (session 1). Ne pas conclure que le service arrêté contrôle le processus session 0.
- Quatre fichiers `C:\\Program Files\\GPUbnb` présents, Authenticode Valid, tous signés par le même certificat test SHA256 `200208e0ef9dc3de4911df5541e6b11506c07de2820849006311cb68b342965a`. Date NotAfter UTC `2026-10-20T22:23:47Z`. Certificat NON public.
- SHA256 installés: Agent `073c98950248301bb152aa0ebd08c5e72d0a118f294388b584029cd145e981da`; stream `d114bca3293da78481dee1d53d06c7b91b4a94f08ccde4a61d268ea73d039690`; worker `720325acac59d5e7e24f25f2ec72e13cef1e1071249943f024ff135844091579`; media `510d559b056ba094f8dc06b73d4c6d7bce46ca97fa774524e605844ad16fc9de`.
- Agent installé `build-info`: `0.6.6` frozen, `buildCommit=9be531450463`. Worker installé `sourceCommit=3cb18fb71c494e3947768455d61bc8763cd1e5c2` et pin média identique au certificat installé. Ces binaires NE correspondent PAS au HEAD Stage 4.
- Il reste à vérifier: commit du helper, dépendances PE, NVENC matériel, protocole 4/4, compatibilité IddCx et WTS. **Ne pas solliciter d'autres actions utilisateur sur PC1 tant que le paquet neuf n'est pas attesté.**
