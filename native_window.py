"""Native Windows behaviour for the frameless WebView2 window.

pywebview moves frameless windows with JavaScript, which bypasses Windows' own
move/size loop: no Aero Snap, no drag-to-top maximise and no drag-down restore.
Here the window keeps a sizable style (without a visible frame) and dragging or
resizing hands the mouse to Windows, exactly like a normal title bar.
"""
from __future__ import annotations

import ctypes
import os
from ctypes import wintypes

WM_NCCALCSIZE = 0x0083
WM_NCLBUTTONDOWN = 0x00A1
WM_NCDESTROY = 0x0082
GWL_STYLE = -16
WS_THICKFRAME, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_CAPTION = 0x40000, 0x10000, 0x20000, 0x80000, 0xC00000
SWP_FLAGS = 0x0002 | 0x0001 | 0x0004 | 0x0020 | 0x0200  # NOMOVE|NOSIZE|NOZORDER|FRAMECHANGED|NOOWNERZORDER
HIT = {"caption": 2, "left": 10, "right": 11, "top": 12, "topleft": 13, "topright": 14,
       "bottom": 15, "bottomleft": 16, "bottomright": 17}

if os.name == "nt":
    user32 = ctypes.windll.user32
    comctl32 = ctypes.windll.comctl32
    LRESULT = ctypes.c_ssize_t
    SUBCLASSPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM,
                                      wintypes.LPARAM, ctypes.c_size_t, ctypes.c_size_t)
    comctl32.DefSubclassProc.restype = LRESULT
    comctl32.DefSubclassProc.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    comctl32.SetWindowSubclass.argtypes = [wintypes.HWND, SUBCLASSPROC, ctypes.c_size_t, ctypes.c_size_t]
    user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
    user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
    user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.MonitorFromWindow.restype = wintypes.HMONITOR

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                    ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    class NCCALCSIZE_PARAMS(ctypes.Structure):
        _fields_ = [("rgrc", wintypes.RECT * 3), ("lppos", ctypes.c_void_p)]


class NativeFrame:
    """Install once per window handle; keep the instance alive (holds the callback)."""

    def __init__(self, hwnd: int):
        self.hwnd = hwnd
        self._proc = None
        if os.name != "nt":
            return
        self._proc = SUBCLASSPROC(self._wndproc)
        comctl32.SetWindowSubclass(hwnd, self._proc, 0xD0A1, 0)
        style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE)
        # WS_CAPTION + WS_THICKFRAME enable Aero Snap; WM_NCCALCSIZE hides the frame they would draw.
        style |= WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_SYSMENU
        user32.SetWindowLongPtrW(hwnd, GWL_STYLE, style)
        user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_FLAGS)

    def _wndproc(self, hwnd, msg, wparam, lparam, _id, _data):
        if msg == WM_NCCALCSIZE and wparam:
            # No visible frame. When maximised, keep the client area on the work
            # area so the taskbar stays visible and nothing spills off-screen.
            if user32.IsZoomed(hwnd):
                params = ctypes.cast(lparam, ctypes.POINTER(NCCALCSIZE_PARAMS)).contents
                monitor = user32.MonitorFromWindow(hwnd, 2)
                info = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
                if user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
                    params.rgrc[0] = info.rcWork
            return 0
        return comctl32.DefSubclassProc(hwnd, msg, wparam, lparam)

    def begin(self, kind: str) -> None:
        """Start a native move (`caption`) or resize (edge name) with the held mouse button."""
        if os.name != "nt" or kind not in HIT:
            return
        point = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(point))
        user32.ReleaseCapture()
        packed = (point.y & 0xFFFF) << 16 | (point.x & 0xFFFF)
        user32.PostMessageW(self.hwnd, WM_NCLBUTTONDOWN, HIT[kind], packed)

    def toggle_maximize(self) -> bool:
        if os.name == "nt":
            user32.ShowWindow(self.hwnd, 9 if user32.IsZoomed(self.hwnd) else 3)  # SW_RESTORE / SW_MAXIMIZE
        return self.maximized

    def minimize(self) -> None:
        if os.name == "nt":
            user32.ShowWindow(self.hwnd, 6)

    @property
    def maximized(self) -> bool:
        return bool(os.name == "nt" and user32.IsZoomed(self.hwnd))
