using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

public class Program {
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern IntPtr GetDesktopWindow();

    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    [DllImport("user32.dll")]
    static extern bool LockSetForegroundWindow(uint uLockCode);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    const int SW_RESTORE = 9;
    const uint LSFW_UNLOCK = 2;
    const uint GA_ROOTOWNER = 3;
    const uint GA_ROOT = 2;

    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_SHOWWINDOW = 0x0040;

    static string TempFilePath {
        get {
            return Path.Combine(Path.GetTempPath(), "vc_last_fg_window.txt");
        }
    }

    static void Log(string msg) {
        try {
            string p = Path.Combine(Path.GetTempPath(), "vc_focus_helper.log");
            File.AppendAllText(p, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + msg + Environment.NewLine);
        } catch {}
    }

    static IntPtr ResolveTopLevelWindow(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return IntPtr.Zero;

        IntPtr desktop = GetDesktopWindow();

        IntPtr rootOwner = GetAncestor(hWnd, GA_ROOTOWNER);
        if (rootOwner != IntPtr.Zero && rootOwner != desktop && IsWindow(rootOwner) && IsWindowVisible(rootOwner)) {
            return rootOwner;
        }

        IntPtr root = GetAncestor(hWnd, GA_ROOT);
        if (root != IntPtr.Zero && root != desktop && IsWindow(root) && IsWindowVisible(root)) {
            return root;
        }

        try {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid != 0) {
                Process p = Process.GetProcessById((int)pid);
                if (p.MainWindowHandle != IntPtr.Zero && p.MainWindowHandle != desktop && IsWindow(p.MainWindowHandle)) {
                    return p.MainWindowHandle;
                }
            }
        } catch {}

        if (hWnd != desktop && IsWindow(hWnd) && IsWindowVisible(hWnd)) {
            return hWnd;
        }
        return IntPtr.Zero;
    }

    static bool SwitchToHwnd(IntPtr targetHwnd) {
        if (targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd)) {
            Log("SwitchToHwnd failed: invalid HWND=" + targetHwnd);
            return false;
        }

        IntPtr currentFg = GetForegroundWindow();
        if (targetHwnd == currentFg) {
            Log("SwitchToHwnd: target is already foreground, bringing to top");
            BringWindowToTop(targetHwnd);
            SetForegroundWindow(targetHwnd);
            return true;
        }

        uint targetPid;
        GetWindowThreadProcessId(targetHwnd, out targetPid);
        uint fgPid;
        GetWindowThreadProcessId(currentFg, out fgPid);

        Log(string.Format("SwitchToHwnd target={0} (PID={1}) currentFg={2} (PID={3})", targetHwnd, targetPid, currentFg, fgPid));

        // Unlock foreground lock
        LockSetForegroundWindow(LSFW_UNLOCK);

        // Only restore if minimized to taskbar; never touch normal or maximized windows!
        if (IsIconic(targetHwnd)) {
            ShowWindow(targetHwnd, SW_RESTORE);
        }

        BringWindowToTop(targetHwnd);
        SwitchToThisWindow(targetHwnd, false);
        bool result = SetForegroundWindow(targetHwnd);

        Log("SwitchToHwnd result: " + result);
        return true;
    }

    static void MakeTopmost(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return;
        SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        BringWindowToTop(hWnd);
        Log("MakeTopmost applied to HWND=" + hWnd);
    }

    public static void Main(string[] args) {
        if (args.Length == 0) return;
        string cmd = args[0].ToLowerInvariant();

        if (cmd == "save") {
            uint discordPid = 0;
            if (args.Length > 1) uint.TryParse(args[1], out discordPid);

            IntPtr fg = GetForegroundWindow();
            if (fg != IntPtr.Zero) {
                uint fgPid;
                GetWindowThreadProcessId(fg, out fgPid);

                // If foreground window belongs to Discord, do not overwrite the saved external window
                if (discordPid != 0 && fgPid == discordPid) {
                    Log("Save ignored: foreground is Discord PID=" + fgPid);
                    Environment.Exit(2);
                    return;
                }

                IntPtr target = ResolveTopLevelWindow(fg);
                if (target != IntPtr.Zero && IsWindow(target)) {
                    File.WriteAllText(TempFilePath, target.ToInt64().ToString());
                    Log(string.Format("Saved external window: HWND={0} PID={1} (from fg={2})", target, fgPid, fg));
                    Environment.Exit(0);
                    return;
                }
            }
            Log("Save failed: fg is Zero or invalid");
            Environment.Exit(1);
        } else if (cmd == "restore") {
            try {
                if (File.Exists(TempFilePath)) {
                    string text = File.ReadAllText(TempFilePath).Trim();
                    long val;
                    if (long.TryParse(text, out val) && val != 0) {
                        bool ok = SwitchToHwnd(new IntPtr(val));
                        Environment.Exit(ok ? 0 : 1);
                        return;
                    }
                }
            } catch (Exception ex) {
                Log("Restore exception: " + ex.Message);
            }
            Environment.Exit(1);
        } else if (cmd == "focus" && args.Length > 1) {
            try {
                long val;
                if (long.TryParse(args[1], out val) && val != 0) {
                    bool ok = SwitchToHwnd(new IntPtr(val));
                    Environment.Exit(ok ? 0 : 1);
                    return;
                }
            } catch (Exception ex) {
                Log("Focus exception: " + ex.Message);
            }
            Environment.Exit(1);
        } else if (cmd == "topmost" && args.Length > 1) {
            try {
                long val;
                if (long.TryParse(args[1], out val) && val != 0) {
                    MakeTopmost(new IntPtr(val));
                    Environment.Exit(0);
                    return;
                }
            } catch {}
            Environment.Exit(1);
        }
    }
}
