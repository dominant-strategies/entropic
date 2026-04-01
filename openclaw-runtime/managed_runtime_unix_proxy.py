#!/usr/bin/env python3
import argparse
import selectors
import socket
import socketserver
import sys
from typing import Optional


def log(message: str) -> None:
    print(f"[managed-runtime-proxy] {message}", flush=True)


def forward_bidirectional(client: socket.socket, upstream: socket.socket) -> None:
    selector = selectors.DefaultSelector()
    selector.register(client, selectors.EVENT_READ, upstream)
    selector.register(upstream, selectors.EVENT_READ, client)
    sockets_open = 2

    try:
        while sockets_open > 0:
            for key, _ in selector.select():
                source: socket.socket = key.fileobj
                target: socket.socket = key.data
                try:
                    data = source.recv(65536)
                except OSError:
                    data = b""

                if not data:
                    try:
                        selector.unregister(source)
                    except Exception:
                        pass
                    sockets_open -= 1
                    try:
                        target.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    continue

                try:
                    target.sendall(data)
                except OSError:
                    return
    finally:
        selector.close()


class ProxyServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def make_handler(unix_socket_path: str):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            upstream: Optional[socket.socket] = None
            try:
                upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                upstream.connect(unix_socket_path)
                forward_bidirectional(self.request, upstream)
            except Exception as error:
                log(f"proxy error from {self.client_address}: {error}")
            finally:
                if upstream is not None:
                    try:
                        upstream.close()
                    except OSError:
                        pass
                try:
                    self.request.close()
                except OSError:
                    pass

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen-host", default="127.0.0.1")
    parser.add_argument("--listen-port", type=int, default=11445)
    parser.add_argument("--unix-socket", required=True)
    args = parser.parse_args()

    server = ProxyServer((args.listen_host, args.listen_port), make_handler(args.unix_socket))
    log(
        f"listening on http://{args.listen_host}:{args.listen_port} -> unix://{args.unix_socket}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
