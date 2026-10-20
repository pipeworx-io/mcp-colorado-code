# Colorado Code — Colorado Revised Statutes by citation, topic, and title

Keyless. "C.R.S. 18-3-102" returns murder in the first degree.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1854+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## The official site redirects into a wall; a second official route does not

leg.colorado.gov's "C.R.S. Online" link does not host the text itself — it
redirects into `advance.lexis.com`, a JS-rendered, cookie-session SPA whose
own next step is a login-capture redirect (`CaptureReturnUrl`). That is the
same class of wall this pack family declines (ASP.NET postback / anti-bot),
and it has no stable per-citation URL to probe anyway.

The Office of Legislative Legal Services separately publishes the whole
C.R.S. as downloadable files, one per title, on its own plain file server —
no login, no JS, keyless:

```
https://olls.info/crs/crs2026-title-18.htm         (current edition)
https://olls.info/crs-archive/CRS-2015-TITLE-18.htm (a historical edition)
```

## Files are per title, citations are per section — and titles are BIG

A title file holds the whole title plus case-law annotations after every
section (Title 18 alone is ~9.5MB), so the section is cut out of it bounded
by the next section heading OR the start of the annotations, whichever comes
first. Annotations are Lexis's editorial case-law commentary, not the
statute, and are never returned — only the statutory text, the `Source:`
amendment history, and `Cross references:` (all public law).

The cut runs on the raw HTML, not the tag-stripped text, on purpose: a real
section heading is the only place a citation is wrapped in
`<b><span>NUM.</span></b>`. The per-article mini table-of-contents that
precedes every article, and plain cross-references inside OTHER sections'
annotations (a citation that happens to land at the start of a text line
once tags are stripped), both repeat the same number unbolded — textually
indistinguishable from a heading after stripping, never bold in the source.

## Three file formats across 27 years of archive

Checked against Title 18 (old enough to exist in every edition):

| Years | Generator | Heading marker |
|---|---|---|
| 2026 (current) | Word | `<b><span>NUM.</span></b>` |
| 2000-2024 | Word | a `name=NUM` anchor tag, `NUM. Title.` + `class=CodeSegment` labels |
| 2025 | WordPerfect | a bold `STRONG`-tagged `NUM.  Title.` |

2025 is declined explicitly (`edition_format_unsupported`) rather than risk
a silently wrong parse for one edition out of twenty-seven — almost
certainly a one-year migration artifact between the other two generators.
If a future year changes format again, `co_statute` will start answering
`section_not_found` for a title that exists; the same risk every sibling
state pack already takes on the current year alone, just extended here
across 25 archived years too.

## Topic search is a nearby-heading window, not full hierarchy awareness

`co_search` runs against the ~18MB General Index (`crs2026-index.htm`), which
is a nested tree — a topic heading followed by indented sub-entries that do
not repeat the heading word. Matching only a result line misses that
structure, so each query word is matched within a small window of the lines
immediately preceding a citation-bearing entry. This works well for short
topics (1-3 words: "landlord", "security deposit", "concealed handgun") and
gets noisier on long compound phrases, which is why the tool description
says so.

## The four capabilities

- **By citation** — `co_statute`. Yes.
- **By topic** — `co_search` (General Index) and `co_titles` (title list with
  subject hints). Yes, with the window caveat above.
- **Historical version** — `co_statute` with `year`, 2000-2024 and current;
  2025 declined (see above). Yes, mostly.
- **Amendments/history** — the `Source:` line, surfaced as `history`. Yes for
  the current template and 2000-2024; for 2000-2024 editions
  `cross_references` is usually `null` because that era files "Cross
  references:" inside the annotations block this pack deliberately excludes.

## Data sources

- <https://olls.info/crs/> — current C.R.S. edition, by title.
- <https://olls.info/crs-archive/> — archived editions back to 2000, by title
  and year. `robots.txt` disallows crawling this path for SEO; that is not a
  redistribution question for data this public (CLAUDE.md's standing ruling).
- <https://olls.info/crs/crs2026-index.htm> — the General Index, for `co_search`.

Colorado Office of Legislative Legal Services. Colorado statutes are public
record.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "colorado-code": {
      "url": "https://gateway.pipeworx.io/colorado-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/colorado-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1854+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/co_statute \
  -H 'Content-Type: application/json' \
  -d '{"section":"18-3-102"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/co_statute`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "colorado-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-colorado-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-colorado-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Colorado Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
