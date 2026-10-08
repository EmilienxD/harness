"""Native desktop notifications using operating-system tools (no Python dependencies)."""

import base64
import json
import shutil
import subprocess
import sys


# Use a stable per-user identity so Windows can expose notification preferences.
# No activation action is needed: these notifications only display text.
_WINDOWS_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $appId = 'Harness.DesktopNotification'
    $key = 'HKCU:\Software\Classes\AppUserModelId\' + $appId
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name DisplayName -Value 'Harness' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name CustomActivator -Value '{8D52D829-99B9-43E5-AD1A-93343154473C}' -PropertyType String -Force | Out-Null
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
    $nodes = $xml.GetElementsByTagName('text')
    $nodes.Item(0).AppendChild($xml.CreateTextNode([string]$payload.title)) | Out-Null
    $nodes.Item(1).AppendChild($xml.CreateTextNode([string]$payload.body)) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
'''

_MAC_SCRIPT = '''on run argv
    display notification (item 2 of argv) with title (item 1 of argv)
end run'''


def _backend():
    name = {'win32': 'powershell.exe', 'darwin': 'osascript', 'linux': 'notify-send'}.get(sys.platform)
    executable = shutil.which(name) if name else None
    if not executable:
        raise RuntimeError(f'Desktop notifications require {name or "a supported desktop platform"}.')
    return executable


def backend_available() -> bool:
    """Whether this platform has its native notification executable installed."""
    try:
        _backend()
    except RuntimeError:
        return False
    return True


def send_notification(title: str, body: str) -> None:
    """Submit a notification, raising RuntimeError when delivery fails."""
    executable = _backend()
    kwargs = dict(check=True, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=8)
    if sys.platform == 'win32':
        script = base64.b64encode(_WINDOWS_SCRIPT.encode('utf-16-le')).decode('ascii')
        args = [executable, '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', script]
        # ASCII JSON avoids Windows PowerShell console encoding differences.
        kwargs.update(input=json.dumps({'title': title, 'body': body}, ensure_ascii=True), creationflags=0x08000000)
    elif sys.platform == 'darwin':
        args = [executable, '-e', _MAC_SCRIPT, '--', title, body]
    else:
        args = [executable, '--app-name=Harness', '--', title, body]
    try:
        subprocess.run(args, **kwargs)
    except (OSError, subprocess.SubprocessError) as error:
        detail = getattr(error, 'stderr', None) or str(error)
        raise RuntimeError(f'Desktop notification delivery failed: {detail}') from error
