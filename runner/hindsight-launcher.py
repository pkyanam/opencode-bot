#!/usr/bin/env python3
import os
import socket
import sys
from urllib.parse import quote

from pg0 import Pg0

pg = Pg0(name="hindsight", username="hindsight", password="hindsight", database="hindsight")
# pg0 is a process-level dependency shared by Hindsight child restarts.  Reuse
# a live instance instead of calling start(), which fails when pg0 is already
# running.  An explicit non-pg0 URL remains available for production images
# that provide managed Postgres.
configured_url = os.environ.get("HINDSIGHT_API_DATABASE_URL")
if configured_url and configured_url != "pg0":
    os.execvp("hindsight-api", ["hindsight-api", *sys.argv[1:]])
info = pg.info()
if not getattr(info, "running", False):
    try:
        info = pg.start()
    except Exception as startup_error:
        # pg0's metadata can briefly report `running=False` after the child
        # API exits even though its managed Postgres daemon remains alive.
        # Reuse its recorded local port when it accepts connections; otherwise
        # propagate the original startup error.
        try:
            known_port = getattr(pg.info(), "port", None) or getattr(info, "port", None)
            if not known_port:
                raise startup_error
            with socket.create_connection(("127.0.0.1", int(known_port)), timeout=1):
                info = type("PgInfo", (), {"port": known_port, "running": True})()
        except OSError:
            raise startup_error
port = getattr(info, "port", None) or getattr(pg.info(), "port", None)
if not port:
    raise RuntimeError("pg0 did not provide a PostgreSQL port")
uri = f"postgresql://{quote('hindsight')}:{quote('hindsight')}@127.0.0.1:{int(port)}/hindsight"
os.environ["HINDSIGHT_API_DATABASE_URL"] = uri
os.execvp("hindsight-api", ["hindsight-api", *sys.argv[1:]])
