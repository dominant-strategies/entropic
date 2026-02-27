#!/bin/bash
set -euo pipefail

# Entropic Cleanup Script
# Run this script to completely remove Entropic's runtime and data
# Usage: ./scripts/cleanup-entropic.sh

echo "╔════════════════════════════════════════╗"
echo "║      Entropic Application Cleanup          ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "This script will remove:"
echo "  • Colima VMs and runtime"
echo "  • Docker containers and volumes"
echo "  • Application cache and state"
echo "  • Runtime binaries and configuration"
echo ""
echo "All app data (chat history, settings, caches) will be removed."
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cleanup cancelled."
    exit 0
fi

echo ""
echo "Starting cleanup..."
echo ""

# Kill any running Nova/Entropic processes so their open file handles
# don't block directory removal with "permission denied".
echo "→ Stopping any running Entropic/Nova processes..."
pkill -9 -f "[Ee]ntropic" 2>/dev/null || true
pkill -9 -f "[Nn]ova\.app" 2>/dev/null || true
sleep 1
echo "  ✓ Done"
echo ""

# Find Docker binary
DOCKER_BIN=""
if command -v docker >/dev/null 2>&1; then
    DOCKER_BIN="$(command -v docker)"
fi

# Find Colima binary
COLIMA_BIN=""
if command -v colima >/dev/null 2>&1; then
    COLIMA_BIN="$(command -v colima)"
fi

# Clean up Docker containers and volumes (both dev and prod)
if [ -n "$DOCKER_BIN" ]; then
    echo "→ Cleaning up Docker resources..."

    for profile in nova-vz nova-qemu entropic-vz entropic-qemu; do
        for colima_home in "$HOME/.nova/colima" "$HOME/.nova/colima-dev" "$HOME/.entropic/colima" "$HOME/.entropic/colima-dev"; do
            sock="$colima_home/$profile/docker.sock"
            if [ -S "$sock" ]; then
                DOCKER_HOST="unix://$sock"
                export DOCKER_HOST

                echo "  Removing containers from $profile..."
                $DOCKER_BIN ps -aq 2>/dev/null | xargs -r $DOCKER_BIN rm -f 2>/dev/null || true

                echo "  Removing volumes from $profile..."
                $DOCKER_BIN volume ls -q 2>/dev/null | xargs -r $DOCKER_BIN volume rm -f 2>/dev/null || true

                echo "  Running system prune on $profile..."
                $DOCKER_BIN system prune -af --volumes 2>/dev/null || true
            fi
        done
    done

    unset DOCKER_HOST
    echo "  ✓ Docker cleanup complete"
else
    echo "  ⊘ Docker not found, skipping Docker cleanup"
fi

# Stop and delete Colima VMs
if [ -n "$COLIMA_BIN" ]; then
    echo "→ Stopping and deleting Colima VMs..."

    for profile in nova-vz nova-qemu entropic-vz entropic-qemu; do
        for colima_home in "$HOME/.nova/colima" "$HOME/.nova/colima-dev" "$HOME/.entropic/colima" "$HOME/.entropic/colima-dev"; do
            echo "  Removing legacy $colima_home ($profile)..."
            COLIMA_HOME="$colima_home" LIMA_HOME="$colima_home/_lima" \
                $COLIMA_BIN delete -f -p "$profile" 2>/dev/null || true
        done
    done

    echo "  ✓ Colima VMs deleted"
else
    echo "  ⊘ Colima not found, skipping VM deletion"
fi

# Remove runtime directories from both naming eras.
for runtime_dir in "$HOME/.nova" "$HOME/.entropic"; do
    echo "→ Removing runtime directory: $runtime_dir"
    if [ -d "$runtime_dir" ]; then
        rm -rf "$runtime_dir"
        echo "  ✓ Removed $runtime_dir"
    else
        echo "  ⊘ $runtime_dir not found"
    fi
done

# Clean ALL app data (chat history, settings, caches — full reset)
echo "→ Removing all app data and caches..."
for dir in \
    "$HOME/Library/Application Support/ai.openclaw.entropic" \
    "$HOME/Library/Application Support/ai.openclaw.entropic.dev" \
    "$HOME/Library/Application Support/ai.openclaw.nova" \
    "$HOME/Library/Caches/entropic" \
    "$HOME/Library/Caches/entropic-dev" \
    "$HOME/.cache/entropic"; do
    if [ -d "$dir" ]; then
        chmod -R u+w "$dir" 2>/dev/null || true
        rm -rf "$dir"
        echo "  ✓ Removed $dir"
    else
        echo "  ⊘ $dir not found"
    fi
done

# Clean Docker contexts
echo "→ Cleaning Docker contexts..."
if [ -n "$DOCKER_BIN" ]; then
    $DOCKER_BIN context rm colima-nova-vz 2>/dev/null || true
    $DOCKER_BIN context rm colima-nova-qemu 2>/dev/null || true
    $DOCKER_BIN context rm colima-entropic-vz 2>/dev/null || true
    $DOCKER_BIN context rm colima-entropic-qemu 2>/dev/null || true
    echo "  ✓ Docker contexts cleaned"
fi

echo ""
echo "╔════════════════════════════════════════╗"
echo "║        Cleanup Complete! ✓             ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Entropic has been reset to a clean state."
echo "All app data, caches, and settings have been removed."
echo ""
echo "You can now:"
echo "  • Reinstall Entropic"
echo "  • Restart the app for a fresh setup"
echo "  • Move the app to trash if uninstalling"
echo ""
