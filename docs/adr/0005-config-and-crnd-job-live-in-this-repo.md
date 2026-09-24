# The config and the crnd job live in this repo

The Summarizer's `config.yml` and its crnd job definition are committed to this private repository. The crnd job points the Summarizer at the checkout's copy with `--config`.

The reason is that losing the Mac Mini must not lose anything needed to rebuild it:

- The code is on GitHub.
- translate's `summarizer` agent is in translate's private repository.
- A config kept only in `~/.config`, as wachi's is, would not survive the machine.

The config holds no secrets. The bot token stays out of the repository; it is set in the crnd job on the machine and can be reset in Discord's Developer Portal if it is lost.

## Considered Options

- **Keep the config in `~/.config` and back it up with rclone to encrypted Google Drive.** Rejected: it adds another moving part and keeps no history.

## Consequences

- A config edit takes effect on the next Run. It must be committed and pushed to keep the off-site copy current.
- `~/.config/discord-link-summarizer/config.yml` is still the default path when `--config` is not given.
- The job file is restored with `crnd import`, and the token has to be added back by hand.
