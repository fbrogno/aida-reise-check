#!/bin/bash
cd "$(dirname "$0")" || exit 1
( sleep 1; open http://127.0.0.1:8765 ) &
python3 app/serve.py
