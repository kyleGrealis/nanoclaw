---
name: brave-search
description: Search the web with Brave Search. Use for open-ended "look up X" queries where you don't already know the source URL. Returns titles, URLs, and short descriptions that you can follow up with agent-browser or WebFetch.
allowed-tools: Bash(brave-search:*)
---

# Brave Search

Reliable web search that doesn't trigger CAPTCHA like DuckDuckGo does in the browser. Use this instead of opening a search engine page with agent-browser.

## Quick start

```bash
brave-search "raspberry pi 5 power consumption"
brave-search --count 5 "tailscale subnet router"
brave-search --news "cloudflare outage"
```

## Options

| Flag | Default | Notes |
|------|---------|-------|
| `--count N` | 10 | 1-20 results |
| `--country XX` | US | Two-letter ISO code |
| `--json` | off | Raw JSON instead of formatted text |
| `--news` | off | Search news endpoint instead of web |

## Typical workflow

1. `brave-search "<query>"` to find candidate URLs
2. Pick the best-looking result
3. `agent-browser open <url>` or `WebFetch <url>` to read the full page
4. Summarize for the user

Don't paste raw search results back to the user without filtering — pick the relevant ones and pull actual content from them.
