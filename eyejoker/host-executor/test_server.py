import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("host_executor_server", Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(server)


class HostExecutorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        server.AUDIT_PATH = Path(self.tmp.name) / "audit.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def test_harmless_command_executes_and_is_audited(self):
        result = server.execute({"command": "printf UNIT_OK", "cwd": "/tmp", "timeout": 5})
        self.assertTrue(result["ok"])
        self.assertEqual(result["stdout"], "UNIT_OK")
        rows = [json.loads(line) for line in server.AUDIT_PATH.read_text().splitlines()]
        self.assertEqual(rows[-1]["result"]["exit_code"], 0)

    def test_dangerous_command_requires_confirmation(self):
        result = server.execute({"command": "rm -rf /tmp/not-real"})
        self.assertFalse(result["ok"])
        self.assertIn("confirm_dangerous", result["error"])

    def test_timeout_is_enforced(self):
        result = server.execute({"command": "sleep 2", "timeout": 1})
        self.assertFalse(result["ok"])
        self.assertTrue(result["timed_out"])


if __name__ == "__main__":
    unittest.main()
