import pytest

from harness_cli import host_actions


@pytest.fixture(autouse=True)
def forget_cached_host_products():
    """Keep one test's host inventory from answering another test's probe."""
    host_actions.forget_host_products()
    yield
    host_actions.forget_host_products()
