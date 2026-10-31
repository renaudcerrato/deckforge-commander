# Launch Environment

Each program launch receives a fresh snapshot of Stream Deck metadata and the key's theme. These variables are **DeckForge Commander-defined**, not standard SDK environment variables.

## Example

```python
import os

theme = os.environ.get("ELGATO_ACTION_THEME_COLOR", "#969696")
column = os.environ.get("ELGATO_KEY_COLUMN")
label = "Key" if column is None else f"Column {column}"
print(f"text:Building|color:{theme};label:{label}", flush=True)
```

Use the theme as ink and the optional column as a caption. Missing coordinates return `None`; column `0` is valid.

## Exported variables

Values are strings; numbers use decimal notation. Missing metadata is omitted, not guessed.

| Variable | Meaning |
|---|---|
| `ELGATO_PLUGIN_UUID` | Plugin UUID. |
| `ELGATO_PLUGIN_VERSION` | Plugin version. |
| `ELGATO_ACTION_UUID` | Registered action type; see UUIDs below. |
| `ELGATO_ACTION_CONTEXT` | Current action instance; not a durable key ID. |
| `ELGATO_ACTION_THEME_COLOR` | Lowercase `#rrggbb`; defaults to `#969696`. |
| `ELGATO_DEVICE_ID` | Device identifier. |
| `ELGATO_DEVICE_NAME` | User-configurable name, not a model name. |
| `ELGATO_DEVICE_TYPE` | Device type. |
| `ELGATO_DEVICE_COLUMNS` | Device grid columns, not pixels. |
| `ELGATO_DEVICE_ROWS` | Device grid rows, not pixels. |
| `ELGATO_KEY_COLUMN` | Optional, zero-based key column. |
| `ELGATO_KEY_ROW` | Optional, zero-based key row. |
| `ELGATO_APP_VERSION` | Stream Deck app version. |
| `ELGATO_APP_LANGUAGE` | App language. |
| `ELGATO_APP_PLATFORM` | App platform. |
| `ELGATO_APP_PLATFORM_VERSION` | Platform version. |

## Per-key identity

`ELGATO_ACTION_UUID` identifies the action type:

| Key | UUID |
|---|---|
| Stream | `git.renaudcerrato.deckforge.stream` |
| Loop | `git.renaudcerrato.deckforge.loop` |
| Run | `git.renaudcerrato.deckforge.run` |

Action context is session-scoped, not stable across app cycles. Use it for temporary namespacing only.
