"""Fetch every immutable diagram image in one authenticated Grill snapshot."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import time
import tempfile
import urllib.request
import uuid
import zlib

from grill_me_in_cloud_hook import HostedClient, InterviewRuntime

MAX_IMAGE = 6 * 1024 * 1024
MAX_TOTAL = 50 * 1024 * 1024


class ImageError(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ImageError("The board redirected an authenticated request; check grill.url.")


def valid_png(data: bytes) -> bool:
    """Check the PNG structure, checksums, dimensions and bounded decoded scanlines."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return False
    offset, chunks, compressed = 8, [], bytearray()
    try:
        while offset < len(data):
            size = struct.unpack_from(">I", data, offset)[0]
            kind = data[offset + 4:offset + 8]
            body = data[offset + 8:offset + 8 + size]
            crc = struct.unpack_from(">I", data, offset + 8 + size)[0]
            if zlib.crc32(kind + body) != crc:
                return False
            chunks.append(kind)
            if kind == b"IHDR":
                if offset != 8 or size != 13:
                    return False
                width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
                if not (0 < width <= 16384 and 0 < height <= 16384 and width * height <= 16_000_000):
                    return False
                if depth != 8 or color not in (2, 6) or compression or filtering or interlace:
                    return False
                expected = height * (1 + width * (4 if color == 6 else 3))
            if kind == b"IDAT":
                compressed.extend(body)
            if kind == b"IEND" and size:
                return False
            if kind not in (b"IHDR", b"IDAT", b"IEND", b"PLTE") and not (kind and 97 <= kind[0] <= 122):
                return False
            offset += size + 12
            if kind == b"IEND":
                break
        if not chunks or chunks[0] != b"IHDR" or chunks[-1] != b"IEND" or offset != len(data):
            return False
        decoder = zlib.decompressobj()
        decoded = decoder.decompress(bytes(compressed), expected + 1)
        return len(decoded) == expected and decoder.eof and not decoder.unused_data and all(decoded[row * (expected // height)] <= 4 for row in range(height))
    except (ValueError, struct.error, zlib.error, UnboundLocalError):
        return False


def download_snapshot(client: HostedClient, snapshot_id: str, cache: Path | None = None) -> list[dict]:
    try:
        snapshot_id = str(uuid.UUID(snapshot_id))
    except ValueError:
        raise ImageError("Snapshot identity must be a UUID.") from None
    deadline = time.monotonic() + 20
    opener = urllib.request.build_opener(NoRedirect)

    def get(path: str, limit: int) -> bytes:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ImageError("Image preparation timed out; retry the same snapshot.")
        request = urllib.request.Request(client.origin + path, headers={"Authorization": f"Bearer {client.code}"})
        try:
            with opener.open(request, timeout=min(1, remaining)) as response:
                chunks, size = [], 0
                while True:
                    if time.monotonic() >= deadline:
                        raise ImageError("Image preparation timed out; retry the same snapshot.")
                    chunk = response.read1(min(65536, limit + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > limit:
                        raise ImageError("The board response exceeds the image delivery limit.")
                return b"".join(chunks)
        except ImageError:
            raise
        except Exception:
            raise ImageError("Image request failed. Check Grill credentials, board availability and snapshot assets, then retry.") from None

    try:
        snapshot = json.loads(get(f"/api/v1/prompt-snapshots/{snapshot_id}", 512 * 1024))["snapshot"]
        images = snapshot["images"]
        if snapshot["id"] != snapshot_id or not isinstance(images, list) or len(images) > 20:
            raise ValueError()
        total = 0
        for item in images:
            if str(uuid.UUID(item["asset_id"])) != item["asset_id"] or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
                raise ValueError()
            if item["media_type"] != "image/png" or type(item["byte_size"]) is not int or not 0 < item["byte_size"] <= MAX_IMAGE:
                raise ValueError()
            if not all(isinstance(item.get(key), str) and item[key] for key in ("question_id", "diagram_id")):
                raise ValueError()
            total += item["byte_size"]
        if total > MAX_TOTAL:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ImageError("The snapshot contains invalid image metadata. Review again on the board.") from None
    cache = (cache or InterviewRuntime.default_root() / "image-cache").resolve()
    if cache.is_relative_to(Path.cwd().resolve()):
        cache = Path(tempfile.gettempdir()).resolve() / "harness-grill-image-cache"
    cache.mkdir(parents=True, exist_ok=True)
    result = []
    for item in images:
        destination = cache / f"{item['sha256']}.png"

        def verified(data: bytes) -> bool:
            return len(data) == item["byte_size"] and hashlib.sha256(data).hexdigest() == item["sha256"] and valid_png(data)

        cached = destination.read_bytes() if destination.is_file() and destination.stat().st_size <= MAX_IMAGE else b""
        if not verified(cached):
            data = get(f"/api/v1/assets/{item['asset_id']}", item["byte_size"])
            if not verified(data):
                raise ImageError("A diagram image failed integrity verification. Retry or export it again on the board.")
            temporary = cache / f".{uuid.uuid4()}.tmp"
            try:
                temporary.write_bytes(data)
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
        result.append({"question_id": item["question_id"], "diagram_id": item["diagram_id"], "path": str(destination)})
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", help="Immutable reviewed snapshot UUID")
    args = parser.parse_args()
    try:
        result = download_snapshot(HostedClient.from_environment(Path.cwd()), args.snapshot)
        print(json.dumps({"snapshot_id": args.snapshot, "images": result}, ensure_ascii=False))
        return 0
    except ImageError as error:
        print(str(error), file=sys.stderr)
    except Exception:
        print("Grill image preparation failed. Check Harness configuration and retry the snapshot.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
