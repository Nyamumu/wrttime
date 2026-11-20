"""화면 스크립트(www/nmm/*.js)는 모듈 없이 같은 전역에서 돈다.
최상위 함수/상수 이름이 겹치면 나중에 읽힌 파일이 앞의 것을 덮어써서 다른 화면이 깨진다 (예: 1.0.22의 zoneOf)."""
import glob
import os
import re
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DECL = re.compile(r"^(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+|class\s+)([A-Za-z_$][\w$]*)", re.M)


class FrontendGlobalsTest(unittest.TestCase):
    def test_no_duplicate_top_level_names(self):
        seen = {}
        dups = []
        for path in sorted(glob.glob(os.path.join(BASE, "www", "nmm", "*.js"))):
            with open(path, encoding="utf-8") as f:
                for name in DECL.findall(f.read()):
                    rel = os.path.basename(path)
                    if name in seen:
                        dups.append(f"{name}: {seen[name]}, {rel}")
                    else:
                        seen[name] = rel
        self.assertEqual(dups, [])


if __name__ == "__main__":
    unittest.main()
