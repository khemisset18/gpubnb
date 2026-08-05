# GPU Proof Workspace

Premier workload louable de GPUbnb. Le locataire ne fournit aucune commande, image, variable,
URL ou fichier. Le conteneur exécute uniquement un calcul CUDA borné entre 30 et 600 secondes,
publie une preuve toutes les cinq secondes, puis est supprimé et vérifié par l'agent.

Le runtime doit être lancé sans réseau, sans capacité Linux, en lecture seule, sans montage hôte,
avec `no-new-privileges`, une limite de processus, de mémoire et de CPU, et une image GHCR
épinglée par digest.
