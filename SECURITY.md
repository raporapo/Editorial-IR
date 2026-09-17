# Security

## Reporting a vulnerability

Open a private security advisory through GitHub's "Report a vulnerability"
button on this repository. Please do not open a public issue for something
exploitable.

Expect an acknowledgement within a few days.

## What this project touches

It reads media files, runs `ffmpeg` and `ffprobe` as subprocesses, optionally
starts a Python subprocess, and optionally makes HTTPS requests to endpoints you
configure. It writes into a project directory and into paths you pass to
`--out`.

Things worth knowing:

- **Media is attacker-controlled input.** Both ffmpeg and any model backend
  parse untrusted bytes. Processing media you did not produce carries whatever
  risk those parsers carry. This project does not add sandboxing.
- **Command arguments are built in code, never interpolated from user input into
  a shell.** Every subprocess is invoked with an argument array.
- **Keys come from the environment**, and are never written into a project, an
  IR, a plan or an adapter's output.
- **Nothing phones home.** There is no telemetry under any configuration. The
  only network calls are to endpoints you configure, and every analysis reports
  whether anything left the machine.

## Scope

In scope: path traversal through project or output paths, command injection,
a crafted project file causing arbitrary writes, credential leakage into any
written artefact.

Out of scope: vulnerabilities in ffmpeg or in model backends — report those
upstream, though we will happily take a mitigation.
