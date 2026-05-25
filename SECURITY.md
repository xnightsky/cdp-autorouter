# Security Policy

## Supported Versions

`chrome-devtools-mcp-autorouter` is currently pre-1.0. Security fixes are expected to land on the `main` branch first.

| Version | Supported |
| ------- | --------- |
| `main` | Yes |
| `< 0.1.0` | No |

## Reporting a Vulnerability

Please do not disclose exploitable details, credentials, private URLs, screenshots, or internal environment data in public Issues or Pull Requests.

Preferred reporting path:

1. Use GitHub's private vulnerability reporting flow: `Security` -> `Report a vulnerability`.
2. If private reporting is not enabled yet, open a public Issue with only a short, non-sensitive summary and ask the maintainer to enable private reporting before sharing details.

Helpful non-sensitive context:

- affected version or commit SHA;
- operating system and Node.js version;
- whether the instance is `managed` or `attached`;
- whether the exposure involves HTTP compat routes, Admin API, or WS/CDP proxying.

Do not include:

- API keys, passwords, bearer tokens, session cookies, private keys, or database connection strings;
- internal hostnames, private IPs, VPN-only URLs, or screenshots containing private data;
- full exploit payloads before a private channel is available.

## Maintainer Response

The maintainer should acknowledge a valid report, assess impact, and coordinate a fix before public disclosure. If a credential or secret is ever exposed in Git history, rotate or revoke it first; rewriting history or changing repository visibility is not sufficient once a secret has been committed.
