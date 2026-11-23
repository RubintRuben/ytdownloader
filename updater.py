"""Download verified Windows releases and swap the portable executable on exit."""

import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading

import httpx

from version import APP_VERSION


_RELEASE_API = "https://api.github.com/repos/RubintRuben/ytdownloader/releases"
_ASSET_NAME = "Downloader.exe"
_MAX_EXE_BYTES = 350 * 1024 * 1024


class ReleaseAccessError(Exception):
    pass


def _protect_token(data: bytes, encrypt: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("length", wintypes.DWORD), ("data", ctypes.c_void_p)]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.addressof(buffer))
    result = Blob()
    library = ctypes.WinDLL("crypt32", use_last_error=True)
    operation = library.CryptProtectData if encrypt else library.CryptUnprotectData
    operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    operation.restype = wintypes.BOOL
    if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(result.data, result.length)
    finally:
        local_free = ctypes.windll.kernel32.LocalFree
        local_free.argtypes = [ctypes.c_void_p]
        local_free.restype = ctypes.c_void_p
        local_free(result.data)


def _version_tuple(version: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", version)
    return tuple(map(int, match.groups())) if match else None


def _github_headers(accept: str, token: str = "") -> dict:
    headers = {"Accept": accept, "User-Agent": f"Downloader/{APP_VERSION}",
               "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _latest_release(token: str = "") -> dict | None:
    headers = _github_headers("application/vnd.github+json", token)
    response = httpx.get(f"{_RELEASE_API}/latest", headers=headers,
                         timeout=12)
    if response.status_code == 404:
        repository = httpx.get(_RELEASE_API.removesuffix("/releases"), headers=headers, timeout=12)
        if repository.status_code in {401, 403, 404}:
            raise ReleaseAccessError()
        repository.raise_for_status()
        return None
    if response.status_code == 401:
        raise ReleaseAccessError()
    response.raise_for_status()
    release = response.json()
    tag = release.get("tag_name", "")
    latest = _version_tuple(tag)
    if not latest or latest <= _version_tuple(APP_VERSION) or release.get("draft") or release.get("prerelease"):
        return None
    for asset in release.get("assets", []):
        size, asset_id = asset.get("size"), asset.get("id")
        digest = asset.get("digest") or ""
        if (asset.get("name") == _ASSET_NAME and asset.get("state") == "uploaded"
                and isinstance(asset_id, int) and asset_id > 0
                and isinstance(size, int) and 0 < size <= _MAX_EXE_BYTES
                and re.fullmatch(r"sha256:[a-fA-F0-9]{64}", digest)):
            return {"version": tag.removeprefix("v"), "size": size, "id": asset_id,
                    "sha256": digest[7:].lower()}
    return None


def _download_asset(release: dict, destination: Path, progress, token: str = "") -> None:
    digest = hashlib.sha256()
    received = 0
    with httpx.Client(timeout=25, follow_redirects=True) as client:
        # httpx strips authorization from redirects to other origins.
        with client.stream("GET", f"{_RELEASE_API}/assets/{release['id']}",
                           headers=_github_headers("application/octet-stream", token)) as response:
            response.raise_for_status()
            with destination.open("xb") as output:
                for chunk in response.iter_bytes(256 * 1024):
                    if not received and not chunk.startswith(b"MZ"):
                        raise ValueError("Release asset is not a Windows executable")
                    received += len(chunk)
                    if received > release["size"]:
                        raise ValueError("Release asset exceeds the advertised size")
                    digest.update(chunk)
                    output.write(chunk)
                    progress(int(100 * received / release["size"]))
    if received != release["size"] or digest.hexdigest() != release["sha256"]:
        raise ValueError("Release asset integrity check failed")


def _launch_installer(staged: Path, digest: str, log_file: Path) -> None:
    import ctypes

    executable = Path(sys.executable).resolve()
    # The one-file bootloader can still hold the EXE after this Python process exits.
    # The helper retries the atomic replacement while Windows releases the handle.
    helper = staged.with_suffix(".ps1")
    helper.write_text(_INSTALL_SCRIPT, encoding="utf-8")
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    arguments = [str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                 "-ExecutionPolicy", "Bypass", "-File", str(helper), "-Target", str(executable),
                 "-Staged", str(staged), "-Digest", digest, "-AppPid", str(os.getpid()),
                 "-LauncherPid", str(os.getppid()), "-LogPath", str(log_file)]
    # A PyInstaller child normally inherits the app's DLL search directory.
    # Start the OS helper with its normal Windows DLL search order.
    set_dll_directory = ctypes.windll.kernel32.SetDllDirectoryW
    set_dll_directory.argtypes = [ctypes.c_wchar_p]
    set_dll_directory(None)
    try:
        with log_file.open("ab") as log:
            subprocess.Popen(arguments, creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True,
                             stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    finally:
        if getattr(sys, "_MEIPASS", None):
            set_dll_directory(str(sys._MEIPASS))


class DesktopUpdater:
    def __init__(self, log_file: Path):
        self._lock = threading.Lock()
        self._log_file = log_file
        self._token_file = log_file.with_name("update-token.dpapi")
        self._release = None
        self._state = "idle"
        self._progress = 0

    @property
    def enabled(self):
        return os.name == "nt" and getattr(sys, "frozen", False)

    def status(self) -> dict:
        with self._lock:
            return {"version": APP_VERSION, "available": self._release["version"] if self._release else None,
                    "state": self._state if self.enabled else "source", "progress": self._progress,
                    "storedToken": self.enabled and self._token_file.is_file()}

    def _token(self):
        if token := os.environ.get("DOWNLOADER_GITHUB_TOKEN"):
            return token
        try:
            return _protect_token(self._token_file.read_bytes(), encrypt=False).decode("utf-8")
        except (OSError, UnicodeError):
            return ""

    def save_token(self, value: str) -> bool:
        value = value.strip()
        if not self.enabled or (value and not re.fullmatch(r"github_pat_[A-Za-z0-9_]{20,250}", value)):
            return False
        with self._lock:
            if self._state in {"checking", "downloading", "ready", "restarting"}:
                return False
            try:
                if value:
                    encrypted = _protect_token(value.encode("utf-8"), encrypt=True)
                    with tempfile.NamedTemporaryFile(dir=self._token_file.parent, delete=False) as file:
                        pending = Path(file.name)
                        file.write(encrypted)
                    try:
                        pending.replace(self._token_file)
                    finally:
                        pending.unlink(missing_ok=True)
                else:
                    self._token_file.unlink(missing_ok=True)
            except OSError:
                return False
            self._release = None
            self._state = "idle"
            return True

    def check(self):
        with self._lock:
            if not self.enabled or self._state in {"checking", "downloading", "ready", "restarting"}:
                return
            self._state = "checking"
        try:
            release = _latest_release(self._token())
        except ReleaseAccessError:
            with self._lock:
                self._release = None
                self._state = "access_required"
            return
        except (httpx.HTTPError, ValueError, TypeError):
            with self._lock:
                self._state = "check_error"
            return
        with self._lock:
            self._release = release
            self._state = "available" if release else "current"

    def start(self):
        with self._lock:
            if not self.enabled or not self._release or self._state not in {"available", "install_error", "check_error"}:
                return
            self._state = "downloading"
            self._progress = 0
            release = self._release.copy()
        threading.Thread(target=self._stage, args=(release,), daemon=True).start()

    def _stage(self, release: dict):
        staged = None
        try:
            target = Path(sys.executable).resolve()
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".Downloader-update-", suffix=".part",
                                             delete=False) as file:
                staged = Path(file.name)
            staged.unlink()
            _download_asset(release, staged, self._set_progress, self._token())
            with self._lock:
                self._staged = staged
                self._state = "ready"
        except (OSError, KeyError, ValueError, httpx.HTTPError):
            if staged:
                staged.unlink(missing_ok=True)
            with self._lock:
                self._state = "install_error"

    def finish(self, restart):
        with self._lock:
            if self._state != "ready":
                return
            self._state = "restarting"
        try:
            _launch_installer(self._staged, self._release["sha256"], self._log_file)
        except (OSError, KeyError):
            self._staged.unlink(missing_ok=True)
            with self._lock:
                self._state = "install_error"
            return
        restart()

    def _set_progress(self, progress):
        with self._lock:
            self._progress = progress


_INSTALL_SCRIPT = r"""
param([string]$Target, [string]$Staged, [string]$Digest, [int]$AppPid, [int]$LauncherPid, [string]$LogPath)
$ErrorActionPreference = 'Stop'
$backup = "$Staged.previous"
$replaced = $false
function Start-Downloader {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Target
    $start.WorkingDirectory = [IO.Path]::GetDirectoryName($Target)
    $start.UseShellExecute = $false
    $start.EnvironmentVariables['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
    [void][Diagnostics.Process]::Start($start)
}
function Get-Application([int]$ProcessId = $AppPid) {
    try { [Diagnostics.Process]::GetProcessById($ProcessId) }
    catch [ArgumentException] { $null }
}
try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Staged)
    try {
        $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '')
    } finally {
        $stream.Dispose()
        $hasher.Dispose()
    }
    if ($hash -ne $Digest) {
        throw 'The staged update failed validation.'
    }
    $application = Get-Application
    if ($application -and -not $application.WaitForExit(90000)) {
        throw 'Downloader did not exit before the update timeout.'
    }
    $launcher = Get-Application $LauncherPid
    $name = [IO.Path]::GetFileNameWithoutExtension($Target)
    if ($launcher -and $launcher.ProcessName -eq $name -and -not $launcher.WaitForExit(20000)) {
        throw 'The original launcher kept the executable open.'
    }
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        try {
            [IO.File]::Replace($Staged, $Target, $backup, $false)
            $replaced = $true
            break
        } catch [System.IO.IOException] {
            [Threading.Thread]::Sleep(250)
        }
    }
    if (-not $replaced) { throw 'Windows kept the executable locked.' }
    Start-Downloader
    try { [IO.File]::Delete($backup) } catch {}
} catch {
    try { [IO.File]::AppendAllText($LogPath, "Update failed: $($_.Exception.Message)`r`n") } catch {}
    if ($replaced -and [IO.File]::Exists($backup)) {
        [IO.File]::Replace($backup, $Target, $null, $false)
    }
    if (-not (Get-Application)) { Start-Downloader }
} finally {
    try { [IO.File]::Delete($Staged) } catch {}
    try { [IO.File]::Delete($PSCommandPath) } catch {}
}
"""
