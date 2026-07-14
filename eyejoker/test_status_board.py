#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name('status-board.py')
spec = importlib.util.spec_from_file_location('status_board', MODULE_PATH)
assert spec is not None
status_board = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(status_board)


class CLIProxyQuotaCollectionTests(unittest.TestCase):
    def test_collects_all_quota_capable_accounts_via_management_api(self):
        files = [
            {
                'name': 'claude-onecli-direct.json',
                'type': 'claude',
                'auth_index': 'claude-direct',
                'status': 'active',
                'label': 'onecli-direct@local',
            },
            {
                'name': 'codex-team.json',
                'type': 'codex',
                'auth_index': 'codex-team',
                # Exhausted accounts are status=error but quota must still show 100%.
                'status': 'error',
                'account_id': 'team-account',
            },
            {
                'name': 'claude-a.json',
                'type': 'claude',
                'auth_index': 'claude-a',
                'status': 'active',
            },
            {
                'name': 'codex-pro.json',
                'type': 'codex',
                'auth_index': 'codex-pro',
                'status': 'active',
                'account_id': 'pro-account',
            },
            {
                'name': 'claude-b.json',
                'type': 'claude',
                'auth_index': 'claude-b',
                'status': 'active',
            },
        ]
        responses = {
            'claude-direct': {
                'status_code': 403,
                'body': json.dumps({'error': {'type': 'permission_error'}}),
            },
            'claude-a': {
                'status_code': 200,
                'body': json.dumps({
                    'five_hour': {'utilization': 1.0, 'resets_at': '2026-07-15T05:00:00Z'},
                    'seven_day': {'utilization': 40.0, 'resets_at': '2026-07-18T05:00:00Z'},
                }),
            },
            'claude-b': {
                'status_code': 200,
                'body': json.dumps({
                    'limits': [
                        {'kind': 'session', 'percent': 3, 'resets_at': '2026-07-15T06:00:00Z'},
                        {'kind': 'weekly_all', 'percent': 9, 'resets_at': '2026-07-20T06:00:00Z'},
                    ]
                }),
            },
            'codex-pro': {
                'status_code': 200,
                'body': json.dumps({
                    'plan_type': 'pro',
                    'rate_limit': {
                        'primary_window': {
                            'used_percent': 5,
                            'limit_window_seconds': 604800,
                            'reset_at': 1784563197,
                        }
                    },
                }),
            },
            'codex-team': {
                'status_code': 200,
                'body': json.dumps({
                    'plan_type': 'team',
                    'rate_limit': {
                        'primary_window': {
                            'used_percent': 7,
                            'limit_window_seconds': 18000,
                            'reset_at': 1784560000,
                        },
                        'secondary_window': {
                            'used_percent': 100,
                            'limit_window_seconds': 604800,
                            'reset_at': 1784990000,
                        },
                    },
                }),
            },
        }
        calls = []

        def fake_fetch(path, payload=None):
            if path == '/auth-files':
                return {'files': files}
            self.assertEqual(path, '/api-call')
            self.assertIsNotNone(payload)
            assert payload is not None
            calls.append(payload)
            return responses[payload['auth_index']]

        warnings = []
        claude_rows, codex_rows = status_board.collect_cliproxy_quota_rows(
            warnings, fetch=fake_fetch
        )

        self.assertEqual(
            claude_rows,
            [
                ('Claude1', 1, '2026-07-15T05:00:00Z', 40, '2026-07-18T05:00:00Z', None),
                ('Claude2', 3, '2026-07-15T06:00:00Z', 9, '2026-07-20T06:00:00Z', None),
            ],
        )
        self.assertEqual(
            codex_rows,
            [
                ('Codex1 pro', -1, '', 5, 1784563197, None),
                ('Codex2 team', 7, 1784560000, 100, 1784990000, None),
            ],
        )
        self.assertIn('Codex2 7d 100%', warnings)
        self.assertEqual(len(calls), 4)
        codex_calls = [call for call in calls if 'chatgpt.com' in call['url']]
        self.assertEqual(
            [call['header']['Chatgpt-Account-Id'] for call in codex_calls],
            ['pro-account', 'team-account'],
        )

    def test_falls_back_to_safe_stale_cache_when_management_api_is_down(self):
        cache = {
            'at': 1000,
            'claude_rows': [['Claude1', 80, 'c5', 40, 'c7', None]],
            'codex_rows': [['Codex1 pro', -1, '', 90, 1234, None]],
        }
        with tempfile.TemporaryDirectory() as directory:
            cache_path = pathlib.Path(directory) / 'quota.json'
            cache_path.write_text(json.dumps(cache))

            def broken_fetch(_path, _payload=None):
                raise OSError('proxy unavailable')

            warnings = []
            claude_rows, codex_rows = status_board.collect_quota_rows(
                warnings,
                fetch=broken_fetch,
                cache_path=cache_path,
                now=lambda: 1600,
            )

        self.assertEqual(claude_rows[0][-1], 10)
        self.assertEqual(codex_rows[0][-1], 10)
        self.assertIn('Claude1 5h 80%', warnings)
        self.assertIn('Codex1 7d 90%', warnings)

    def test_live_cache_contains_only_rendered_quota_rows(self):
        def fake_fetch(path, payload=None):
            if path == '/auth-files':
                return {
                    'files': [{
                        'name': 'private-email@example.com.json',
                        'type': 'claude',
                        'auth_index': 'private-auth-index',
                        'status': 'active',
                        'access_token': 'private-token',
                    }]
                }
            return {
                'status_code': 200,
                'body': json.dumps({
                    'five_hour': {'utilization': 2, 'resets_at': 'five'},
                    'seven_day': {'utilization': 4, 'resets_at': 'seven'},
                }),
            }

        with tempfile.TemporaryDirectory() as directory:
            cache_path = pathlib.Path(directory) / 'quota.json'
            status_board.collect_quota_rows(
                [], fetch=fake_fetch, cache_path=cache_path, now=lambda: 2000
            )
            cached = cache_path.read_text()

        self.assertNotIn('private-email', cached)
        self.assertNotIn('private-auth-index', cached)
        self.assertNotIn('private-token', cached)
        self.assertIn('Claude1', cached)

    def test_one_account_failure_uses_only_that_accounts_cached_row(self):
        files = [
            {'name': 'claude-a.json', 'type': 'claude', 'auth_index': 'ca', 'status': 'active'},
            {'name': 'claude-b.json', 'type': 'claude', 'auth_index': 'cb', 'status': 'active'},
            {'name': 'codex-a-pro.json', 'type': 'codex', 'auth_index': 'gx', 'status': 'active', 'account_id': 'account'},
        ]
        responses = {
            'ca': {
                'status_code': 200,
                'body': json.dumps({
                    'five_hour': {'utilization': 10, 'resets_at': 'live-c5'},
                    'seven_day': {'utilization': 20, 'resets_at': 'live-c7'},
                }),
            },
            'cb': {'status_code': 500, 'body': '{}'},
            'gx': {
                'status_code': 200,
                'body': json.dumps({
                    'plan_type': 'pro',
                    'rate_limit': {'primary_window': {
                        'used_percent': 5,
                        'limit_window_seconds': 604800,
                        'reset_at': 9999,
                    }},
                }),
            },
        }

        def fake_fetch(path, payload=None):
            if path == '/auth-files':
                return {'files': files}
            assert payload is not None
            return responses[payload['auth_index']]

        cache = {
            'at': 1000,
            'claude_rows': [
                ['Claude1', 1, 'old-a5', 2, 'old-a7', None],
                ['Claude2', 80, 'old-b5', 40, 'old-b7', None],
            ],
            'codex_rows': [['Codex1 pro', -1, '', 2, 8888, None]],
        }
        with tempfile.TemporaryDirectory() as directory:
            cache_path = pathlib.Path(directory) / 'quota.json'
            cache_path.write_text(json.dumps(cache))
            warnings = []
            claude_rows, codex_rows = status_board.collect_quota_rows(
                warnings, fetch=fake_fetch, cache_path=cache_path, now=lambda: 1600
            )
            cache_after = json.loads(cache_path.read_text())

        self.assertEqual(claude_rows[0], ('Claude1', 10, 'live-c5', 20, 'live-c7', None))
        self.assertEqual(claude_rows[1], ('Claude2', 80, 'old-b5', 40, 'old-b7', 10))
        self.assertEqual(codex_rows[0], ('Codex1 pro', -1, '', 5, 9999, None))
        self.assertEqual(cache_after['at'], 1000)
        self.assertIn('Claude2 5h 80%', warnings)


if __name__ == '__main__':
    unittest.main()
