"""Isolated tests for oricode_updates — fastapi stubbed, temp manifest."""

import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

# Stub fastapi so the module imports without the framework installed.
fastapi = types.ModuleType('fastapi')


class _Router:
    def get(self, *_a, **_kw):
        return lambda fn: fn


class _Response:
    def __init__(self, status_code=200, content=None, **_kw):
        self.status_code = status_code
        self.body = content


fastapi.APIRouter = _Router
fastapi.Response = _Response
sys.modules['fastapi'] = fastapi

sys.path.insert(0, str(Path(__file__).parent))
import oricode_updates  # noqa: E402

COMMIT_OLD = 'a' * 40
COMMIT_NEW = 'b' * 40
COMMIT_UNKNOWN = 'c' * 40
SHA = 'd' * 64
URL = 'https://oricode.orizonstudio.cloud/descargas/OriCode-1.1.0.zip'


def desktop_record(**over):
    rec = {
        'version': COMMIT_NEW,
        'productVersion': '1.1.0',
        'url': URL,
        'sha256hash': SHA,
        'timestamp': 1730000000000,
        'previousVersions': [COMMIT_OLD],
    }
    rec.update(over)
    return rec


def android_record(**over):
    rec = {
        'versionCode': 2,
        'versionName': '1.1.0',
        'url': 'https://oricode.orizonstudio.cloud/descargas/oricode-1.1.0.apk',
        'sha256': SHA,
    }
    rec.update(over)
    return rec


class TestUpdateFeed(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        oricode_updates.RELEASES_MANIFEST = Path(self.tmp.name) / 'stable.json'

    def tearDown(self):
        self.tmp.cleanup()

    def write_manifest(self, platforms=None, raw=None):
        if raw is not None:
            oricode_updates.RELEASES_MANIFEST.write_text(raw)
        else:
            oricode_updates.RELEASES_MANIFEST.write_text(json.dumps({'platforms': platforms or {}}))

    def check(self, platform='win32-x64-user', quality='oricode', commit=COMMIT_OLD):
        return asyncio.run(oricode_updates.check_update(platform, quality, commit))

    def android(self):
        return asyncio.run(oricode_updates.android_release())

    def test_missing_manifest_503(self):
        self.assertEqual(self.check().status_code, 503)

    def test_empty_manifest_503(self):
        self.write_manifest(raw='{}')
        self.assertEqual(self.check().status_code, 503)
        self.write_manifest(raw='not json')
        self.assertEqual(self.check().status_code, 503)

    def test_current_commit_no_update(self):
        self.write_manifest({'win32-x64-user': desktop_record()})
        self.assertEqual(self.check(commit=COMMIT_NEW).status_code, 204)

    def test_unknown_commit_no_update(self):
        self.write_manifest({'win32-x64-user': desktop_record()})
        self.assertEqual(self.check(commit=COMMIT_UNKNOWN).status_code, 204)

    def test_known_previous_gets_update(self):
        self.write_manifest({'win32-x64-user': desktop_record()})
        result = self.check()
        self.assertEqual(result['version'], COMMIT_NEW)
        self.assertEqual(result['productVersion'], '1.1.0')
        self.assertEqual(result['url'], URL)
        self.assertEqual(result['sha256hash'], SHA)
        self.assertEqual(result['timestamp'], 1730000000000)

    def test_invalid_url_503(self):
        for bad in ('https://evil.example.com/descargas/x.zip',
                    'http://oricode.orizonstudio.cloud/descargas/x.zip',
                    'https://oricode.orizonstudio.cloud/other/x.zip',
                    'https://user:pw@oricode.orizonstudio.cloud/descargas/x.zip',
                    'https://oricode.orizonstudio.cloud/descargas/x.zip#frag',
                    'not a url'):
            self.write_manifest({'win32-x64-user': desktop_record(url=bad)})
            self.assertEqual(self.check().status_code, 503, bad)

    def test_malformed_port_and_traversal_503(self):
        for bad in ('https://oricode.orizonstudio.cloud:bad/descargas/x.zip',
                    'https://oricode.orizonstudio.cloud:/descargas/x.zip',
                    'https://oricode.orizonstudio.cloud/descargas/../etc/passwd',
                    'https://oricode.orizonstudio.cloud/descargas/%2e%2e/secret',
                    'https://oricode.orizonstudio.cloud/descargas/sub/dir.apk',
                    'https://oricode.orizonstudio.cloud/descargas/x.zip?tok=1',
                    'https://oricode.orizonstudio.cloud/descargas/'):
            self.write_manifest({'win32-x64-user': desktop_record(url=bad)})
            self.assertEqual(self.check().status_code, 503, bad)

    def test_bad_semver_or_timestamp_503(self):
        self.write_manifest({'win32-x64-user': desktop_record(productVersion='next')})
        self.assertEqual(self.check().status_code, 503)
        self.write_manifest({'win32-x64-user': desktop_record(timestamp=True)})
        self.assertEqual(self.check().status_code, 503)
        self.write_manifest({'win32-x64-user': desktop_record(timestamp=0)})
        self.assertEqual(self.check().status_code, 503)
        self.write_manifest({'android': android_record(versionCode=True)})
        self.assertEqual(self.android().status_code, 503)

    def test_other_platform_204(self):
        self.write_manifest({'win32-x64-user': desktop_record()})
        self.assertEqual(self.check(platform='darwin-arm64').status_code, 204)

    def test_non_stable_quality_204(self):
        self.write_manifest({'win32-x64-user': desktop_record()})
        self.assertEqual(self.check(quality='insider').status_code, 204)

    def test_bad_platform_or_commit_204(self):
        self.write_manifest({'win32-x64-user': desktop_record()})
        self.assertEqual(self.check(platform='../../etc/passwd').status_code, 204)
        self.assertEqual(self.check(commit='short').status_code, 204)

    def test_android_valid(self):
        self.write_manifest({'android': android_record()})
        result = self.android()
        self.assertEqual(result['versionCode'], 2)
        self.assertEqual(result['versionName'], '1.1.0')
        self.assertEqual(result['sha256'], SHA)

    def test_android_missing_204(self):
        self.write_manifest({'win32-x64-user': desktop_record()})
        self.assertEqual(self.android().status_code, 204)

    def test_android_invalid_503(self):
        self.write_manifest({'android': android_record(url='https://evil.example.com/x.apk')})
        self.assertEqual(self.android().status_code, 503)
        self.write_manifest({'android': android_record(versionCode='two')})
        self.assertEqual(self.android().status_code, 503)

    def test_503_body_leaks_nothing(self):
        self.write_manifest({'win32-x64-user': desktop_record(url='http://bad/')})
        resp = self.check()
        self.assertEqual(resp.status_code, 503)
        self.assertNotIn('var/www', str(resp.body))
        self.assertNotIn('stable.json', str(resp.body))


if __name__ == '__main__':
    unittest.main(verbosity=2)
