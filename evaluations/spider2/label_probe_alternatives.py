"""Label probe alternatives against Spider2 gold (plan T4.1 replay).

Reads JSONL items {key, instanceId, dbPath, sql} on stdin, runs each SQL
read-only on its SQLite database, compares the rows with the gold CSV(s) using
the official evaluator's comparison, and writes {key, match, error?} per line.

Usage: python label_probe_alternatives.py <evaluation_suite_dir> < items.jsonl > labels.jsonl
"""
import json
import sqlite3
import sys
from pathlib import Path

import pandas as pd


def main() -> None:
    suite = Path(sys.argv[1])
    sys.path.insert(0, str(suite))
    import evaluate  # noqa: E402  (the official module, for its comparison and gold resolution)

    standards = {}
    for line in (suite / "gold" / "spider2lite_eval.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            item = json.loads(line)
            standards[item["instance_id"]] = item
    gold_dir = str(suite / "gold" / "exec_result")
    for line in sys.stdin:
        if not line.strip():
            continue
        item = json.loads(line)
        out = {"key": item["key"]}
        try:
            standard = standards[item["instanceId"]]
            uri = Path(item["dbPath"]).resolve().as_uri() + "?mode=ro"
            with sqlite3.connect(uri, uri=True) as conn:
                pred = pd.read_sql_query(item["sql"], conn)
            gold_paths, _single = evaluate.resolve_gold_paths(item["instanceId"], gold_dir)
            golds = [evaluate.load_gold_csv(str(path)) for path in gold_paths]
            if not golds:
                raise FileNotFoundError(f"no gold CSV for {item['instanceId']}")
            condition_cols = standard.get("condition_cols")
            ignore_order = standard.get("ignore_order", False)
            if len(golds) == 1:
                match = evaluate.compare_pandas_table(pred, golds[0], condition_cols, ignore_order)
            else:
                match = evaluate.compare_multi_pandas_table(pred, golds, condition_cols, ignore_order)
            out["match"] = bool(match)
        except Exception as error:  # a failing alternative is labelled, not fatal
            out["match"] = False
            out["error"] = str(error)[:200]
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
