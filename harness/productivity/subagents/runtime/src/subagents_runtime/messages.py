"""Provider-neutral wording for runtime messages delivered to agents."""

import re


def runtime_message(message: str) -> str:
    """Keep failure details while abstracting the terminal integration's name."""
    return re.sub(r"\baboard\b", "the runtime", message, flags=re.IGNORECASE)
