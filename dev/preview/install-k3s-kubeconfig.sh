#!/usr/bin/env bash

set -euo pipefail

VM_NAME="$(git symbolic-ref HEAD 2>&1 | awk '{ sub(/^refs\/heads\//, ""); $0 = tolower($0); gsub(/[^-a-z0-9]/, "-"); print }')"
NAMESPACE="preview-${VM_NAME}"

PRIVATE_KEY=$HOME/.ssh/vm_id_rsa
PUBLIC_KEY=$HOME/.ssh/vm_id_rsa.pub
PORT=8022
THIS_DIR="$(dirname "$0")"
USER="ubuntu"

KUBECONFIG_PATH="/home/gitpod/.kube/config"
K3S_KUBECONFIG_PATH="$(mktemp)"
MERGED_KUBECONFIG_PATH="$(mktemp)"

K3S_CONTEXT="k3s-preview-environment"
K3S_ENDPOINT="${VM_NAME}.kube.gitpod-dev.com"

while getopts n:p:u: flag
do
    case "${flag}" in
        n) NAMESPACE="${OPTARG}";;
        p) PORT="${OPTARG}";;
        u) USER="${OPTARG}";;
        *) ;;
    esac
done


function log {
    echo "[$(date)] $*"
}

function has-harvester-access {
    kubectl --context=harvester auth can-i get secrets > /dev/null 2>&1 || false
}

function set-up-ssh {
    if [[ (! -f $PRIVATE_KEY) || (! -f $PUBLIC_KEY) ]]; then
        log Setting up ssh-keys
        "$THIS_DIR"/install-vm-ssh-keys.sh
    fi
}

if ! has-harvester-access; then
    log Setting up kubeconfig
    "$THIS_DIR"/download-and-merge-harvester-kubeconfig.sh
fi

set-up-ssh

ssh "$USER"@127.0.0.1 \
    -o UserKnownHostsFile=/dev/null \
    -o StrictHostKeyChecking=no \
    -o "ProxyCommand=$THIS_DIR/ssh-proxy-command.sh -p $PORT -n $NAMESPACE" \
    -i "$HOME/.ssh/vm_id_rsa" \
    -p "$PORT" \
    sudo cat /etc/rancher/k3s/k3s.yaml \
    | sed 's/default/'${K3S_CONTEXT}'/g' \
    | sed -e 's/127.0.0.1/'"${K3S_ENDPOINT}"'/g' \
    > "${K3S_KUBECONFIG_PATH}"

log "Merging kubeconfig files ${KUBECONFIG_PATH} ${K3S_KUBECONFIG_PATH} into ${MERGED_KUBECONFIG_PATH}"
KUBECONFIG="${KUBECONFIG_PATH}:${K3S_KUBECONFIG_PATH}" \
    kubectl config view --flatten --merge > "${MERGED_KUBECONFIG_PATH}"

log "Overwriting ${KUBECONFIG_PATH}"
mv "${MERGED_KUBECONFIG_PATH}" "${KUBECONFIG_PATH}"

log "Cleaning up temporay K3S kubeconfig"
rm "${K3S_KUBECONFIG_PATH}"

log "Done"
