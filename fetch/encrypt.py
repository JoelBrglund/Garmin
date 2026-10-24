"""Lock data/data.json with a passphrase so it can be published safely.

Usage (from the repository folder):
    python fetch/encrypt.py                 # writes site/data.enc

The passphrase comes from the DASHBOARD_PASSPHRASE environment variable; if it isn't set,
you are asked to type it. The dashboard asks for the same passphrase to unlock the data.

How it works: the data is compressed (gzip), then encrypted with AES-256-GCM. The
encryption key is made from the passphrase with PBKDF2 (2,000,000 rounds of SHA-256),
which makes guessing passphrases slow. The browser reverses these steps.
"""
from __future__ import annotations

import base64
import getpass
import gzip
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

REPO = Path(__file__).resolve().parents[1]
IN_FILE = REPO / "data" / "data.json"
OUT_FILE = REPO / "site" / "data.enc"
# Higher = slower to guess passphrases, but also slower to unlock. The number is saved with
# the data, so the browser always uses the right value.
ITERATIONS = 2_000_000


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def encrypt(plaintext: bytes, passphrase: str) -> dict:
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS).derive(
        passphrase.encode("utf-8"))
    ciphertext = AESGCM(key).encrypt(iv, gzip.compress(plaintext), None)
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITERATIONS, "salt": b64(salt), "iv": b64(iv), "ct": b64(ciphertext)}


def with_refresh_key(plaintext: bytes) -> bytes:
    """Add the GitHub key that lets the dashboard's refresh button start an update.

    It goes only into the encrypted copy (never into data/data.json), so only someone with the
    passphrase can use it. Without DASHBOARD_REFRESH_TOKEN the button just reloads the website copy.
    """
    token = os.environ.get("DASHBOARD_REFRESH_TOKEN", "").strip()
    if not token:
        return plaintext
    data = json.loads(plaintext)
    data["refresh"] = {
        "token": token,
        "repo": os.environ.get("GITHUB_REPOSITORY", "JoelBrglund/Garmin"),
        "workflow": "update.yml",
        "ref": "main",
    }
    return json.dumps(data).encode("utf-8")


def main() -> None:
    if not IN_FILE.exists():
        sys.exit(f"{IN_FILE.relative_to(REPO)} not found - run fetch/fetch_garmin.py first.")
    passphrase = os.environ.get("DASHBOARD_PASSPHRASE") or getpass.getpass("Dashboard passphrase: ")
    if len(passphrase) < 12:
        sys.exit("Use a passphrase of at least 12 characters (e.g. four random words).")
    OUT_FILE.write_text(json.dumps(encrypt(with_refresh_key(IN_FILE.read_bytes()), passphrase)), encoding="utf-8")
    print(f"Encrypted data saved to {OUT_FILE.relative_to(REPO)}")


if __name__ == "__main__":
    main()
