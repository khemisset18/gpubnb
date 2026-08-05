# XMRig 6.26.0 — provenance des exécutables approuvés

Date de vérification : 2 août 2026.

Source officielle : <https://github.com/xmrig/xmrig/releases/tag/v6.26.0>

Le runtime n'autorise que les exécutables extraits des archives ci-dessous. Chaque archive a été téléchargée depuis la publication officielle, puis comparée à la somme SHA-256 publiée par XMRig avant extraction. L'empreinte de l'exécutable extrait est compilée dans l'application.

| Plateforme | Archive | SHA-256 officielle de l'archive | SHA-256 de l'exécutable extrait |
|---|---|---|---|
| Linux x86_64 | `xmrig-6.26.0-linux-static-x64.tar.gz` | `fc6f8ae5f64e4f17481f7e3be29a1c56949f216a998414188003eae1db20c9e5` | `b20f39fc00d242e706b6c30367ad811c676e0575050a4ec2f30104b696944b49` |
| macOS x86_64 | `xmrig-6.26.0-macos-x64.tar.gz` | `1da924b358c0089e361540c4a9e6f8b09538b29efeafa2379590e0f6db358ff4` | `3bf7a353daa4af0f4d2aa4c5a0294fd14d3a330b0abf2e2e4dd23e14650aa527` |
| macOS arm64 | `xmrig-6.26.0-macos-arm64.tar.gz` | `6ae4eb4216e99a201ae9a3d2c3a7c275207c5165cfc25da1f3d735d6c4829c18` | `c66f9881bed79a550e18d54b9ae5cf03b91a0e881efdbf7962db2e58de0b4f7b` |
| Windows x86_64 | `xmrig-6.26.0-windows-x64.zip` | `bba8097cb37d9b458a1cb1137876b27cde6740d17fe4ccbc086ba07d87d9e147` | `6fa80698d7268f6e88aa88c06fb27ee99e1bcee747c2e76911e6206a5b1aeeb3` |

## Politique fail-closed

- `xmrig_randomx` est le seul profil raccordé à ce manifeste.
- Les plateformes absentes du tableau sont refusées.
- lolMiner et T-Rex restent refusés tant que leurs archives et exécutables n'ont pas une provenance documentée au même niveau.
- Un fichier manquant, déplacé, vide ou dont l'empreinte diffère est refusé avant toute création de processus.
- Le chemin canonique doit rester à l'intérieur du répertoire d'installation approuvé.

Cette preuve couvre l'intégrité des artefacts. Elle ne remplace pas la vérification fonctionnelle et matérielle sur une machine réelle.
