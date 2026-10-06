#!/bin/bash
# Stop only node listeners on the dashboard port; stopped is already success.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/dashboard-control.sh"
stop_dashboard_server
