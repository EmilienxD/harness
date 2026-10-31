"""Provider-neutral wording for runtime messages delivered to agents."""

def runtime_message(message: str) -> str:
    """Preserve diagnostics supplied by providers and execution hosts."""
    return message
