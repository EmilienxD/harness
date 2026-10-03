import importlib.util
import json
import subprocess
from pathlib import Path

import pytest


def load_delivery():
    path = Path(__file__).resolve().parents[2] / 'harness/productivity/enable-desktop-notification/desktop_notification.py'
    spec = importlib.util.spec_from_file_location('desktop_notification_delivery', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_enable_detects_missing_native_backend(monkeypatch):
    delivery = load_delivery()
    monkeypatch.setattr(delivery.sys, 'platform', 'linux')
    monkeypatch.setattr(delivery.shutil, 'which', lambda name: None)
    assert delivery.backend_available() is False
    with pytest.raises(RuntimeError, match='notify-send'):
        delivery.send_notification('Session', 'Done')


@pytest.mark.parametrize('platform, executable', [('linux', 'notify-send'), ('darwin', 'osascript'), ('win32', 'powershell.exe')])
def test_delivers_untrusted_unicode_as_data(monkeypatch, platform, executable):
    delivery = load_delivery()
    monkeypatch.setattr(delivery.sys, 'platform', platform)
    monkeypatch.setattr(delivery.shutil, 'which', lambda name: executable)
    calls = []
    monkeypatch.setattr(delivery.subprocess, 'run', lambda args, **kwargs: calls.append((args, kwargs)))
    title, body = 'Session "$(bad)"', 'Réussi <&>\nnext line'
    delivery.send_notification(title, body)
    args, kwargs = calls[0]
    assert args[0] == executable
    assert kwargs['timeout'] <= 15
    if platform == 'win32':
        assert json.loads(kwargs['input']) == {'title': title, 'body': body}
        assert title not in ' '.join(args)
        assert kwargs['creationflags'] == 0x08000000
    else:
        assert args[-2:] == [title, body]


@pytest.mark.parametrize('failure', [subprocess.CalledProcessError(1, ['notify-send'], stderr='No desktop bus'), subprocess.TimeoutExpired(['notify-send'], 10), OSError('Unavailable')])
def test_delivery_failures_are_reported_to_caller(monkeypatch, failure):
    delivery = load_delivery()
    monkeypatch.setattr(delivery.sys, 'platform', 'linux')
    monkeypatch.setattr(delivery.shutil, 'which', lambda name: 'notify-send')
    def fail(*args, **kwargs):
        raise failure
    monkeypatch.setattr(delivery.subprocess, 'run', fail)
    with pytest.raises(RuntimeError, match='Desktop notification delivery failed'):
        delivery.send_notification('Session', 'Done')
