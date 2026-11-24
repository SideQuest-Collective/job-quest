---
description: Show and change the Job Quest daily intel, interview trainer and Daily Drop podcast schedules.
argument-hint: "[intel|trainer|podcast] [time|off]"
---

Manage the three Job Quest background schedules. They are launchd jobs on macOS and
crontab entries on Linux, installed outside the plugin by the scripts in
`~/.job-quest/bin`. Always call the scripts by these full paths. Data in `~/.job-quest`
is never deleted here.

Arguments: `$ARGUMENTS`

## Status

1. Check each schedule. The exit code is the answer:

   ```bash
   ~/.job-quest/bin/install-schedule.sh --exists; echo "intel: $?"
   ~/.job-quest/bin/install-trainer-schedule.sh --exists; echo "trainer: $?"
   ~/.job-quest/bin/install-podcast-schedule.sh --exists; echo "podcast: $?"
   ```

   - `0`: installed.
   - `1`: not installed.
   - `2`, or any other code, or the script is missing: status unknown, the check could not
     run. Never report this as "not installed"; say the status is unknown and show any error.

2. For the details of what is installed, run `~/.job-quest/bin/install-schedule.sh --current-cron`,
   `~/.job-quest/bin/install-trainer-schedule.sh --current-range` and
   `~/.job-quest/bin/install-podcast-schedule.sh --show`.
3. Show the user a short table: schedule, state (installed, not installed, unknown) and when it runs.
4. If `$ARGUMENTS` names a change (for example `intel 07:30`, `trainer 9-21`, `podcast off`),
   act on it using the sections below. Otherwise show the status and ask which schedule, if
   any, the user wants to change.
5. Confirm with the user before installing or removing anything. After every change, run
   that schedule's `--exists` again and report the result.

## Daily intel

Before any change:

- Read `~/.job-quest/data/local-setup.json`. If it says `"schedule": "external"`, an external
  review owns the daily run: in the status, say that a missing native schedule is expected.
  Install a native schedule only after telling the user that and getting an explicit yes.
  If the file exists but cannot be read (invalid JSON), say so and do not change the schedule.
- Read `~/.job-quest/data/intel-schedule-preference.json`. If it exists but is unreadable
  (invalid JSON, a `schema` other than `job-quest-intel-schedule/1`, or a `frequency` other
  than `off`, `daily` or `weekdays`), report the problem and do not change the schedule. Never
  overwrite or replace that file unless the user explicitly approves replacing it.

Install or change. Offer what the preference file can record, the same choices as Dashboard
Setup: `weekdays` or `daily`, at a time. The default is weekdays at 07:03:

```bash
~/.job-quest/bin/install-schedule.sh "3 7 * * 1-5"   # weekdays at HH:MM -> "<M> <H> * * 1-5"
~/.job-quest/bin/install-schedule.sh "3 7 * * *"     # daily at HH:MM    -> "<M> <H> * * *"
```

Any other cron shape is not offered here; point the user to the job-quest skill's Schedule
Management flow for a custom expression.

After a successful install, write `~/.job-quest/data/intel-schedule-preference.json` so it
describes what was installed: `frequency` `weekdays` or `daily`, `time` as zero-padded
`HH:MM`, and `cron` as the expression installed. `updatedAt` is the current ISO time and
`timeZone` the local IANA zone. For the default:

```json
{
  "schema": "job-quest-intel-schedule/1",
  "frequency": "weekdays",
  "time": "07:03",
  "cron": "3 7 * * 1-5",
  "updatedAt": "<ISO timestamp, e.g. 2026-11-24T10:00:00.000Z>",
  "timeZone": "<IANA time zone, e.g. America/Los_Angeles>"
}
```

Without this, a preference left at `off` would keep the session-start check quiet about a
schedule that later goes missing.

Remove:

```bash
~/.job-quest/bin/install-schedule.sh --uninstall
```

Then record the manual-only choice in `~/.job-quest/data/intel-schedule-preference.json`, so
the session-start check stops reporting the schedule as missing:

```json
{
  "schema": "job-quest-intel-schedule/1",
  "frequency": "off",
  "time": null,
  "cron": null,
  "updatedAt": "<ISO timestamp>",
  "timeZone": "<IANA time zone>"
}
```

If the install or removal exits non-zero, report its error and leave the preference file as it is.

## Trainer

The interview trainer texts a question at the top of each hour in a range of hours.

- If `~/.job-quest/data/trainer/config.json` does not exist, the trainer is not set up. Send
  the user to the job-quest skill's trainer section (phone number, iMessage Automation, and
  Full Disk Access for `trainer-messages-reader`) and install nothing.
- Install or change the hours (default `9-21`):

  ```bash
  ~/.job-quest/bin/install-trainer-schedule.sh 9-21
  ```

  After a successful install, set `startHour` and `endHour` in
  `~/.job-quest/data/trainer/config.json` to the same range (for `9-21`: `startHour` 9,
  `endHour` 21) and leave every other key as it is. The runner reads its hours from that
  file, so the two must match.
- Remove:

  ```bash
  ~/.job-quest/bin/install-trainer-schedule.sh --uninstall
  ```

## Podcast

The Daily Drop podcast runs once a day at a time (default `08:30`):

```bash
~/.job-quest/bin/install-podcast-schedule.sh 08:30
```

Remove it with:

```bash
~/.job-quest/bin/install-podcast-schedule.sh --uninstall
```
