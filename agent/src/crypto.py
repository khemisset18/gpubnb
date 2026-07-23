"""
Cryptographic utilities for Agent authentication and message signing.
Uses Ed25519 for signing and verification.
"""

import os
import json
import base64
import time
from pathlib import Path
from typing import Dict, Tuple, Optional
from datetime import datetime, timedelta

import nacl.signing
import nacl.utils
import nacl.exceptions


class CryptoManager:
    """Manages Ed25519 key generation, storage, and cryptographic operations."""

    def __init__(self, config_dir: Optional[Path] = None):
        """
        Initialize crypto manager.
        
        Args:
            config_dir: Directory for storing keys. Defaults to ~/.config/gpubnb/
        """
        if config_dir is None:
            if os.name == 'nt':  # Windows
                config_dir = Path(os.getenv('LOCALAPPDATA', '~')) / 'GPUbnb'
            else:  # Linux/macOS
                xdg_config = os.getenv('XDG_CONFIG_HOME')
                config_dir = Path(xdg_config or '~/.config') / 'gpubnb'
        
        self.config_dir = Path(config_dir).expanduser()
        self.key_file = self.config_dir / 'agent.key'
        self.machine_id_file = self.config_dir / 'machine_id'
        self.nonce_cache_file = self.config_dir / 'nonce_cache.json'
        
        self._signing_key: Optional[nacl.signing.SigningKey] = None
        self._nonce_cache: Dict[str, float] = {}
        
    def ensure_keys_exist(self) -> Tuple[str, str]:
        """
        Ensure keys exist, creating them if necessary.
        
        Returns:
            Tuple of (public_key_base58, machine_id)
        """
        self.config_dir.mkdir(parents=True, exist_ok=True)
        
        if not self.key_file.exists():
            self._generate_keys()
        
        self._load_keys()
        public_key_b58 = self.get_public_key_b58()
        
        if not self.machine_id_file.exists():
            machine_id = self._generate_machine_id()
            self.machine_id_file.write_text(machine_id)
        else:
            machine_id = self.machine_id_file.read_text().strip()
        
        return public_key_b58, machine_id

    def _generate_keys(self) -> None:
        """Generate new Ed25519 keypair and save to file."""
        signing_key = nacl.signing.SigningKey.generate()
        key_bytes = bytes(signing_key)
        
        self.key_file.write_bytes(key_bytes)
        self.key_file.chmod(0o600)  # Only readable by owner
        
        print(f"✅ Generated new Ed25519 keypair at {self.key_file}")
        print(f"   Public key: {self.get_public_key_b58()}")

    def _load_keys(self) -> None:
        """Load signing key from file."""
        if self.key_file.exists():
            key_bytes = self.key_file.read_bytes()
            self._signing_key = nacl.signing.SigningKey(key_bytes)
        else:
            raise FileNotFoundError(f"Key file not found: {self.key_file}")

    def _generate_machine_id(self) -> str:
        """Generate a random machine ID."""
        import uuid
        return str(uuid.uuid4())

    def get_public_key_b58(self) -> str:
        """Get public key as base58 string."""
        if self._signing_key is None:
            self._load_keys()
        
        public_key_bytes = bytes(self._signing_key.verify_key)
        return self._base58_encode(public_key_bytes)

    def sign_message(self, message: bytes) -> str:
        """
        Sign a message with the private key.
        
        Args:
            message: Message bytes to sign
            
        Returns:
            Signature as base58 string
        """
        if self._signing_key is None:
            self._load_keys()
        
        signature = self._signing_key.sign(message).signature
        return self._base58_encode(signature)

    def create_signed_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
    ) -> Dict:
        """
        Create a signed API request.
        
        Args:
            method: HTTP method (GET, POST, etc.)
            path: API path (e.g., "/agent/heartbeat")
            body: Request body as dict
            
        Returns:
            Dict with signature headers
        """
        timestamp = datetime.utcnow().isoformat() + 'Z'
        nonce = nacl.utils.random(16).hex()
        
        # Create message to sign: METHOD + PATH + TIMESTAMP + NONCE
        message = f"{method}\n{path}\n{timestamp}\n{nonce}"
        if body:
            import json
            message += "\n" + json.dumps(body, separators=(',', ':'), sort_keys=True)
        
        message_bytes = message.encode('utf-8')
        signature = self.sign_message(message_bytes)
        
        return {
            'x-agent-timestamp': timestamp,
            'x-agent-nonce': nonce,
            'x-agent-signature': signature,
        }

    def verify_message(self, message: bytes, signature_b58: str) -> bool:
        """
        Verify a message signature.
        
        Args:
            message: Original message bytes
            signature_b58: Signature as base58 string
            
        Returns:
            True if signature is valid
        """
        if self._signing_key is None:
            self._load_keys()
        
        try:
            signature = self._base58_decode(signature_b58)
            verify_key = self._signing_key.verify_key
            verify_key.verify(message, signature)
            return True
        except nacl.exceptions.BadSignatureError:
            return False

    @staticmethod
    def _base58_encode(data: bytes) -> str:
        """Encode bytes to base58 string."""
        ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
        
        if not data:
            return ''
        
        num = int.from_bytes(data, 'big')
        encoded = []
        
        while num > 0:
            num, remainder = divmod(num, 58)
            encoded.append(ALPHABET[remainder])
        
        # Add leading zeros
        for byte in data:
            if byte == 0:
                encoded.append(ALPHABET[0])
            else:
                break
        
        return ''.join(reversed(encoded))

    @staticmethod
    def _base58_decode(encoded: str) -> bytes:
        """Decode base58 string to bytes."""
        ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
        
        if not encoded:
            return b''
        
        num = 0
        for char in encoded:
            if char not in ALPHABET:
                raise ValueError(f"Invalid base58 character: {char}")
            num = num * 58 + ALPHABET.index(char)
        
        # Decode to bytes
        combined = num.to_bytes((num.bit_length() + 7) // 8, 'big')
        
        # Add leading zeros
        nz_prefix = len(encoded) - len(encoded.lstrip(ALPHABET[0]))
        return b'\x00' * nz_prefix + combined

    def reset_keys(self, confirm: bool = False) -> None:
        """
        Reset/revoke keys (delete local copies).
        
        Args:
            confirm: If True, perform deletion without prompt
        """
        if not confirm:
            response = input(
                f"⚠️  This will delete your local key at {self.key_file}.\n"
                "You will need to link again. Continue? (y/N): "
            )
            if response.lower() != 'y':
                return
        
        if self.key_file.exists():
            self.key_file.unlink()
            print(f"✅ Deleted key file: {self.key_file}")
        
        self._signing_key = None
