# Security Policy

## Reporting a Vulnerability

Do not open a public issue for security-sensitive reports.

Instead, use [GitHub's private vulnerability reporting](https://github.com/dominant-strategies/entropic/security/advisories/new)
to send a report to the maintainers. Include:

- affected area (e.g., runtime sandbox, auth flow, build pipeline)
- impact (what an attacker could do)
- steps to reproduce
- any suggested fix

If you are unsure whether something is security-sensitive, report it privately
first.

## Handling Expectations

When a report is confirmed, maintainers will aim to:

- acknowledge receipt
- assess impact and scope
- prepare a fix or mitigation
- disclose publicly after users have a reasonable path to update

## Out of Scope

The following are generally not treated as security issues unless there is a
clear exploit path:

- theoretical issues with no practical impact
- purely stylistic hardening suggestions
- reports that depend on already-compromised local machines
