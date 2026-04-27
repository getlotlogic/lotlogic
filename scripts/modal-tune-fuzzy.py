"""Modal-based auto-tuning of plate fuzzy-match parameters.

Mirrors the YOLO retrain loop: pulls labeled data, fits config, commits
to the repo. The runtime (camera-snapshot edge function) reads the
committed JSON at startup.

Two outputs:

  1. OCR confusion pairs — character pairs that PR predictably misreads.
     Mined from plate_events grouped by session_id (sessions are ground
     truth: the system already proved these reads belong to the same
     vehicle via earlier matching + downstream allowlist hits + operator
     labels).

  2. dHash burst threshold — the Hamming distance below which two frames
     are "the same physical vehicle." Computed from the empirical
     intra-session vs inter-session distance distribution. Picked at the
     point that maximizes F1.

Output: a single JSON file at supabase/functions/camera-snapshot/auto-fuzzy-config.json
committed to main via the Contents API. The runtime imports this and
merges it with the in-code defaults — additive, never destructive.

Setup:

  python3 -m modal deploy scripts/modal-tune-fuzzy.py

Run:

  curl -X POST -H "Modal-Key: $WK" -H "Modal-Secret: $WS" \\
    https://<workspace>--lotlogic-tune-fuzzy-kick-off.modal.run

Cost: a few cents per run (CPU only, ~30s wall).
"""

from __future__ import annotations

import os
import time

import modal

app = modal.App("lotlogic-tune-fuzzy")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "supabase==2.10.0",
        "requests==2.32.3",
        "fastapi[standard]==0.115.0",
    )
)


@app.function(
    image=image,
    timeout=10 * 60,
    secrets=[modal.Secret.from_name("lotlogic-train")],
)
def tune_fuzzy(
    days_lookback: int = 30,
    min_session_size: int = 2,
    min_pair_count: int = 3,
    top_k_confusions: int = 30,
) -> dict:
    """Mine OCR confusions + tune dHash threshold from session data,
    commit the resulting JSON to the repo. Returns a status dict."""
    import json
    from collections import Counter

    import requests
    from supabase import create_client

    started_at = time.time()
    print(f"[tune_fuzzy] start  lookback={days_lookback}d")

    sb = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

    # 1. Pull plate_events from the last N days that have a session_id.
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                           time.gmtime(time.time() - days_lookback * 86400))
    # Paginate manually — supabase-py respects PostgREST's 1000-row default
    # response cap regardless of .limit(). Use range() to walk pages.
    rows: list[dict] = []
    page_size = 1000
    page = 0
    while True:
        page_res = (
            sb.table("plate_events")
            .select("session_id,plate_text,image_dhash,created_at")
            .gte("created_at", cutoff)
            .not_.is_("session_id", "null")
            .not_.is_("plate_text", "null")
            .order("created_at", desc=True)
            .range(page * page_size, (page + 1) * page_size - 1)
            .execute()
        )
        page_data = page_res.data or []
        rows.extend(page_data)
        if len(page_data) < page_size:
            break
        page += 1
        if page > 50:  # safety: cap at 50k events
            break
    print(f"[tune_fuzzy] {len(rows)} plate_events pulled across {page + 1} page(s)")

    # Group by session_id.
    by_session: dict[str, list[dict]] = {}
    for r in rows:
        sid = r.get("session_id")
        if not sid:
            continue
        by_session.setdefault(sid, []).append(r)

    sessions_with_drift = {sid: evs for sid, evs in by_session.items()
                           if len({e["plate_text"] for e in evs if e.get("plate_text")}) >= min_session_size}
    print(f"[tune_fuzzy] {len(sessions_with_drift)} sessions with plate drift")

    # 2. OCR confusion mining via greedy alignment of same-length pairs.
    # For each session with multiple distinct plate strings, take all
    # same-length pairs and tabulate per-position character substitutions.
    # We DON'T attempt full Levenshtein alignment for diff-length pairs —
    # too noisy at the scale we have today.
    pair_counter: Counter[tuple[str, str]] = Counter()
    same_len_pairs = 0
    for sid, evs in sessions_with_drift.items():
        plates = sorted(set(e["plate_text"] for e in evs if e.get("plate_text")))
        for i in range(len(plates)):
            for j in range(i + 1, len(plates)):
                a, b = plates[i].upper(), plates[j].upper()
                if len(a) != len(b):
                    continue
                same_len_pairs += 1
                for ca, cb in zip(a, b):
                    if ca == cb:
                        continue
                    if not (ca.isalnum() and cb.isalnum()):
                        continue
                    # Canonicalize ordering so (A,B) and (B,A) collapse.
                    pair = (min(ca, cb), max(ca, cb))
                    pair_counter[pair] += 1

    top_confusions = [
        {"pair": [a, b], "count": cnt}
        for (a, b), cnt in pair_counter.most_common(top_k_confusions)
        if cnt >= min_pair_count
    ]
    print(f"[tune_fuzzy] {same_len_pairs} same-length pairs analyzed → "
          f"{len(top_confusions)} confusion pairs above floor {min_pair_count}")

    # 3. dHash threshold tuning. For each session, compute pairwise
    # Hamming distances over its events' image_dhash. Same-session
    # distances are POSITIVE examples (should match). Random pairs from
    # different sessions on the same property in the same time window
    # are NEGATIVE examples (should not match). Pick threshold that
    # maximizes F1.
    def hamming_hex(a: str, b: str) -> int:
        if not a or not b or len(a) != len(b):
            return 64
        x = int(a, 16) ^ int(b, 16)
        return bin(x).count("1")

    pos_distances: list[int] = []
    neg_distances: list[int] = []
    sessions_with_dhash = 0
    for sid, evs in sessions_with_drift.items():
        dhs = [e["image_dhash"] for e in evs if e.get("image_dhash")]
        if len(dhs) < 2:
            continue
        sessions_with_dhash += 1
        for i in range(len(dhs)):
            for j in range(i + 1, len(dhs)):
                pos_distances.append(hamming_hex(dhs[i], dhs[j]))

    # Negative samples: pair events across different sessions, on the
    # same property, within the same hour. We don't have an easy
    # property-grouping in the rows; just sample randomly across rows.
    import random
    random.seed(42)
    all_with_dhash = [r for r in rows if r.get("image_dhash") and r.get("session_id")]
    if len(all_with_dhash) >= 2:
        for _ in range(min(5000, len(all_with_dhash) * 2)):
            a = random.choice(all_with_dhash)
            b = random.choice(all_with_dhash)
            if a["session_id"] == b["session_id"]:
                continue
            neg_distances.append(hamming_hex(a["image_dhash"], b["image_dhash"]))

    # F1 sweep over thresholds [3..20].
    best_threshold = 8  # fall back to current default
    best_f1 = 0.0
    f1_table: list[dict] = []
    for thr in range(3, 21):
        tp = sum(1 for d in pos_distances if d <= thr)
        fp = sum(1 for d in neg_distances if d <= thr)
        fn = len(pos_distances) - tp
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
        f1_table.append({"thr": thr, "p": round(precision, 3), "r": round(recall, 3), "f1": round(f1, 3)})
        if f1 > best_f1:
            best_f1 = f1
            best_threshold = thr
    print(f"[tune_fuzzy] dhash F1 sweep: best thr={best_threshold} f1={best_f1:.3f}  "
          f"(pos n={len(pos_distances)}, neg n={len(neg_distances)})")

    # 4. Build the JSON config.
    config = {
        "version": int(time.time()),
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lookback_days": days_lookback,
        "stats": {
            "total_events": len(rows),
            "sessions_with_drift": len(sessions_with_drift),
            "same_length_pairs_analyzed": same_len_pairs,
            "sessions_with_dhash": sessions_with_dhash,
            "pos_distance_count": len(pos_distances),
            "neg_distance_count": len(neg_distances),
        },
        "ocr_confusions": top_confusions,
        "dhash_threshold": best_threshold,
        "dhash_f1_sweep": f1_table,
    }

    # 5. Commit to GitHub via Contents API.
    gh_pat = os.environ.get("GITHUB_PAT")
    gh_owner = os.environ.get("GITHUB_OWNER", "getlotlogic")
    gh_repo = os.environ.get("GITHUB_REPO", "lotlogic")
    gh_branch = os.environ.get("GITHUB_BRANCH", "main")
    gh_path = "supabase/functions/camera-snapshot/auto-fuzzy-config.json"

    commit_sha = None
    commit_url = None
    if gh_pat:
        import base64
        gh_headers = {
            "Authorization": f"Bearer {gh_pat}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "lotlogic-tune-fuzzy",
        }
        api_base = f"https://api.github.com/repos/{gh_owner}/{gh_repo}/contents/{gh_path}"
        sha = None
        try:
            r = requests.get(f"{api_base}?ref={gh_branch}", headers=gh_headers, timeout=15)
            if r.status_code == 200:
                sha = r.json().get("sha")
            elif r.status_code != 404:
                print(f"[tune_fuzzy] github GET unexpected {r.status_code}: {r.text[:200]}")
        except Exception as e:
            print(f"[tune_fuzzy] github GET error: {e}")

        body_str = json.dumps(config, indent=2) + "\n"
        commit_message = (
            f"chore(alpr): auto-tuned fuzzy match config\n\n"
            f"Auto-generated by Modal lotlogic-tune-fuzzy.\n"
            f"Lookback: {days_lookback} days, {len(rows)} events, "
            f"{len(sessions_with_drift)} sessions with drift.\n"
            f"Top confusions: {len(top_confusions)} pairs above count >= {min_pair_count}.\n"
            f"dHash threshold: {best_threshold} (F1={best_f1:.3f}).\n"
        )
        put_body = {
            "message": commit_message,
            "content": base64.b64encode(body_str.encode("utf-8")).decode("ascii"),
            "branch": gh_branch,
        }
        if sha:
            put_body["sha"] = sha
        try:
            r = requests.put(api_base, headers={**gh_headers, "Content-Type": "application/json"},
                             json=put_body, timeout=30)
            if r.ok:
                resp = r.json()
                commit_sha = resp.get("commit", {}).get("sha")
                commit_url = resp.get("commit", {}).get("html_url")
                print(f"[tune_fuzzy] committed {commit_sha} -> {commit_url}")
            else:
                print(f"[tune_fuzzy] github PUT failed {r.status_code}: {r.text[:300]}")
        except Exception as e:
            print(f"[tune_fuzzy] github PUT error: {e}")
    else:
        print("[tune_fuzzy] GITHUB_PAT not set — printing config instead of committing")
        print(json.dumps(config, indent=2))

    # Persist the run report to fuzzy_match_runs so the Tuner Inspector
    # page can show what was analyzed and what was determined. The
    # runtime edge function continues to read the JSON-on-disk via
    # import; this table is purely for visibility + history.
    try:
        sb.table("fuzzy_match_runs").insert({
            "trained_at": config["trained_at"],
            "lookback_days": config["lookback_days"],
            "total_events": config["stats"]["total_events"],
            "sessions_with_drift": config["stats"]["sessions_with_drift"],
            "same_length_pairs_analyzed": config["stats"]["same_length_pairs_analyzed"],
            "pos_distance_count": config["stats"]["pos_distance_count"],
            "neg_distance_count": config["stats"]["neg_distance_count"],
            "ocr_confusions": config["ocr_confusions"],
            "dhash_threshold": config["dhash_threshold"],
            "dhash_f1_sweep": config["dhash_f1_sweep"],
            "config_full": config,
            "commit_sha": commit_sha,
            "commit_url": commit_url,
        }).execute()
        print("[tune_fuzzy] persisted run to fuzzy_match_runs")
    except Exception as e:
        print(f"[tune_fuzzy] DB insert failed (non-fatal): {e}")

    return {
        "ok": True,
        "wall_time_sec": int(time.time() - started_at),
        "config": config,
        "commit_sha": commit_sha,
        "commit_url": commit_url,
    }


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("lotlogic-train")],
    timeout=30,
)
@modal.fastapi_endpoint(method="POST", label="kick-off", requires_proxy_auth=True)
def kick_off(request: dict | None = None) -> dict:
    """Web endpoint to trigger a fuzzy-tune run asynchronously."""
    handle = tune_fuzzy.spawn(
        days_lookback=int((request or {}).get("days_lookback", 30)),
        min_session_size=int((request or {}).get("min_session_size", 2)),
        min_pair_count=int((request or {}).get("min_pair_count", 3)),
        top_k_confusions=int((request or {}).get("top_k_confusions", 30)),
    )
    return {"ok": True, "call_id": handle.object_id}


@app.local_entrypoint()
def main(days_lookback: int = 30):
    """`modal run scripts/modal-tune-fuzzy.py` for ad-hoc runs."""
    result = tune_fuzzy.remote(days_lookback=days_lookback)
    print(f"\n=== TUNING COMPLETE ===\n{result}")
