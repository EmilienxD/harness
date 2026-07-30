import json
import os
import sys
import time
import urllib.error
import urllib.request


def main():
    agent_id = os.environ.get("ABOARD_AGENT_ID")
    if not agent_id or os.environ.get("ABOARD_AGENT_TYPE") != "manager":
        return 0
    payload = json.load(sys.stdin)
    endpoint = sys.argv[1]
    port = int(os.environ["ABOARD_BRIDGE_PORT"])
    token = os.environ["ABOARD_BRIDGE_TOKEN"]
    body = {"agentId": agent_id}
    if endpoint.endswith("/stop"):
        body["stopHookActive"] = bool(payload.get("stop_hook_active", False))
    while True:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{endpoint}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request) as response:
                result = json.load(response)
        except (urllib.error.URLError, ConnectionError):
            return 0
        if result.get("state") != "running":
            break
        time.sleep(1)
    if "additionalContext" in result:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": payload["hook_event_name"], "additionalContext": result["additionalContext"]}}))
    elif result.get("state") == "results":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": result["additionalContext"]}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
