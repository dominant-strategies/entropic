#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== Building Skill Scanner Container ==="
docker build -t nova-skill-scanner:latest "$PROJECT_ROOT/skill-scanner"
echo "=== Skill Scanner image built: nova-skill-scanner:latest ==="
docker images nova-skill-scanner:latest
