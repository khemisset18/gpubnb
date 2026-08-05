# GPU Proof Workspace

Premier workload louable de GPUbnb. Le locataire ne fournit aucune commande, image, variable,
URL ou fichier. Le conteneur ex?cute uniquement un calcul CUDA born? entre 30 et 600 secondes,
publie une preuve toutes les cinq secondes, puis est supprim? et v?rifi? par l'agent.

Le runtime doit ?tre lanc? sans r?seau, sans capacit? Linux, en lecture seule, sans montage h?te,
avec `no-new-privileges`, une limite de processus, de m?moire et de CPU, et une image GHCR
?pingl?e par digest.
