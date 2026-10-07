interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * HTML-to-text helpers shared by the state statute packs.
 *
 * One decoder rather than one per pack, because the copies had already begun
 * to drift: the hex-entity case (&#x2003; em space, &#x2014; em dash) was
 * handled in Florida's copy and not California's, so Californian statutes were
 * quietly emitting raw entities where punctuation belonged. Fixed once here.
 *
 * publish-pack.sh inlines workspace imports, so a standalone pack still ships
 * self-contained.
 */

const SCRIPT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK = /<\/?(p|div|br|tr|li|h[1-6]|blockquote)\b[^>]*>/gi;

/** Convert a slice of statute HTML to readable plain text. */
function statuteText(html: string): string {
  return html
    .replace(/\r\n?/g, '\n')
    .replace(SCRIPT, ' ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // Hex before decimal: legislature sites emit &#x2003; and &#x2014;
    // constantly, and a decimal-only decoder leaves them in the middle of the
    // statute looking like markup noise.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&sect;/g, '\u00a7')
    // Named entities that carry MEANING, decoded before the catch-all below.
    // This was a real defect: the catch-all replaced &ndash; with a SPACE, so
    // Maryland's "&sect;2&ndash;201." decoded to "2 201" and a lookup for
    // section 2-201 reported a statute that plainly exists as missing. Dashes
    // are everywhere in statutory text and numbering, so the corruption was
    // silent and general rather than particular to one state.
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&rsquo;|&apos;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Text from a container, starting AFTER its opening tag.
 *
 * Slicing at the marker itself leaves the tail of the tag — `laws-body">` — as
 * the first characters of the statute, which is exactly what three packs did
 * before testing caught it.
 */
function textFromContainer(html: string, marker: string | RegExp): string | null {
  const i = typeof marker === 'string' ? html.indexOf(marker) : html.search(marker);
  if (i === -1) return null;
  const gt = html.indexOf('>', i);
  return statuteText(html.slice(gt === -1 ? i : gt + 1));
}

/**
 * Read a statute response as text, honouring its actual encoding.
 *
 * Several state sites serve WINDOWS-1252 while sending `content-type:
 * text/html` with no charset. Response.text() assumes UTF-8, so their smart
 * quotes and non-breaking spaces decode to replacement characters — Nevada
 * rendered `"Murder" defined` as mojibake, and Oregon's section headings
 * became unmatchable because the "space" after the section number is a 0xA0
 * that never survived the decode.
 *
 * That is the quiet kind of damage: the text still looks like text, so nothing
 * errors, and a heading regex simply stops matching for reasons no one can see
 * in the output.
 *
 * Strict UTF-8 first — if the bytes really are UTF-8 this succeeds and nothing
 * changes — then fall back to windows-1252, which decodes every byte and so
 * cannot itself fail.
 */
async function readStatuteResponse(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/**
 * Cut one section out of a page that holds a whole chapter.
 *
 * A section number appears several times on these pages and only one of them
 * starts the statute. The others are a table-of-contents entry at the top and
 * cross-references inside neighbouring sections. Picking the FIRST match
 * returns a heading with nothing under it; picking the LAST returns whatever
 * fragment follows a cross-reference. Both were tried and both produced
 * confident, tiny, wrong answers — Oregon 140 characters, Nevada 39, each
 * looking like a real result.
 *
 * The body is simply the candidate with the most text before the next section
 * begins, which is true regardless of where the page puts its contents list.
 *
 * @param heading matches the start of the wanted section (global flag required)
 * @param next    matches the start of ANY section, to bound the slice
 */
function sliceSection(text: string, heading: RegExp, next: RegExp): string | null {
  // Record where each candidate starts AND how long its heading is. Skipping
  // only one character past the start lets the  pattern re-match the very
  // heading we just found, which yields an empty body — that bug returned
  // section_not_found for a section plainly present on the page.
  const found: Array<{ at: number; len: number }> = [];
  const re = new RegExp(heading.source, heading.flags.includes('g') ? heading.flags : heading.flags + 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    found.push({ at: m.index, len: m[0].length });
    if (re.lastIndex === m.index) re.lastIndex++;   // guard zero-width matches
  }
  if (!found.length) return null;

  let best: string | null = null;
  for (const { at, len } of found) {
    const from = at + len;
    const nre = new RegExp(next.source, next.flags.includes('g') ? next.flags : next.flags + 'g');
    const m = nre.exec(text.slice(from));
    const body = (m ? text.slice(at, from + m.index) : text.slice(at)).trim();
    if (body.length > (best?.length ?? 0)) best = body;
  }
  return best && best.length > 0 ? best : null;
}
/**
 * Colorado Revised Statutes — state statutes by citation, topic, and title.
 *
 * The official statute site (leg.colorado.gov) does not host the text: its
 * "C.R.S. Online" link is a redirect into advance.lexis.com, a JS-rendered,
 * cookie-session, login-capture SPA with no stable per-citation URL — the
 * same class of wall this pack family treats as OUT (ASP.NET postback /
 * anti-bot). That is not the only official route, though. The Office of
 * Legislative Legal Services separately publishes the whole C.R.S. as
 * downloadable HTM/PDF/DOCX files, one per title, on its own plain file
 * server (olls.info) — no login, no JS, keyless:
 *
 *   https://olls.info/crs/crs2026-title-18.htm        -> current edition, title 18 (padded 2-digit)
 *   https://olls.info/crs-archive/CRS-2026-TITLE-18.htm -> same text, archive naming (NOT padded)
 *   https://olls.info/crs-archive/CRS-2015-TITLE-18.htm -> the 2015 edition of title 18
 *
 * FILES ARE PER TITLE, CITATIONS ARE PER SECTION, same shape as Texas/Nevada
 * — fetch the title, cut the section out of it. The difference here is size:
 * a title file is the whole title PLUS case-law annotations after every
 * section (Title 18 alone is ~9.5MB), so the cut has to stop BEFORE the
 * "ANNOTATION" block as well as before the next section — annotations are
 * Lexis's editorial case-law commentary, not the statute, and returning them
 * would both bloat every response and hand back content this pack has no
 * license to redistribute. The statute text itself, the "Source:" amendment
 * history, and "Cross references:" are all public law and included.
 *
 * sliceSection's "most text wins" heuristic (shared/statute-html.ts) is load
 * -bearing here for a reason specific to this file: before every article,
 * OLLS repeats a mini table-of-contents listing each section's number and
 * title with NO bold markup — textually indistinguishable from the real
 * heading once tags are stripped. The real section wins because thousands of
 * characters of statute + history sit before its next boundary, where the
 * TOC entry's next boundary is a few words away.
 *
 * Archive back to 2000 is public (robots.txt disallows crawling it for SEO,
 * which is not a redistribution question — CLAUDE.md's standing ruling is
 * that a Disallow on already-public data is not a blocker).
 *
 * The general index (crs2026-index.htm, ~18MB, an A-Z subject index with
 * section citations) is fetched and line-searched for co_search — genuine
 * topic -> citation search, not just a title list.
 */

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Colorado Office of Legislative Legal Services');
}

const UA = 'pipeworx-mcp-colorado-code/1.0 (+https://pipeworx.io)';
const CURRENT_FILES = 'https://olls.info/crs';
const ARCHIVE_FILES = 'https://olls.info/crs-archive';
const MIN_ARCHIVE_YEAR = 2000;

/** Official title names, from the OLLS download page's own table (44 titles;
 *  "Title 00" is the Colorado Constitution, a separate document, out of scope
 *  here). */
const TITLES: Record<string, string> = {
  '1': 'Elections', '2': 'Legislative', '3': 'United States',
  '4': 'Uniform Commercial Code', '5': 'Consumer Credit Code',
  '6': 'Consumer and Commercial Affairs', '7': 'Corporations and Associations',
  '8': 'Labor and Industry', '9': 'Safety - Industrial and Commercial',
  '10': 'Insurance', '11': 'Financial Institutions', '12': 'Professions and Occupations',
  '13': 'Courts and Court Procedure', '14': 'Domestic Matters',
  '15': 'Probate, Trusts, and Fiduciaries', '16': 'Criminal Proceedings',
  '17': 'Corrections', '18': 'Criminal Code', '19': "Children's Code",
  '20': 'District Attorneys', '21': 'State Public Defender', '22': 'Education',
  '23': 'Postsecondary Education', '24': 'Government - State',
  '25': 'Public Health and Environment', '26': 'Human Services Code',
  '27': 'Behavioral Health', '28': 'Military and Veterans', '29': 'Government - Local',
  '30': 'Government - County', '31': 'Government - Municipal', '32': 'Special Districts',
  '33': 'Parks and Wildlife', '34': 'Mineral Resources', '35': 'Agriculture',
  '36': 'Natural Resources - General', '37': 'Water and Irrigation',
  '38': 'Property - Real and Personal', '39': 'Taxation', '40': 'Utilities',
  '41': 'Aeronautics: Aircraft and Airports', '42': 'Vehicles and Traffic',
  '43': 'Transportation', '44': 'Revenue - Regulation of Activities',
};

/** Short subject hints for the handful of titles people actually ask about by
 *  topic rather than by number — routing help, not a topic index. */
const SUBJECTS: Record<string, string> = {
  '18': 'crimes, punishment, criminal code',
  '42': 'driving, DUI, traffic, vehicle registration',
  '38': 'property, real estate, landlord-tenant',
  '14': 'divorce, custody, support, marriage',
  '8': 'wages, hours, workers compensation, unemployment',
  '13': 'civil lawsuits, court procedure, evidence',
  '25': 'public health, environment',
  '19': "children, juvenile, family services",
  '39': 'state and local taxes',
  '24': 'state government, open records',
  '7': 'corporations, LLCs, partnerships',
  '15': 'wills, trusts, estates, probate',
  '10': 'insurance regulation and claims',
  '22': 'K-12 schools',
  '26': 'welfare, human services, medicaid',
};

const CITATION = /^(\d{1,3})(?:\.\d+)?[A-Za-z]?-(\d{1,4})(?:\.\d+)?[A-Za-z]?-(\d{1,4})(?:\.\d+)?[A-Za-z]?$/;

/**
 * OLLS has used at least THREE different HTML export templates for the same
 * document across the archive it publishes (checked against title 18, which
 * is old enough to exist in every edition):
 *   2026 (current): Word, `<b><span>NUM.</span></b>` headings — cutSection().
 *   2000-2024:      Word, `<a name=NUM></a>` anchors + `class=CodeSegment`
 *                    labels (History / Annotations) — cutSectionLegacy().
 *   2025:            WordPerfect, `<STRONG>NUM.  Title. </STRONG>` headings —
 *                    a one-year anomaly, almost certainly a migration
 *                    artifact, not yet worth a third parser for one edition
 *                    out of twenty-seven. Declined explicitly rather than
 *                    silently mis-parsed.
 * If a future year changes format again this will start reporting
 * section_not_found for a title that exists — the same risk every sibling
 * state pack takes on the CURRENT year alone; this pack additionally takes
 * it on 25 archived years, which is why the format is pinned here rather
 * than guessed per request.
 */
const UNSUPPORTED_EDITION_YEARS = new Set([2025]);

function editionFormat(editionYear: number | null): 'current' | 'legacy' | 'unsupported' {
  if (editionYear === null || editionYear >= 2026) return 'current';
  if (UNSUPPORTED_EDITION_YEARS.has(editionYear)) return 'unsupported';
  return 'legacy';
}

function titleFileUrl(title: string, year: number | null): { url: string; edition: string } {
  if (year == null) {
    const padded = title.padStart(2, '0');
    return { url: `${CURRENT_FILES}/crs2026-title-${padded}.htm`, edition: 'current' };
  }
  return { url: `${ARCHIVE_FILES}/CRS-${year}-TITLE-${title}.htm`, edition: String(year) };
}

/**
 * Bound a section between its heading and either the next section heading
 * or the start of the case-law ANNOTATION block that follows it — whichever
 * comes first. Annotations are Lexis's editorial commentary, not the
 * statute, and this pack returns only the public-law text.
 *
 * This runs on the RAW (undecoded-to-text) HTML on purpose. A real section
 * heading is the only place a citation number is wrapped in
 * `<b><span>NUM.</span></b>` — the per-article mini table-of-contents that
 * precedes every article repeats the same number in plain (unbold) text, and
 * so does every cross-reference inside another section's annotations, e.g.
 * "...of his conviction under subsection (1)(d) of §\n18-3-102. People v.
 * Jones..." — a citation that happens to fall at the start of a text LINE
 * after tags are stripped, immediately followed by a period and more prose,
 * which is indistinguishable from a heading in TEXT form but is never bold
 * in the source. Matching the bold wrapper in the RAW html, then converting
 * only the winning slice to text, avoids that false positive instead of
 * hoping sliceSection's "most text wins" heuristic always out-votes it (it
 * doesn't: an annotation block can run longer than the statute it follows).
 */
function cutSection(rawHtml: string, section: string): string | null {
  const esc = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rawBody = sliceSection(
    rawHtml,
    new RegExp(`<b>\\s*<span[^>]*>\\s*${esc}\\.\\s*</span>\\s*</b>`, 'g'),
    new RegExp(
      `<b>\\s*<span[^>]*>\\s*\\d{1,3}(?:\\.\\d+)?[A-Za-z]?-\\d{1,4}(?:\\.\\d+)?[A-Za-z]?-\\d{1,4}(?:\\.\\d+)?[A-Za-z]?\\.\\s*</span>\\s*</b>` +
      `|<p[^>]*align=center[^>]*>\\s*<b>\\s*<span[^>]*>\\s*ANNOTATION\\s*</span>\\s*</b>`,
      'g',
    ),
  );
  if (rawBody === null) return null;
  return statuteText(rawBody).replace(/ /g, ' ');
}

/**
 * Same job as cutSection(), for the 2000-2024 archive template. Headings
 * there are a named anchor rather than a bold span -- `<a
 * name=18-3-102></a>18-3-102. Murder in the first degree.` -- which is
 * unambiguous on its own (anchors are unique), bounded by either the next
 * section's anchor or the `CodeSegment` label that introduces the
 * case-law annotations for this one. The `CodeSegment` labels themselves
 * ("Statute text", "History", "Annotations") are UI furniture, not content,
 * and are stripped from the slice before conversion to text.
 */
function cutSectionLegacy(rawHtml: string, section: string): string | null {
  const esc = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rawBody = sliceSection(
    rawHtml,
    new RegExp(`<a name=${esc}></a>`, 'g'),
    new RegExp(
      `<a name=\\d{1,3}(?:\\.\\d+)?[A-Za-z]?-\\d{1,4}(?:\\.\\d+)?[A-Za-z]?-\\d{1,4}(?:\\.\\d+)?[A-Za-z]?>` +
      `|<p class=CodeSegment>Annotations</p>`,
      'g',
    ),
  );
  if (rawBody === null) return null;
  const stripped = rawBody.replace(/<p class=CodeSegment>[^<]*<\/p>/g, '');
  return statuteText(stripped).replace(/\u00a0/g, ' ');
}

function extractHistory(body: string): string | null {
  const m = /\nSource:\s*\n?\s*([\s\S]*?)(?=\n\s*Cross\s*\n?\s*references:|$)/.exec(body);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function extractCrossReferences(body: string): string | null {
  const m = /\n\s*Cross\s*\n?\s*references:\s*\n?\s*([\s\S]*)$/.exec(body);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'co_statute',
    description:
      'Get the FULL TEXT of a section of the Colorado Revised Statutes (C.R.S.) — Colorado state law — by citation. "C.R.S. 18-3-102" is murder in the first degree. Returns the statutory text, the amendment "Source:" history, and cross references. Pass "year" (2000-current, except 2025 which is not yet supported) to get an older edition instead of the current one, e.g. to see how a section read before a given amendment. Keyless. Use for "what does C.R.S. 18-3-102 say", "Colorado landlord security deposit law", or to check a Colorado statute a case relies on.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Section as cited, e.g. "18-3-102" (murder) or "38-12-103" (security deposits). Title-article-section; the title is the part before the first dash.' },
        year: { type: 'integer', description: `Optional. A C.R.S. edition year from ${MIN_ARCHIVE_YEAR} through the current year, to retrieve a historical version of the section instead of the current one. Omit for the current edition.` },
      },
      required: ['section'],
    },
  },
  {
    name: 'co_titles',
    description:
      'List the 44 titles of the Colorado Revised Statutes with their official names — Title 18 is the Criminal Code, Title 42 is Vehicles and Traffic, Title 38 is Property, and so on. Keyless. Use when you know the subject but not the title number, before calling co_statute or co_search.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Optional subject to filter by, e.g. "divorce", "DUI", "landlord".' },
      },
    },
  },
  {
    name: 'co_search',
    description:
      'Search the Colorado Revised Statutes GENERAL INDEX by topic and get back matching index entries with their C.R.S. citations — e.g. "landlord", "security deposit", "concealed handgun", "driving under the influence". This is a real subject-index search, not just a title list: it finds the specific section(s) a plain-English topic maps to so you can pass them to co_statute. Works best with a SHORT topic (1-3 words) — the index is a nested tree (a topic heading followed by indented sub-entries that do not repeat the heading word), matched here within a small window of nearby lines, so a long compound phrase can miss or pick up a loosely related neighbor. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic to search for, e.g. "landlord", "security deposit", "concealed handgun". Short phrases work best.' },
        limit: { type: 'integer', description: 'Max results to return (default 15, max 50).' },
      },
      required: ['query'],
    },
  },
];

async function fetchTitleHtml(title: string, year: number | null): Promise<
  | { ok: true; html: string; url: string; edition: string }
  | { ok: false; status: number; url: string; edition: string }
> {
  const { url, edition } = titleFileUrl(title, year);
  const res = await pwFetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return { ok: false, status: res.status, url, edition };
  const html = await readStatuteResponse(res);
  return { ok: true, html, url, edition };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'co_titles': {
      const q = String(args.subject ?? '').trim().toLowerCase();
      const rows = Object.entries(TITLES)
        .map(([num, titleName]) => ({ title: Number(num), name: titleName, covers: SUBJECTS[num] ?? null }))
        .sort((a, b) => a.title - b.title)
        .filter((r) =>
          !q ||
          r.name.toLowerCase().includes(q) ||
          (r.covers ?? '').toLowerCase().includes(q),
        );
      return {
        returned: rows.length,
        total: Object.keys(TITLES).length,
        titles: rows,
        ...(q && rows.length === 0
          ? { note: `Nothing matched "${q}" in the title names or subject hints. Call co_search for a full subject-index search, or co_titles with no argument to see all 44 titles.` }
          : {}),
        note_constitution: 'The Colorado Constitution is a separate document (not a numbered C.R.S. title) and is not covered by this pack.',
        source: 'Colorado Office of Legislative Legal Services (olls.info)',
      };
    }

    case 'co_statute': {
      const raw = String(args.section ?? '').trim().replace(/\s+/g, '').replace(/^(C\.?R\.?S\.?|§+)/i, '');
      const m = CITATION.exec(raw);
      if (!m) {
        return { found: false, reason: 'unparsed_section',
          message: `"${args.section}" is not a Colorado Revised Statutes citation.`,
          hint: 'C.R.S. sections are title-article-section, e.g. "18-3-102" (murder) or "38-12-103" (security deposits). The title is the part before the first dash.' };
      }
      const title = m[1];
      if (!TITLES[title]) {
        return { found: false, reason: 'unknown_title', section: raw, title,
          message: `Title ${title} is not one of the 44 numbered C.R.S. titles.`,
          hint: 'Call co_titles to see the valid title numbers (1-44).' };
      }

      let year: number | null = null;
      if (args.year !== undefined && args.year !== null && args.year !== '') {
        const y = Number(args.year);
        const currentYear = new Date().getUTCFullYear();
        if (!Number.isInteger(y) || y < MIN_ARCHIVE_YEAR || y > currentYear) {
          return { found: false, reason: 'invalid_year', section: raw, year: args.year,
            message: `year must be an integer from ${MIN_ARCHIVE_YEAR} through ${currentYear}.`,
            hint: 'Omit year for the current edition.' };
        }
        year = y;
      }

      if (year !== null && editionFormat(year) === 'unsupported') {
        return { found: false, reason: 'edition_format_unsupported', section: raw, year,
          message: `The ${year} C.R.S. edition was published in a different file format this pack does not yet parse correctly, so it is declined rather than risk a silently wrong answer.`,
          hint: 'Try a year from 2000-2024, or omit year for the current edition.' };
      }

      let fetched = await fetchTitleHtml(title, year);
      let fellBack = false;
      if (!fetched.ok && fetched.status === 404 && year === null) {
        // The "current" filename hard-codes the edition year in its path
        // (crs2026-title-NN.htm). When that year's edition is not yet
        // published — e.g. early in a session before the annual drop — fall
        // back to the previous year's ARCHIVE copy rather than reporting a
        // false not-found for a title that plainly exists. Skip the fallback
        // entirely if that year happens to be one this pack can't parse.
        const fallbackYear = new Date().getUTCFullYear() - 1;
        if (editionFormat(fallbackYear) !== 'unsupported') {
          fetched = await fetchTitleHtml(title, fallbackYear);
          fellBack = fetched.ok;
        }
      }
      if (!fetched.ok) {
        if (fetched.status === 404) {
          return { found: false, reason: 'title_or_year_not_found', section: raw, title, year,
            message: `No C.R.S. title ${title}${year ? ` for edition ${year}` : ''} at the Office of Legislative Legal Services file server (HTTP 404).`,
            hint: year ? `Editions are available from ${MIN_ARCHIVE_YEAR} through the current year.` : 'Call co_titles to confirm the title number.' };
        }
        throw new Error(`Colorado OLLS file server returned HTTP ${fetched.status} for title ${title}`);
      }

      const resolvedYear = fetched.edition === 'current' ? null : Number(fetched.edition);
      const body = editionFormat(resolvedYear) === 'legacy'
        ? cutSectionLegacy(fetched.html, raw)
        : cutSection(fetched.html, raw);
      if (!body) {
        return { found: false, reason: 'section_not_found', section: raw, title, title_name: TITLES[title], edition: fetched.edition,
          message: `Title ${title} (${TITLES[title]}) exists but has no section ${raw} in the ${fetched.edition} edition.`,
          hint: 'Section numbers are not contiguous — repealed or renumbered sections are normal. Try co_search, or a different year.' };
      }

      const headingMatch = /^\S+\.\s*([^\n]+?)\s*$/m.exec(body.split('\n')[0] ?? '');
      const history = extractHistory(body);
      const crossReferences = extractCrossReferences(body);
      // Trim the Source:/Cross references: tail off the returned statute text
      // itself — those are surfaced as separate fields.
      const statuteOnly = body.split(/\nSource:\s*\n?/)[0]!.trim();

      return {
        citation: `C.R.S. § ${raw}`,
        section: raw,
        title: Number(title),
        title_name: TITLES[title],
        heading: headingMatch ? headingMatch[1].replace(/\s+/g, ' ').trim() : null,
        text: statuteOnly,
        text_chars: statuteOnly.length,
        history,
        cross_references: crossReferences,
        edition: fetched.edition,
        is_current: fetched.edition === 'current' && !fellBack,
        ...(fellBack ? { note: `The current (undated) edition file was not available; returned the ${fetched.edition} edition instead.` } : {}),
        url: fetched.url,
        data_as_of: fetched.edition === 'current' ? 'Colorado Revised Statutes, 2026 edition' : `Colorado Revised Statutes, ${fetched.edition} edition`,
        source: 'Colorado Office of Legislative Legal Services (olls.info), keyless',
        attribution: 'Colorado statutes are public record. Case-law annotations that follow each section in the official file are Lexis editorial commentary and are not included here.',
      };
    }

    case 'co_search': {
      const query = String(args.query ?? '').trim();
      if (!query) {
        return { found: false, reason: 'missing_query', message: 'query is required, e.g. "security deposit".' };
      }
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));

      const res = await pwFetch(`${CURRENT_FILES}/crs2026-index.htm`, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`Colorado OLLS file server returned HTTP ${res.status} for the general index`);
      const text = statuteText(await readStatuteResponse(res)).replace(/\u00a0/g, ' ');

      // The index is a nested tree -- a topic heading, then indented
      // sub-entries that do not repeat the heading word ("LANDLORD AND
      // TENANT" / "Security deposit." / "Return of, section 38-12-103.").
      // Matching only the entry's own line misses that structure entirely,
      // so each word of the query is matched against a small window of the
      // lines immediately preceding the citation-bearing entry instead of
      // the entry alone -- enough to catch the nearest heading without
      // pulling in an unrelated sibling topic several entries back.
      const WINDOW = 6;
      const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
      const CITE = /\d{1,3}(?:\.\d+)?[A-Za-z]?-\d{1,4}(?:\.\d+)?[A-Za-z]?-\d{1,4}(?:\.\d+)?[A-Za-z]?/g;
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

      const results: Array<{ entry: string; citations: string[] }> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const citations = [...line.matchAll(CITE)].map((m) => m[0].replace(/\.$/, ''));
        if (citations.length === 0) continue;
        const context = lines.slice(Math.max(0, i - WINDOW), i + 1).join(' ').toLowerCase();
        if (!words.every((w) => context.includes(w))) continue;
        results.push({ entry: line, citations });
        if (results.length >= limit) break;
      }

      return {
        returned: results.length,
        query,
        results,
        ...(results.length === 0
          ? { note: `No General Index entries matched "${query}" within a nearby-heading window. Try a shorter topic (1-2 words), or call co_titles to browse by title.` }
          : { hint: 'Pass a citation above to co_statute to get its full text.' }),
        url: `${CURRENT_FILES}/crs2026-index.htm`,
        data_as_of: 'Colorado Revised Statutes General Index, 2026 edition',
        source: 'Colorado Office of Legislative Legal Services (olls.info), keyless',
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
