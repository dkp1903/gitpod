#!/bin/bash

echo 'patching configmap server-config'
LINE="\"githubApp\": \{\"appId\":${GH_APP_ID},\"authProviderId\":\"Public-GitHub\",\"certPath\":\"\/github-app-cert\/cert\",\"certSecretName\":\"server-github-app-cert\",\"enabled\":true,\"marketplaceName\":\"gitpod-io\",\"webhookSecret\":\"omgsecret\"}"
kubectl get cm server-config -o yaml > server-config.yml
perl -0777 -i.original -pe "s/\"githubApp\":.+?\}/$LINE/igs" server-config.yml
kubectl apply -f server-config.yml
rm server-config.yml

echo 'updating the secret'
kubectl delete secret server-github-app-cert
kubectl create secret generic server-github-app-cert --from-literal=cert="$GH_APP_KEY"

if kubectl get deployment server -o json | grep -q 'github-app-cert-secret'; then
  echo 'deployment already contains github-app-cert-volume. Skipping patching server deployment.'
else
  echo 'updating server deployment'
  kubectl get deployment server -o json | \
    sed -E "s|\"volumeMounts\": \[|\"volumeMounts\": \[ {\"name\": \"github-app-cert-secret\", \"readOnly\": true, \"mountPath\": \"/github-app-cert\"},|" | \
    sed -E "s|\"volumes\": \[|\"volumes\": \[ {\"name\": \"github-app-cert-secret\", \"secret\": { \"secretName\": \"server-github-app-cert\"}},|" | \
    kubectl apply -f -
fi
echo 'restarting server deployment'
kubectl rollout restart deployment server