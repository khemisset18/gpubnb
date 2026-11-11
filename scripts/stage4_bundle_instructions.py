"""Bind the Stage 4 unsigned bundle instructions to its exact verified provenance.

Offline-only: no PE execution, signing, installation, network or hardware access.
Historical docs must never be blindly copied into a current-build archive.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

README = "README.md"
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")


def _valid_hash(value: str, length: int) -> str:
    pattern = HEX40 if length == 40 else HEX64
    if not pattern.fullmatch(value):
        raise ValueError("stage4_instructions_invalid_provenance_hash")
    return value


def _manifest(directory: Path, commit: str, publisher: str, digest: str) -> dict:
    _valid_hash(commit, 40)
    _valid_hash(publisher, 64)
    _valid_hash(digest, 64)
    path = directory / "stage4.manifest.json"
    if path.is_symlink() or not path.is_file():
        raise ValueError("stage4_instructions_manifest_missing_or_link")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("stage4_instructions_manifest_digest_mismatch")
    data = json.loads(raw)
    if (
        data.get("sourceCommit") != commit
        or data.get("publisherSha256") != publisher
        or data.get("kind") != "STAGE4_UNSIGNED_PRIVATE_CANDIDATE"
        or data.get("signatureStatus") != "unsigned"
        or data.get("installable") is not False
        or data.get("publicBookabilityEnabled") is not False
    ):
        raise ValueError("stage4_instructions_manifest_provenance_mismatch")
    return data


def expected_readme(commit: str, publisher: str, manifest_digest: str) -> bytes:
    _valid_hash(commit, 40)
    _valid_hash(publisher, 64)
    _valid_hash(manifest_digest, 64)
    document = f"""# GPUBNB Stage 4 — candidat Windows NON SIGNÉ et NON INSTALLABLE

Ce dossier accompagne uniquement une archive de qualification **logicielle**.
Ne pas exécuter ces PE sur PC1, les installer, lancer une réservation,
modifier Render, lever une quarantaine ou démarrer un streaming PC1→PC2.
Le pin éditeur ci-dessous est une donnée de provenance, **pas** une preuve
que le certificat existe encore, est valide ou est approuvé sur PC1.

## Identité immuable de CETTE archive

- Commit source exact : `{commit}`
- SHA-256 du manifeste : `{manifest_digest}`
- SHA-256 du certificat éditeur attendu : `{publisher}`
- Signature des quatre exécutables : **absente**
- Statut : **unsigned / installable=false / publicBookabilityEnabled=false**

Le SHA-256 de l'archive interne est publié séparément dans
`stage4-provenance.txt` de l'artefact GitHub correspondant. Contrôler ces
valeurs contre les preuves du workflow **du même SHA** ; une empreinte
présente à l'intérieur d'une archive ne vaut pas authentification externe.

## Suite autorisée, sans accès au matériel

1. Vérifier les 4 composants, les hashes, le manifeste et les identités au
   SHA ci-dessus, dans un environnement isolé.
2. Obtenir une vérification distincte de signature/chaîne, permissions,
   GPU éligible, état de quarantaine, rollback, backend et contrôles STOP.
3. Ne planifier l'essai physique qu'après ses prérequis et une autorisation
   explicite, avec opérateur et témoin, jamais sur une machine en quarantaine.

Runbook correspondant au code exact :
https://github.com/khemisset18/gpubnb/blob/{commit}/docs/operations/WINDOWS_NATIVE_STAGE4_CONSOLE_300S_RUNBOOK.md

**Aucun certificat, secret, hash historique, PR ancienne ou ancienne version
de Render ne doit être réutilisé par simple copie d'une notice précédente.**
"""
    return document.encode("utf-8")


def create(directory: Path, commit: str, publisher: str, digest: str) -> None:
    _manifest(directory, commit, publisher, digest)
    instructions = directory / "instructions"
    # Refuse to overwrite/carry forward any historical instructions.
    instructions.mkdir()
    (instructions / README).write_bytes(expected_readme(commit, publisher, digest))
    verify(directory, commit, publisher, digest)


def verify(directory: Path, commit: str, publisher: str, digest: str) -> None:
    _manifest(directory, commit, publisher, digest)
    instructions = directory / "instructions"
    if instructions.is_symlink() or not instructions.is_dir():
        raise ValueError("stage4_instructions_directory_missing_or_link")
    entries = list(instructions.iterdir())
    if len(entries) != 1 or entries[0].name != README or entries[0].is_symlink() or not entries[0].is_file():
        raise ValueError("stage4_instructions_stale_or_unexpected_file")
    if entries[0].read_bytes() != expected_readme(commit, publisher, digest):
        raise ValueError("stage4_instructions_not_bound_to_manifest")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("create", "verify"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    if args.action == "create":
        create(args.directory, args.commit, args.publisher, args.manifest_sha256)
    else:
        verify(args.directory, args.commit, args.publisher, args.manifest_sha256)
    print("stage4_bundle_instructions: OK; bound to manifest, no legacy guidance")


if __name__ == "__main__":
    main()
