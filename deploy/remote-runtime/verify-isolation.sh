#!/usr/bin/env bash
set -euo pipefail

namespace="${ANICODE_RUNTIME_NAMESPACE:-anicode-runtime}"
direct_pod="anicode-cni-direct-$RANDOM"
proxy_pod="anicode-cni-proxy-$RANDOM"
unauthorized_pod="anicode-cni-unauthorized-$RANDOM"

cleanup() {
  kubectl -n "$namespace" delete pod "$direct_pod" "$proxy_pod" "$unauthorized_pod" \
    --ignore-not-found --wait=false >/dev/null
}
trap cleanup EXIT

kubectl cluster-info >/dev/null
command -v jq >/dev/null
enforce="$(kubectl get namespace "$namespace" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')"
test "$enforce" = "restricted"

# Keep the deployed controller's least-privilege RBAC synchronized with KubernetesJobRuntime's
# two-phase protocol: create a suspended Job, UID-bound PATCH it active, and manage only exact-name
# execution-scoped Secrets. `kubectl auth can-i` checks the effective RoleBindings, not just YAML.
controller_identity="system:serviceaccount:${namespace}:anicode-control-plane"
require_controller_permission() {
  local verb="$1"
  local resource="$2"
  local allowed
  allowed="$(kubectl auth can-i "$verb" "$resource" --as="$controller_identity" -n "$namespace")"
  if test "$allowed" != "yes"; then
    echo "controller RBAC is missing: $verb $resource" >&2
    exit 1
  fi
}
deny_controller_permission() {
  local verb="$1"
  local resource="$2"
  local allowed
  allowed="$(kubectl auth can-i "$verb" "$resource" --as="$controller_identity" -n "$namespace")"
  if test "$allowed" != "no"; then
    echo "controller RBAC is broader than required: $verb $resource" >&2
    exit 1
  fi
}

for verb in create get list watch delete patch; do
  require_controller_permission "$verb" jobs.batch
done
for verb in create get delete; do
  require_controller_permission "$verb" secrets
done
for verb in list watch update patch; do
  deny_controller_permission "$verb" secrets
done

control_image="$(kubectl -n "$namespace" get deployment anicode-remote-runtime \
  -o jsonpath='{.spec.template.spec.containers[0].image}')"
runner_image="$(kubectl -n "$namespace" get deployment anicode-remote-runtime \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="ANICODE_RUNTIME_IMAGE")].value}')"
case "$control_image$runner_image" in
  *REPLACE_WITH_DIGEST*|*:latest*)
    echo "refusing isolation test with placeholder or latest image" >&2
    exit 1
    ;;
esac
test -n "$runner_image"

tls_mode="$(kubectl -n "$namespace" get deployment anicode-remote-runtime \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="ANICODE_REMOTE_TLS_MODE")].value}')"
case "$tls_mode" in
  native) ;;
  trusted-proxy)
    service_type="$(kubectl -n "$namespace" get service anicode-remote-runtime \
      -o jsonpath='{.spec.type}')"
    test "$service_type" = "ClusterIP"
    kubectl -n "$namespace" get networkpolicy \
      remote-runtime-ingress-from-tls-gateway-only >/dev/null
    ;;
  *)
    echo "Remote Runtime has no accepted TLS boundary mode" >&2
    exit 1
    ;;
esac

if test -n "${ANICODE_REMOTE_PUBLIC_URL:-}"; then
  case "$ANICODE_REMOTE_PUBLIC_URL" in
    https://*) ;;
    *)
      echo "ANICODE_REMOTE_PUBLIC_URL must use https://" >&2
      exit 1
      ;;
  esac
  node -e 'fetch(new URL("/healthz", process.argv[1])).then(r=>process.exit(r.ok?0:1)).catch(e=>{console.error(e);process.exit(1)})' \
    "$ANICODE_REMOTE_PUBLIC_URL"
else
  echo "ANICODE_REMOTE_PUBLIC_URL is unset; external certificate/TLS routing was not probed" >&2
fi

secure_run() {
  local name="$1"
  local labels="$2"
  shift 2
  kubectl -n "$namespace" run "$name" --restart=Never --image="$runner_image" \
    --labels="$labels" --dry-run=client -o json --command -- "$@" |
    jq '.spec.automountServiceAccountToken = false
      | .spec.securityContext = {"runAsNonRoot":true,"seccompProfile":{"type":"RuntimeDefault"}}
      | .spec.containers[0].securityContext = {"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}
      | .spec.containers[0].resources = {"requests":{"cpu":"10m","memory":"32Mi"},"limits":{"cpu":"100m","memory":"128Mi"}}' |
    kubectl apply -f - >/dev/null
}

deny_script='const dns=require("node:dns").promises;const net=require("node:net");
const socket=(host,port)=>new Promise(r=>{const s=net.connect({host,port});const done=x=>{s.destroy();r(x)};s.setTimeout(1500,()=>done(false));s.once("connect",()=>done(true));s.once("error",()=>done(false))});
(async()=>{const probes=[await socket("1.1.1.1",443),await socket("169.254.169.254",80),await socket("2606:4700:4700::1111",443)];let resolved=false;try{await dns.lookup("example.com");resolved=true}catch{}if(probes.some(Boolean)||resolved){console.error({probes,resolved});process.exit(1)}console.log("direct IPv4/IPv6, metadata and DNS egress denied")})()'

secure_run "$direct_pod" 'app.kubernetes.io/name=anicode-runner,anicode.dev/network=denied' \
  node -e "$deny_script"
kubectl -n "$namespace" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$direct_pod" --timeout=45s
kubectl -n "$namespace" logs "$direct_pod"

proxy_ip="$(kubectl -n "$namespace" get endpointslice \
  -l kubernetes.io/service-name=anicode-egress-proxy \
  -o jsonpath='{.items[0].endpoints[0].addresses[0]}')"
test -n "$proxy_ip"
proxy_script='const net=require("node:net");const [host,port]=process.argv.slice(1);const s=net.connect({host,port:Number(port)});let data="";s.setTimeout(3000,()=>process.exit(2));s.once("connect",()=>s.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));s.on("data",c=>data+=c);s.on("end",()=>{if(!data.includes(" 407 ")){console.error(data);process.exit(1)}console.log("proxy reachable only through authenticated protocol")});s.once("error",e=>{console.error(e);process.exit(2)})'

secure_run "$proxy_pod" 'app.kubernetes.io/name=anicode-runner,anicode.dev/network=proxy' \
  node -e "$proxy_script" "$proxy_ip" 8080
kubectl -n "$namespace" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$proxy_pod" --timeout=45s
kubectl -n "$namespace" logs "$proxy_pod"

unauthorized_script='const net=require("node:net");const [host,port]=process.argv.slice(1);const s=net.connect({host,port:Number(port)});s.setTimeout(2000,()=>{console.log("unauthorized pod cannot reach proxy");s.destroy();process.exit(0)});s.once("connect",()=>{console.error("unauthorized pod reached proxy");process.exit(1)});s.once("error",()=>process.exit(0))'
secure_run "$unauthorized_pod" 'app.kubernetes.io/name=untrusted-probe' \
  node -e "$unauthorized_script" "$proxy_ip" 8080
kubectl -n "$namespace" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$unauthorized_pod" --timeout=45s
kubectl -n "$namespace" logs "$unauthorized_pod"

kubectl -n "$namespace" rollout status deployment/anicode-remote-runtime --timeout=120s
kubectl -n "$namespace" rollout status deployment/anicode-egress-proxy --timeout=120s
echo "AniCode Kubernetes isolation verification passed"
