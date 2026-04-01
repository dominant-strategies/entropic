#!/usr/bin/env bash

# Shared runtime helpers for mode-aware (dev/prod) Colima + Docker orchestration.
# This file is intended to be sourced by other scripts.

entropic_runtime_mode() {
    local mode="${ENTROPIC_RUNTIME_MODE:-dev}"
    case "$mode" in
        dev|prod)
            printf '%s\n' "$mode"
            ;;
        *)
            echo "ERROR: ENTROPIC_RUNTIME_MODE must be 'dev' or 'prod' (got: $mode)" >&2
            return 1
            ;;
    esac
}

entropic_default_colima_home() {
    local mode
    mode="$(entropic_runtime_mode)" || return 1
    case "$mode" in
        prod)
            printf '%s\n' "$HOME/.entropic/colima"
            ;;
        dev)
            printf '%s\n' "$HOME/.entropic/colima-dev"
            ;;
    esac
}

entropic_default_legacy_colima_home() {
    local mode
    mode="$(entropic_runtime_mode)" || return 1
    case "$mode" in
        prod)
            printf '%s\n' "$HOME/.nova/colima"
            ;;
        dev)
            printf '%s\n' "$HOME/.nova/colima-dev"
            ;;
    esac
}

entropic_colima_home() {
    if [ -n "${ENTROPIC_COLIMA_HOME:-}" ]; then
        printf '%s\n' "$ENTROPIC_COLIMA_HOME"
        return 0
    fi
    entropic_default_colima_home
}

entropic_mode_label() {
    local mode
    mode="$(entropic_runtime_mode)" || return 1
    if [ "$mode" = "prod" ]; then
        printf '%s\n' "production"
    else
        printf '%s\n' "development"
    fi
}

entropic_host_os() {
    uname -s | tr '[:upper:]' '[:lower:]'
}

entropic_linux_uses_native_docker() {
    [ "$(entropic_host_os)" = "linux" ]
}

entropic_colima_home_candidates() {
    local seen=":"
    local home
    local uid
    local tmp_base
    local fallback_shared
    local fallback_tmp

    uid="$(id -u)"
    tmp_base="${TMPDIR:-/tmp}"
    tmp_base="${tmp_base%/}"
    if [ -z "$tmp_base" ]; then
        tmp_base="/tmp"
    fi
    fallback_shared="/Users/Shared/entropic/colima-${uid}"
    fallback_tmp="${tmp_base}/entropic-colima-${uid}"

    for home in \
        "$(entropic_colima_home)" \
        "$(entropic_default_colima_home)" \
        "$(entropic_default_legacy_colima_home)" \
        "$fallback_shared" \
        "$fallback_tmp"
    do
        [ -n "$home" ] || continue
        case "$seen" in
            *":$home:"*)
                continue
                ;;
        esac
        seen="${seen}${home}:"
        printf '%s\n' "$home"
    done
}

entropic_find_docker_binary() {
    local project_root="${1:-}"
    local candidates=()
    local path

    if command -v docker >/dev/null 2>&1; then
        candidates+=("$(command -v docker)")
    fi

    if [ -n "$project_root" ]; then
        if [ -x "$project_root/src-tauri/resources/bin/docker" ]; then
            candidates+=("$project_root/src-tauri/resources/bin/docker")
        fi
        if [ -x "$project_root/src-tauri/target/debug/resources/bin/docker" ]; then
            candidates+=("$project_root/src-tauri/target/debug/resources/bin/docker")
        fi
    fi

    for path in "${candidates[@]}"; do
        if "$path" --version >/dev/null 2>&1; then
            printf '%s\n' "$path"
            return 0
        fi
    done

    return 1
}

entropic_find_colima_binary() {
    local project_root="${1:-}"
    local candidates=()

    # Prefer the system colima first — bundled binaries may be Gatekeeper-rejected
    # on macOS (they pass --version but hang or get killed on actual VM operations).
    if command -v colima >/dev/null 2>&1; then
        candidates+=("$(command -v colima)")
    fi

    if [ -n "$project_root" ]; then
        if [ -x "$project_root/src-tauri/target/debug/resources/bin/colima" ]; then
            candidates+=("$project_root/src-tauri/target/debug/resources/bin/colima")
        fi
        if [ -x "$project_root/src-tauri/resources/bin/colima" ]; then
            candidates+=("$project_root/src-tauri/resources/bin/colima")
        fi
    fi

    local path
    for path in "${candidates[@]}"; do
        if "$path" --version >/dev/null 2>&1; then
            printf '%s\n' "$path"
            return 0
        fi
    done

    return 1
}

entropic_docker_host_is_available() {
    local docker_bin="$1"
    local candidate="$2"
    if [ -z "$candidate" ]; then
        return 1
    fi
    DOCKER_HOST="$candidate" "$docker_bin" info >/dev/null 2>&1
}

entropic_docker_host_for_profile() {
    local docker_bin="$1"
    local colima_home="$2"
    local profile="$3"
    local sock="$colima_home/$profile/docker.sock"
    local candidate="unix://$sock"
    if [ -S "$sock" ] && entropic_docker_host_is_available "$docker_bin" "$candidate"; then
        printf '%s\n' "$candidate"
        return 0
    fi
    return 1
}

entropic_resolve_mode_docker_host() {
    local docker_bin="$1"
    local home
    local host

    if [ -n "${DOCKER_HOST:-}" ] && entropic_docker_host_is_available "$docker_bin" "$DOCKER_HOST"; then
        printf '%s\n' "$DOCKER_HOST"
        return 0
    fi

    while IFS= read -r home; do
        if host="$(entropic_docker_host_for_profile "$docker_bin" "$home" "entropic-vz")"; then
            printf '%s\n' "$host"
            return 0
        fi
        if host="$(entropic_docker_host_for_profile "$docker_bin" "$home" "entropic-qemu")"; then
            printf '%s\n' "$host"
            return 0
        fi
    done < <(entropic_colima_home_candidates)

    return 1
}

entropic_default_docker_is_ready() {
    local docker_bin="$1"
    "$docker_bin" info >/dev/null 2>&1
}

entropic_runtime_path_for_colima() {
    local colima_bin="$1"
    local project_root="${2:-}"
    local path_prefix
    path_prefix="$PATH"
    # Only prepend bundled bin dirs when using a bundled colima binary.
    # If the system colima is used, prepending bundled paths would cause
    # system colima to find Gatekeeper-killed limactl/lima instead of the
    # system-installed ones, resulting in "signal: killed" errors.
    if [ -n "$project_root" ] && [[ "$colima_bin" == "$project_root/"* ]]; then
        path_prefix="$project_root/src-tauri/target/debug/resources/bin:$project_root/src-tauri/resources/bin:$path_prefix"
    fi
    printf '%s\n' "$path_prefix"
}

entropic_run_colima() {
    local colima_bin="$1"
    local colima_home="$2"
    local project_root="$3"
    shift 3

    COLIMA_HOME="$colima_home" \
    LIMA_HOME="$colima_home/_lima" \
    PATH="$(entropic_runtime_path_for_colima "$colima_bin" "$project_root")" \
    "$colima_bin" "$@"
}

entropic_qemu_available() {
    command -v qemu-img >/dev/null 2>&1
}

entropic_cleanup_stale_colima_profile() {
    local colima_bin="$1"
    local colima_home="$2"
    local project_root="$3"
    local profile="$4"
    local runtime_dir="$colima_home/$profile"
    local instance_dir="$colima_home/_lima/colima-$profile"
    local pid_file="$runtime_dir/daemon/daemon.pid"
    local pid
    local command

    entropic_run_colima "$colima_bin" "$colima_home" "$project_root" --profile "$profile" stop --force >/dev/null 2>&1 || true

    if [ -f "$pid_file" ]; then
        pid="$(tr -dc '0-9' < "$pid_file" | head -c 32)"
        if [ -n "$pid" ]; then
            command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
            case "$command" in
                *colima*|*lima*|*hostagent*)
                    kill "$pid" >/dev/null 2>&1 || true
                    sleep 1
                    if kill -0 "$pid" >/dev/null 2>&1; then
                        kill -9 "$pid" >/dev/null 2>&1 || true
                    fi
                    ;;
            esac
        fi
        rm -f "$pid_file"
    fi

    rm -f \
        "$runtime_dir/docker.sock" \
        "$runtime_dir/containerd.sock" \
        "$instance_dir/ha.sock"
}

entropic_colima_profile_log_contains() {
    local colima_home="$1"
    local profile="$2"
    local pattern="$3"
    local ha_log="$colima_home/_lima/colima-$profile/ha.stderr.log"

    [ -f "$ha_log" ] || return 1
    grep -qi "$pattern" "$ha_log"
}

entropic_start_colima_for_mode() {
    local docker_bin="$1"
    local colima_bin="$2"
    local project_root="$3"
    local colima_home
    local profile
    local vm_type
    local host
    local attempts_left
    local start_output

    colima_home="$(entropic_colima_home)" || return 1
    mkdir -p "$colima_home/_lima"

    for profile in entropic-vz entropic-qemu; do
        if [ "$profile" = "entropic-vz" ]; then
            vm_type="vz"
        else
            vm_type="qemu"
        fi

        if [ "$vm_type" = "qemu" ] && ! entropic_qemu_available; then
            echo "WARNING: Skipping Colima qemu fallback for profile $profile because qemu-img is not installed." >&2
            continue
        fi

        if host="$(entropic_docker_host_for_profile "$docker_bin" "$colima_home" "$profile")"; then
            printf '%s\n' "$host"
            return 0
        fi

        if entropic_run_colima "$colima_bin" "$colima_home" "$project_root" --profile "$profile" status 2>/dev/null | grep -qi "running"; then
            entropic_run_colima "$colima_bin" "$colima_home" "$project_root" --profile "$profile" stop --force >/dev/null 2>&1 || true
        fi

        if start_output="$(entropic_run_colima "$colima_bin" "$colima_home" "$project_root" --profile "$profile" start --vm-type "$vm_type" 2>&1)"; then
            printf '%s\n' "$start_output" >&2
            attempts_left=30
            while [ "$attempts_left" -gt 0 ]; do
                if host="$(entropic_docker_host_for_profile "$docker_bin" "$colima_home" "$profile")"; then
                    printf '%s\n' "$host"
                    return 0
                fi
                sleep 1
                attempts_left=$((attempts_left - 1))
            done
        else
            printf '%s\n' "$start_output" >&2
            if [ "$vm_type" = "vz" ] && {
                printf '%s\n' "$start_output" | grep -qi "in use by instance" ||
                entropic_colima_profile_log_contains "$colima_home" "$profile" "in use by instance"
            }; then
                echo "WARNING: Detected stale Colima VZ state for profile $profile; forcing cleanup and retrying once." >&2
                entropic_cleanup_stale_colima_profile "$colima_bin" "$colima_home" "$project_root" "$profile"
                if start_output="$(entropic_run_colima "$colima_bin" "$colima_home" "$project_root" --profile "$profile" start --vm-type "$vm_type" 2>&1)"; then
                    printf '%s\n' "$start_output" >&2
                    attempts_left=30
                    while [ "$attempts_left" -gt 0 ]; do
                        if host="$(entropic_docker_host_for_profile "$docker_bin" "$colima_home" "$profile")"; then
                            printf '%s\n' "$host"
                            return 0
                        fi
                        sleep 1
                        attempts_left=$((attempts_left - 1))
                    done
                else
                    printf '%s\n' "$start_output" >&2
                fi
            fi
        fi
    done

    return 1
}

entropic_delete_colima_profiles() {
    local colima_bin="$1"
    local project_root="$2"
    local colima_home

    colima_home="$(entropic_colima_home)" || return 1
    entropic_run_colima "$colima_bin" "$colima_home" "$project_root" --profile entropic-vz stop --force >/dev/null 2>&1 || true
    entropic_run_colima "$colima_bin" "$colima_home" "$project_root" --profile entropic-qemu stop --force >/dev/null 2>&1 || true
    entropic_run_colima "$colima_bin" "$colima_home" "$project_root" --profile entropic-vz delete --force >/dev/null 2>&1 || true
    entropic_run_colima "$colima_bin" "$colima_home" "$project_root" --profile entropic-qemu delete --force >/dev/null 2>&1 || true
}

entropic_remove_colima_home_if_safe() {
    local target="$1"
    local tmp_base

    if [ -z "$target" ]; then
        return 1
    fi

    tmp_base="${TMPDIR:-/tmp}"
    tmp_base="${tmp_base%/}"
    if [ -z "$tmp_base" ]; then
        tmp_base="/tmp"
    fi

    case "$target" in
        "/"|"/Users"|"/tmp"|"$HOME")
            return 1
            ;;
        "$HOME/.entropic/colima"|"$HOME/.entropic/colima-dev"|"$HOME/.nova/colima"|"$HOME/.nova/colima-dev"|"/Users/Shared/entropic/colima-"*|"/tmp/entropic-colima-"*|"${tmp_base}/entropic-colima-"*)
            rm -rf "$target"
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

entropic_default_context_allowed() {
    # Allow Docker Desktop if explicitly requested
    [ "${ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP:-0}" = "1" ] && return 0

    # Auto-allow on CI environments (GitHub Actions, GitLab CI, etc.)
    [ "${CI:-}" = "true" ] && return 0
    [ -n "${GITHUB_ACTIONS:-}" ] && return 0
    [ -n "${GITLAB_CI:-}" ] && return 0
    [ -n "${CIRCLECI:-}" ] && return 0

    return 1
}
