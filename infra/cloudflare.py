#!/usr/bin/env python3
"""Cloudflare side of Deyao's services (idempotent): their own tunnel `services`, Access apps and DNS, apart from Jarvis
(whose tunnel, apps and tokens are never touched). Prints nothing secret.

  CF_JARVIS2_INFRA_TOKEN  tunnel + Access apps + DNS (scoped token "jarvis2-infra")
  CLOUDFLARE_API          only to mint service tokens (the scoped token can't)

  infra/cloudflare.py OUT
      Access first, then the tunnel, DNS last:
        search.deyaochen.com → transcript search (http://search.services.svc.cluster.local:8090)
        dsh.deyaochen.com    → the persistent dsh web UI (http://dsh-web.services.svc.cluster.local:8095)
      The service token transcript-search (sessions' CLI) is kept unless ROTATE=1; a newly minted one's values go to OUT
      (mode 600) as SEARCH_ACCESS_ID/SECRET, with the tunnel's TUNNEL_TOKEN. Likewise the service token dsh-web (the dsh web
      UI's way into the sessions' own origins <id>-s.deyaochen.com, whose Access admits any service token of the account)
      as DSH_WEB_ACCESS_ID/SECRET.

Access apps:
  "Transcript search"  search.deyaochen.com  Deyao's email (the page at /), or the service token transcript-search
  "DeepSeek Harness"   dsh.deyaochen.com     Deyao's email
"""
import json, os, sys, urllib.request, urllib.error

ACCOUNT = "ee3b4deef856baf11e1a67b242438325"
ZONE = "f51ca95ee5e6c664372000f887c96a92"
EMAIL = "chendeyao000@gmail.com"
TUNNEL = "services"
SEARCH_HOST = "search.deyaochen.com"
SEARCH_ORIGIN = "http://search.services.svc.cluster.local:8090"
DSH_HOST = "dsh.deyaochen.com"
DSH_ORIGIN = "http://dsh-web.services.svc.cluster.local:8095"
API = "https://api.cloudflare.com/client/v4"


def call(method, path, body=None, token=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + (token or os.environ["CF_JARVIS2_INFRA_TOKEN"]),
                                          "Content-Type": "application/json", "User-Agent": "services-infra/1"})
    try:
        r = json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        r = json.loads(e.read() or b"{}")
    if not r.get("success"):
        raise SystemExit(f"{method} {path}: {r.get('errors')}")
    return r["result"]


def service_token(name, vals, idkey, secretkey):
    big = os.environ["CLOUDFLARE_API"]
    tok = next((t for t in call("GET", f"/accounts/{ACCOUNT}/access/service_tokens", token=big) if t["name"] == name), None)
    if tok and os.environ.get("ROTATE"):
        tok = {"id": tok["id"]} | call("POST", f"/accounts/{ACCOUNT}/access/service_tokens/{tok['id']}/rotate", token=big)
        vals |= {idkey: tok["client_id"], secretkey: tok["client_secret"]}
    elif not tok:
        tok = call("POST", f"/accounts/{ACCOUNT}/access/service_tokens", {"name": name, "duration": "8760h"}, token=big)
        vals |= {idkey: tok["client_id"], secretkey: tok["client_secret"]}
    return tok


def access_app(name, domain, policies):
    app = next((a for a in call("GET", f"/accounts/{ACCOUNT}/access/apps") if a.get("name") == name), None)
    body = {"name": name, "domain": domain, "type": "self_hosted", "session_duration": "720h",
            "app_launcher_visible": False, "auto_redirect_to_identity": False}
    app = call("PUT" if app else "POST", f"/accounts/{ACCOUNT}/access/apps" + (f"/{app['id']}" if app else ""), body)
    for p in call("GET", f"/accounts/{ACCOUNT}/access/apps/{app['id']}/policies"):
        call("DELETE", f"/accounts/{ACCOUNT}/access/apps/{app['id']}/policies/{p['id']}")
    for i, p in enumerate(policies, 1):
        call("POST", f"/accounts/{ACCOUNT}/access/apps/{app['id']}/policies", dict(p, precedence=i))
    return app["aud"]


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out, vals = sys.argv[1], {}
    tok = service_token("transcript-search", vals, "SEARCH_ACCESS_ID", "SEARCH_ACCESS_SECRET")
    aud = access_app("Transcript search", SEARCH_HOST, [
        {"name": "Deyao", "decision": "allow", "include": [{"email": {"email": EMAIL}}]},
        {"name": "sessions (scripts/transcript-search.py)", "decision": "non_identity",
         "include": [{"service_token": {"token_id": tok["id"]}}]}])
    dtok = service_token("dsh-web", vals, "DSH_WEB_ACCESS_ID", "DSH_WEB_ACCESS_SECRET")
    daud = access_app("DeepSeek Harness", DSH_HOST, [
        {"name": "Deyao", "decision": "allow", "include": [{"email": {"email": EMAIL}}]}])
    tunnels = call("GET", f"/accounts/{ACCOUNT}/cfd_tunnel?name={TUNNEL}&is_deleted=false")
    tun = tunnels[0] if tunnels else call("POST", f"/accounts/{ACCOUNT}/cfd_tunnel", {"name": TUNNEL, "config_src": "cloudflare"})
    call("PUT", f"/accounts/{ACCOUNT}/cfd_tunnel/{tun['id']}/configurations", {"config": {"ingress": [
        {"hostname": SEARCH_HOST, "service": SEARCH_ORIGIN}, {"hostname": DSH_HOST, "service": DSH_ORIGIN},
        {"service": "http_status:404"}]}})
    vals["TUNNEL_TOKEN"] = call("GET", f"/accounts/{ACCOUNT}/cfd_tunnel/{tun['id']}/token")
    for host in (SEARCH_HOST, DSH_HOST):
        rec = {"type": "CNAME", "name": host, "content": f"{tun['id']}.cfargotunnel.com", "proxied": True,
               "comment": "tunnel services (DE0CH/services)"}
        recs = call("GET", f"/zones/{ZONE}/dns_records?name={host}")
        call("PUT" if recs else "POST", f"/zones/{ZONE}/dns_records" + (f"/{recs[0]['id']}" if recs else ""), rec)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.writelines(f"{k}={v}\n" for k, v in vals.items())
    print(f"ok: tunnel {TUNNEL} {tun['id']}: https://{SEARCH_HOST}/ behind Access (aud {aud}, client id {tok['client_id']}), "
          f"https://{DSH_HOST}/ behind Access (aud {daud}; dsh-web token {dtok['client_id']}); "
          f"new values ({', '.join(sorted(vals))}) in {out}")


if __name__ == "__main__":
    main()
