vcl 4.1;

# AWCMS-Mini edge cache.
#
# ## The one rule
#
# This cache stores NOTHING the application has not explicitly marked as
# storable. `src/lib/http/cache-policy.ts` stamps every response that did not
# opt in with `Cache-Control: private, no-store`, and `vcl_backend_response`
# below turns anything without a recognised opt-in into hit-for-pass. The
# application knows whether a response carries tenant- or user-scoped data;
# this file does not, and must never guess.
#
# ## Why the cache key is shaped the way it is
#
# The app resolves the tenant from the request Host for public pages, and from
# the session for authenticated ones. A key that ignored either would let one
# tenant's page satisfy another tenant's request, so `vcl_hash` always mixes
# in:
#
#   * the normalised Host          -> tenant isolation for public pages
#   * the locale cookie            -> a page rendered in `id` never answers `en`
#   * the session + tenant cookies -> per-user isolation for authenticated pages
#
# The session component is added whenever a session cookie is present, before
# we know how the backend will classify the response. That costs a logged-in
# visitor their own copy of an otherwise-public page. The duplication is the
# deliberate trade: the alternative is a key that is correct only if the
# backend classification is correct, and a bug there leaks one user's page to
# another.
#
# ## Portability note
#
# Cookie values are extracted with plain `regsub` rather than vmod_cookie's
# `cookie.get()`. vmod_cookie ships in `varnish-modules`, which is NOT present
# in the official `varnish` container image — using it would make this VCL fail
# to load at startup on the very image the compose file pins.

import std;

# The backend hostname is the compose service name, resolved by the container
# network's DNS. Deliberately a literal: VCL performs no environment
# interpolation, so a `${VAR}` here would be loaded verbatim and fail.
backend default {
  .host = "app";
  .port = "4321";
  .first_byte_timeout = 60s;
  .between_bytes_timeout = 60s;
  .max_connections = 200;
}

# Only these may issue BAN. The container network, nothing else — an
# internet-reachable ban endpoint is a trivial cache-flush denial of service.
acl purgers {
  "localhost";
  "127.0.0.1";
  "10.0.0.0"/8;
  "172.16.0.0"/12;
  "192.168.0.0"/16;
}

sub vcl_recv {
  # Normalise the Host once, so `Example.COM` and `example.com` cannot occupy
  # two entries — and, more importantly, cannot be used to sidestep a ban.
  set req.http.Host = std.tolower(req.http.Host);

  if (req.method == "BAN") {
    if (!client.ip ~ purgers) {
      return (synth(403, "Ban not permitted from this address"));
    }
    if (!req.http.X-Ban-Url) {
      return (synth(400, "X-Ban-Url required"));
    }
    # Host-scoped by construction: a ban issued for one tenant can never evict
    # another tenant's entries, even if the URL pattern is broad.
    ban("obj.http.X-Cache-Host == " + req.http.Host
        + " && obj.http.X-Cache-Url ~ " + req.http.X-Ban-Url);
    return (synth(200, "Banned"));
  }

  # Never cache anything that is not a plain read.
  if (req.method != "GET" && req.method != "HEAD") {
    return (pass);
  }

  # Bearer-token API traffic is machine-to-machine and frequently carries
  # per-caller authorization that no cookie reflects.
  if (req.http.Authorization) {
    return (pass);
  }

  # Authentication endpoints establish or destroy identity. A cached response
  # here is a session-fixation bug regardless of what the app says.
  if (req.url ~ "^/api/v1/auth/" || req.url ~ "^/(login|logout)(/|\?|$)") {
    return (pass);
  }

  # Health and metrics must always reflect the live process, or a failing
  # instance reads healthy for the whole TTL.
  if (req.url ~ "^/api/v1/health" || req.url ~ "^/metrics") {
    return (pass);
  }

  return (hash);
}

sub vcl_hash {
  hash_data(req.url);
  hash_data(req.http.Host);

  # Locale is a cookie, resolved in the app's middleware. Two locales are two
  # different documents at the same URL. Hash the empty string when absent, so
  # "no locale cookie" is its own bucket rather than colliding with whichever
  # locale happens to be first.
  if (req.http.Cookie ~ "awcms_mini_locale=") {
    hash_data(regsub(req.http.Cookie,
      "^.*;? *awcms_mini_locale=([^;]*).*$", "\1"));
  } else {
    hash_data("locale=none");
  }

  # Present only for authenticated requests. The session token is key material
  # only — Varnish hashes it and never stores or logs it — and it is the one
  # value that reliably separates two users of the same tenant.
  if (req.http.Cookie ~ "awcms_mini_session=") {
    hash_data(regsub(req.http.Cookie,
      "^.*;? *awcms_mini_session=([^;]*).*$", "\1"));
    hash_data(regsub(req.http.Cookie,
      "^.*;? *awcms_mini_tenant_id=([^;]*).*$", "\1"));
  } else {
    hash_data("session=anonymous");
  }

  return (lookup);
}

sub vcl_backend_response {
  # Tag every stored object so BAN above can scope by tenant + path.
  set beresp.http.X-Cache-Host = bereq.http.Host;
  set beresp.http.X-Cache-Url = bereq.url;

  # A response that sets a cookie must never be stored: a cached Set-Cookie
  # hands one visitor's session, locale, or tenant selection to the next. The
  # app already forces these to no-store; this is the belt to that suspenders,
  # because the consequence of missing one is severe.
  if (beresp.http.Set-Cookie) {
    set beresp.uncacheable = true;
    set beresp.ttl = 120s;
    return (deliver);
  }

  # Session-scoped: only this cache may store it. The app sent
  # `Cache-Control: private, no-store` for every other cache in the path, plus
  # this private header for us.
  if (beresp.http.X-AWCMS-Edge-Cache ~ "^session; max-age=[0-9]+$") {
    set beresp.ttl = std.duration(
      regsub(beresp.http.X-AWCMS-Edge-Cache, "^session; max-age=", "") + "s",
      0s);
    # No grace and no keep: serving a stale AUTHORIZED page after a role
    # change, suspension, or entitlement expiry is a security problem, not a
    # freshness annoyance.
    set beresp.grace = 0s;
    set beresp.keep = 0s;
    return (deliver);
  }

  # Anonymous and shareable. Grace is allowed here because the content carries
  # no authorization state — a few seconds of staleness during a backend blip
  # beats an error page.
  if (beresp.http.Cache-Control ~ "public"
      && beresp.http.Cache-Control ~ "max-age=[1-9]") {
    set beresp.grace = 10s;
    return (deliver);
  }

  # Everything else: hit-for-pass rather than a plain pass, so a stampede of
  # concurrent requests for one uncacheable object does not each open its own
  # backend connection.
  set beresp.uncacheable = true;
  set beresp.ttl = 120s;
  return (deliver);
}

sub vcl_deliver {
  # Strip the private signalling before it reaches anyone. Leaking
  # `X-AWCMS-Edge-Cache` would advertise which authenticated routes are
  # cached; the rest is internal bookkeeping and edge topology.
  unset resp.http.X-AWCMS-Edge-Cache;
  unset resp.http.X-Cache-Host;
  unset resp.http.X-Cache-Url;
  unset resp.http.Via;
  unset resp.http.X-Varnish;
  unset resp.http.Age;

  # Deliberately NOT reporting hit/miss by default: it is a side channel that
  # tells a visitor whether someone else recently fetched a given
  # authenticated URL. Opt in only while debugging.
  if (std.getenv("VARNISH_DEBUG_HEADERS") == "true") {
    if (obj.hits > 0) {
      set resp.http.X-Cache = "HIT";
    } else {
      set resp.http.X-Cache = "MISS";
    }
  }

  return (deliver);
}

sub vcl_backend_error {
  # Never surface Varnish's own branded error page — it discloses the edge
  # topology to anyone who can trigger a backend failure.
  set beresp.http.Content-Type = "text/plain; charset=utf-8";
  set beresp.http.Cache-Control = "private, no-store";
  set beresp.body = "Service temporarily unavailable.";
  return (deliver);
}

sub vcl_synth {
  set resp.http.Content-Type = "text/plain; charset=utf-8";
  set resp.http.Cache-Control = "private, no-store";
  return (deliver);
}
