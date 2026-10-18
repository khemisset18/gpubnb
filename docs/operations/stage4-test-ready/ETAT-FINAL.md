# Stage 4 — état vérifié 18 octobre 2026

PR #303 ouverte, draft; HEAD initial `781137ecd34e5dac07e060a82a1695700b22f218`. 20 workflows GitHub Actions réussis à ce HEAD, mais aucun paquet complet Agent + stream + worker + media DLL attesté.

Artefacts recensés: helper `gpubnb-windows-stream-helper-781137ecd34e5dac07e060a82a1695700b22f218` et host preflight `gpubnb-host-windows-preflight-781137ecd34e5dac07e060a82a1695700b22f218`; archives non inspectées octet à octet. Empreintes SHA256 PE, architecture exacte, dépendances, Authenticode et contrats des quatre composants: NON CONFIRMÉS. Anciennes empreintes du commit `2b055992...` non réutilisables.

Certificat privé PC1 expirant le 21 octobre 2026 selon état ancien: magasin local inaccessible, identité et validité réelles non vérifiées. PC1 IddCx/WTS/NVENC non audité sur machine. PC2 navigateur et vidéo 300 secondes non testés.

Render `srv-dau86i2d0e5s73elmk10` au commit Stage 3 `6b655614d3b9c3fda7912742b539601ba22598f1`, auto-deploy désactivé. Aucune installation, déploiement, réservation ou qualification exécutée. État: BLOQUÉ avant autorisation du test physique.

## Inspection octet-à-octet des archives CI (18/10/2026)
Archives téléchargées directement depuis GitHub Actions; fichiers lus à l'intérieur des ZIP, SHA256 calculés localement, en-tête PE vérifié sans exécution des fichiers.
- Artefact 12132764129: `gpubnb-windows-stream.exe`, 464384 octets, SHA256 `e041ee80a0ad31b0b27edc7a0e7bcff50d8cfe2afefadc24f4db64887388620d`, Machine 0x8664 (AMD64), Optional Header 0x20b (PE32+).
- Artefact 12132808032: `gpubnb-agent.exe`, 22258206 octets, SHA256 `3a6ca3a88c5b46e19294ac4fc1f68666461532b99854f60aa3bce6f33f413b13`, Machine 0x8664 (AMD64); `gpubnb-host-tunnel.exe` SHA256 `de966e31a3eb816e4abb504cc965b2a4483c17f420cc38f95929670fd44e1f03`, AMD64; installateur `GPUbnb Host_0.1.0_x64-setup.exe` SHA256 `4c1e51094108fbf8ef0821dc6a5c49b6da43a7b274299e3185540bd5238d4697` (en-tête PE machine 0x14c du stub: ne démontre pas l'architecture du payload).
- Artefact 12132164519: installateur `dist-installers/nsis/GPUbnb Host_0.1.0_x64-setup.exe`, SHA256 `78e5bc2de9ac252950bb52dfca586b9f9b2d841498d158166e50f76de208`, accompagné de fichiers dist-evidence; **ce n'est pas un paquet natif quatre composants**.
- Dans ces trois archives, **ni `gpubnb-windows-worker.exe` ni `GPUbnbWindowsMedia.dll` n'apparaissent**. Agent et helper sont deux archives séparées. Leur commit de build réel, signature et compatibilité protocolaire ne sont pas attestés par la présence de fichiers/PE seuls.
- Aucune archive n'a été lancée, extraite sur PC1, signée ou installée. Le paquet complet Stage 4 demeure **BLOQUÉ**.
