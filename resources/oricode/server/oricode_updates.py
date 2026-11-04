"""OriCode update feed endpoints.

Serves the native VS Code update protocol and the Android release manifest
from a single JSON document at ``/var/www/oricode/releases/stable.json``.

Manifest schema::

    {
      "platforms": {
        "win32-x64-user": {
          "version": "<40 hex git commit>",
          "productVersion": "<semver>",
          "url": "https://oricode.orizonstudio.cloud/descargas/<artifact>",
          "sha256hash": "<64 hex>",
          "timestamp": <epoch ms>,
          "previousVersions": ["<40 hex prior shipped commits>"]
        },
        "darwin-arm64": { /* same */ },
        "android": {
          "versionCode": <int>,
          "versionName": "<str>",
          "url": "https://oricode.orizonstudio.cloud/descargas/<apk>",
          "sha256": "<64 hex>"
        }
      }
    }

Deployment: ``app.include_router(oricode_updates.router)`` in main.py.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Response

router = APIRouter()

RELEASES_MANIFEST = Path('/var/www/oricode/releases/stable.json')
UPDATE_ORIGIN = 'https://oricode.orizonstudio.cloud'
ALLOWED_PATH_PREFIX = '/descargas/'

_COMMIT_RE = re.compile(r'^[0-9a-f]{40}$')
_SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
_DESKTOP_PLATFORM_RE = re.compile(r'^(win32|darwin|linux)[-_][a-z0-9-]+$')
_SEMVER_RE = re.compile(r'^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$')


def _load_manifest() -> dict | None:
    try:
        data = json.loads(RELEASES_MANIFEST.read_text(encoding='utf-8'))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _trusted_url(url) -> bool:
    if not isinstance(url, str) or len(url) > 2048:
        return False
    try:
        parsed = urlparse(url)
        # Accessing .port raises ValueError on malformed ports/brackets.
        port = parsed.port
    except ValueError:
        return False
    origin = urlparse(UPDATE_ORIGIN)
    if parsed.scheme != origin.scheme or parsed.hostname != origin.hostname or port != origin.port:
        return False
    if parsed.netloc != origin.netloc:
        return False  # rejects 'host:' empty port and any explicit port
    if parsed.username or parsed.password or parsed.fragment or parsed.query:
        return False
    # Decode once and require a safe plain filename under /descargas/.
    path = unquote(parsed.path)
    if not path.startswith(ALLOWED_PATH_PREFIX):
        return False
    rest = path[len(ALLOWED_PATH_PREFIX):]
    if not rest or '/' in rest or rest in ('.', '..') or '..' in path.split('/'):
        return False
    return True


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _valid_desktop_record(record) -> bool:
    return (
        isinstance(record, dict)
        and bool(_COMMIT_RE.match(str(record.get('version') or '')))
        and isinstance(record.get('productVersion'), str) and bool(_SEMVER_RE.match(record['productVersion']))
        and _trusted_url(record.get('url'))
        and bool(_SHA256_RE.match(str(record.get('sha256hash') or '')))
        and _is_int(record.get('timestamp')) and record['timestamp'] > 0
        and isinstance(record.get('previousVersions'), list)
        and all(_COMMIT_RE.match(str(v) or '') for v in record['previousVersions'])
    )


def _valid_android_record(record) -> bool:
    return (
        isinstance(record, dict)
        and _is_int(record.get('versionCode')) and record['versionCode'] > 0
        and isinstance(record.get('versionName'), str) and bool(record['versionName'])
        and _trusted_url(record.get('url'))
        and bool(_SHA256_RE.match(str(record.get('sha256') or '')))
    )


def _unavailable() -> Response:
    # Generic error only — never leak manifest paths or parse details.
    return Response(status_code=503, content='update feed unavailable')


@router.get('/api/update/{platform}/{quality}/{commit}')
async def check_update(platform: str, quality: str, commit: str):
    if quality not in ('stable', 'oricode') or not _DESKTOP_PLATFORM_RE.match(platform) or not _COMMIT_RE.match(commit):
        return Response(status_code=204)
    manifest = _load_manifest()
    if manifest is None or not isinstance(manifest.get('platforms'), dict):
        return _unavailable()
    record = manifest['platforms'].get(platform)
    if record is None:
        return Response(status_code=204)
    if not _valid_desktop_record(record):
        return _unavailable()
    if commit == record['version'] or commit not in record['previousVersions']:
        return Response(status_code=204)
    return {
        'version': record['version'],
        'productVersion': record['productVersion'],
        'url': record['url'],
        'sha256hash': record['sha256hash'],
        'timestamp': record['timestamp'],
    }


@router.get('/api/releases/android')
async def android_release():
    manifest = _load_manifest()
    if manifest is None or not isinstance(manifest.get('platforms'), dict):
        return _unavailable()
    record = manifest['platforms'].get('android')
    if record is None:
        return Response(status_code=204)
    if not _valid_android_record(record):
        return _unavailable()
    return {
        'versionCode': record['versionCode'],
        'versionName': record['versionName'],
        'url': record['url'],
        'sha256': record['sha256'],
    }


def register_update_routes(app):
    """Include the update feed router in the FastAPI app."""
    app.include_router(router)
