#!/usr/bin/env python3
# glm-vision.py - GLM vision fallback caller for vlm-vision.ps1.
# Uses Python's bundled OpenSSL so it works even when Windows schannel
# cannot acquire TLS credentials (sandbox/restricted-token environments).
# Only invoked by vlm-vision.ps1 after a native network/TLS failure.
# ASCII-only source. Chinese prompt text is passed via argv.
#
# stdout on success (exit 0):
#   {"content": "...", "latency_ms": 1234}
# stderr on failure (exit 1): human-readable error.
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"


def main():
    if len(sys.argv) < 4:
        print(
            "usage: python glm-vision.py <image> <prompt> <model> [base_url]",
            file=sys.stderr,
        )
        return 1

    image_path = sys.argv[1]
    prompt = sys.argv[2]
    model = sys.argv[3]
    base_url = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_URL

    api_key = os.environ.get("GLM_API_KEY") or os.environ.get(
        "VISION_CUSTOM_API_KEY", ""
    )
    if not api_key:
        print("ERROR: no API key available for glm fallback", file=sys.stderr)
        return 1

    try:
        with open(image_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
    except OSError as e:
        print("ERROR: cannot read image: %s" % e, file=sys.stderr)
        return 1

    ext = image_path.lower().rsplit(".", 1)[-1]
    mime = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "gif": "image/gif",
        "bmp": "image/bmp",
    }.get(ext, "image/png")

    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"

    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:%s;base64,%s" % (mime, b64)},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    }
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), method="POST"
    )
    req.add_header("Authorization", "Bearer " + api_key)
    req.add_header("Content-Type", "application/json; charset=utf-8")

    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=180)
        data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(
            "ERROR: HTTP %s %s"
            % (e.code, e.read().decode("utf-8", "replace")),
            file=sys.stderr,
        )
        return 1
    except Exception as e:
        print("ERROR: %s" % e, file=sys.stderr)
        return 1
    latency_ms = int((time.time() - t0) * 1000)

    choices = data.get("choices") or []
    content = choices[0].get("message", {}).get("content") if choices else None
    if content:
        print(json.dumps({"content": content, "latency_ms": latency_ms}, ensure_ascii=False))
        return 0

    print("ERROR: empty response content", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
