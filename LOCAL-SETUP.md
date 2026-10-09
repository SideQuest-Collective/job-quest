# Local Job Quest setup

Job Quest works on the Mac without any optional connection. The dashboard stores its own state under `~/.job-quest/data` and listens on loopback by default. Keep the existing career-review schedule if it already produces the daily brief; connecting its files does not install another schedule or run an inbox scan.

To show that review in **Opportunities**, point Job Quest at the local brief and recruiter queue after confirming both files are current and readable:

```bash
~/.job-quest/bin/configure-local.cjs \
  --career-brief /absolute/path/to/daily-intelligence.json \
  --reply-queue /absolute/path/to/recruiter-reply-queue.json \
  --external-schedule
~/.job-quest/bin/restart.sh
```

The command stores paths in private `~/.job-quest/data/local-setup.json` (mode `0600`). The dashboard reads the brief on request. It changes a queue record only when you explicitly save a draft, snooze, pause, resume, skip, or mark a message sent. Queue edits use record revisions and preserve other fields. Opening a conversation, copying text, or opening a calendar link does not mark anything sent or booked. The user sends replies and chooses booking times.

In **Opportunities → Accounts to review**, add each Gmail account you want covered. Add **LinkedIn email notifications** separately if those messages arrive in Gmail. This records desired sources; it does not connect an account or prove a completed scan. Link an account to a named source row only when that row actually describes its review. The row's checked/blocked time and detail show the review coverage; access verification is recorded separately after a connector or browser access check. LinkedIn notifications do not establish coverage of the direct LinkedIn inbox, InMail, or invitations. Missing or blocked sources remain visible as such.

The optional interview bridge uses `~/.interview` unless you choose another existing directory:

```bash
~/.job-quest/bin/configure-local.cjs --interview-home /absolute/path/to/interview-home
~/.job-quest/bin/restart.sh
```

For private phone access, first configure and verify Tailscale Serve and the exact login identity. Then use `--private-origin https://your-device.your-tailnet.ts.net --tailscale-user your-login` and restart. This command records the allowlisted origin and identity; it does not turn on Tailscale or publish Job Quest. Keep the Mac awake and online while using the phone. `--local-only` removes those two private-access settings and retains the local brief, queue, and interview paths.

Run `~/.job-quest/bin/configure-local.cjs --help` to see the options. The local status endpoint `/api/local-setup` reports which optional paths and private access settings are configured without returning brief or queue content. A configured path or account is not proof that a source was checked today; verify the Opportunities page and its source rows after each setup change.

For a source checkout, `install.sh` copies `skill/bin/configure-local.cjs` to `~/.job-quest/bin` and makes it executable. When updating an existing local installation, preserve `~/.job-quest/data`, the current branch changes, and the external review schedule. Install only the reviewed source files needed for this update, then restart and check the local page before testing private phone access.
