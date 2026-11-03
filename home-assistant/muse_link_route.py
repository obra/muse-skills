"""Send this process's TCP connections to home-network addresses through the
Muse Home Link proxy.

Loaded at interpreter start by muse_link_route.pth. Does nothing unless
MUSE_LINK_PROXY names the Link proxy, as host:port or http://host:port. A connection to an IPv4
address inside MUSE_LINK_ROUTE_CIDRS (default: the private RFC 1918 ranges,
minus the tunnel's own subnet) is opened to the proxy and turned into an HTTP
CONNECT tunnel to that address. Only TCP sockets are routed; every other
connection, UDP included, is left alone.

Supported callers: asyncio's selector event loop (aiohttp, asyncio streams,
loop.sock_connect and loop.create_connection), which tunnels without
blocking the loop, and blocking socket.connect callers (requests and urllib3,
urllib, httpx). Other event loops (uvloop, trio) and code that drives its own
non-blocking connect are not supported; for them the tunnel is set up in
blocking mode, bounded at _NONBLOCKING_CONNECT_TIMEOUT seconds.
scripts/tests/test_home_assistant_link_route.py pins this behaviour.

The service also sets the cell's HTTP(S)_PROXY for package downloads, with
the private ranges in NO_PROXY. urllib and httpx do not understand CIDR
entries there, so this module makes them bypass the proxy for those
addresses too; requests, uv and aiohttp need no help.
"""

import importlib.abc
import ipaddress
import os
import socket
import sys

_PROXY = os.environ.get("MUSE_LINK_PROXY", "").strip()
_DEFAULT_CIDRS = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
_EXCLUDED = (ipaddress.ip_network("10.42.0.0/24"),)
_MAX_REPLY = 16384
_NONBLOCKING_CONNECT_TIMEOUT = 10.0
_NETWORKS = ()


def _parse_proxy(value):
    host, _, port = value.split("://", 1)[-1].rstrip("/").rpartition(":")
    host = host.strip("[]")
    if not host or not port.isdigit():
        raise ValueError(f"MUSE_LINK_PROXY must be host:port or http://host:port, got {value!r}")
    return host, int(port)


def _routed(address):
    if not isinstance(address, tuple) or len(address) < 2:
        return False
    try:
        ip = ipaddress.ip_address(address[0])
    except ValueError:
        return False
    if ip.version != 4 or any(ip in net for net in _EXCLUDED):
        return False
    return any(ip in net for net in _NETWORKS)


def _connect_request(address):
    target = f"{address[0]}:{address[1]}"
    return f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode()


def _check_reply(reply, address):
    status_line = reply.split(b"\r\n", 1)[0].decode("latin-1", "replace")
    parts = status_line.split(" ", 2)
    if len(parts) < 2 or parts[1] != "200":
        raise ConnectionRefusedError(
            f"Home Link proxy refused {address[0]}:{address[1]}: {status_line}"
        )


def _tcp(sock):
    return sock.type == socket.SOCK_STREAM


def _install():
    proxy_addr = _parse_proxy(_PROXY)
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex

    # The CONNECT exchange runs on the raw socket even when the caller wrapped
    # it in TLS before connecting; TLS starts once the tunnel is up.
    def tunnel_blocking(sock, address):
        timeout = sock.gettimeout()
        if timeout == 0.0:
            # Only a non-asyncio caller reaches here with a non-blocking
            # socket; bound how long it can stall that caller's loop.
            sock.settimeout(_NONBLOCKING_CONNECT_TIMEOUT)
        try:
            original_connect(sock, proxy_addr)
            socket.socket.sendall(sock, _connect_request(address))
            reply = b""
            while b"\r\n\r\n" not in reply:
                chunk = socket.socket.recv(sock, 1)
                if not chunk or len(reply) > _MAX_REPLY:
                    raise ConnectionError("Home Link proxy closed during CONNECT")
                reply += chunk
            _check_reply(reply, address)
        finally:
            sock.settimeout(timeout)

    def connect(self, address):
        if _tcp(self) and _routed(address):
            return tunnel_blocking(self, address)
        return original_connect(self, address)

    def connect_ex(self, address):
        if _tcp(self) and _routed(address):
            try:
                tunnel_blocking(self, address)
            except OSError as err:
                return err.errno or 111
            return 0
        return original_connect_ex(self, address)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex

    from asyncio import selector_events

    original_sock_connect = selector_events.BaseSelectorEventLoop.sock_connect

    async def sock_connect(self, sock, address):
        if not _tcp(sock) or sock.family != socket.AF_INET:
            return await original_sock_connect(self, sock, address)
        # Resolve here, as the original would, so a name that resolves to a
        # home address takes this non-blocking path instead of the blocking one.
        resolved = await self._ensure_resolved(
            address, family=sock.family, type=sock.type, proto=sock.proto, loop=self
        )
        address = resolved[0][4]
        if not _routed(address):
            return await original_sock_connect(self, sock, address)
        await original_sock_connect(self, sock, proxy_addr)
        await self.sock_sendall(sock, _connect_request(address))
        reply = b""
        while b"\r\n\r\n" not in reply:
            chunk = await self.sock_recv(sock, 1)
            if not chunk or len(reply) > _MAX_REPLY:
                raise ConnectionError("Home Link proxy closed during CONNECT")
            reply += chunk
        _check_reply(reply, address)

    selector_events.BaseSelectorEventLoop.sock_connect = sock_connect


def _home_host(host):
    host = (host or "").strip()
    if host.count(":") == 1:
        host = host.partition(":")[0]
    return _routed((host.strip("[]"), 0))


def _patch_urllib(module):
    original = module.proxy_bypass_environment

    def proxy_bypass_environment(host, proxies=None):
        return _home_host(host) or original(host, proxies)

    module.proxy_bypass_environment = proxy_bypass_environment
    if module.proxy_bypass is original:
        module.proxy_bypass = proxy_bypass_environment


def _patch_httpx(module):
    clients = module._client
    for cls in (clients.Client, clients.AsyncClient):
        original = cls._transport_for_url

        def transport_for_url(self, url, _original=original):
            if _home_host(url.host):
                return self._transport
            return _original(self, url)

        cls._transport_for_url = transport_for_url


_PATCHES = {"urllib.request": _patch_urllib, "httpx": _patch_httpx}


class _PatchOnImport(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        patch = _PATCHES.get(name)
        if patch is None:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None and spec.loader is not None:
                break
        else:
            return None
        exec_module = spec.loader.exec_module

        def exec_and_patch(module):
            exec_module(module)
            try:
                patch(module)
            except AttributeError:
                pass

        spec.loader.exec_module = exec_and_patch
        return spec


if _PROXY:
    _NETWORKS = tuple(
        ipaddress.ip_network(cidr.strip())
        for cidr in os.environ.get("MUSE_LINK_ROUTE_CIDRS", _DEFAULT_CIDRS).split(",")
        if cidr.strip()
    )
    _install()
    for _name, _patch in _PATCHES.items():
        if _name in sys.modules:
            _patch(sys.modules[_name])
    sys.meta_path.insert(0, _PatchOnImport())
