# Security Policy

## Supported versions

Security fixes are applied to the current public release line. Older releases may
not receive fixes; upgrade to the latest release before reporting an issue that
may already be resolved.

## Reporting a vulnerability

Please report security issues **privately**:

- Use GitHub's private vulnerability reporting on this repository
  (Security → Report a vulnerability), or
- Email `contact@nibistudio.top` with the subject `[SECURITY] NIBI client`.

Do **not** open a public issue, discussion, or pull request that describes an
unfixed vulnerability.

Include, when possible:

- affected version or commit
- operating system and platform
- a minimal reproduction or proof of concept
- impact assessment
- whether the issue requires a malicious workspace, plugin, or remote peer

Do not include real credentials, personal data, or third-party secrets in the
report. If a credential may have leaked, rotate it first and say so.

## What to expect

- We aim to acknowledge reports within a few business days.
- We will confirm the affected versions and scope, then coordinate a fix and a
  disclosure date with you.
- We may ask for a private fork or a minimal patch to validate the issue.
- Credit is given by default unless you ask to remain anonymous.

## Scope

In scope:

- the desktop client, web client, server, CLI, TUI, and shared packages in this
  repository
- IPC, RPC, deep links, protocol parsing, file handling, plugin loading, and
  permission boundaries
- build and release scripts that are part of the public repository
- dependency vulnerabilities that are reachable from the product

Out of scope:

- issues that require a compromised operating system, administrator access, or
  physical access
- vulnerabilities in third-party services or upstream projects that are not
  reachable through NIBI
- reports that only demonstrate missing hardening without a concrete impact
- social engineering, spam, or denial-of-service against hosted infrastructure

## Public repository and CI

This repository never stores release signing material or real provider keys.
Public workflows run on GitHub-hosted runners, use `pull_request` (not
`pull_request_target`), declare read-only permissions by default, and do not
receive repository secrets from forks. If you find a workflow that violates
these rules, treat it as a security report.

## Safe harbor

We will not pursue legal action for good-faith security research that:

- stays within the scope above
- avoids privacy violations, data destruction, and service disruption
- gives us reasonable time to fix the issue before public disclosure
- does not access data that is not yours

If you are unsure whether an action is allowed, ask first at
`contact@nibistudio.top`.
