"""Helpers for Muse dynamic credential surrogates.

Import this bundled helper from generated skill CLIs. It returns only
``hsurr:*`` surrogate values; Sentinel/authd replace those surrogates with
real credentials on approved outbound requests.
"""

from __future__ import annotations

import json
import os
import socket
from http.client import HTTPResponse
import urllib.parse
import urllib.request
from typing import Iterable


AUTHD_SOCKET = os.environ.get("JARVIS_AUTHD_SOCK", "/run/hatch/auth/authd.sock")
SURROGATE_PATH = "/v1/credentials/surrogate"


class DynamicCredentialError(RuntimeError):
    """Raised when a dynamic credential cannot be loaded or applied."""


def _post_json_unix(socket_path: str, path: str, payload: dict, timeout: float) -> str:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = (
        f"POST {path} HTTP/1.1\r\n"
        "Host: authd.local\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode("ascii") + body

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(socket_path)
        conn.sendall(request)
        chunks = []
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)

    raw = b"".join(chunks)
    header_bytes, sep, response_body = raw.partition(b"\r\n\r\n")
    if not sep:
        raise DynamicCredentialError("authd returned a malformed HTTP response")
    status_line = header_bytes.splitlines()[0].decode("iso-8859-1", errors="replace")
    parts = status_line.split(" ", 2)
    if len(parts) < 2 or not parts[1].isdigit():
        raise DynamicCredentialError(f"authd returned malformed status: {status_line}")
    status = int(parts[1])
    text = response_body.decode("utf-8", errors="replace")
    if status != 200:
        raise DynamicCredentialError(
            f"authd {SURROGATE_PATH} returned HTTP {status}: {text.strip()}"
        )
    return text


def dynamic_credential_entry(
    credential_name: str,
    entry_name: str = "access_token",
    *,
    socket_path: str = AUTHD_SOCKET,
    timeout: float = 5.0,
) -> dict:
    """Return one surrogated credential entry from authd."""

    text = _post_json_unix(socket_path, SURROGATE_PATH, {"name": credential_name}, timeout)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise DynamicCredentialError("authd surrogate response was not JSON") from exc

    for entry in payload.get("credentials", []):
        if entry.get("name") != entry_name:
            continue
        surrogate = str(entry.get("surrogate", "")).strip()
        if not surrogate.startswith("hsurr:"):
            raise DynamicCredentialError(
                f"authd returned a non-surrogate value for {credential_name}:{entry_name}"
            )
        return entry

    raise DynamicCredentialError(
        f"missing {entry_name} surrogate for credential {credential_name}"
    )


def ensure_allowed_url(url: str, allowed_hosts: Iterable[str]) -> None:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    allowed = {item.strip().lower() for item in allowed_hosts if item.strip()}
    if not host or host not in allowed:
        allowed_display = ", ".join(sorted(allowed)) or "<none>"
        raise DynamicCredentialError(
            f"refusing authenticated request to {host or '<missing host>'}; "
            f"allowed hosts: {allowed_display}"
        )


def add_surrogate_to_request(
    request: urllib.request.Request,
    credential_name: str,
    *,
    entry_name: str = "access_token",
    allowed_hosts: Iterable[str],
) -> None:
    """Apply a dynamic credential surrogate to a urllib request."""

    ensure_allowed_url(request.full_url, allowed_hosts)
    entry = dynamic_credential_entry(credential_name, entry_name)
    surrogate = str(entry["surrogate"]).strip()
    placement = entry.get("placement")

    if placement == "bearer_header":
        request.add_header("Authorization", f"Bearer {surrogate}")
        return
    if isinstance(placement, dict) and isinstance(placement.get("custom_header"), str):
        request.add_header(placement["custom_header"], surrogate)
        return
    if isinstance(placement, dict) and "url_path_segment" in placement:
        raise DynamicCredentialError(
            "url_path_segment credentials must be applied before Request creation"
        )
    if isinstance(placement, dict) and "query_param" in placement:
        raise DynamicCredentialError(
            "query_param credentials must be applied to the URL before Request "
            "creation; use url_with_surrogate_query_param(...)"
        )
    raise DynamicCredentialError(f"unsupported credential placement: {placement!r}")


def read_response_body(response: HTTPResponse, chunk_size: int = 65536) -> bytes:
    """Read an HTTP response without requiring Content-Length to be exact."""

    chunks = []
    while True:
        chunk = response.read(chunk_size)
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


def read_json_response(response: HTTPResponse) -> dict:
    """Read a JSON response body using chunked reads."""

    body = read_response_body(response)
    try:
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise DynamicCredentialError("provider response was not valid JSON") from exc


def url_with_surrogate_path_segment(
    url_template: str,
    credential_name: str,
    *,
    entry_name: str = "access_token",
    allowed_hosts: Iterable[str],
) -> str:
    """Replace a ``{}`` placeholder in a URL path with a surrogate token."""

    ensure_allowed_url(url_template, allowed_hosts)
    if "{}" not in urllib.parse.urlparse(url_template).path:
        raise DynamicCredentialError("url template path must contain {} placeholder")
    entry = dynamic_credential_entry(credential_name, entry_name)
    placement = entry.get("placement")
    if not (isinstance(placement, dict) and "url_path_segment" in placement):
        raise DynamicCredentialError(f"credential is not url_path_segment: {placement!r}")
    surrogate = urllib.parse.quote(str(entry["surrogate"]).strip(), safe="")
    return url_template.replace("{}", surrogate, 1)


def url_with_surrogate_query_param(
    url: str,
    credential_name: str,
    *,
    entry_name: str = "access_token",
    allowed_hosts: Iterable[str],
) -> str:
    """Append a surrogate to the URL's named query parameter.

    The placement names the query parameter (``{"query_param": "api_key"}``);
    the surrogate is added as ``?<name>=<surrogate>``. Sentinel replaces the
    surrogate with the real key on approved egress. Pass the returned URL to the
    request instead of building the query string with the secret in the skill.
    """

    ensure_allowed_url(url, allowed_hosts)
    entry = dynamic_credential_entry(credential_name, entry_name)
    placement = entry.get("placement")
    if not (isinstance(placement, dict) and isinstance(placement.get("query_param"), str)):
        raise DynamicCredentialError(f"credential is not query_param: {placement!r}")
    param = placement["query_param"]
    surrogate = str(entry["surrogate"]).strip()
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.append((param, surrogate))
    new_query = urllib.parse.urlencode(query)
    return urllib.parse.urlunsplit(parsed._replace(query=new_query))
